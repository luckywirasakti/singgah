#!/usr/bin/env node
/**
 * singgah — dynamic reverse-tunnel proxy
 *
 * Routes inbound HTTP requests to local SSH reverse-tunnel ports based on the
 * Host header, and falls back to serving the built Vite site when no live
 * tunnel matches.
 *
 *   root / www            → DEFAULT_PORT
 *   <9000-9015>.<domain>  → that numeric tunnel port
 *   <name>.<domain>       → port resolved from NAMES_FILE
 *
 * Configuration is supplied entirely through the environment (see .env.example).
 * No hostnames, domains or IPs are hard-coded.
 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';

// Load .env from the working directory if present (Node >=20.12).
try {
  if (typeof process.loadEnvFile === 'function') process.loadEnvFile();
} catch {
  /* no .env file — rely on the ambient environment */
}

// ──────────────────────────────────────────────────────────────────────────
// Configuration
// ──────────────────────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    console.error(`[config] missing required environment variable: ${name}`);
    console.error('[config] copy .env.example to .env and fill it in');
    process.exit(1);
  }
  return value.trim();
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) {
    console.error(`[config] ${name} must be an integer, got: ${raw}`);
    process.exit(1);
  }
  return n;
}

// Built JS lives in dist-server/; the Vite site is built to dist/ one level up.
const ROOT = path.resolve(import.meta.dirname, '..');

const CONFIG = Object.freeze({
  port: intEnv('PROXY_PORT', 3000),
  bindHost: process.env.BIND_HOST || '0.0.0.0',
  staticDir: path.resolve(process.env.STATIC_DIR || path.join(ROOT, 'dist')),
  domain: requireEnv('DOMAIN'),
  tunnelMin: intEnv('TUNNEL_MIN', 9000),
  tunnelMax: intEnv('TUNNEL_MAX', 9015),
  defaultPort: intEnv('DEFAULT_PORT', 9000),
  namesFile: path.resolve(process.env.NAMES_FILE || path.join(ROOT, 'tunnel-names.json')),
  tunnelHost: process.env.TUNNEL_HOST || '127.0.0.1',
  scanIntervalMs: intEnv('SCAN_INTERVAL_MS', 2000),
  scanTimeoutMs: intEnv('SCAN_TIMEOUT_MS', 500),
  proxyTimeoutMs: intEnv('PROXY_TIMEOUT_MS', 30000),
});

if (CONFIG.tunnelMin > CONFIG.tunnelMax) {
  console.error('[config] TUNNEL_MIN must be <= TUNNEL_MAX');
  process.exit(1);
}

const MIME_TYPES: Record<string, string> = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
  '.pdf': 'application/pdf',
});

// Hop-by-hop headers must not be forwarded by a proxy (RFC 7230 §6.1).
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

// ──────────────────────────────────────────────────────────────────────────
// Logging
// ──────────────────────────────────────────────────────────────────────────

type Level = 'info' | 'warn' | 'error';

function log(level: Level, message: string, meta?: Record<string, unknown>): void {
  const line = `${new Date().toISOString()} [${level}] ${message}`;
  const out = meta ? `${line} ${JSON.stringify(meta)}` : line;
  if (level === 'error') console.error(out);
  else console.log(out);
}

// ──────────────────────────────────────────────────────────────────────────
// Name → port mapping (generated from the tunnel range)
// ──────────────────────────────────────────────────────────────────────────

// Ordered pool of friendly subdomain names, themed around places you "singgah".
// The Nth name maps to TUNNEL_MIN + N, so the number of names always tracks the
// configured range. Override the pool with the TUNNEL_NAMES env (comma-separated).
const DEFAULT_NAME_POOL = [
  'panggung', 'dapur', 'loteng', 'gudang', 'taman', 'pelabuhan', 'mercusuar',
  'genting', 'halaman', 'balkon', 'pantai', 'teras', 'beranda', 'serambi',
  'lorong', 'tangga', 'jendela', 'pintu', 'sumur', 'kolam', 'gerbang', 'menara',
  'bukit', 'lembah', 'sungai', 'danau', 'hutan', 'ladang', 'sawah', 'kebun',
];

function buildNamePool(): string[] {
  const raw = process.env.TUNNEL_NAMES;
  if (!raw || !raw.trim()) return DEFAULT_NAME_POOL;
  return raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/** name → port, e.g. { panggung: 9000, dapur: 9001, ... } */
let nameMap: Record<string, number> = Object.create(null);

function buildNames(): void {
  const pool = buildNamePool();
  const slots = CONFIG.tunnelMax - CONFIG.tunnelMin + 1;
  const next: Record<string, number> = Object.create(null);
  for (let i = 0; i < slots; i++) {
    const name = pool[i];
    if (name) next[name] = CONFIG.tunnelMin + i;
  }
  nameMap = next;

  const named = Object.keys(nameMap).length;
  log('info', 'tunnel names generated', { slots, named });
  if (named < slots) {
    log('warn', 'name pool smaller than tunnel range; extra ports are numeric-only', {
      missing: slots - named,
    });
  }
}

// Best-effort: publish the mapping so the singgah-cli client can resolve names
// without a separate source of truth. Failure here is non-fatal.
function writeNamesFile(): void {
  try {
    fs.writeFileSync(CONFIG.namesFile, `${JSON.stringify(nameMap, null, 2)}\n`);
    log('info', 'names file written', { file: CONFIG.namesFile });
  } catch (err) {
    log('warn', 'could not write names file (CLI name resolution may be stale)', {
      file: CONFIG.namesFile,
      error: (err as Error).message,
    });
  }
}

buildNames();
writeNamesFile();

// ──────────────────────────────────────────────────────────────────────────
// Tunnel liveness scanning
// ──────────────────────────────────────────────────────────────────────────

const tunnelAlive = new Set<number>();

function probePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const finish = (alive: boolean) => {
      socket.destroy();
      resolve(alive);
    };
    socket.setTimeout(CONFIG.scanTimeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
    socket.connect(port, CONFIG.tunnelHost);
  });
}

