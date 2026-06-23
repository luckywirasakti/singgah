# singgah

> _singgah_ (Indonesian): to stop by, to drop in.

Expose any local port to the internet over a plain SSH reverse tunnel — no
third-party tunneling service, no agent to install. A small Node proxy on your
server routes friendly subdomains (`panggung.example.com`) to whichever local
app you've tunneled, and serves a static landing page when nothing is connected.

> **This is the server side** — the proxy and the landing page. The client CLI
> you run on your laptop lives in its own repo: **singgah-cli**.

```
┌──────────────┐   ssh -R 9000:localhost:5173   ┌──────────────────────────┐
│  your laptop │ ─────────────────────────────▶ │  server                  │
│  :5173 (app) │                                │  server/proxy.ts   :3000 │
└──────────────┘                                │   ├─ :9000 ─▶ your app    │
                                                │   └─ static fallback     │
        https://panggung.example.com ◀──────────┤  (behind Nginx/Caddy)    │
                                                └──────────────────────────┘
```

## Project layout

```
src/            frontend landing page (Vite + TypeScript)
server/proxy.ts the reverse-tunnel proxy (Node, TypeScript)
tunnel-names.json  generated name → port map (runtime output, for the CLI)
```

Both halves share one repo and one toolchain. The frontend builds to `dist/`;
the proxy builds to `dist-server/` and serves `dist/` as its fallback.

## How it works

1. `singgah <port>` opens an SSH reverse tunnel from your machine to a tunnel
   port (9000–9015) on the server.
2. The proxy (`server/proxy.ts`) continuously scans those ports, and routes
   inbound HTTP by the `Host` header:
   - `example.com` / `www.example.com` → `DEFAULT_PORT`
   - `9001.example.com` → numeric tunnel port `9001`
   - `panggung.example.com` → port resolved from the generated name map (see [Friendly names](#friendly-names))
3. If no live tunnel matches, the proxy serves the built static site from
   `STATIC_DIR` (with SPA fallback to `index.html`).

A TLS terminator (Nginx, Caddy, …) should sit in front of the proxy and forward
plain HTTP to `PROXY_PORT`.

## Requirements

- Node.js ≥ 22 (built-in `.env` loader and native TS type-stripping for `proxy:dev`)
- An SSH server with `GatewayPorts clientspecified` enabled
- The **singgah-cli** client on the machines that open tunnels

## Configuration

All hosts, IPs and domains come from the environment — nothing is hard-coded.
Copy the example file and fill it in:

```bash
cp .env.example .env
$EDITOR .env
```

`.env` is gitignored. **Never commit real IPs or domains.** See
[.env.example](.env.example) for every variable and its default.

| Variable         | Required | Default               |
| ---------------- | -------- | --------------------- |
| `DOMAIN`         | ✅       | —                     |
| `PROXY_PORT`     |          | `3000`                |
| `BIND_HOST`      |          | `0.0.0.0`             |
| `STATIC_DIR`     |          | `./dist`              |
| `NAMES_FILE`     |          | `./tunnel-names.json` |
| `TUNNEL_MIN/MAX` |          | `9000` / `9015`       |
| `DEFAULT_PORT`   |          | `9000`                |

## Usage

### Client

The client CLI lives in the **singgah-cli** repo. Install it on any machine you
want to tunnel from, then:

```bash
singgah 5173      # → https://panggung.example.com
singgah list      # show active tunnels
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

### Friendly names

Names are **generated automatically** to match the tunnel range — no file to
hand-edit. The proxy takes an ordered pool of names and maps the Nth name to
`TUNNEL_MIN + N`, so a range of 16 ports yields 16 names, a range of 20 yields
20, and so on.

- Default pool: a built-in set of Indonesian "place" names
  (`panggung`, `dapur`, `loteng`, …).
- Override with the `TUNNEL_NAMES` env (comma-separated, ordered):

  ```bash
  TUNNEL_NAMES=alpha,beta,gamma  # alpha→9000, beta→9001, gamma→9002
  ```

On startup the proxy writes the resulting map to `NAMES_FILE`
(`tunnel-names.json`) so the **singgah-cli** client can resolve names. That file
is generated — it's gitignored and should not be edited by hand. If the pool is
smaller than the range, the extra ports stay reachable by number
(`9015.example.com`).

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
- Static serving is hardened against path traversal — requests escaping
  `STATIC_DIR` fall back to the SPA shell.
- Hop-by-hop headers are stripped when proxying (RFC 7230 §6.1).
- The proxy only exposes ports in `[TUNNEL_MIN, TUNNEL_MAX]`; keep that range
  firewalled to localhost on the server so tunnels aren't reachable directly.

## License

MIT
