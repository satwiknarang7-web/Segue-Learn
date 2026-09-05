import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { config, usesHttps } from '../config.js';
import { HttpError, badRequest, conflict, notFound } from '../lib/errors.js';
import { createJoinCode } from '../lib/ids.js';
import {
  buildOtpauthUri,
  createTotpSecret,
  formatSecretForDisplay,
  verifyTotp,
} from '../lib/totp.js';
import { asString } from '../lib/validate.js';
import { universityRepository } from '../repositories/universityRepository.js';
import { userRepository } from '../repositories/userRepository.js';

/**
 * Accounts, carried over from SegueQuiz and re-scoped to a university.
 *
 * Two things are new. Signing up resolves a university from the email domain,
 * so an address decides which ecosystem the account belongs to and an
 * unrecognised domain gets no account at all. And presenting a university's
 * faculty code at signup grants the rights needed to create classrooms;
 * without it every new account is a student.
 *
 * Everything here is async now, because the repositories talk to Postgres.
 */

const scrypt = promisify(crypto.scrypt);

const COOKIE_NAME = 'ep_session';
const ACTIVE_TTL_MS = 12 * 60 * 60 * 1000;
/** A half-finished sign-in only needs to survive the 2FA step. */
const PENDING_TTL_MS = 10 * 60 * 1000;

const RECOVERY_CODE_COUNT = 8;

// Throttling, so neither a password nor a six-digit code can be ground down.
const MAX_FAILURES = 8;
const LOCKOUT_MS = 5 * 60 * 1000;
const failures = new Map();

let secretsCache = null;

/**
 * The session signing key.
 *
 * It comes from the environment when set, which is what a deployment must do:
 * a hosted container has no durable disk, so a generated key would be replaced
 * on every restart and sign everybody straight back out. With nothing set it is
 * generated once into the data directory, which keeps local use to one command.
 */
function secrets() {
  if (secretsCache) return secretsCache;

  const fromEnvironment = process.env.EDUPLATFORM_SESSION_SECRET ?? '';
  let stored = {};

  if (!fromEnvironment) {
    const file = path.join(config.dataDir, 'secrets.json');
    try {
      stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      stored = {};
    }

    if (typeof stored.sessionSecret !== 'string' || stored.sessionSecret.length < 32) {
      stored.sessionSecret = crypto.randomBytes(32).toString('hex');
      fs.mkdirSync(config.dataDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(stored, null, 2), 'utf8');
    }
  }

  secretsCache = {
    sessionSecret: fromEnvironment || stored.sessionSecret,
    sessionSecretFromEnvironment: Boolean(fromEnvironment),
  };
  return secretsCache;
}

/* ------------------------------------------------------------------ *
 * Primitives
 * ------------------------------------------------------------------ */

const base64url = (buffer) => Buffer.from(buffer).toString('base64url');

const signPayload = (payload) =>
  crypto.createHmac('sha256', secrets().sessionSecret).update(payload).digest('base64url');

function safeEqual(a, b) {
  const left = crypto.createHash('sha256').update(String(a)).digest();
  const right = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(left, right);
}

async function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const derived = await scrypt(password, salt, 64);
  return { salt, hash: derived.toString('hex') };
}

async function passwordMatches(password, user) {
  const { hash } = await hashPassword(password, user.passwordSalt);
  return safeEqual(hash, user.passwordHash);
}

const hashRecoveryCode = (code) =>
  crypto.createHash('sha256').update(code.replace(/\s|-/g, '').toUpperCase()).digest('hex');

function createRecoveryCodes() {
  const plain = Array.from(
    { length: RECOVERY_CODE_COUNT },
    () => `${createJoinCode(5)}-${createJoinCode(5)}`,
  );
  return { plain, stored: plain.map((code) => ({ hash: hashRecoveryCode(code), usedAt: null })) };
}

