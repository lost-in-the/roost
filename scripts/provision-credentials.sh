#!/usr/bin/env bash
# Provision the roost MQTT password cache from 1Password.

set -euo pipefail

umask 077

config_dir="${HOME:?HOME is required}/.config/roost"
target="$config_dir/credentials.env"
raw_daemon=
raw_panel=
tmp=
cleanup() {
  rm -f -- "${raw_daemon:-}" "${raw_panel:-}" "${tmp:-}"
}

on_signal() {
  local signal="$1"
  trap '' HUP INT TERM
  cleanup
  trap - EXIT HUP INT TERM
  kill -s "$signal" "$$"
}

read_secret() {
  local field="$1"
  local path="$2"
  local raw="$3"
  local value
  local byte_count
  local stripped_count
  local lf_count
  local final_lf_count
  local status

  if ! op read "$path" > "$raw" 2>/dev/null; then
    printf 'error: %s could not be read from 1Password; unlock 1Password and retry\n' "$field" >&2
    return 1
  fi

  byte_count=$(wc -c < "$raw")
  stripped_count=$(LC_ALL=C tr -d '\0' < "$raw" | wc -c)
  if [ "$byte_count" != "$stripped_count" ]; then
    printf 'error: %s contains a NUL byte; refusing to write an invalid EnvironmentFile\n' "$field" >&2
    return 1
  fi

  stripped_count=$(LC_ALL=C tr -d '\r' < "$raw" | wc -c)
  if [ "$byte_count" != "$stripped_count" ]; then
    printf 'error: %s contains a carriage return; refusing to write an invalid EnvironmentFile\n' "$field" >&2
    return 1
  fi

  status=0
  LC_ALL=C grep -q "'" "$raw" || status=$?
  if [ "$status" -eq 0 ]; then
    printf 'error: %s cannot be represented in a systemd EnvironmentFile; choose a password without a single quote\n' "$field" >&2
    return 1
  elif [ "$status" -ne 1 ]; then
    printf 'error: %s could not be validated (grep exited %s); refusing to write an invalid EnvironmentFile\n' "$field" "$status" >&2
    return 1
  fi

  if ! iconv -f UTF-8 -t UTF-8 < "$raw" >/dev/null 2>/dev/null; then
    printf 'error: %s is not valid UTF-8; refusing to write an invalid EnvironmentFile\n' "$field" >&2
    return 1
  fi

  status=0
  LC_ALL=C grep -q "$(printf '\357\273\277')" "$raw" || status=$?
  if [ "$status" -eq 0 ]; then
    printf 'error: %s contains a byte order mark; refusing to write an invalid EnvironmentFile\n' "$field" >&2
    return 1
  elif [ "$status" -ne 1 ]; then
    printf 'error: %s could not be validated (grep exited %s); refusing to write an invalid EnvironmentFile\n' "$field" "$status" >&2
    return 1
  fi

  status=0
  LC_ALL=C grep -qaE $'\357\267[\220-\257]|\357\277[\276\277]|[\360-\364][\217\237\257\277]\277[\276\277]' "$raw" || status=$?
  if [ "$status" -eq 0 ]; then
    printf 'error: %s contains a Unicode noncharacter; refusing to write an invalid EnvironmentFile\n' "$field" >&2
    return 1
  elif [ "$status" -ne 1 ]; then
    printf 'error: %s could not be validated (grep exited %s); refusing to write an invalid EnvironmentFile\n' "$field" "$status" >&2
    return 1
  fi

  lf_count=$(LC_ALL=C tr -cd '\n' < "$raw" | wc -c)
  if [ "$lf_count" -gt 1 ]; then
    printf 'error: %s contains a newline; refusing to write an invalid EnvironmentFile\n' "$field" >&2
    return 1
  fi
  if [ "$lf_count" -eq 1 ]; then
    final_lf_count=$(LC_ALL=C tail -c 1 "$raw" | wc -l)
    if [ "$final_lf_count" -ne 1 ]; then
      printf 'error: %s contains a newline; refusing to write an invalid EnvironmentFile\n' "$field" >&2
      return 1
    fi
  fi

  value=$(cat "$raw")
  if [ -z "$value" ]; then
    printf 'error: %s was empty; refusing to replace ~/.config/roost/credentials.env\n' "$field" >&2
    return 1
  fi

  printf '%s' "$value"
}

command -v op >/dev/null || {
  printf 'error: 1Password CLI (op) not found on PATH; install it, sign in, and retry\n' >&2
  exit 1
}
install -d -m 700 "$config_dir"
trap cleanup EXIT
trap 'on_signal HUP' HUP
trap 'on_signal INT' INT
trap 'on_signal TERM' TERM
raw_daemon=$(mktemp "$config_dir/roost-daemon.XXXXXX")
daemon=$(read_secret ROOST_MQTT_PASSWORD 'op://Homelab/Mosquitto - roost daemon/password' "$raw_daemon")
raw_panel=$(mktemp "$config_dir/roost-panel.XXXXXX")
panel=$(read_secret ROOST_MQTT_RENDERER_PASSWORD 'op://Homelab/Mosquitto - roost panel/password' "$raw_panel")
tmp=$(mktemp "$config_dir/credentials.env.XXXXXX")
chmod 600 "$tmp"
printf "ROOST_MQTT_PASSWORD='%s'\nROOST_MQTT_RENDERER_PASSWORD='%s'\n" "$daemon" "$panel" > "$tmp"
chmod 600 "$tmp"
trap '' HUP INT TERM
mv -f "$tmp" "$target"
tmp=
rm -f -- "$raw_daemon" "$raw_panel"
raw_daemon=
raw_panel=
trap - EXIT HUP INT TERM
