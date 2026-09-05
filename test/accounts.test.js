import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';

import { freshDatabase, truncateAll } from './helpers/database.js';

const { close } = await freshDatabase();

const { accountService } = await import('../src/services/accountService.js');
const { universityRepository } = await import('../src/repositories/universityRepository.js');
const { userRepository } = await import('../src/repositories/userRepository.js');
const { generateTotp } = await import('../src/lib/totp.js');

after(() => close());
beforeEach(() => truncateAll());

const PASSWORD = 'a-long-enough-password';

const seedUniversity = (overrides = {}) =>
  universityRepository.insert({
    name: 'Test University',
    slug: 'test',
    emailDomain: 'test.edu',
    ...overrides,
  });

/** A request carrying whatever cookie a previous step handed back. */
const requestWith = (cookie) => ({
  headers: { cookie: cookie ? cookie.split(';')[0] : '' },
});

let counter = 0;
const uniqueKey = () => `client-${(counter += 1)}`;

describe('signUp', () => {
  it('puts a new account in the university that owns the email domain', async () => {
    const uni = await seedUniversity({ emailDomain: 'cam.ac.uk' });
    const { user } = await accountService.signUp(
      { name: 'Ada', email: 'ada@cam.ac.uk', password: PASSWORD },
      uniqueKey(),
    );

    assert.equal(user.university.id, uni.id);
    assert.equal(user.role, 'student');
  });

  it('refuses an email domain no university owns', async () => {
    await seedUniversity({ emailDomain: 'cam.ac.uk' });
    await assert.rejects(
      () =>
        accountService.signUp(
          { name: 'Ada', email: 'ada@gmail.com', password: PASSWORD },
          uniqueKey(),
        ),
      /does not belong to a university/i,
    );
  });

  it('grants faculty when the staff code matches', async () => {
    await seedUniversity({ facultySignupCode: 'STAFF-2026' });
    const { user } = await accountService.signUp(
      { name: 'Alan', email: 'alan@test.edu', password: PASSWORD, facultyCode: 'STAFF-2026' },
      uniqueKey(),
    );
    assert.equal(user.role, 'faculty');
  });

  it('rejects a wrong staff code rather than silently making a student', async () => {
    await seedUniversity({ facultySignupCode: 'STAFF-2026' });
    await assert.rejects(
      () =>
        accountService.signUp(
          { name: 'Eve', email: 'eve@test.edu', password: PASSWORD, facultyCode: 'GUESS' },
          uniqueKey(),
        ),
      /staff code is not right/i,
    );
  });

  it('does not match an empty staff code against a university that has none', async () => {
    await seedUniversity({ facultySignupCode: null });

    const { user } = await accountService.signUp(
      { name: 'Eve', email: 'eve@test.edu', password: PASSWORD, facultyCode: '' },
      uniqueKey(),
    );
    assert.equal(user.role, 'student');
  });

  it('refuses a staff code at a university that has none set', async () => {
    await seedUniversity({ facultySignupCode: null });
    await assert.rejects(
      () =>
        accountService.signUp(
          { name: 'Eve', email: 'eve@test.edu', password: PASSWORD, facultyCode: 'ANYTHING' },
          uniqueKey(),
        ),
      /staff code is not right/i,
    );
  });

  it('refuses a second account for the same email in one university', async () => {
    await seedUniversity();
    const signUp = () =>
      accountService.signUp(
        { name: 'Ada', email: 'ada@test.edu', password: PASSWORD },
        uniqueKey(),
      );

    await signUp();
    await assert.rejects(signUp, /already exists/i);
  });

  it('refuses a password that is too short', async () => {
    await seedUniversity();
    await assert.rejects(
      () =>
        accountService.signUp(
          { name: 'Ada', email: 'ada@test.edu', password: 'short' },
          uniqueKey(),
        ),
      /at least 10 characters/i,
    );
  });

  it('issues a pending session, not an active one', async () => {
    await seedUniversity();
    const { cookie } = await accountService.signUp(
      { name: 'Ada', email: 'ada@test.edu', password: PASSWORD },
      uniqueKey(),
    );

    assert.equal(await accountService.currentUser(requestWith(cookie)), null);
  });
});

