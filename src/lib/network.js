import os from 'node:os';

const PRIVATE_RANGES = [
  /^192\.168\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
];

/**
 * Best-effort detection of the machine's LAN IPv4 address.
 * QR codes must point at an address a phone on the same Wi-Fi can reach,
 * so `localhost` is never a useful answer here.
 */
export function detectLanAddress() {
  const candidates = [];

  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal) continue;
      candidates.push({ name, address: address.address });
    }
  }

  const preferred = candidates.find((candidate) =>
    PRIVATE_RANGES.some((range) => range.test(candidate.address)),
  );

  return (preferred ?? candidates[0])?.address ?? null;
}
