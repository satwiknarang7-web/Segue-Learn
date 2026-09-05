/**
 * What an uploaded file actually is.
 *
 * The browser sends a content type, and a person can send whatever they like.
 * Nothing here trusts it: the type is read from the first bytes of the file,
 * and a file whose bytes do not match a format on the list is refused. That is
 * what stops a script being stored and later served back as an image.
 */

const SIGNATURES = [
  {
    type: 'image/png',
    extension: 'png',
    // PNG's signature includes CRLF and EOF bytes precisely so that a transfer
    // which mangles line endings is detectable.
    bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  },
  { type: 'image/jpeg', extension: 'jpg', bytes: [0xff, 0xd8, 0xff] },
  { type: 'image/gif', extension: 'gif', bytes: [0x47, 0x49, 0x46, 0x38] },
];

const startsWith = (buffer, bytes) =>
  buffer.length >= bytes.length && bytes.every((byte, index) => buffer[index] === byte);

/** WebP is RIFF....WEBP, so the marker sits after a four byte length. */
function isWebp(buffer) {
  return (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  );
}

/**
 * The format of `buffer`, or null if it is not one this accepts.
 * SVG is deliberately absent: it is a document that can carry script, and
 * serving one from our own origin would hand it our cookies.
 */
export function detectImageType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;

  for (const signature of SIGNATURES) {
    if (startsWith(buffer, signature.bytes)) {
      return { type: signature.type, extension: signature.extension };
    }
  }

  if (isWebp(buffer)) return { type: 'image/webp', extension: 'webp' };

  return null;
}

export const ACCEPTED_IMAGE_TYPES = [...SIGNATURES.map((s) => s.type), 'image/webp'];