describe('signIn', () => {
  beforeEach(async () => {
    await seedUniversity();
    await accountService.signUp(
      { name: 'Ada', email: 'ada@test.edu', password: PASSWORD },
      uniqueKey(),
    );
  });

  it('accepts the right password and asks for the second factor', async () => {
    const result = await accountService.signIn(
      { email: 'ada@test.edu', password: PASSWORD },
      uniqueKey(),
    );
    assert.equal(result.needsEnrolment, true);
    assert.ok(result.cookie);
  });

  it('gives the same message for a wrong password and an unknown address', async () => {
    const wrongPassword = await accountService
      .signIn({ email: 'ada@test.edu', password: 'nope-nope-nope' }, uniqueKey())
      .catch((error) => error.message);

    const unknownAccount = await accountService
      .signIn({ email: 'nobody@test.edu', password: PASSWORD }, uniqueKey())
      .catch((error) => error.message);

    const unknownUniversity = await accountService
      .signIn({ email: 'nobody@elsewhere.edu', password: PASSWORD }, uniqueKey())
      .catch((error) => error.message);

    assert.equal(wrongPassword, unknownAccount);
    assert.equal(unknownAccount, unknownUniversity);
  });
});

describe('two-factor enrolment', () => {
  it('activates with a real code and then signs in properly', async () => {
    await seedUniversity();
    const signUp = await accountService.signUp(
      { name: 'Ada', email: 'ada@test.edu', password: PASSWORD },
      uniqueKey(),
    );

    const stored = await userRepository.findByEmail(
      (await universityRepository.findByEmailDomain('test.edu')).id,
      'ada@test.edu',
    );

    const activation = await accountService.activateTwoFactor(
      requestWith(signUp.cookie),
      generateTotp(stored.totpSecret),
      uniqueKey(),
    );

    assert.equal(activation.recoveryCodes.length, 8);

    // The cookie handed back is active, so protected routes now open.
    const signedIn = await accountService.currentUser(requestWith(activation.cookie));
    assert.equal(signedIn.email, 'ada@test.edu');
  });

  it('lets a recovery code stand in for the authenticator, once', async () => {
    await seedUniversity();
    const signUp = await accountService.signUp(
      { name: 'Ada', email: 'ada@test.edu', password: PASSWORD },
      uniqueKey(),
    );
    const uni = await universityRepository.findByEmailDomain('test.edu');
    const stored = await userRepository.findByEmail(uni.id, 'ada@test.edu');

    const { recoveryCodes } = await accountService.activateTwoFactor(
      requestWith(signUp.cookie),
      generateTotp(stored.totpSecret),
      uniqueKey(),
    );

    const pending = await accountService.signIn(
      { email: 'ada@test.edu', password: PASSWORD },
      uniqueKey(),
    );

    const used = await accountService.verifySecondFactor(
      requestWith(pending.cookie),
      recoveryCodes[0],
      uniqueKey(),
    );
    assert.equal(used.usedRecoveryCode, true);
    assert.equal(used.remaining, 7);

    // The same code a second time is refused.
    const pendingAgain = await accountService.signIn(
      { email: 'ada@test.edu', password: PASSWORD },
      uniqueKey(),
    );
    await assert.rejects(
      () =>
        accountService.verifySecondFactor(
          requestWith(pendingAgain.cookie),
          recoveryCodes[0],
          uniqueKey(),
        ),
      /not right/i,
    );
  });
});

describe('requireFaculty', () => {
  it('lets faculty through and turns a student away', async () => {
    await seedUniversity({ facultySignupCode: 'STAFF' });

    const asActive = async (email, facultyCode) => {
      const signUp = await accountService.signUp(
        { name: 'Person', email, password: PASSWORD, ...(facultyCode ? { facultyCode } : {}) },
        uniqueKey(),
      );
      const uni = await universityRepository.findByEmailDomain('test.edu');
      const stored = await userRepository.findByEmail(uni.id, email);
      const { cookie } = await accountService.activateTwoFactor(
        requestWith(signUp.cookie),
        generateTotp(stored.totpSecret),
        uniqueKey(),
      );
      return requestWith(cookie);
    };

    const teacher = await asActive('teacher@test.edu', 'STAFF');
    const student = await asActive('student@test.edu');

    assert.ok(await accountService.requireFaculty(teacher));
    await assert.rejects(() => accountService.requireFaculty(student), /teaching staff/i);
  });
});