function parseCookies(header = '') {
  const jar = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    jar[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return jar;
}

/* ------------------------------------------------------------------ *
 * Sessions
 *
 * Two stages: "pending" is issued once a password is accepted and only
 * unlocks the 2FA step; "active" is issued once the second factor is
 * proven and is what every signed-in route requires.
 * ------------------------------------------------------------------ */

function buildCookie(user, stage) {
  const ttl = stage === 'active' ? ACTIVE_TTL_MS : PENDING_TTL_MS;
  const payload = base64url(
    JSON.stringify({
      userId: user.id,
      stage,
      version: user.tokenVersion,
      expiresAt: Date.now() + ttl,
    }),
  );

  const value = `${payload}.${signPayload(payload)}`;
  return [
    `${COOKIE_NAME}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    ...(usesHttps() ? ['Secure'] : []),
    `Max-Age=${Math.floor(ttl / 1000)}`,
  ].join('; ');
}

async function readSession(req) {
  const raw = parseCookies(req.headers?.cookie ?? '')[COOKIE_NAME];
  if (!raw) return null;

  const separator = raw.lastIndexOf('.');
  if (separator === -1) return null;

  const payload = raw.slice(0, separator);
  const signature = raw.slice(separator + 1);
  if (!safeEqual(signature, signPayload(payload))) return null;

  let claims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (!claims?.userId || claims.expiresAt < Date.now()) return null;

  const user = await userRepository.findById(claims.userId);
  if (!user) return null;
  // Bumping tokenVersion signs every existing session out.
  if (user.tokenVersion !== claims.version) return null;

  return { user, stage: claims.stage };
}

/* ------------------------------------------------------------------ *
 * Throttling
 * ------------------------------------------------------------------ */

function assertNotLockedOut(key) {
  const record = failures.get(key);
  if (!record) return;
  if (Date.now() > record.resetAt) {
    failures.delete(key);
    return;
  }
  if (record.count >= MAX_FAILURES) {
    throw new HttpError(429, 'Too many attempts. Wait a few minutes and try again.');
  }
}

function recordFailure(key) {
  const record = failures.get(key);
  if (!record || Date.now() > record.resetAt) {
    failures.set(key, { count: 1, resetAt: Date.now() + LOCKOUT_MS });
    return;
  }
  record.count += 1;
}

/* ------------------------------------------------------------------ *
 * Public surface
 * ------------------------------------------------------------------ */

function publicUser(user, university = null) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.platformRole,
    twoFactorEnabled: user.totpConfirmed,
    createdAt: user.createdAt,
    ...(university ? { university: { id: university.id, name: university.name, slug: university.slug } } : {}),
  };
}

function enrolmentDetails(user) {
  return {
    otpauthUri: buildOtpauthUri({
      secret: user.totpSecret,
      account: user.email,
      issuer: 'EduPlatform',
    }),
    secret: formatSecretForDisplay(user.totpSecret),
    qrUrl: '/api/auth/2fa/qr.svg',
  };
}

export const accountService = {
  COOKIE_NAME,

  describeSecrets() {
    return { sessionSecretFromEnvironment: secrets().sessionSecretFromEnvironment };
  },

  readSession,

  /** The signed-in person, or null when the second factor is still outstanding. */
  async currentUser(req) {
    const session = await readSession(req);
    return session?.stage === 'active' ? session.user : null;
  },

  signOutCookie() {
    const secure = usesHttps() ? ' Secure;' : '';
    return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax;${secure} Max-Age=0`;
  },

  /**
   * Creates an account inside the university that owns the address's domain.
   *
   * `facultyCode` is optional; matching the university's code makes the new
   * account faculty, which is what allows creating classrooms.
   */
  async signUp({ name, email, password, facultyCode }, clientKey) {
    assertNotLockedOut(clientKey);

    const cleanName = asString(name, 'name', { max: config.limits.nameMaxLength });
    const cleanEmail = userRepository.normaliseEmail(
      asString(email, 'email', { max: config.limits.emailMaxLength }),
    );
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      throw badRequest('Enter a valid email address.');
    }

    if (
      typeof password !== 'string' ||
      password.length < config.limits.minPasswordLength
    ) {
      throw badRequest(
        `Choose a password of at least ${config.limits.minPasswordLength} characters.`,
      );
    }

    const university = await universityRepository.findByEmailDomain(
      userRepository.domainOf(cleanEmail),
    );
    if (!university) {
      throw badRequest(
        'That email domain does not belong to a university on EduPlatform. ' +
          'Use your university address, or ask an administrator to add your institution.',
      );
    }

    if (await userRepository.findByEmail(university.id, cleanEmail)) {
      throw conflict('An account already exists for that email. Sign in instead.');
    }

    // A university with no code set cannot have faculty self-promote at all,
    // so an empty stored code must never match an empty submitted one.
    const submittedFacultyCode = String(facultyCode ?? '').trim();
    const platformRole =
      university.facultySignupCode &&
      submittedFacultyCode &&
      safeEqual(submittedFacultyCode.toLowerCase(), university.facultySignupCode.toLowerCase())
        ? 'faculty'
        : 'student';

    if (submittedFacultyCode && platformRole !== 'faculty') {
      recordFailure(clientKey);
      throw badRequest('That staff code is not right.');
    }

    const { salt, hash } = await hashPassword(password);

    const user = await userRepository.insert({
      universityId: university.id,
      name: cleanName,
      email: cleanEmail,
      passwordSalt: salt,
      passwordHash: hash,
      totpSecret: createTotpSecret(),
      platformRole,
    });

    return {
      user: publicUser(user, university),
      enrolment: enrolmentDetails(user),
      cookie: buildCookie(user, 'pending'),
    };
  },

  async signIn({ email, password }, clientKey) {
    assertNotLockedOut(clientKey);

    // Same message for every failure, so this cannot be used to discover
    // which addresses -- or which universities -- have accounts.
    const rejection = new HttpError(401, 'That email and password do not match.');
    const cleanEmail = userRepository.normaliseEmail(email);

    const university = await universityRepository.findByEmailDomain(
      userRepository.domainOf(cleanEmail),
    );
    const user = university ? await userRepository.findByEmail(university.id, cleanEmail) : null;

    if (!user) {
      recordFailure(clientKey);
      // Spend comparable time so a missing account is not obvious from latency.
      await hashPassword(String(password ?? ''), 'decoy-salt');
      throw rejection;
    }

    if (!(await passwordMatches(String(password ?? ''), user))) {
      recordFailure(clientKey);
      throw rejection;
    }

    return {
      cookie: buildCookie(user, 'pending'),
      // Somebody who never finished enrolling is sent back to finish it.
      needsEnrolment: !user.totpConfirmed,
      enrolment: user.totpConfirmed ? null : enrolmentDetails(user),
    };
  },

  /** The pending user, for the 2FA screens. Throws if there is no half-session. */
  async requirePending(req) {
    const session = await readSession(req);
    if (!session) throw new HttpError(401, 'Start again from the sign-in page.');
    return session;
  },

  enrolmentFor(user) {
    return enrolmentDetails(user);
  },

  /** Finish sign-up: prove the authenticator works, then hand over recovery codes. */
  async activateTwoFactor(req, code, clientKey) {
    assertNotLockedOut(clientKey);
    const { user } = await accountService.requirePending(req);

    if (user.totpConfirmed) throw conflict('Two-factor authentication is already switched on.');

    if (!verifyTotp(user.totpSecret, code)) {
      recordFailure(clientKey);
      throw badRequest('That code is not right. Check your authenticator app and try again.');
    }

    const { plain, stored } = createRecoveryCodes();
    const updated = await userRepository.confirmTwoFactor(user.id, stored);

    failures.delete(clientKey);
    return {
      user: publicUser(updated),
      recoveryCodes: plain,
      cookie: buildCookie(updated, 'active'),
    };
  },

  /** Second step of sign-in: an authenticator code, or a one-time recovery code. */
  async verifySecondFactor(req, code, clientKey) {
    assertNotLockedOut(clientKey);
    const { user } = await accountService.requirePending(req);

    if (!user.totpConfirmed) {
      throw new HttpError(409, 'Finish setting up two-factor authentication first.');
    }

    const candidate = String(code ?? '').trim();

    if (verifyTotp(user.totpSecret, candidate)) {
      const updated = await userRepository.markSignedIn(user.id);
      failures.delete(clientKey);
      return {
        user: publicUser(updated),
        cookie: buildCookie(updated, 'active'),
        usedRecoveryCode: false,
      };
    }

    const updated = await userRepository.useRecoveryCode(user.id, hashRecoveryCode(candidate));
    if (updated) {
      failures.delete(clientKey);
      return {
        user: publicUser(updated),
        cookie: buildCookie(updated, 'active'),
        usedRecoveryCode: true,
        remaining: updated.recoveryCodes.filter((entry) => entry.usedAt === null).length,
      };
    }

    recordFailure(clientKey);
    throw badRequest('That code is not right.');
  },

  /**
   * Reset a forgotten password.
   *
   * There is no mail server to send a reset link through, so the second factor
   * does the authorising instead: prove you still hold the authenticator, or
   * spend one of the recovery codes issued at sign-up.
   *
   * Every existing session is invalidated afterwards, so a password changed
   * because it may have leaked also boots whoever might be using it.
   */
  async resetPassword({ email, code, newPassword }, clientKey) {
    assertNotLockedOut(clientKey);

    const rejection = new HttpError(400, 'That email and code do not match an account.');

    if (
      typeof newPassword !== 'string' ||
      newPassword.length < config.limits.minPasswordLength
    ) {
      throw badRequest(
        `Choose a password of at least ${config.limits.minPasswordLength} characters.`,
      );
    }

    const cleanEmail = userRepository.normaliseEmail(email);
    const university = await universityRepository.findByEmailDomain(
      userRepository.domainOf(cleanEmail),
    );
    const user = university ? await userRepository.findByEmail(university.id, cleanEmail) : null;

    // Same failure whether the account is missing or the code is wrong.
    if (!user || !user.totpConfirmed) {
      recordFailure(clientKey);
      await hashPassword(newPassword, 'decoy-salt');
      throw rejection;
    }

    const candidate = String(code ?? '').trim();
    const recoveryHash = hashRecoveryCode(candidate);
    const hasRecovery = user.recoveryCodes.some(
      (entry) => entry.usedAt === null && entry.hash === recoveryHash,
    );

    if (!verifyTotp(user.totpSecret, candidate) && !hasRecovery) {
      recordFailure(clientKey);
      throw rejection;
    }

    const { salt, hash } = await hashPassword(newPassword);
    const updated = await userRepository.resetPassword(user.id, {
      salt,
      hash,
      spentRecoveryHash: hasRecovery ? recoveryHash : null,
    });

    failures.delete(clientKey);
    return {
      user: publicUser(updated),
      usedRecoveryCode: hasRecovery,
      remainingRecoveryCodes: updated.recoveryCodes.filter((entry) => entry.usedAt === null).length,
    };
  },

  async requireUser(req) {
    const user = await accountService.currentUser(req);
    if (!user) throw new HttpError(401, 'Sign in to do that.');
    return user;
  },

  /** Signed in *and* allowed to create classrooms. */
  async requireFaculty(req) {
    const user = await accountService.requireUser(req);
    if (user.platformRole !== 'faculty' && user.platformRole !== 'admin') {
      throw new HttpError(403, 'Only teaching staff can do that.');
    }
    return user;
  },

  async describe(req) {
    const session = await readSession(req);
    if (!session) return { authenticated: false, stage: 'anonymous' };

    if (session.stage !== 'active') {
      return {
        authenticated: false,
        stage: 'pending',
        needsEnrolment: !session.user.totpConfirmed,
      };
    }

    const university = await universityRepository.findById(session.user.universityId);
    return { authenticated: true, stage: 'active', user: publicUser(session.user, university) };
  },

  async findById(id) {
    const user = await userRepository.findById(id);
    if (!user) throw notFound('That account does not exist.');
    return user;
  },
};
