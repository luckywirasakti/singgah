#!/usr/bin/env bash
set -e

# ── singgah CLI ──
# Auto-tunnel a local port to your domain via SSH reverse tunnel.
# Subdomain names are computed locally with the SAME module the server uses
# (../shared/names.mjs), so client and server always agree — no stored file.
#
# Usage:  singgah <local-port>
#         singgah list
#         singgah <local-port> --port <tunnel-port>

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NAMES_MJS="$SCRIPT_DIR/../shared/names.mjs"

# Load a local .env (repo root, script dir, or cwd) so secrets stay out of git.
for envfile in "$SCRIPT_DIR/../.env" "$SCRIPT_DIR/.env" "./.env"; do
  if [ -f "$envfile" ]; then
    set -a; . "$envfile"; set +a
    break
  fi
done

SERVER="${SINGGAH_SERVER:?set SINGGAH_SERVER (server IP/host) in your environment or .env}"
USER="${SINGGAH_USER:-ubuntu}"
SSH_DEST="${USER}@${SERVER}"
DOMAIN="${SINGGAH_DOMAIN:?set SINGGAH_DOMAIN (your domain) in your environment or .env}"
BASE="${SINGGAH_BASE:-9000}"

# Shared secret for the proxy control plane (dynamic names). When set, a fresh
# random name is registered per tunnel; when empty, we fall back to the
# deterministic port↔name matrix (the original static behaviour).
SECRET="${SINGGAH_SECRET:-}"
CTRL="https://${DOMAIN}/_singgah"

command -v node >/dev/null 2>&1 || { echo "Error: node is required (used for name resolution)"; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "Error: curl is required (used for name registration)"; exit 1; }
POOL_SIZE="$(node "$NAMES_MJS" --size)"
MAX=$((BASE + POOL_SIZE - 1))

# Colors
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# ── port → friendly name (via the shared module) ──
name_for_port() { node "$NAMES_MJS" "$1" "$BASE" 2>/dev/null || true; }

# ── a fresh random friendly name (via the shared module) ──
random_name() { node "$NAMES_MJS" --random 2>/dev/null || true; }

# ── url for a tunnel port (friendly name, else numeric) ──
url_for_port() {
  local port=$1 name
  name="$(name_for_port "$port")"
  if [ -n "$name" ]; then echo "${name}.${DOMAIN}"; else echo "${port}.${DOMAIN}"; fi
}

# ── register a dynamic name → port; echoes the HTTP status code ──
register_name() {
  curl -sS -o /dev/null -w '%{http_code}' \
    -X POST "$CTRL/register" \
    -H "x-singgah-secret: $SECRET" \
    -H 'content-type: application/json' \
    -d "{\"name\":\"$1\",\"port\":$2}" 2>/dev/null || echo "000"
}

# ── release a dynamic name (best effort) ──
release_name() {
  [ -n "$SECRET" ] && [ -n "${NAME:-}" ] || return 0
  curl -sS -o /dev/null \
    -X POST "$CTRL/release" \
    -H "x-singgah-secret: $SECRET" \
    -H 'content-type: application/json' \
    -d "{\"name\":\"$NAME\"}" >/dev/null 2>&1 || true
}

# ── choose + register a dynamic name for a port; sets the global NAME ──
# Falls back to the deterministic name when no secret is configured or the
# control plane is unreachable.
assign_name() {
  local port=$1 forced=$2 code attempt
  if [ -z "$SECRET" ]; then
    NAME="$(name_for_port "$port")"
    return 0
  fi
  if [ -n "$forced" ]; then
    code="$(register_name "$forced" "$port")"
    if [ "$code" = "200" ]; then NAME="$forced"; return 0; fi
    echo "Error: could not register name '$forced' (HTTP $code)"; exit 1
  fi
  for attempt in $(seq 1 12); do
    local candidate; candidate="$(random_name)"
    code="$(register_name "$candidate" "$port")"
    case "$code" in
      200) NAME="$candidate"; return 0 ;;
      409) continue ;;                       # collision — try another name
      *)   echo "⚠️  control plane unavailable (HTTP $code); using static name" >&2
           NAME="$(name_for_port "$port")"; return 0 ;;
    esac
  done
  echo "⚠️  no free name after 12 tries; using static name" >&2
  NAME="$(name_for_port "$port")"
}

show_help() {
  echo "singgah — Tunnel local port to $DOMAIN"
  echo ""
  echo "Usage:"
  echo "  singgah <local-port>              Auto-assign port + random name"
  echo "  singgah <local-port> --port <p>   Force a specific tunnel port"
  echo "  singgah <local-port> --name <n>   Force a specific subdomain name"
  echo "  singgah list                      Show active tunnels"
  echo ""
  echo "Naming:"
  if [ -n "$SECRET" ]; then
    echo "  Dynamic: a fresh random name is registered per tunnel (SINGGAH_SECRET set)."
  else
    echo "  Static: names derive from the port (set SINGGAH_SECRET for dynamic names)."
  fi
  echo ""
  echo "Environment variables (set in .env or your shell):"
  echo "  SINGGAH_SERVER   Server IP/host        (required)"
  echo "  SINGGAH_DOMAIN   Domain               (required)"
  echo "  SINGGAH_USER     SSH user             (default: ubuntu)"
  echo "  SINGGAH_BASE     Base tunnel port     (default: 9000)"
  echo "  SINGGAH_SECRET   Control-plane secret (enables dynamic names)"
  echo ""
  echo "Addressable window: $BASE-$MAX ($POOL_SIZE names)"
}

