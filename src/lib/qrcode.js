/**
 * Minimal, dependency-free QR Code encoder (ISO/IEC 18004).
 *
 * Scope is deliberately narrow because SegueQuiz only ever encodes short join
 * URLs: byte mode, versions 1-10, all four error-correction levels. That is
 * roughly 200 characters at level M - far more than a LAN URL needs.
 */

import zlib from 'node:zlib';

const MAX_VERSION = 10;

// Format-information bits for each error correction level.
const EC_FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 };

// [error correction codewords per block, number of blocks] indexed by version.
const EC_SPECS = {
  L: [null, [7, 1], [10, 1], [15, 1], [20, 1], [26, 1], [18, 2], [20, 2], [24, 2], [30, 2], [18, 4]],
  M: [null, [10, 1], [16, 1], [26, 1], [18, 2], [24, 2], [16, 4], [18, 4], [22, 4], [22, 5], [26, 5]],
  Q: [null, [13, 1], [22, 1], [18, 2], [26, 2], [18, 4], [24, 4], [18, 6], [22, 6], [20, 8], [24, 8]],
  H: [null, [17, 1], [28, 1], [22, 2], [16, 4], [22, 4], [28, 4], [26, 5], [26, 6], [24, 8], [28, 8]],
};

// Total codewords (data + error correction) per version.
const TOTAL_CODEWORDS = [null, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346];

// Row/column centres of the alignment patterns per version.
const ALIGNMENT_CENTRES = [
  null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
  [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
];

const PAD_BYTES = [0xec, 0x11];

/* ------------------------------------------------------------------ *
 * GF(256) arithmetic for Reed-Solomon error correction
 * ------------------------------------------------------------------ */

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);

(function initGaloisField() {
  let value = 1;
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = value;
    GF_LOG[value] = i;
    value <<= 1;
    if (value & 0x100) value ^= 0x11d; // primitive polynomial x^8 + x^4 + x^3 + x^2 + 1
  }
  for (let i = 255; i < 512; i += 1) GF_EXP[i] = GF_EXP[i - 255];
})();

