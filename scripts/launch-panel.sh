#!/usr/bin/env bash
# Launch the roost panel renderer and place it on its Hyprland output.
#
# Why this script exists rather than pure window rules: on Hyprland 0.56.2 two
# things do not work declaratively (both verified by hand, see config/README.md):
#
#   1. A `fullscreen = true` window rule does not apply to this window, so the
#      panel comes up inset by the bar's reserved area (1024x574 instead of
#      1024x600). Dispatching fullscreen after the window maps does work.
#
#   2. A `default = true` workspace rule does not claim the output when a
#      numbered workspace already owns it, which is always the case because
#      Hyprland assigns one as the monitor connects. Focusing the named
#      workspace once, then focusing back, does work and persists.
#
# Everything here is idempotent: run it again and it re-places an existing panel.

set -euo pipefail

ROOST_HTTP_HOST="${ROOST_HTTP_HOST:-127.0.0.1}"
ROOST_HTTP_PORT="${ROOST_HTTP_PORT:-8477}"
PANEL_URL="http://${ROOST_HTTP_HOST}:${ROOST_HTTP_PORT}/"
PANEL_TITLE="roost"
WORKSPACE="name:roost"
PROFILE_DIR="${ROOST_BROWSER_PROFILE:-${XDG_STATE_HOME:-$HOME/.local/state}/roost/browser}"
BROWSER="${ROOST_BROWSER:-chromium}"

log() { printf '[roost-panel] %s\n' "$*" >&2; }

command -v "$BROWSER" >/dev/null || { log "browser '$BROWSER' not found"; exit 1; }
command -v hyprctl >/dev/null || { log "hyprctl not found; is Hyprland running?"; exit 1; }

# 1. Wait for the daemon to serve the renderer. The daemon may still be backing
#    off against an unreachable broker, which is fine: the page loads and shows
#    its own disconnected state.
log "waiting for ${PANEL_URL}"
for _ in $(seq 1 60); do
  if curl -sf -o /dev/null "${PANEL_URL}"; then break; fi
  sleep 0.5
done
curl -sf -o /dev/null "${PANEL_URL}" || { log "daemon did not come up at ${PANEL_URL}"; exit 1; }

# 2. Launch the browser, unless a panel is already up.
if ! hyprctl clients -j | jq -e --arg t "$PANEL_TITLE" 'any(.[]; .title == $t)' >/dev/null; then
  log "launching ${BROWSER}"
  mkdir -p "$PROFILE_DIR"
  setsid "$BROWSER" \
    --app="${PANEL_URL}" \
    --user-data-dir="${PROFILE_DIR}" \
    --ozone-platform=wayland \
    --no-first-run \
    --noerrdialogs \
    --disable-infobars \
    --disable-session-crashed-bubble \
    --hide-crash-restore-bubble \
    --disable-features=TranslateUI \
    </dev/null >/dev/null 2>&1 &
  disown 2>/dev/null || true
fi

# 3. Wait for the window to map.
for _ in $(seq 1 60); do
  if hyprctl clients -j | jq -e --arg t "$PANEL_TITLE" 'any(.[]; .title == $t)' >/dev/null; then break; fi
  sleep 0.5
done

address=$(hyprctl clients -j | jq -r --arg t "$PANEL_TITLE" '.[] | select(.title == $t) | .address' | head -1)
[ -n "$address" ] || { log "panel window never appeared"; exit 1; }
log "panel window ${address}"

# 4. Remember where the human was, so we can put focus back.
previous_monitor=$(hyprctl monitors -j | jq -r '.[] | select(.focused) | .name')

# 5. Make the named workspace the one actually displayed on the panel output,
#    then hand focus straight back. The workspace stays put afterwards.
hyprctl dispatch "hl.dsp.focus({ workspace = \"${WORKSPACE}\" })" >/dev/null

# 6. Evict any non-panel windows that landed on the panel workspace. Static
#    window rules only prevent initial opens; this repairs existing state.
hyprctl clients -j \
  | jq -r --arg ws "roost" --arg panel "$address" '
      .[]
      | select(.workspace.name == $ws)
      | select(.address != $panel)
      | .address
    ' \
  | while IFS= read -r intruder; do
      [ -n "$intruder" ] || continue
      log "evicting non-panel window ${intruder} from ${WORKSPACE}"
      if hyprctl dispatch "hl.dsp.focus({ window = \"address:${intruder}\" })" >/dev/null; then
        hyprctl dispatch 'hl.dsp.window.move({ workspace = "1", follow = false })' >/dev/null || true
        fullscreen=$(hyprctl clients -j | jq -r --arg a "$intruder" '.[] | select(.address == $a) | .fullscreen' | head -1)
        if [ -n "$fullscreen" ] && [ "$fullscreen" != "0" ]; then
          log "clearing fullscreen=${fullscreen} on evicted window ${intruder}"
          if hyprctl dispatch "hl.dsp.focus({ window = \"address:${intruder}\" })" >/dev/null; then
            hyprctl dispatch 'hl.dsp.window.fullscreen()' >/dev/null || true
          fi
        fi
      fi
    done

# 7. Fullscreen the panel so it covers the bar and uses the whole glass.
hyprctl dispatch "hl.dsp.focus({ window = \"address:${address}\" })" >/dev/null
if [ "$(hyprctl clients -j | jq -r --arg a "$address" '.[] | select(.address == $a) | .fullscreen')" = "0" ]; then
  hyprctl dispatch 'hl.dsp.window.fullscreen()' >/dev/null
fi

# 8. Give the desk back to the human.
if [ -n "$previous_monitor" ]; then
  hyprctl dispatch "hl.dsp.focus({ monitor = \"${previous_monitor}\" })" >/dev/null
fi

hyprctl clients -j | jq -r --arg a "$address" \
  '.[] | select(.address == $a) | "[roost-panel] placed: workspace=\(.workspace.name) monitor=\(.monitor) size=\(.size|join("x")) fullscreen=\(.fullscreen)"' >&2