# ── Find first available tunnel port on the server ──
find_available_port() {
  ssh "$SSH_DEST" "
    for p in \$(seq $BASE $MAX); do
      if ! ss -tlnp 2>/dev/null | grep -q \":\$p \"; then
        echo \"\$p\"
        break
      fi
    done
  " 2>/dev/null
}

# ── Check if a specific tunnel port is free on the server ──
is_port_free() {
  ssh "$SSH_DEST" "ss -tlnp 2>/dev/null | grep -q ':$1 ' && echo no || echo yes" 2>/dev/null
}

# ── List active tunnels ──
# With a secret, names are dynamic so we ask the proxy's registry; otherwise we
# fall back to scanning the server's listening ports and naming them statically.
cmd_list() {
  echo -e "${CYAN}Active tunnels on $SERVER:${NC}"

  if [ -n "$SECRET" ]; then
    local json
    json="$(curl -sS -H "x-singgah-secret: $SECRET" "$CTRL/list" 2>/dev/null)" || true
    if [ -n "$json" ]; then
      echo "$json" | node -e '
        const domain = process.argv[1];
        let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
          try {
            const t=(JSON.parse(s).tunnels||[]).sort((a,b)=>a.port-b.port);
            if(!t.length){console.log("  (none)");return;}
            for(const {name,port} of t) console.log(`  :${port}  →  https://${name}.${domain}`);
          } catch { console.log("  (could not read registry)"); }
        });
      ' "$DOMAIN"
      return
    fi
    echo -e "  ${YELLOW}(control plane unreachable; falling back to port scan)${NC}"
  fi

  ssh "$SSH_DEST" "ss -tlnp 2>/dev/null | grep -oP '\\b[0-9]{4,5}\\b' | sort -n | uniq" 2>/dev/null \
    | while read -r port; do
        if [ -n "$port" ] && [ "$port" -ge "$BASE" ] && [ "$port" -le "$MAX" ]; then
          echo -e "  :$port  →  ${GREEN}https://$(url_for_port "$port")${NC}"
        fi
      done
}

# ── Main tunnel command ──
cmd_tunnel() {
  local local_port=$1 forced_port=$2 forced_name=$3

  if ! [[ "$local_port" =~ ^[0-9]+$ ]] || [ "$local_port" -lt 1 ] || [ "$local_port" -gt 65535 ]; then
    echo "Error: invalid local port '$local_port'"
    exit 1
  fi

  local tunnel_port
  if [ -n "$forced_port" ]; then
    tunnel_port=$forced_port
    if [ "$tunnel_port" -lt "$BASE" ] || [ "$tunnel_port" -gt "$MAX" ]; then
      echo "Error: tunnel port $tunnel_port is outside the window $BASE-$MAX"
      exit 1
    fi
    if [ "$(is_port_free "$tunnel_port")" != "yes" ]; then
      echo "Error: tunnel port $tunnel_port is already in use on the server"
      exit 1
    fi
  else
    echo -n "⏳ Scanning for an available tunnel port... "
    tunnel_port=$(find_available_port)
    if [ -z "$tunnel_port" ]; then
      echo -e "\nError: no available ports in window $BASE-$MAX"
      exit 1
    fi
    echo "$tunnel_port"
  fi

  # Pick (and, with a secret, register) the subdomain name for this tunnel.
  # NAME is global so the EXIT trap can release it when the tunnel closes.
  NAME=""
  trap release_name EXIT
  assign_name "$tunnel_port" "$forced_name"

  local url
  if [ -n "$NAME" ]; then url="${NAME}.${DOMAIN}"; else url="${tunnel_port}.${DOMAIN}"; fi

  echo ""
  echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "  ${GREEN}Local${NC}    :$local_port → tunnel :$tunnel_port"
  echo -e "  ${GREEN}URL${NC}      https://$url"
  echo -e "  ${GREEN}Command${NC}  ssh -R $tunnel_port:localhost:$local_port $SSH_DEST"
  echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo ""
  echo -e "${YELLOW}Press Ctrl+C to close tunnel${NC}"
  echo ""

  ssh -R "$tunnel_port:localhost:$local_port" -N "$SSH_DEST"
}

# ── Entry point ──
case "${1:-help}" in
  list)
    cmd_list
    ;;
  -h|--help|help)
    show_help
    ;;
  *)
    local_port=$1
    forced_port=""
    forced_name=""
    shift 2>/dev/null || true
    while [ $# -gt 0 ]; do
      case "$1" in
        --port|-p) forced_port="$2"; shift 2 ;;
        --name|-n) forced_name="$2"; shift 2 ;;
        *) shift ;;
      esac
    done

    if [ -z "$local_port" ]; then
      show_help
      exit 1
    fi
    cmd_tunnel "$local_port" "$forced_port" "$forced_name"
    ;;
esac