function gfMultiply(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

/** Coefficients of the Reed-Solomon divisor polynomial of the given degree. */
function reedSolomonDivisor(degree) {
  const result = new Uint8Array(degree);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < degree; j += 1) {
      result[j] = gfMultiply(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

/** Error-correction codewords for one data block. */
function reedSolomonRemainder(data, divisor) {
  const result = new Uint8Array(divisor.length);
  for (const byte of data) {
    const factor = byte ^ result[0];
    result.copyWithin(0, 1);
    result[result.length - 1] = 0;
    for (let i = 0; i < result.length; i += 1) {
      result[i] ^= gfMultiply(divisor[i], factor);
    }
  }
  return result;
}

/* ------------------------------------------------------------------ *
 * Bit-level helpers
 * ------------------------------------------------------------------ */

class BitBuffer {
  constructor() {
    this.bits = [];
  }

  push(value, length) {
    for (let i = length - 1; i >= 0; i -= 1) {
      this.bits.push((value >>> i) & 1);
    }
  }

  get length() {
    return this.bits.length;
  }

  toBytes() {
    const bytes = new Uint8Array(Math.ceil(this.bits.length / 8));
    this.bits.forEach((bit, index) => {
      if (bit) bytes[index >>> 3] |= 0x80 >>> (index & 7);
    });
    return bytes;
  }
}

const getBit = (value, index) => ((value >>> index) & 1) !== 0;

function dataCodewordCount(version, ecLevel) {
  const [ecPerBlock, blocks] = EC_SPECS[ecLevel][version];
  return TOTAL_CODEWORDS[version] - ecPerBlock * blocks;
}

const characterCountBits = (version) => (version <= 9 ? 8 : 16);

function chooseVersion(byteLength, ecLevel, minVersion) {
  for (let version = Math.max(1, minVersion); version <= MAX_VERSION; version += 1) {
    const capacityBits = dataCodewordCount(version, ecLevel) * 8;
    const requiredBits = 4 + characterCountBits(version) + byteLength * 8;
    if (requiredBits <= capacityBits) return version;
  }
  throw new Error(
    `Content is too long for a QR code (${byteLength} bytes at level ${ecLevel}; max version ${MAX_VERSION}).`,
  );
}

/* ------------------------------------------------------------------ *
 * Codeword assembly
 * ------------------------------------------------------------------ */

function encodeData(bytes, version, ecLevel) {
  const capacityBits = dataCodewordCount(version, ecLevel) * 8;
  const buffer = new BitBuffer();

  buffer.push(0b0100, 4); // byte mode
  buffer.push(bytes.length, characterCountBits(version));
  for (const byte of bytes) buffer.push(byte, 8);

  // Terminator, then pad to a byte boundary, then alternating pad bytes.
  buffer.push(0, Math.min(4, capacityBits - buffer.length));
  buffer.push(0, (8 - (buffer.length % 8)) % 8);

  const codewords = Array.from(buffer.toBytes());
  for (let i = 0; codewords.length * 8 < capacityBits; i += 1) {
    codewords.push(PAD_BYTES[i % PAD_BYTES.length]);
  }
  return codewords;
}

/** Split into blocks, add error correction, then interleave as the spec requires. */
function addErrorCorrection(codewords, version, ecLevel) {
  const [ecPerBlock, blockCount] = EC_SPECS[ecLevel][version];
  const totalData = dataCodewordCount(version, ecLevel);
  const shortBlockLength = Math.floor(totalData / blockCount);
  const longBlockCount = totalData % blockCount;

  const dataBlocks = [];
  const ecBlocks = [];
  const divisor = reedSolomonDivisor(ecPerBlock);

  let offset = 0;
  for (let i = 0; i < blockCount; i += 1) {
    const length = shortBlockLength + (i >= blockCount - longBlockCount ? 1 : 0);
    const block = codewords.slice(offset, offset + length);
    offset += length;
    dataBlocks.push(block);
    ecBlocks.push(reedSolomonRemainder(block, divisor));
  }

  const result = [];
  for (let i = 0; i < shortBlockLength + 1; i += 1) {
    for (const block of dataBlocks) {
      if (i < block.length) result.push(block[i]);
    }
  }
  for (let i = 0; i < ecPerBlock; i += 1) {
    for (const block of ecBlocks) result.push(block[i]);
  }
  return result;
}

/* ------------------------------------------------------------------ *
 * Module placement
 * ------------------------------------------------------------------ */

const MASK_FUNCTIONS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

class Matrix {
  constructor(version, ecLevel) {
    this.version = version;
    this.ecLevel = ecLevel;
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
    this.reserved = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
  }

  setFunctionModule(x, y, isDark) {
    this.modules[y][x] = isDark;
    this.reserved[y][x] = true;
  }

  drawFunctionPatterns() {
    const { size } = this;

    for (let i = 0; i < size; i += 1) {
      this.setFunctionModule(6, i, i % 2 === 0);
      this.setFunctionModule(i, 6, i % 2 === 0);
    }

    this.drawFinderPattern(3, 3);
    this.drawFinderPattern(size - 4, 3);
    this.drawFinderPattern(3, size - 4);

    const centres = ALIGNMENT_CENTRES[this.version];
    const last = centres.length - 1;
    for (let i = 0; i <= last; i += 1) {
      for (let j = 0; j <= last; j += 1) {
        const isFinderCorner =
          (i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0);
        if (isFinderCorner) continue;
        this.drawAlignmentPattern(centres[i], centres[j]);
      }
    }

    this.drawFormatBits(0); // real bits are written once the mask is chosen
    this.drawVersionBits();
  }

  drawFinderPattern(centreX, centreY) {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const x = centreX + dx;
        const y = centreY + dy;
        if (x < 0 || x >= this.size || y < 0 || y >= this.size) continue;
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        this.setFunctionModule(x, y, distance !== 2 && distance !== 4);
      }
    }
  }

  drawAlignmentPattern(centreX, centreY) {
    for (let dy = -2; dy <= 2; dy += 1) {
      for (let dx = -2; dx <= 2; dx += 1) {
        this.setFunctionModule(
          centreX + dx,
          centreY + dy,
          Math.max(Math.abs(dx), Math.abs(dy)) !== 1,
        );
      }
    }
  }

  drawFormatBits(mask) {
    const data = (EC_FORMAT_BITS[this.ecLevel] << 3) | mask;
    let remainder = data;
    for (let i = 0; i < 10; i += 1) {
      remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
    }
    const bits = ((data << 10) | remainder) ^ 0x5412;
    const { size } = this;

    for (let i = 0; i <= 5; i += 1) this.setFunctionModule(8, i, getBit(bits, i));
    this.setFunctionModule(8, 7, getBit(bits, 6));
    this.setFunctionModule(8, 8, getBit(bits, 7));
    this.setFunctionModule(7, 8, getBit(bits, 8));
    for (let i = 9; i < 15; i += 1) this.setFunctionModule(14 - i, 8, getBit(bits, i));

    for (let i = 0; i < 8; i += 1) this.setFunctionModule(size - 1 - i, 8, getBit(bits, i));
    for (let i = 8; i < 15; i += 1) this.setFunctionModule(8, size - 15 + i, getBit(bits, i));
    this.setFunctionModule(8, size - 8, true); // always-dark module
  }

  drawVersionBits() {
    if (this.version < 7) return;
    let remainder = this.version;
    for (let i = 0; i < 12; i += 1) {
      remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
    }
    const bits = (this.version << 12) | remainder;

    for (let i = 0; i < 18; i += 1) {
      const bit = getBit(bits, i);
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.setFunctionModule(a, b, bit);
      this.setFunctionModule(b, a, bit);
    }
  }

  /** Walk the two-module-wide zigzag from the bottom-right corner. */
  drawCodewords(codewords) {
    const { size } = this;
    let bitIndex = 0;

    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5; // the vertical timing pattern is skipped
      for (let vertical = 0; vertical < size; vertical += 1) {
        for (let column = 0; column < 2; column += 1) {
          const x = right - column;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vertical : vertical;
          if (this.reserved[y][x] || bitIndex >= codewords.length * 8) continue;
          this.modules[y][x] = getBit(codewords[bitIndex >>> 3], 7 - (bitIndex & 7));
          bitIndex += 1;
        }
      }
    }
  }

  applyMask(mask) {
    const shouldFlip = MASK_FUNCTIONS[mask];
    for (let y = 0; y < this.size; y += 1) {
      for (let x = 0; x < this.size; x += 1) {
        if (this.reserved[y][x]) continue;
        if (shouldFlip(x, y)) this.modules[y][x] = !this.modules[y][x];
      }
    }
  }

  /** Try every mask and keep the one with the lowest penalty score. */
  selectBestMask() {
    let bestMask = 0;
    let bestPenalty = Infinity;

    for (let mask = 0; mask < 8; mask += 1) {
      this.applyMask(mask);
      this.drawFormatBits(mask);
      const penalty = this.penaltyScore();
      this.applyMask(mask); // XOR a second time to undo
      if (penalty < bestPenalty) {
        bestPenalty = penalty;
        bestMask = mask;
      }
    }

    this.applyMask(bestMask);
    this.drawFormatBits(bestMask);
    return bestMask;
  }

  penaltyScore() {
    const { size, modules } = this;
    let penalty = 0;

    const finderLike = [true, false, true, true, true, false, true, false, false, false, false];
    const finderLikeReversed = [...finderLike].reverse();
    const matchesAt = (line, start, pattern) =>
      pattern.every((value, index) => line[start + index] === value);

    const scoreLine = (line) => {
      let runLength = 1;
      for (let i = 1; i < size; i += 1) {
        if (line[i] === line[i - 1]) {
          runLength += 1;
          if (runLength === 5) penalty += 3;
          else if (runLength > 5) penalty += 1;
        } else {
          runLength = 1;
        }
      }
      for (let i = 0; i + finderLike.length <= size; i += 1) {
        if (matchesAt(line, i, finderLike) || matchesAt(line, i, finderLikeReversed)) {
          penalty += 40;
        }
      }
    };

    for (let y = 0; y < size; y += 1) scoreLine(modules[y]);
    for (let x = 0; x < size; x += 1) scoreLine(modules.map((row) => row[x]));

    for (let y = 0; y < size - 1; y += 1) {
      for (let x = 0; x < size - 1; x += 1) {
        const value = modules[y][x];
        if (
          value === modules[y][x + 1] &&
          value === modules[y + 1][x] &&
          value === modules[y + 1][x + 1]
        ) {
          penalty += 3;
        }
      }
    }

    const dark = modules.flat().filter(Boolean).length;
    const total = size * size;
    const fivePercentSteps = Math.floor((Math.abs(dark * 20 - total * 10) * 10) / total / 5);
    penalty += fivePercentSteps * 10;

    return penalty;
  }
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

/**
 * Encode text as a QR code matrix.
 * @returns {{ size: number, version: number, ecLevel: string, mask: number, modules: boolean[][] }}
 */
export function createQrCode(text, { ecLevel = 'M', minVersion = 1 } = {}) {
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error('QR code content must be a non-empty string.');
  }
  if (!EC_SPECS[ecLevel]) {
    throw new Error(`Unknown error correction level "${ecLevel}". Use L, M, Q or H.`);
  }

  const bytes = Buffer.from(text, 'utf8');
  const version = chooseVersion(bytes.length, ecLevel, minVersion);
  const codewords = addErrorCorrection(encodeData(bytes, version, ecLevel), version, ecLevel);

  const matrix = new Matrix(version, ecLevel);
  matrix.drawFunctionPatterns();
  matrix.drawCodewords(codewords);
  const mask = matrix.selectBestMask();

  return {
    size: matrix.size,
    version,
    ecLevel,
    mask,
    modules: matrix.modules,
  };
}

