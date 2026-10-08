#!/usr/bin/env bash
# One-time (idempotent) root setup of the hosted box (ADR 0020, docs/ops/hosting.md).
# Copy deploy/ to the box and run it as root:
#
#   DEPLOY_PUBKEY='ssh-ed25519 …' ADMIN_PUBKEY='ssh-ed25519 …' bash provision.sh base
#   bash provision.sh ssh      # only after `ssh deploy@` and `ssh admin@` both work
#
# base: packages + unattended upgrades, users, pinned Bun, Caddy, nftables, units, backups.
# ssh:  root login and passwords off, only deploy and admin may log in.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pin_file="$here/.bun-version"; [[ -f "$pin_file" ]] || pin_file="$here/../.bun-version"
bun_version="$(tr -d '[:space:]' < "$pin_file")"
[[ "$(id -u)" == 0 ]] || { echo "run as root" >&2; exit 1; }

add_user() { # name pubkey [extra useradd args]
  local name="$1" key="$2"; shift 2
  id "$name" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash "$@" "$name"
  install -d -m 0700 -o "$name" -g "$name" "/home/$name/.ssh"
  printf '%s\n' "$key" > "/home/$name/.ssh/authorized_keys"
  chown "$name:$name" "/home/$name/.ssh/authorized_keys"
  chmod 0600 "/home/$name/.ssh/authorized_keys"
  passwd -l "$name" >/dev/null
}

base() {
  [[ "${DEPLOY_PUBKEY:-}" == ssh-* && "${ADMIN_PUBKEY:-}" == ssh-* ]] || { echo "set DEPLOY_PUBKEY and ADMIN_PUBKEY" >&2; exit 2; }
  export DEBIAN_FRONTEND=noninteractive

  # Caddy's own signed repo: Ubuntu's caddy package is years behind.
  if [[ ! -s /usr/share/keyrings/caddy-stable-archive-keyring.gpg || ! -s /etc/apt/sources.list.d/caddy-stable.list ]]; then
    curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  fi
  apt-get update -qq
  apt-get -y -qq full-upgrade
  apt-get -y -qq install caddy sqlite3 unzip curl rsync nftables unattended-upgrades polkitd

  # Unattended upgrades: security pockets (Ubuntu default) plus Caddy; reboot for kernels at 04:30 UTC.
  install -m 0644 "$here/apt/20auto-upgrades" /etc/apt/apt.conf.d/20auto-upgrades
  install -m 0644 "$here/apt/52omega-share-unattended" /etc/apt/apt.conf.d/52omega-share-unattended

  # Users: deploy ships releases and may restart the one unit; admin is the root path (sudo).
  id omega-share >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin omega-share
  add_user deploy "$DEPLOY_PUBKEY"
  add_user admin "$ADMIN_PUBKEY" --groups sudo
  printf 'admin ALL=(ALL) NOPASSWD:ALL\n' > /etc/sudoers.d/90-omega-admin
  chmod 0440 /etc/sudoers.d/90-omega-admin
  visudo -cq
  install -m 0644 "$here/polkit/50-omega-share-deploy.rules" /etc/polkit-1/rules.d/50-omega-share-deploy.rules

  install -d -m 0755 -o deploy -g deploy /opt/omega-share /opt/omega-share/releases
  # Backups: written by the service user, readable by deploy for the off-box pull (setgid group).
  install -d -m 2750 -o omega-share -g deploy /var/backups/omega-share
  install -d -m 0755 /usr/local/lib/omega-share
  install -m 0755 "$here/backup.sh" /usr/local/lib/omega-share/backup.sh

  # Bun, pinned and checked against the hash committed in deploy/ (not one fetched beside the zip),
  # root-owned so a deploy can't swap the runtime. A version bump updates both files.
  if [[ "$(/usr/local/bin/bun --version 2>/dev/null || true)" != "$bun_version" ]]; then
    local tmp; tmp="$(mktemp -d)"
    local url="https://github.com/oven-sh/bun/releases/download/bun-v$bun_version"
    curl -fsSL -o "$tmp/bun.zip" "$url/bun-linux-aarch64.zip"
    (cd "$tmp" && sha256sum -c "$here/bun-linux-aarch64.sha256")
    unzip -q "$tmp/bun.zip" -d "$tmp"
    install -m 0755 "$tmp/bun-linux-aarch64/bun" /usr/local/bin/bun
    rm -r -f "$tmp"
  fi

  install -m 0644 "$here/Caddyfile" /etc/caddy/Caddyfile
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
  install -m 0644 "$here/omega-share.service" "$here/omega-share-backup.service" "$here/omega-share-backup.timer" /etc/systemd/system/
  systemctl daemon-reload
  systemctl enable omega-share.service omega-share-backup.timer
  systemctl start omega-share-backup.timer
  systemctl restart caddy # admin off: no `caddy reload`

  # Firewall: load with an automatic rollback in case it cuts this session; confirm with `firewall-ok`.
  nft -c -f "$here/nftables.conf"
  systemctl disable --now ufw 2>/dev/null || true
  install -m 0644 "$here/nftables.conf" /etc/nftables.conf
  systemctl stop omega-nft-rollback.timer omega-nft-rollback.service 2>/dev/null || true
  systemd-run --collect --unit=omega-nft-rollback --on-active=180 /usr/sbin/nft flush ruleset >/dev/null
  nft -f /etc/nftables.conf
  systemctl enable nftables.service
  echo "nftables loaded; run 'bash provision.sh firewall-ok' from a NEW ssh session within 3 minutes"
}

firewall_ok() {
  systemctl stop omega-nft-rollback.timer 2>/dev/null || true
  echo "firewall kept"
}

ssh_hardening() {
  for u in deploy admin; do
    [[ -s "/home/$u/.ssh/authorized_keys" ]] || { echo "$u has no key: refusing to lock root out" >&2; exit 1; }
  done
  install -m 0644 "$here/sshd/00-omega-share.conf" /etc/ssh/sshd_config.d/00-omega-share.conf
  sshd -t
  passwd -l root >/dev/null
  # Socket-activated sshd reads the config per connection; a reload only matters if the service runs.
  systemctl reload ssh 2>/dev/null || echo "note: ssh.service not running (socket activation); config applies to new connections"
  echo "root login off; only deploy and admin may log in"
}

case "${1:-}" in
  base) base ;;
  firewall-ok) firewall_ok ;;
  ssh) ssh_hardening ;;
  *) echo "usage: provision.sh base|firewall-ok|ssh" >&2; exit 2 ;;
esac
