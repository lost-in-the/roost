#!/usr/bin/env bash
# Capture every meaningful Roost panel state from the real 1024x600 output.
#
# This temporarily overrides only roost-daemon's ExecStart so the existing
# config and credential EnvironmentFiles remain untouched. The live source is
# restored on success, failure, or signal. Captures are debug artifacts under
# tmp/ and are deliberately not committed.

set -euo pipefail

repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
runtime_dir=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
config_dir=${XDG_CONFIG_HOME:-$HOME/.config}
dropin_dir="$config_dir/systemd/user/roost-daemon.service.d"
http_url=${ROOST_CAPTURE_HTTP_URL:-http://127.0.0.1:8477}
capture_root=${ROOST_CAPTURE_DIR:-"$repo_dir/tmp/panel-captures"}
capture_stamp=$(date +%Y%m%d-%H%M%S)
destination="$capture_root/$capture_stamp"
requested_output=''
dropin=''
original_source=''
restoring=false

usage() {
  printf 'Usage: %s [--output OUTPUT] [--destination DIR]\n' "${0##*/}"
  printf 'Captures the live Roost output through its built-in demo, then restores it.\n'
}

while (($#)); do
  case "$1" in
    --output)
      requested_output=${2:?--output needs a Hyprland output name}
      shift 2
      ;;
    --destination)
      destination=${2:?--destination needs a directory}
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

log() { printf '[roost-capture] %s\n' "$*" >&2; }

for command_name in curl flock grim hyprctl jq mktemp systemctl; do
  command -v "$command_name" >/dev/null || {
    printf 'Required command not found: %s\n' "$command_name" >&2
    exit 1
  }
done

mkdir -p "$runtime_dir" "$destination" "$dropin_dir"
exec 9>"$runtime_dir/roost-capture-panel.lock"
flock -n 9 || { log 'another panel capture is already running'; exit 1; }
if find "$dropin_dir" -maxdepth 1 -name 'zz-roost-capture.*.conf' -print -quit | grep -q .; then
  log 'a stale panel-capture override exists; refusing to guess whether it is safe to remove'
  exit 1
fi

status_json() { curl -fsS "$http_url/status"; }

wait_for_source() {
  local expected=$1
  local body source
  for _ in $(seq 1 80); do
    if body=$(status_json 2>/dev/null); then
      source=$(jq -r '.source // empty' <<<"$body")
      [[ "$source" == "$expected" ]] && return 0
    fi
    sleep 0.25
  done
  return 1
}

original_source=$(status_json | jq -r '.source // empty')
[[ -n "$original_source" ]] || { log 'could not determine the current source'; exit 1; }
[[ $(systemctl --user is-active roost-daemon.service) == active ]] || {
  log 'roost-daemon.service is not active; refusing to invent deployment state'
  exit 1
}

panel_monitor_id=$(hyprctl clients -j | jq -r '.[] | select(.title == "roost") | .monitor' | head -1)
if [[ -n "$requested_output" ]]; then
  panel_output=$requested_output
elif [[ -n "$panel_monitor_id" ]]; then
  panel_output=$(hyprctl monitors -j | jq -r --argjson id "$panel_monitor_id" '.[] | select(.id == $id) | .name' | head -1)
else
  panel_output=''
fi
[[ -n "$panel_output" ]] || { log 'could not identify the output holding the roost window'; exit 1; }
hyprctl monitors -j | jq -e --arg output "$panel_output" 'any(.[]; .name == $output and .width == 1024 and .height == 600)' >/dev/null || {
  log "output $panel_output is not the expected 1024x600 panel"
  exit 1
}

restore_live_source() {
  local rc=$?
  $restoring && return "$rc"
  restoring=true
  trap - EXIT
  # A second terminal signal must not interrupt removal/restart and strand the
  # daemon on the mock source. The original trap already preserved the intended
  # shell exit status in rc.
  trap '' HUP INT TERM
  if [[ -n "$dropin" && -e "$dropin" ]]; then
    rm -f -- "$dropin"
    if systemctl --user daemon-reload &&
       systemctl --user restart roost-daemon.service &&
       wait_for_source "$original_source"; then
      log "restored source=$original_source"
    else
      log "WARNING: daemon did not report restored source=$original_source"
      rc=1
    fi
  fi
  exit "$rc"
}

trap restore_live_source EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

dropin=$(mktemp "$dropin_dir/zz-roost-capture.XXXXXX.conf")
[[ "$repo_dir" != *$'\n'* && "$repo_dir" != *'"'* ]] || {
  log 'repository path cannot be represented safely in the temporary systemd override'
  exit 1
}
{
  printf '%s\n' '[Service]' 'ExecStart='
  printf 'ExecStart=/usr/bin/env ROOST_SOURCE=mock ROOST_MOCK_SCRIPT=demo /usr/bin/node "%s/daemon/index.js"\n' "$repo_dir"
} >"$dropin"

systemctl --user daemon-reload
systemctl --user restart roost-daemon.service
wait_for_source mock || { log 'mock source did not become ready'; exit 1; }

printf 'captured_at\t%s\noutput\t%s\noriginal_source\t%s\n' \
  "$(date --iso-8601=seconds)" "$panel_output" "$original_source" \
  >"$destination/context.tsv"

capture_started=$SECONDS
capture_at() {
  local offset=$1 name=$2 description=$3
  local due=$((capture_started + offset))
  if ((SECONDS < due)); then sleep $((due - SECONDS)); fi
  local path="$destination/$name.png"
  grim -o "$panel_output" "$path"
  printf '%s\t%s\t%s\n' "$name.png" "$offset" "$description" >>"$destination/manifest.tsv"
  log "captured $name.png — $description"
}

printf 'file\toffset_seconds\tstate\n' >"$destination/manifest.tsv"
capture_at 1  01-idle             'idle roster'
capture_at 7  02-listening        'one actor listening'
capture_at 13 03-thinking         'one actor thinking'
capture_at 21 04-multi-agent      'two actors thinking'
capture_at 29 05-stalled          'stalled outranks thinking'
capture_at 37 06-approval         'actionable approval with actor and countdown'
capture_at 53 07-handoff          'long request downgraded to handoff'
capture_at 61 08-bare-attention   'attention state without a prompt'

log "complete: $destination"
printf '%s\n' "$destination"
