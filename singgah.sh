#!/usr/bin/env bash
set -e

# ── singgah CLI ──
# Auto-tunnel a local port to singgah.web.id via SSH reverse tunnel
# Usage:  singgah <local-port>
#         singgah list
#         singgah <local-port> --port <tunnel-port>

SERVER="${SINGGAH_SERVER:-43.157.223.230}"
USER="${SINGGAH_USER:-ubuntu}"
SSH_DEST="${USER}@${SERVER}"
NAMES_FILE="${SINGGAH_NAMES:-/home/ubuntu/singgah/tunnel-names.json}"
TUNNEL_MIN=${SINGGAH_TUNNEL_MIN:-9000}
TUNNEL_MAX=${SINGGAH_TUNNEL_MAX:-9015}
DOMAIN="${SINGGAH_DOMAIN:-singgah.web.id}"

# Colors
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

show_help() {
  echo "singgah — Tunnel local port to $DOMAIN"
  echo ""
  echo "Usage:"
  echo "  singgah <local-port>              Auto-assign tunnel port"
  echo "  singgah <local-port> --port <p>   Force specific tunnel port"
  echo "  singgah list                      Show active tunnels"
  echo ""
  echo "Examples:"
  echo "  singgah 5173     → https://panggung.$DOMAIN"
  echo "  singgah 3001     → https://dapur.$DOMAIN"
  echo ""
  echo "Environment variables:"
  echo "  SINGGAH_SERVER      Server IP/host (default: $SERVER)"
  echo "  SINGGAH_USER        SSH user (default: $USER)"
  echo "  SINGGAH_DOMAIN      Domain (default: $DOMAIN)"
  echo "  SINGGAH_NAMES       Path to names mapping on server"
}

# ── SSH helper — fetch names mapping ──
fetch_names() {
  ssh "$SSH_DEST" "cat $NAMES_FILE" 2>/dev/null
}

# ── Resolve indie name from port ──
port_to_name() {
  local port=$1 json=$2
  if command -v jq &>/dev/null; then
    echo "$json" | jq -r "to_entries[] | select(.value == $port) | .key"
  else
    echo "$json" | grep -oP "\"\\w+\":\\s*${port}\\b" | grep -oP '"\w+' | tr -d '"'
  fi
}

# ── Find first available tunnel port on server ──
find_available_port() {
  ssh "$SSH_DEST" "
    for p in \$(seq $TUNNEL_MIN $TUNNEL_MAX); do
      if ! ss -tlnp 2>/dev/null | grep -q \":\$p \"; then
        echo \"\$p\"
        break
      fi
    done
  " 2>/dev/null
}

# ── Check if a specific tunnel port is free ──
is_port_free() {
  local port=$1
  ssh "$SSH_DEST" "ss -tlnp 2>/dev/null | grep -q ':$port ' && echo no || echo yes" 2>/dev/null
}

# ── List active tunnels ──
cmd_list() {
  echo -e "${CYAN}Active tunnels on $SERVER:${NC}"
  local json=$(fetch_names)

  ssh "$SSH_DEST" "
    ss -tlnp 2>/dev/null | grep -E ':9[0-9]{3} ' | grep -oP '\\b9[0-9]{3}\\b' | sort -n | uniq
  " 2>/dev/null | while read -r port; do
    if [ -n "$port" ]; then
      local name=$(port_to_name "$port" "$json")
      if [ -n "$name" ] && [ "$name" != "null" ]; then
        echo -e "  :$port  →  ${GREEN}https://${name}.${DOMAIN}${NC}"
      else
        echo -e "  :$port  →  https://${port}.${DOMAIN}"
      fi
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
    local status=$(is_port_free "$tunnel_port")
    if [ "$status" != "yes" ]; then
      echo "Error: tunnel port $tunnel_port is already in use on server"
      exit 1
    fi
  else
    echo -n "⏳ Scanning for available tunnel port... "
    tunnel_port=$(find_available_port)
    if [ -z "$tunnel_port" ]; then
      echo -e "\nError: no available ports in range $TUNNEL_MIN-$TUNNEL_MAX"
      exit 1
    fi
    echo "$tunnel_port"
  fi

  local json=$(fetch_names)
  local name=$(port_to_name "$tunnel_port" "$json")
  if [ -n "$name" ] && [ "$name" != "null" ]; then
    local url="${name}.${DOMAIN}"
  else
    local url="${tunnel_port}.${DOMAIN}"
  fi

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
