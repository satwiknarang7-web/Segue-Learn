import { randomBytes, randomUUID } from 'node:crypto';

// Ambiguous characters (0/O, 1/I/L) are excluded so codes stay readable when
// somebody types the join code by hand instead of scanning the QR.
const READABLE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

/** Short, human-typeable identifier used in join URLs (e.g. /take/7HQ4KD). */
export function createJoinCode(length = 6) {
  const bytes = randomBytes(length);
  let code = '';
  for (let i = 0; i < length; i += 1) {
    code += READABLE_ALPHABET[bytes[i] % READABLE_ALPHABET.length];
  }
  return code;
}

/** Opaque identifier for records that are never typed by a human. */
export function createId() {
  return randomUUID();
}
