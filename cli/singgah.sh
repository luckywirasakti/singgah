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

command -v node >/dev/null 2>&1 || { echo "Error: node is required (used for name resolution)"; exit 1; }
POOL_SIZE="$(node "$NAMES_MJS" --size)"
MAX=$((BASE + POOL_SIZE - 1))

# Colors
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# ── port → friendly name (via the shared module) ──
name_for_port() { node "$NAMES_MJS" "$1" "$BASE" 2>/dev/null || true; }

# ── url for a tunnel port (friendly name, else numeric) ──
url_for_port() {
  local port=$1 name
  name="$(name_for_port "$port")"
  if [ -n "$name" ]; then echo "${name}.${DOMAIN}"; else echo "${port}.${DOMAIN}"; fi
}

show_help() {
  echo "singgah — Tunnel local port to $DOMAIN"
  echo ""
  echo "Usage:"
  echo "  singgah <local-port>              Auto-assign a tunnel port"
  echo "  singgah <local-port> --port <p>   Force a specific tunnel port"
  echo "  singgah list                      Show active tunnels"
  echo ""
  echo "Examples:"
  echo "  singgah 5173     → https://$(url_for_port "$BASE")"
  echo "  singgah 3001     → https://$(url_for_port "$((BASE + 1))")"
  echo ""
  echo "Environment variables (set in .env or your shell):"
  echo "  SINGGAH_SERVER   Server IP/host        (required)"
  echo "  SINGGAH_DOMAIN   Domain               (required)"
  echo "  SINGGAH_USER     SSH user             (default: ubuntu)"
  echo "  SINGGAH_BASE     Base tunnel port     (default: 9000)"
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
cmd_list() {
  echo -e "${CYAN}Active tunnels on $SERVER:${NC}"
  ssh "$SSH_DEST" "ss -tlnp 2>/dev/null | grep -oP '\\b[0-9]{4,5}\\b' | sort -n | uniq" 2>/dev/null \
    | while read -r port; do
        if [ -n "$port" ] && [ "$port" -ge "$BASE" ] && [ "$port" -le "$MAX" ]; then
          echo -e "  :$port  →  ${GREEN}https://$(url_for_port "$port")${NC}"
        fi
      done
}

# ── Main tunnel command ──
cmd_tunnel() {
  local local_port=$1 forced_port=$2

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

  local url
  url="$(url_for_port "$tunnel_port")"

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
    shift 2>/dev/null || true
    while [ $# -gt 0 ]; do
      case "$1" in
        --port|-p) forced_port="$2"; shift 2 ;;
        *) shift ;;
      esac
    done

    if [ -z "$local_port" ]; then
      show_help
      exit 1
    fi
    cmd_tunnel "$local_port" "$forced_port"
    ;;
esac
