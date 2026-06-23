# singgah

> _singgah_ (Indonesian): to stop by, to drop in.

Expose any local port to the internet over a plain SSH reverse tunnel — no
third-party tunneling service, no agent to install. A small Node proxy on your
server routes friendly subdomains (`panggung-biru.example.com`) to whichever
local app you've tunneled, and serves a static landing page when nothing is
connected.

```
┌──────────────┐   ssh -R 9001:localhost:5173   ┌──────────────────────────┐
│  your laptop │ ─────────────────────────────▶ │  server                  │
│  :5173 (app) │   (cli/singgah.sh)             │  server/proxy.ts   :3000 │
└──────────────┘                                │   ├─ :9001 ─▶ your app    │
                                                │   └─ static fallback     │
     https://panggung-hijau.example.com ◀───────┤  (behind Nginx/Caddy)    │
                                                └──────────────────────────┘
```

## Project layout

```
src/             frontend landing page (Vite + TypeScript)
server/proxy.ts  the reverse-tunnel proxy (Node, TypeScript)
shared/names.mjs deterministic port ↔ name mapping (used by proxy AND cli)
cli/singgah.sh   the client that opens the SSH tunnel
```

One repo, one toolchain. The frontend builds to `dist/`; the proxy builds to
`dist-server/` and serves `dist/` as its fallback. The proxy and the CLI both
use `shared/names.mjs`, so they always agree on names with no stored state.

## How it works

1. `cli/singgah.sh <port>` opens an SSH reverse tunnel from your machine to a
   tunnel port on the server (e.g. `9001`).
2. The proxy (`server/proxy.ts`) routes inbound HTTP by the `Host` header:
   - `example.com` / `www.example.com` → `DEFAULT_PORT`
   - `9001.example.com` → numeric tunnel port `9001`
   - `panggung-hijau.example.com` → port derived from [`shared/names.mjs`](shared/names.mjs)
3. It then forwards to that local port. If nothing is listening, it serves the
   built static site from `STATIC_DIR` (with SPA fallback to `index.html`).

A TLS terminator (Nginx, Caddy, …) should sit in front of the proxy and forward
plain HTTP to `PROXY_PORT`.

## Names (no file, no scanning)

Subdomain names are **computed on the fly** by a pure function shared between
the proxy and the CLI — there is no names file and no background port scanner.

The mapping is a deterministic, bijective noun×adjective matrix anchored at
`PORT_BASE`:

```
9000 → panggung-biru     9001 → panggung-hijau     9255 → tangga-fajar
```

- The proxy turns an incoming `noun-adj` subdomain back into a port.
- The CLI turns an assigned port into the same `noun-adj` name to print the URL
  (`node shared/names.mjs <port>`).

Because both sides call the *same* module, they can never disagree — and nothing
needs to be persisted or fetched.

### The window is also a security allowlist

The pool holds `POOL_SIZE` (256) names, so only ports in
`[PORT_BASE, PORT_BASE + 256)` are ever addressable. A crafted subdomain can't
be mapped to an out-of-window port, so it can't reach local services like SSH
(`:22`) or a database. There is **no max to configure** — the top of the window
follows the pool size automatically. Set `PORT_BASE` to move the whole window.

## Requirements

- Node.js ≥ 22 — server (built-in `.env` loader, native TS type-stripping) and
  client (the CLI calls `node` for name resolution)
- An SSH server with `GatewayPorts clientspecified` enabled

## Configuration

All hosts, IPs and domains come from the environment — nothing is hard-coded.
Copy the example file and fill it in:

```bash
cp .env.example .env
$EDITOR .env
```

`.env` is gitignored. **Never commit real IPs or domains.** See
[.env.example](.env.example) for every variable.

| Variable         | Side   | Required | Default     |
| ---------------- | ------ | -------- | ----------- |
| `DOMAIN`         | proxy  | ✅       | —           |
| `PORT_BASE`      | proxy  |          | `9000`      |
| `DEFAULT_PORT`   | proxy  |          | `PORT_BASE` |
| `PROXY_PORT`     | proxy  |          | `3000`      |
| `BIND_HOST`      | proxy  |          | `0.0.0.0`   |
| `STATIC_DIR`     | proxy  |          | `./dist`    |
| `SINGGAH_SERVER` | cli    | ✅       | —           |
| `SINGGAH_DOMAIN` | cli    | ✅       | —           |
| `SINGGAH_USER`   | cli    |          | `ubuntu`    |
| `SINGGAH_BASE`   | cli    |          | `9000`      |

> `SINGGAH_BASE` (client) must equal `PORT_BASE` (server) — otherwise the two
> sides compute different names for the same port.

## Usage

### Client

```bash
./cli/singgah.sh 5173              # auto-assign a tunnel port
./cli/singgah.sh 3001 --port 9002  # force a specific tunnel port
./cli/singgah.sh list              # show active tunnels
./cli/singgah.sh --help
```

Symlink it onto your `PATH` for convenience:

```bash
ln -s "$PWD/cli/singgah.sh" /usr/local/bin/singgah
```

### Server (proxy)

```bash
npm install
npm run build:all     # builds the site (dist/) and the proxy (dist-server/)
npm start             # runs dist-server/proxy.js (reads .env)
```

During development you can run the proxy straight from TypeScript with reload:

```bash
npm run proxy:dev     # node --watch + native type-stripping
```

Run it under a process manager in production so it restarts on boot/crash.
Example `systemd` unit:

```ini
# /etc/systemd/system/singgah-proxy.service
[Unit]
Description=singgah tunnel proxy
After=network.target

[Service]
WorkingDirectory=/home/ubuntu/singgah
EnvironmentFile=/home/ubuntu/singgah/.env
# Run node directly (not `npm start`): systemd then supervises the node process
# itself, so SIGTERM reaches it and the graceful shutdown runs. An `npm` wrapper
# would catch the signal and node may get SIGKILLed on stop/restart instead.
# `which node` to find the path (may differ under nvm, e.g. ~/.nvm/.../bin/node).
ExecStart=/usr/bin/node dist-server/proxy.js
Restart=always
User=ubuntu

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now singgah-proxy
```

## npm scripts

| Script                | What it does                                       |
| --------------------- | -------------------------------------------------- |
| `npm run dev`         | Vite dev server for the landing page               |
| `npm run build`       | Build the frontend → `dist/`                       |
| `npm run build:server`| Compile the proxy → `dist-server/`                 |
| `npm run build:all`   | Build both                                         |
| `npm run proxy:dev`   | Run the proxy from TS with `--watch` (development) |
| `npm start`           | Run the compiled proxy (`dist-server/proxy.js`)    |

## Security notes

- Secrets live only in `.env`; the proxy refuses to start without `DOMAIN`.
- Subdomains map only to ports in `[PORT_BASE, PORT_BASE + 256)`, so they can't
  reach arbitrary local services. Keep that window firewalled to localhost on
  the server so tunnels aren't reachable directly.
- Static serving is hardened against path traversal — requests escaping
  `STATIC_DIR` fall back to the SPA shell.
- Hop-by-hop headers are stripped when proxying (RFC 7230 §6.1).

## License

MIT