async function scanTunnels(): Promise<void> {
  const ports: number[] = [];
  for (let p = CONFIG.tunnelMin; p <= CONFIG.tunnelMax; p++) ports.push(p);
  const results = await Promise.all(ports.map(probePort));
  ports.forEach((port, i) => {
    if (results[i]) tunnelAlive.add(port);
    else tunnelAlive.delete(port);
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Routing
// ──────────────────────────────────────────────────────────────────────────

/** Resolve a tunnel port from the Host header, or null when no route matches. */
function resolvePort(rawHost: string): number | null {
  if (!rawHost) return CONFIG.defaultPort;
  const host = rawHost.replace(/:\d+$/, '').toLowerCase();

  if (host === CONFIG.domain || host === `www.${CONFIG.domain}`) {
    return CONFIG.defaultPort;
  }

  const suffix = `.${CONFIG.domain}`;
  if (!host.endsWith(suffix)) return null;

  const sub = host.slice(0, -suffix.length);
  const num = Number.parseInt(sub, 10);
  if (String(num) === sub && num >= CONFIG.tunnelMin && num <= CONFIG.tunnelMax) {
    return num;
  }
  return nameMap[sub] ?? null;
}

// ──────────────────────────────────────────────────────────────────────────
// Proxying
// ──────────────────────────────────────────────────────────────────────────

function sanitizeHeaders(headers: http.IncomingHttpHeaders | http.OutgoingHttpHeaders): http.OutgoingHttpHeaders {
  const clean: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined && !HOP_BY_HOP_HEADERS.has(key.toLowerCase())) clean[key] = value;
  }
  return clean;
}

function proxyRequest(req: http.IncomingMessage, res: http.ServerResponse, port: number): void {
  const proxyReq = http.request(
    {
      host: CONFIG.tunnelHost,
      port,
      path: req.url,
      method: req.method,
      headers: sanitizeHeaders(req.headers),
      timeout: CONFIG.proxyTimeoutMs,
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, sanitizeHeaders(proxyRes.headers));
      proxyRes.pipe(res);
    },
  );

  proxyReq.on('timeout', () => proxyReq.destroy(new Error('upstream timeout')));
  proxyReq.on('error', (err) => {
    log('warn', 'proxy upstream error, serving static fallback', { port, error: err.message });
    if (!res.headersSent) void serveStatic(req, res);
  });

  req.on('error', () => proxyReq.destroy());
  req.pipe(proxyReq);
}

// ──────────────────────────────────────────────────────────────────────────
// Static file serving (SPA fallback)
// ──────────────────────────────────────────────────────────────────────────

async function readIndex(res: http.ServerResponse): Promise<void> {
  try {
    const data = await fsp.readFile(path.join(CONFIG.staticDir, 'index.html'));
    res.writeHead(200, { 'Content-Type': MIME_TYPES['.html'] });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  }
}

async function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  // Decode and strip the query string, then resolve safely inside staticDir.
  let pathname: string;
  try {
    pathname = decodeURIComponent((req.url || '/').split('?')[0]);
  } catch {
    pathname = '/';
  }

  const resolved = path.resolve(CONFIG.staticDir, `.${pathname}`);
  const relative = path.relative(CONFIG.staticDir, resolved);

  // Reject path traversal: anything that escapes staticDir falls back to the SPA shell.
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return readIndex(res);
  }

  // No extension → treat as an SPA route and serve index.html.
  if (!path.extname(resolved)) return readIndex(res);

  try {
    const data = await fsp.readFile(resolved);
    const ext = path.extname(resolved).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(data);
  } catch {
    return readIndex(res);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Server
// ──────────────────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const tunnelPort = resolvePort(req.headers.host || '');
  res.setHeader('X-Tunnel-Port', tunnelPort !== null ? String(tunnelPort) : 'none');

  if (tunnelPort !== null && tunnelAlive.has(tunnelPort)) {
    proxyRequest(req, res, tunnelPort);
  } else {
    serveStatic(req, res).catch((err: Error) => {
      log('error', 'static handler failed', { error: err.message });
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Internal Server Error');
      }
    });
  }
});

server.on('clientError', (_err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

let scanTimer: NodeJS.Timeout | null = null;

server.listen(CONFIG.port, CONFIG.bindHost, () => {
  log('info', 'proxy listening', {
    address: `${CONFIG.bindHost}:${CONFIG.port}`,
    domain: CONFIG.domain,
    tunnelRange: `${CONFIG.tunnelMin}-${CONFIG.tunnelMax}`,
    names: Object.keys(nameMap).length,
  });
  scanTunnels().catch((err: Error) => log('error', 'scan failed', { error: err.message }));
  scanTimer = setInterval(() => {
    scanTunnels().catch((err: Error) => log('error', 'scan failed', { error: err.message }));
  }, CONFIG.scanIntervalMs);
});

// ──────────────────────────────────────────────────────────────────────────
// Graceful shutdown
// ──────────────────────────────────────────────────────────────────────────

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log('info', 'shutting down', { signal });
  if (scanTimer) clearInterval(scanTimer);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => log('error', 'uncaught exception', { error: err.stack }));
process.on('unhandledRejection', (reason) => log('error', 'unhandled rejection', { reason: String(reason) }));
