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
});

const PORT_MIN = CONFIG.portBase;
const PORT_MAX = CONFIG.portBase + POOL_SIZE - 1;
// Port served for the apex / www domain (defaults to the base of the window).
const DEFAULT_PORT = intEnv('DEFAULT_PORT', CONFIG.portBase);

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

  // Friendly name (e.g. panggung-biru.example.com).
  const port = portForName(sub, CONFIG.portBase);
  return port !== null && inWindow(port) ? port : null;
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
