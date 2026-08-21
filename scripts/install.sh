#!/usr/bin/env bash
# Install roost from a fresh checkout: dependencies, Hyprland config, systemd units.
#
# Idempotent. Symlinks the Hyprland config back into the repo so `git pull`
# updates it, rather than copying and drifting.
#
#   ./scripts/install.sh            # install everything
#   ./scripts/install.sh --dry-run  # show what would change

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HYPR_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/hypr"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
DRY=false
[ "${1:-}" = "--dry-run" ] && DRY=true

say()  { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33m warn:\033[0m %s\n' "$*" >&2; }
run()  { if $DRY; then printf '   would: %s\n' "$*"; else eval "$@"; fi; }

# ── dependencies ─────────────────────────────────────────────────────────────

say "Checking dependencies"
missing=()
for cmd in node npm jq hyprctl; do
  command -v "$cmd" >/dev/null || missing+=("$cmd")
done
command -v chromium >/dev/null || command -v google-chrome-stable >/dev/null || missing+=("chromium")
if [ ${#missing[@]} -gt 0 ]; then
  echo "Missing: ${missing[*]}" >&2
  echo "On Arch/Omarchy:  sudo pacman -S --needed nodejs npm jq chromium" >&2
  exit 1
fi
command -v op >/dev/null || warn "1Password CLI (op) not found — needed by the systemd unit to resolve secrets"
echo "   node $(node --version), $(chromium --version 2>/dev/null || echo chromium)"

say "Installing node dependencies"
run "cd '${REPO_DIR}' && npm install --omit=dev"

# ── configuration ────────────────────────────────────────────────────────────

if [ ! -f "${REPO_DIR}/.env" ]; then
  say "Creating .env from .env.example"
  run "cp '${REPO_DIR}/.env.example' '${REPO_DIR}/.env'"
  warn "Edit ${REPO_DIR}/.env — set ROOST_MQTT_HOST and the op:// secret references"
else
  say ".env already exists, leaving it alone"
fi

# ── Hyprland ─────────────────────────────────────────────────────────────────

say "Installing Hyprland config"
run "mkdir -p '${HYPR_DIR}'"
run "ln -sfn '${REPO_DIR}/config/hypr/roost.lua' '${HYPR_DIR}/roost.lua'"

# The monitor file is generated per machine, so copy it rather than symlink —
# re-running derive-monitor.sh should not silently rewrite a checked-out file
# on a machine with different hardware.
if [ ! -f "${HYPR_DIR}/roost-monitor.lua" ]; then
  run "cp '${REPO_DIR}/config/hypr/roost-monitor.lua' '${HYPR_DIR}/roost-monitor.lua'"
  warn "Panel monitor is a PLACEHOLDER. Plug the panel in, then run:"
  warn "    ./scripts/derive-monitor.sh && cp config/hypr/roost-monitor.lua ${HYPR_DIR}/"
else
  say "roost-monitor.lua already present, leaving it alone"
fi

if grep -q 'require("hypr.roost")' "${HYPR_DIR}/hyprland.lua" 2>/dev/null; then
  say "hyprland.lua already loads roost"
else
  say "Adding require to hyprland.lua"
  run "cp '${HYPR_DIR}/hyprland.lua' '${HYPR_DIR}/hyprland.lua.bak.\$(date +%s)'"
  run "printf '\n-- roost desk agent panel\nrequire(\"hypr.roost\")\n' >> '${HYPR_DIR}/hyprland.lua'"
fi

# ── systemd ──────────────────────────────────────────────────────────────────

say "Installing systemd user units"
run "mkdir -p '${UNIT_DIR}'"
run "ln -sfn '${REPO_DIR}/config/systemd/roost-daemon.service' '${UNIT_DIR}/roost-daemon.service'"
run "ln -sfn '${REPO_DIR}/config/systemd/roost-panel.service'  '${UNIT_DIR}/roost-panel.service'"
run "systemctl --user daemon-reload"

# ── done ─────────────────────────────────────────────────────────────────────

cat <<DONE

Installed. Remaining steps:

  1. Edit .env             ROOST_MQTT_HOST plus the op:// references
  2. Plug the panel in, then:
                           ./scripts/derive-monitor.sh
                           cp config/hypr/roost-monitor.lua ${HYPR_DIR}/
  3. Apply Hyprland config hyprctl reload && hyprctl configerrors
  4. Start it              systemctl --user enable --now roost-daemon roost-panel

To try it without a broker or the panel hardware:

     npm run dev:broker            # terminal 1
     ROOST_MQTT_HOST=127.0.0.1 npm run dev    # terminal 2
     ./scripts/launch-panel.sh     # terminal 3

DONE
