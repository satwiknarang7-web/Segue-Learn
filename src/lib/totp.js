/**
 * Time-based one-time passwords (RFC 6238) and the base32 alphabet they use
 * (RFC 4648), implemented on node:crypto alone.
 *
 * This is what pairs SegueQuiz with Google Authenticator, 1Password, Authy or
 * any other standard authenticator app.
 */

import crypto from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const DIGITS = 6;
const PERIOD_SECONDS = 30;

/** Number of periods either side of "now" that are still accepted. */
const DRIFT_WINDOW = 1;

export function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];

  return output;
}

export function base32Decode(input) {
  const cleaned = String(input).toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const bytes = [];

  for (const character of cleaned) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index === -1) throw new Error('Invalid base32 character.');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** A fresh 160-bit shared secret, in the base32 form authenticator apps expect. */
export function createTotpSecret() {
  return base32Encode(crypto.randomBytes(20));
}

/** HMAC-based one-time password for a specific counter value. */
function hotp(secret, counter) {
  const counterBytes = Buffer.alloc(8);
  counterBytes.writeBigUInt64BE(BigInt(counter));

  const digest = crypto.createHmac('sha1', base32Decode(secret)).update(counterBytes).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) |
    digest[offset + 3];

  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

export function generateTotp(secret, atMs = Date.now()) {
  return hotp(secret, Math.floor(atMs / 1000 / PERIOD_SECONDS));
}

/**
 * Check a code against the current period and one period either side, which
 * absorbs clock drift between the phone and this machine.
 */
export function verifyTotp(secret, candidate, atMs = Date.now()) {
  const cleaned = String(candidate ?? '').replace(/\D/g, '');
  if (cleaned.length !== DIGITS) return false;

  const counter = Math.floor(atMs / 1000 / PERIOD_SECONDS);
  for (let drift = -DRIFT_WINDOW; drift <= DRIFT_WINDOW; drift += 1) {
    const expected = hotp(secret, counter + drift);
    // Same length by construction, so a timing-safe compare is straightforward.
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(cleaned))) return true;
  }
  return false;
}

/** The otpauth:// URI that an authenticator app scans. */
export function buildOtpauthUri({ secret, account, issuer }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** Group the secret into readable blocks for people typing it in by hand. */
export function formatSecretForDisplay(secret) {
  return secret.replace(/(.{4})/g, '$1 ').trim();
}
