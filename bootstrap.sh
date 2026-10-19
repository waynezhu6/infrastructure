#!/usr/bin/env bash
# Prepares a fresh Ubuntu/Debian server to run this repo.
# Safe to re-run: every step checks before it changes anything.
#
# Usage (as root, or with sudo):
#   sudo bash bootstrap.sh --user ubuntu --pubkey "ssh-ed25519 AAAA... github-deploy"
#
# Options:
#   --user NAME     Account that CI deploys as (SERVER_USER). Default: $SUDO_USER, else "deploy".
#   --pubkey KEY    Public half of SSH_DEPLOY_KEY to add to that user's authorized_keys.
#   --ghcr-user NAME
#                   Log the deploy user in to ghcr.io as NAME so it can pull private
#                   app images. Reads a token with read:packages scope from stdin:
#                     cat ghcr_token | ssh ... 'sudo bash bootstrap.sh --ghcr-user NAME ...'

set -euo pipefail

DEPLOY_USER="${SUDO_USER:-deploy}"
[ "$DEPLOY_USER" = "root" ] && DEPLOY_USER="deploy"
PUBKEY=""
GHCR_USER=""

while [ $# -gt 0 ]; do
  case "$1" in
    --user)   DEPLOY_USER="$2"; shift 2 ;;
    --pubkey) PUBKEY="$2"; shift 2 ;;
    --ghcr-user) GHCR_USER="$2"; shift 2 ;;
    -h|--help) echo "Usage: bootstrap.sh [--user NAME] [--pubkey KEY] [--ghcr-user NAME < token]"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

log() { printf '\n==> %s\n' "$*"; }

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root (sudo bash bootstrap.sh ...)" >&2
  exit 1
fi

# Read the token before anything else can consume stdin. It never goes on the
# command line, so it stays out of shell history and the process list.
GHCR_TOKEN=""
if [ -n "$GHCR_USER" ]; then
  if [ -t 0 ]; then
    echo "--ghcr-user needs a token on stdin (cat ghcr_token | ...)" >&2
    exit 1
  fi
  IFS= read -r GHCR_TOKEN || true
  if [ -z "$GHCR_TOKEN" ]; then
    echo "--ghcr-user given but no token was read from stdin" >&2
    exit 1
  fi
fi

# shellcheck source=/dev/null
. /etc/os-release
case "$ID" in
  ubuntu|debian) ;;
  *) echo "Unsupported OS: $ID. This script supports Ubuntu and Debian." >&2; exit 1 ;;
esac

export DEBIAN_FRONTEND=noninteractive

# ------------------------------------------------------------------------------
log "Installing base packages"
apt-get update -q
apt-get install -y -q ca-certificates curl git gnupg rsync

# ------------------------------------------------------------------------------
# Caddy and Postgres run as containers, so Docker is the only runtime needed.
if docker compose version >/dev/null 2>&1; then
  log "Docker already installed ($(docker --version))"
else
  log "Installing Docker Engine and the compose plugin"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/$ID $VERSION_CODENAME stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker

# ------------------------------------------------------------------------------
log "Setting up deploy user '$DEPLOY_USER'"
if ! id "$DEPLOY_USER" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash "$DEPLOY_USER"
fi
# Membership in the docker group is effectively root access on this host.
usermod -aG docker "$DEPLOY_USER"
DEPLOY_HOME="$(getent passwd "$DEPLOY_USER" | cut -d: -f6)"

if [ -n "$PUBKEY" ]; then
  install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$DEPLOY_HOME/.ssh"
  AUTH_KEYS="$DEPLOY_HOME/.ssh/authorized_keys"
  touch "$AUTH_KEYS"
  if grep -qxF "$PUBKEY" "$AUTH_KEYS"; then
    echo "Deploy key already authorized"
  else
    echo "$PUBKEY" >> "$AUTH_KEYS"
    echo "Deploy key added to $AUTH_KEYS"
  fi
  chown "$DEPLOY_USER:$DEPLOY_USER" "$AUTH_KEYS"
  chmod 600 "$AUTH_KEYS"
fi

# ------------------------------------------------------------------------------
# App repos push their backend images to GHCR, and images from private repos are
# private, so the server needs a login to pull them. Doing it once here keeps the
# token on the server instead of in every app repo's secrets.
if [ -n "$GHCR_TOKEN" ]; then
  log "Logging $DEPLOY_USER in to ghcr.io as $GHCR_USER"
  printf '%s' "$GHCR_TOKEN" \
    | sudo -u "$DEPLOY_USER" -H docker login ghcr.io -u "$GHCR_USER" --password-stdin
fi

# ------------------------------------------------------------------------------
# Oracle Cloud's Ubuntu images ship iptables rules that REJECT everything except
# SSH, even when the VCN security list allows the port. Open 80/443 ahead of them.
log "Opening ports 80 and 443 in the host firewall"
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  ufw allow 80/tcp
  ufw allow 443/tcp
  ufw allow 443/udp
elif command -v iptables >/dev/null 2>&1; then
  for rule in tcp:80 tcp:443 udp:443; do
    proto="${rule%%:*}" port="${rule##*:}"
    if ! iptables -C INPUT -p "$proto" --dport "$port" -m state --state NEW -j ACCEPT 2>/dev/null; then
      iptables -I INPUT 1 -p "$proto" --dport "$port" -m state --state NEW -j ACCEPT
      echo "Allowed $proto/$port"
    fi
  done
  if command -v netfilter-persistent >/dev/null 2>&1; then
    netfilter-persistent save
  else
    echo "Note: netfilter-persistent not installed; iptables rules will not survive a reboot." >&2
  fi
else
  echo "No ufw or iptables found; skipping"
fi

# ------------------------------------------------------------------------------
log "Creating $DEPLOY_HOME/infrastructure/sites"
# Must exist and belong to the deploy user before Docker mounts it, or Docker
# creates it as root and project CI cannot rsync frontends into it.
install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$DEPLOY_HOME/infrastructure" "$DEPLOY_HOME/infrastructure/sites"

# ------------------------------------------------------------------------------
log "Done"
cat <<EOF

Server is ready. Remaining steps (see README "Setting up a new server"):
  - Set GitHub Actions secrets on the infrastructure repo:
      SERVER_HOST=<this server's public IP>  SERVER_USER=$DEPLOY_USER
      SSH_DEPLOY_KEY=<private key>           POSTGRES_PASSWORD=<new password>
  - Run the Deploy workflow (Actions tab > Deploy > Run workflow).
EOF
if [ -z "$GHCR_USER" ]; then
  echo "  - Not logged in to ghcr.io: re-run with --ghcr-user to pull private app images."
fi
