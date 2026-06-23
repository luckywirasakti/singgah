/**
 * singgah — deterministic tunnel naming.
 *
 * A pure, bijective mapping between a tunnel port and a friendly subdomain
 * name, shared by the proxy (server) and the CLI (client) so neither needs a
 * stored file or a network round-trip to agree on names.
 *
 *   port → name :  nameForPort(9000) === 'panggung-biru'
 *   name → port :  portForName('panggung-biru') === 9000
 *
 * Names are generated from a fixed noun×adjective matrix. POOL_SIZE distinct
 * names exist; that bounds how many ports can be addressed by name, which also
 * acts as a security allowlist — only ports in [base, base + POOL_SIZE) are ever
 * reachable through the proxy, so crafted subdomains can't reach arbitrary
 * local services (ssh, databases, …).
 */

/** Places you might "singgah" (stop by). */
const NOUNS = [
  'panggung', 'dapur', 'loteng', 'gudang', 'taman', 'pelabuhan', 'mercusuar',
  'genting', 'halaman', 'balkon', 'pantai', 'teras', 'beranda', 'serambi',
  'lorong', 'tangga',
];

/** Moods / colours. */
const ADJECTIVES = [
  'biru', 'hijau', 'jingga', 'senja', 'pagi', 'hangat', 'sunyi', 'riang',
  'teduh', 'cerah', 'lembut', 'kelabu', 'emas', 'embun', 'badai', 'fajar',
];

/** Total number of distinct names = the size of the addressable port window. */
export const POOL_SIZE = NOUNS.length * ADJECTIVES.length;

export const DEFAULT_BASE = 9000;

/**
 * @param {number} port
 * @param {number} [base]
 * @returns {string | null} the subdomain name, or null if the port is out of range.
 */
export function nameForPort(port, base = DEFAULT_BASE) {
  const idx = port - base;
  if (!Number.isInteger(idx) || idx < 0 || idx >= POOL_SIZE) return null;
  const noun = NOUNS[Math.floor(idx / ADJECTIVES.length)];
  const adjective = ADJECTIVES[idx % ADJECTIVES.length];
  return `${noun}-${adjective}`;
}

/**
 * @param {string} name
 * @param {number} [base]
 * @returns {number | null} the tunnel port, or null if the name isn't a valid pair.
 */
export function portForName(name, base = DEFAULT_BASE) {
  const dash = name.indexOf('-');
  if (dash < 0) return null;
  const nounIdx = NOUNS.indexOf(name.slice(0, dash));
  const adjIdx = ADJECTIVES.indexOf(name.slice(dash + 1));
  if (nounIdx < 0 || adjIdx < 0) return null;
  return base + nounIdx * ADJECTIVES.length + adjIdx;
}

// ── CLI entry point ──
// Used by the bash client so it shares this exact logic:
//   node names.mjs <port> [base]   → prints the name (exit 1 if out of range)
//   node names.mjs --size          → prints POOL_SIZE
import { pathToFileURL } from 'node:url';

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const arg = process.argv[2];
  if (arg === '--size') {
    process.stdout.write(`${POOL_SIZE}\n`);
    process.exit(0);
  }
  const port = Number(arg);
  const base = process.argv[3] ? Number(process.argv[3]) : DEFAULT_BASE;
  const name = nameForPort(port, base);
  if (name === null) process.exit(1);
  process.stdout.write(`${name}\n`);
  process.exit(0);
}