/** Render a QR code as a standalone SVG document. */
export function renderQrSvg(text, options = {}) {
  const { margin = 4, dark = '#0f172a', light = '#ffffff', size: pixelSize = 320, ...rest } = options;
  const qr = createQrCode(text, rest);
  const modulesAcross = qr.size + margin * 2;

  // Merge horizontal runs of dark modules into single path commands.
  const parts = [];
  for (let y = 0; y < qr.size; y += 1) {
    let runStart = -1;
    for (let x = 0; x <= qr.size; x += 1) {
      const isDark = x < qr.size && qr.modules[y][x];
      if (isDark && runStart === -1) runStart = x;
      if (!isDark && runStart !== -1) {
        const width = x - runStart;
        parts.push(`M${runStart + margin} ${y + margin}h${width}v1h-${width}z`);
        runStart = -1;
      }
    }
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${pixelSize}" height="${pixelSize}"`,
    ` viewBox="0 0 ${modulesAcross} ${modulesAcross}" shape-rendering="crispEdges">`,
    `<rect width="100%" height="100%" fill="${light}"/>`,
    `<path fill="${dark}" d="${parts.join('')}"/>`,
    '</svg>',
  ].join('');
}

/* ---- PNG output, written by hand to avoid a dependency ---- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, checksum]);
}

/** Render a QR code as an 8-bit grayscale PNG buffer. */
export function renderQrPng(text, options = {}) {
  const { scale = 10, margin = 4, ...rest } = options;
  const qr = createQrCode(text, rest);
  const dimension = (qr.size + margin * 2) * scale;

  // Each row is one filter byte (0 = no filter) followed by one byte per pixel.
  const raw = Buffer.alloc(dimension * (dimension + 1));
  for (let y = 0; y < dimension; y += 1) {
    const rowStart = y * (dimension + 1);
    raw[rowStart] = 0;
    const moduleY = Math.floor(y / scale) - margin;
    for (let x = 0; x < dimension; x += 1) {
      const moduleX = Math.floor(x / scale) - margin;
      const isDark =
        moduleY >= 0 &&
        moduleY < qr.size &&
        moduleX >= 0 &&
        moduleX < qr.size &&
        qr.modules[moduleY][moduleX];
      raw[rowStart + 1 + x] = isDark ? 0x00 : 0xff;
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(dimension, 0);
  header.writeUInt32BE(dimension, 4);
  header[8] = 8; // bit depth
  header[9] = 0; // colour type: grayscale
  header[10] = 0; // compression: deflate
  header[11] = 0; // filter method
  header[12] = 0; // no interlacing

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
