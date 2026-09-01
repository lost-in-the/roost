# roost

A small touchscreen on the desk showing what the OpenClaw agents are doing, so
you stop opening a laptop just to check on them.

One daemon aggregates every agent into a single state and publishes it to MQTT.
Every screen is a thin subscriber of that one message. **The contract is the
asset; renderers are disposable.**

```
  StateSource  (mock demo or live OpenClaw Gateways)
       │
       ▼
  roost daemon ─── aggregates across all agents, truncates the label,
       │           heartbeats every 10s, registers a Last Will
       ▼
   MQTT (EMQX)     topic: roost/agents/state   [retained] + LWT
       │
       ├── panel renderer   fullscreen browser on a pinned Hyprland output
       ├── Stream Deck      (existing, untouched)
       └── Home Assistant   (later)
```

**Current milestone.** M1 presence is complete. The M2 Claude-native touch-
approval path is deployed on the physical panel; its remaining live acceptance
cases are tracked in [`docs/M2-touch-approvals.md`](docs/M2-touch-approvals.md#9-definition-of-done-when-it-is-built).
Home Assistant views, audio, the enclosure and the animated face remain later
work.

---

## Status

| | |
|---|---|
| State contract, daemon, renderer | working; `npm test` is the authoritative suite count |
| Hyprland output pinning | working, verified on the physical panel |
| Physical panel | connected and live, 1024×600 on `HDMI-A-1` |
| OpenClaw integration | live against separate Labby/Omar identities, each paired with `operator.read` + `operator.approvals` |
| Touch approvals | deployed; Labby path verified on glass, genuinely gated Omar-Claude on-device case still open |
| `stalled` detection | observer health `stuck` maps to `stalled`; unknown health still fails back to the session's active/idle reading |
| Touch | working — bound to the panel output, see [`config/hypr/roost.lua`](config/hypr/roost.lua) |

M1 is complete. The daemon reads real agent presence from both OpenClaw Gateways
and the panel tracks live runs, verified during an actual chat: `idle →
thinking → idle` in step with the conversation turns, event-driven rather than
polled. `MockStateSource` remains the default and drives the full state loop
with no gateway, no broker and no panel hardware.

**Touch works.** It needed two things: the USB touch lead connected (video and
touch are separate cables on these panels), and the touch device bound to the
panel's output. Without that binding Hyprland scales normalised touch
coordinates onto whichever monitor has *focus*, so taps landed on the desktop
instead. `config/hypr/roost.lua` section 1b explains the mechanism.

Note there are two touch devices on this machine: `waveshare-ws170120` is the
panel, and `touch-passthrough` is Sunshine's virtual device for remote input.
Only the first is bound; the second must keep targeting `sunshine-vd`.

---

## Try it in three terminals

No broker, no panel hardware, and no OpenClaw needed.

```sh
npm install

npm run dev:broker                        # 1. local MQTT broker (aedes)
ROOST_MQTT_HOST=127.0.0.1 npm run dev     # 2. the daemon, mock source
./scripts/launch-panel.sh                 # 3. the panel
```

The panel opens fullscreen on the `roost` Hyprland workspace. Without the real
panel connected, create a stand-in output first:

```sh
hyprctl output create headless
hyprctl monitors -j | jq -r '.[] | .name'    # note the new HEADLESS-N
```

then point `~/.config/hypr/roost-monitor.lua` at it — see
[`config/README.md`](config/README.md#testing-without-the-panel-hardware).

Watch the contract directly:

```sh
node -e "const m=require('mqtt').connect('mqtt://127.0.0.1:1883');
m.on('connect',()=>m.subscribe('roost/agents/state'));
m.on('message',(t,p)=>console.log(p.toString()))"
```

### Capture every panel state

With the deployed panel and daemon running, this captures the real 1024×600
output through the built-in demo sequence:

```sh
npm run capture:panel
```

The command writes eight timestamped PNGs and a manifest under
`tmp/panel-captures/`. It temporarily restarts only `roost-daemon` with the
mock source, preserves the unit's existing configuration, and restores the
original source on success, failure, or interruption. Concurrent captures are
rejected. To choose a stable artifact directory or a specific output:

```sh
npm run capture:panel -- --destination /tmp/roost-screens
npm run capture:panel -- --output DP-1
```

---

## Install

```sh
./scripts/install.sh            # --dry-run to see what it would touch
```

It checks dependencies, installs npm packages, symlinks the Hyprland config and
systemd units, and creates `.env` from the example. Then:

```sh
$EDITOR .env                                     # non-secret settings only
./scripts/provision-credentials.sh               # writes ~/.config/roost/credentials.env
systemctl --user enable --now roost-daemon roost-panel
```

**Kill switch**, leaving the Stream Deck and everything else alone:

```sh
systemctl --user stop roost-panel roost-daemon
```

### Secrets

The daemon reads plain environment variables and knows nothing about 1Password.
The systemd unit supplies them from two `EnvironmentFile=` entries in
[`config/systemd/roost-daemon.service`](config/systemd/roost-daemon.service):
`.env` for non-secret settings, and `~/.config/roost/credentials.env` for the
two broker passwords.

`.env` must hold literal non-secret values, never an `op://` reference:
`daemon/config.js` refuses unresolved 1Password references at startup. See
["Credentials"](#credentials) for the 1Password source of truth and the restore
command that writes the password cache.

---

## Connecting the real panel

The panel is pinned by **monitor description**, never by connector name, because
connector names (`HDMI-A-1`, `DP-2`) reorder on hotplug and would silently move
it.

```sh
./scripts/derive-monitor.sh                  # writes config/hypr/roost-monitor.lua
cp config/hypr/roost-monitor.lua ~/.config/hypr/
hyprctl reload && hyprctl configerrors       # must print nothing
```

To re-derive it by hand, here or on other hardware:

```sh
hyprctl monitors -j | jq -r '.[] | "\(.name)  \(.width)x\(.height)  \(.description)"'
```

If the panel is plugged in but does not appear, check the connector is live:

```sh
for c in /sys/class/drm/card*-*/status; do echo "$(basename $(dirname $c)) $(cat $c)"; done
```

> **Do not use DisplayLink or any USB display adapter.** It is broken on
> Hyprland, and this GPU has no USB-C, so DP Alt Mode is impossible. Video comes
> off the GPU over HDMI or DisplayPort.

`config/README.md` documents the Hyprland behaviours that differ from the wiki
on 0.56.2 — there are six, and two of them required real workarounds.

---

## Credentials

The two broker passwords live in a **provisionable cache**, not in the repo and
not resolved at start:

```
~/.config/roost/credentials.env      0600, outside the repo
  ROOST_MQTT_PASSWORD='...'          daemon, readwrite roost/#
  ROOST_MQTT_RENDERER_PASSWORD='...' panel, read-only roost/#
```

**1Password remains the source of truth** — the two `Mosquitto - roost …` items
in the Homelab vault. The cache exists so the daemon has *no 1Password
dependency at boot*. It previously ran under `op run --env-file`, which needs an
unlocked 1Password session; there is none at boot, so the unit restart-looped
until someone logged in and unlocked.

Restore it after any environment reset, while 1Password is unlocked:

```sh
./scripts/provision-credentials.sh
```

Run that from the repo root. It reads both values into 0600 same-directory temp
files before touching the existing cache, then writes single-quoted
`EnvironmentFile` assignments so backslashes and boundary whitespace survive
verbatim. It refuses a failed or empty read, NUL, carriage return, newline,
single quote, invalid UTF-8, byte order marks, and Unicode noncharacters, and
keeps the password values out of shell history and external process argv.

**It must be `KEY='VALUE'`.** A bare secret in a systemd `EnvironmentFile`
yields an empty variable with no error at all. If the cache is missing or
incomplete the daemon refuses to start and prints the command above, rather than
failing later as a bare `not authorized` from the broker.

`.env` holds the nine non-secret settings — broker host and port, both
usernames, topic, WebSocket URL, HTTP bind, state source. The unit reads both
files, credentials last, so the cache wins on any overlap.

---

## Connecting to OpenClaw

roost reads agent presence from the OpenClaw gateway as a **paired device**, not
by borrowing the gateway's shared token. Pair once:

```sh
sudo -n cat /var/lib/labby/credentials/gateway-token | node scripts/pair-openclaw.mjs --gateway labby
ROOST_SOURCE=openclaw npm start
```

The shared token is read on stdin, used only for bootstrap authentication, and
written nowhere. Pairing defaults to `operator.read`. The live Labby and Omar
Roost identities now each hold exactly `operator.read` plus
`operator.approvals`, stored with their Ed25519 keys in separate 0600 files:
`openclaw-device.json` and `openclaw-omar-device.json`.

`operator.read` is sufficient for M1 presence. `operator.approvals`
additionally authorizes resolving pending approvals through the loopback
approval route. Pairing Omar alone does not make roost dual-Gateway; M2 step 1
adds the coordinator and per-Gateway wiring. The code default remains `labby`
only for a fresh install; the current physical-panel deployment explicitly
selects `labby,omar`.

When `ROOST_SOURCE=openclaw`, `ROOST_OPENCLAW_GATEWAYS` selects which known
Gateway aliases roost connects to. The code supports `labby,omar` today, but
the default is deliberately conservative:

```sh
ROOST_OPENCLAW_GATEWAYS=labby
```

Per-Gateway overrides exist for both the URL and device file:

```sh
ROOST_OPENCLAW_URL_LABBY=ws://127.0.0.1:19789
ROOST_OPENCLAW_URL_OMAR=ws://127.0.0.1:19791
ROOST_OPENCLAW_DEVICE_FILE_LABBY=/home/you/.local/state/roost/openclaw-device.json
ROOST_OPENCLAW_DEVICE_FILE_OMAR=/home/you/.local/state/roost/openclaw-omar-device.json
```

The legacy unqualified `ROOST_OPENCLAW_URL` and
`ROOST_OPENCLAW_DEVICE_FILE` still work, but only for Labby. Reusing one
unqualified override for both Gateways would be the exact device-identity reuse
the M2 design forbids.

Revoke each identity only through its source Gateway:

```sh
# Labby
sudo -n -u labby env HOME=/var/lib/labby \
  PATH=/opt/labby/runtime/node_modules/.bin:/usr/bin \
  /usr/bin/bash -c 'export OPENCLAW_GATEWAY_TOKEN="$(</var/lib/labby/credentials/gateway-token)"; exec /usr/bin/node /opt/labby/runtime/node_modules/openclaw/openclaw.mjs --profile labby devices revoke --device "$1" --role operator' bash <device-id>

# Omar
/opt/omar/bin/openclaw-omar-admin oo devices revoke --device <device-id> --role operator
```

These machine-bound credentials are not stored in a password manager. Recovery
is source-local re-pairing.

### Adding approval authority on both Gateways

M2 uses two independent paired identities: upgrade the existing Labby identity
and create a separate Omar identity with its own device file. Never reuse either
identity or token against the other Gateway. `--gateway` is mandatory and maps
the fixed URL, device file, and printed approval command; unknown aliases are
refused. See D-015.

For the existing Labby identity, ask for `operator.approvals` on top of the read
scope with `--scopes`:

```sh
sudo -n cat /var/lib/labby/credentials/gateway-token \
  | node scripts/pair-openclaw.mjs --gateway labby --scopes operator.read,operator.approvals
```

Pair Omar separately:

```sh
sudo -n cat /var/lib/omar/credentials/gateway-token \
  | node scripts/pair-openclaw.mjs --gateway omar --scopes operator.read,operator.approvals
```

Running against an already-paired identity performs a scope upgrade while
retaining its Ed25519 identity. In the pinned local Gateways, the shared token
auto-approved both the Labby scope upgrade and Omar's fresh pairing; neither
operation produced a human pairing request. Treat read access to a Gateway's
shared token as authority to mint `operator.approvals`. The script still
handles and prints a source-local approval command if a future Gateway returns
`PAIRING_REQUIRED`.

Two things it will not do:

- **It never records a scope it was not granted.** Roost stores what `hello-ok`
  negotiated and prints any requested scope the Gateway withheld.
- **It never drops a scope you already hold.** The connect frame requests the
  union, because the gateway negotiates exactly what it is asked for and a bare
  `--scopes operator.approvals` would cost roost its `operator.read`.

The current daemon picks up Labby's stored scopes automatically. Omar's
separate device file is used as soon as `omar` appears in
`ROOST_OPENCLAW_GATEWAYS`. A fresh install still defaults to `labby` alone;
production selects both aliases explicitly.

> **Scope is authority, and it is broader than roost.** On OpenClaw
> 2026.7.2-beta.7, an approval carrying no explicit reviewer device list is
> answerable by *any* paired device holding `operator.approvals` — not only by
> the device that raised it. Granting roost this scope therefore lets the daemon
> answer any pending approval on the gateway, and the daemon's loopback HTTP
> server becomes the thing standing in front of that authority.
>
> **The daemon now enforces this itself.** Holding `operator.approvals` (or
> `operator.admin`, which satisfies it) with a non-loopback `ROOST_HTTP_HOST` is
> refused at startup, before anything listens — see `daemon/approval-exposure.js`.
> The check is the *combination*, not the approval route, so it fires the moment
> the scope is granted rather than waiting for M2's route to be written and for
> whoever writes it to remember to attach a guard.
>
> If it refuses, either bind back to loopback or revoke the identity through
> its source Gateway, delete its device file, and re-pair with
> `operator.read`. Merely rerunning the pairing script cannot downgrade scopes
> because it deliberately preserves their union. Exposing the HTTP server is
> still allowed on its own — it only becomes a refusal once approval authority
> is sitting behind it.

roost subscribes rather than polls. Nothing is queued for a disconnected client,
so every reconnect re-subscribes and takes a fresh full snapshot.

---

## Changing the schema

The state contract is the one thing that is expensive to get wrong: every screen
subscribes to it.

1. Edit `schema/agent-state.vN.schema.json`.
2. Add an entry to [`schema/CHANGELOG.md`](schema/CHANGELOG.md) saying **what
   changed and why**.
3. Update `daemon/aggregate.js` and `test/aggregate.test.js`. Aggregation is the
   only producer, so the schema boundary is that one file.
4. Update `renderer/app.js` if the field is displayed — it must keep working
   against a daemon that does not send it yet.
5. `npm test`.

**Adding an optional field is free**: keep `v` the same, because renderers are
required to tolerate unknown fields. **Removing, renaming, or retyping a field
is breaking**: bump `v`, add a new schema file, and publish both until every
subscriber is updated. Adding a value to `state` or `urgency` is breaking in
practice even though it looks additive, because subscribers switch on the value.

### The rules that carry weight

1. **The daemon aggregates; the renderer never does.** Two surfaces that can
   disagree make both untrustworthy.
2. **`stalled` must not look like `thinking`.** Turns legitimately run tens of
   seconds. If working and stuck look alike, the project fails its purpose.
3. **A frozen panel is worse than an error panel.** Last Will and the 30-second
   staleness rule are both required; they cover different failures.
4. **`label` is truncated in the daemon**, at the schema boundary — never in the
   renderer.

---

## Layout

```
daemon/
  index.js          wiring
  aggregate.js      many agents in, one reconciled state out (pure)
  publisher.js      MQTT: retained, Last Will, heartbeat, backoff
  http.js           serves the renderer, accepts laptop-open taps
  laptop-log.js     the durable counter
  instrument.js     the counter as a published, retained value
  config.js         environment parsing
  sources/
    state-source.js the interface everything else is built against
    mock.js         scripted timelines
    openclaw.js     STUB — see docs/DECISIONS.md D-001
renderer/           plain HTML/CSS/JS, no framework, no build step
  components/       shared UI, mountable by any surface
  staleness.js      when to stop believing the panel
  topics.js         which subscription a message came from
schema/             the state contract, versioned, with a changelog
config/hypr/        Hyprland output + workspace pinning
config/systemd/     user units
scripts/            install, derive-monitor, launch-panel, dev-broker
docs/               decisions and the original plans
```

`npm test` runs 259 tests with Node's built-in runner. Aggregation and the log are
tested as pure units; the publisher is tested against a **real** in-process
broker, including cutting sockets to prove the Last Will fires and reconnection
continues.

---

## The "had to open the laptop" button

The success metric is *zero laptop-opens motivated solely by checking on an
agent, across 30 days*. The recessive glyph in the bottom-right corner is the
instrument: an icon and a count at 20% opacity, with a full 88px touch target
behind it. It is tapped a handful of times a month, so it must not compete with
the state readout.

It lives in `renderer/components/laptop-counter.js` so any future surface mounts
the same behaviour. A second layout is available with `?instrument=header`.

The count is published retained on `roost/instrument/laptop-opens`, separate
from agent state because the two have opposite failure semantics — see
[`schema/CHANGELOG.md`](schema/CHANGELOG.md). Reads come over MQTT; a tap goes
out over loopback HTTP, which keeps the browser credential subscribe-only.

One tap appends a timestamped line to `~/.local/state/roost/laptop-opens.log` and
increments the count. The write is `fsync`ed before the tap is acknowledged, and
the count is always read back from the file, so it survives a crash or a reboot.
If the daemon is down the tap is queued in the browser and retried, because an
instrument that silently loses data points measures nothing.

```sh
wc -l < ~/.local/state/roost/laptop-opens.log     # the count
cat    ~/.local/state/roost/laptop-opens.log      # when
```

---

## Reading order

- [`docs/DECISIONS.md`](docs/DECISIONS.md) — what was chosen, why, and what would
  change if a choice is wrong
- [`config/README.md`](config/README.md) — Hyprland version drift and how each
  pinning requirement was verified
- [`schema/CHANGELOG.md`](schema/CHANGELOG.md) — the contract's history
- [`docs/M2-touch-approvals.md`](docs/M2-touch-approvals.md) — design note for
  the touch-approval milestone. Read §6 before changing approval behavior.
- [`docs/BACKLOG.md`](docs/BACKLOG.md) — observed follow-ups, including the
  remaining Omar acceptance and upstream safe-summary work.
- [`docs/desk-agent-presence-plan.md`](docs/desk-agent-presence-plan.md) — why
  this exists at all; start at the TL;DR, then §5, then §3
- [`docs/slice1-delivery-plan.md`](docs/slice1-delivery-plan.md) — flows and
  edge-case decisions
