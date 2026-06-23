#!/usr/bin/env node
/**
 * singgah — dynamic reverse-tunnel proxy
 *
 * Routes inbound HTTP requests to local SSH reverse-tunnel ports based on the
 * Host header, and falls back to serving the built Vite site when no live
 * tunnel answers.
 *
 *   root / www              → DEFAULT_PORT
 *   <port>.<domain>         → that numeric tunnel port (within the window)
 *   <noun>-<adj>.<domain>   → port derived from the shared name module
 *
 * Names are generated on the fly from a deterministic noun×adjective matrix
 * (see ../shared/names.mjs) shared with the CLI — no file, no scanning. The
 * addressable window [PORT_BASE, PORT_BASE + POOL_SIZE) doubles as a security
 * allowlist so crafted subdomains can't reach arbitrary local services.
 *
 * Configuration is supplied entirely through the environment (see .env.example).
 */

import http from 'node:http';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { nameForPort, portForName, POOL_SIZE, DEFAULT_BASE } from '../shared/names.mjs';
import { Registry } from './registry.ts';

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
  // Base of the addressable tunnel window. The top is derived from the name
  // pool size, so there is no max to configure.
  portBase: intEnv('PORT_BASE', DEFAULT_BASE),
  tunnelHost: process.env.TUNNEL_HOST || '127.0.0.1',
  proxyTimeoutMs: intEnv('PROXY_TIMEOUT_MS', 30000),
  // Shared secret the CLI presents to register/release dynamic names. When
  // empty, the control plane is disabled (dynamic names off) and only the
  // deterministic name↔port matrix and numeric subdomains route.
  registerSecret: (process.env.SINGGAH_SECRET || '').trim(),
  registryFile: path.resolve(process.env.REGISTRY_FILE || path.join(ROOT, 'singgah-registry.json')),
  registryTtlMs: intEnv('REGISTRY_TTL_MS', 24 * 60 * 60 * 1000),
});

const PORT_MIN = CONFIG.portBase;
const PORT_MAX = CONFIG.portBase + POOL_SIZE - 1;
// Port served for the apex / www domain (defaults to the base of the window).
const DEFAULT_PORT = intEnv('DEFAULT_PORT', CONFIG.portBase);

// Dynamic name → port registry (persisted). The CLI populates it at request
// time; resolvePort() consults it before falling back to the static matrix.
const registry = new Registry(CONFIG.registryFile, CONFIG.registryTtlMs);
setInterval(() => registry.sweep(), 60_000).unref();

// Names accepted from the control plane: lowercase letters/digits/hyphens, no
// dots — so a registered "name" can never smuggle an extra host label.
const NAME_RE = /^[a-z][a-z0-9-]{0,40}$/;

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
// Routing
// ──────────────────────────────────────────────────────────────────────────

const inWindow = (port: number): boolean => port >= PORT_MIN && port <= PORT_MAX;

/** Resolve a tunnel port from the Host header, or null when no route matches. */
function resolvePort(rawHost: string): number | null {
  if (!rawHost) return DEFAULT_PORT;
  const host = rawHost.replace(/:\d+$/, '').toLowerCase();

  if (host === CONFIG.domain || host === `www.${CONFIG.domain}`) {
    return DEFAULT_PORT;
  }

  const suffix = `.${CONFIG.domain}`;
  if (!host.endsWith(suffix)) return null;

  const sub = host.slice(0, -suffix.length);

  // Numeric subdomain (e.g. 9000.example.com) — only inside the window.
  const num = Number.parseInt(sub, 10);
  if (String(num) === sub) return inWindow(num) ? num : null;

  // Dynamic name registered by the CLI at request time (e.g. kucing-riang).
  const dynamic = registry.resolve(sub);
  if (dynamic !== null) return inWindow(dynamic) ? dynamic : null;

  // Deterministic name↔port matrix (e.g. panggung-biru.example.com) — still
  // works for anyone relying on the original static naming.
  const port = portForName(sub, CONFIG.portBase);
  return port !== null && inWindow(port) ? port : null;
}

// ──────────────────────────────────────────────────────────────────────────
// Control plane (dynamic name registration)
// ──────────────────────────────────────────────────────────────────────────

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': MIME_TYPES['.json'] });
  res.end(payload);
}

async function readJsonBody(req: http.IncomingMessage, limit = 4096): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (parsed === null || typeof parsed !== 'object') throw new Error('expected a JSON object');
  return parsed as Record<string, unknown>;
}

/** Handle /_singgah/* control requests. Guarded by the shared secret. */
async function handleControl(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!CONFIG.registerSecret) {
    return sendJson(res, 503, { error: 'dynamic names disabled (SINGGAH_SECRET not set on the proxy)' });
  }
  if (req.headers['x-singgah-secret'] !== CONFIG.registerSecret) {
    return sendJson(res, 401, { error: 'unauthorized' });
  }

  const route = (req.url || '').split('?')[0];

  if (req.method === 'GET' && route === '/_singgah/list') {
    return sendJson(res, 200, { tunnels: registry.list() });
  }

  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: 'method not allowed' });
  }

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return sendJson(res, 400, { error: (err as Error).message });
  }

  const name = String(body.name ?? '').toLowerCase();
  if (!NAME_RE.test(name)) {
    return sendJson(res, 400, { error: 'invalid name (expected lowercase noun-adj)' });
  }

  if (route === '/_singgah/register') {
    const port = Number(body.port);
    if (!Number.isInteger(port) || !inWindow(port)) {
      return sendJson(res, 400, { error: `port out of window ${PORT_MIN}-${PORT_MAX}` });
    }
    if (!registry.register(name, port)) {
      return sendJson(res, 409, { error: 'name already in use' });
    }
    log('info', 'registered dynamic name', { name, port });
    return sendJson(res, 200, { name, port, host: `${name}.${CONFIG.domain}` });
  }

  if (route === '/_singgah/release') {
    registry.release(name);
    log('info', 'released dynamic name', { name });
    return sendJson(res, 200, { released: name });
  }

  return sendJson(res, 404, { error: 'unknown control route' });
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

// We don't pre-scan tunnels; we attempt the upstream and fall back to the static
// site if nothing is listening. On localhost a refused connection is instant.
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
    log('warn', 'no live tunnel, serving static fallback', { port, error: err.message });
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
  // Control plane is addressed by path, independent of Host, so it works even
  // when hit through the apex domain (which would otherwise route to a tunnel).
  if ((req.url || '').startsWith('/_singgah/')) {
    handleControl(req, res).catch((err: Error) => {
      log('error', 'control handler failed', { error: err.message });
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
    });
    return;
  }

  const tunnelPort = resolvePort(req.headers.host || '');
  res.setHeader('X-Tunnel-Port', tunnelPort !== null ? String(tunnelPort) : 'none');

  if (tunnelPort !== null) {
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

server.listen(CONFIG.port, CONFIG.bindHost, () => {
  log('info', 'proxy listening', {
    address: `${CONFIG.bindHost}:${CONFIG.port}`,
    domain: CONFIG.domain,
    window: `${PORT_MIN}-${PORT_MAX}`,
    names: POOL_SIZE,
    example: `${nameForPort(PORT_MIN, CONFIG.portBase)}.${CONFIG.domain}`,
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Graceful shutdown
// ──────────────────────────────────────────────────────────────────────────

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log('info', 'shutting down', { signal });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => log('error', 'uncaught exception', { error: err.stack }));
process.on('unhandledRejection', (reason) => log('error', 'unhandled rejection', { reason: String(reason) }));
