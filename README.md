# roost

A small touchscreen on the desk showing what the OpenClaw agents are doing, so
you stop opening a laptop just to check on them.

One daemon aggregates every agent into a single state and publishes it to MQTT.
Every screen is a thin subscriber of that one message. **The contract is the
asset; renderers are disposable.**

```
  StateSource  (mock today, OpenClaw later)
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

**Milestone 1.** Panel shows live agent state, driven by a mock source. Touch
approvals, Home Assistant views, audio, the enclosure and the animated face are
all out of scope.

---

## Status

| | |
|---|---|
| State contract, daemon, renderer | working, 155 tests |
| Hyprland output pinning | working, verified on the physical panel |
| Physical panel | connected and live, 1024×600 on `HDMI-A-1` |
| OpenClaw integration | working, paired device scoped `operator.read` |
| `stalled` detection | **not mapped yet** — see [`docs/DECISIONS.md`](docs/DECISIONS.md) D-001 |
| Touch | working — bound to the panel output, see [`config/hypr/roost.lua`](config/hypr/roost.lua) |

M1 is complete. The daemon reads real agent presence from the OpenClaw gateway
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

---

## Install

```sh
./scripts/install.sh            # --dry-run to see what it would touch
```

It checks dependencies, installs npm packages, symlinks the Hyprland config and
systemd units, and creates `.env` from the example. Then:

```sh
$EDITOR .env                                     # broker host + op:// references
systemctl --user enable --now roost-daemon roost-panel
```

**Kill switch**, leaving the Stream Deck and everything else alone:

```sh
systemctl --user stop roost-panel roost-daemon
```

### Secrets

The daemon reads plain environment variables and knows nothing about 1Password.
The systemd unit runs it under `op run --env-file`, so `.env` holds `op://`
**references** and never a credential. `.env` is gitignored;
[`.env.example`](.env.example) lists every variable.

Check a reference resolves without printing its value:

```sh
op read "op://Homelab/EMQX roost daemon/password" >/dev/null && echo ok
```

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
  ROOST_MQTT_PASSWORD=...            daemon, readwrite roost/#
  ROOST_MQTT_RENDERER_PASSWORD=...   panel, read-only roost/#
```

**1Password remains the source of truth** — the two `Mosquitto - roost …` items
in the Homelab vault. The cache exists so the daemon has *no 1Password
dependency at boot*. It previously ran under `op run --env-file`, which needs an
unlocked 1Password session; there is none at boot, so the unit restart-looped
until someone logged in and unlocked.

Restore it after any environment reset, while 1Password is unlocked:

```sh
install -d -m 700 ~/.config/roost && umask 077 && {
  printf 'ROOST_MQTT_PASSWORD=%s\n'          "$(op read 'op://Homelab/Mosquitto - roost daemon/password')"
  printf 'ROOST_MQTT_RENDERER_PASSWORD=%s\n' "$(op read 'op://Homelab/Mosquitto - roost panel/password')"
} > ~/.config/roost/credentials.env
```

The values are piped, never passed as arguments, so they do not reach a process
listing or shell history.

**It must be `KEY=VALUE`.** A bare secret in a systemd `EnvironmentFile` yields
an empty variable with no error at all. If the cache is missing or incomplete
the daemon refuses to start and prints the command above, rather than failing
later as a bare `not authorized` from the broker.

`.env` holds the nine non-secret settings — broker host and port, both
usernames, topic, WebSocket URL, HTTP bind, state source. The unit reads both
files, credentials last, so the cache wins on any overlap.

---

## Connecting to OpenClaw

roost reads agent presence from the OpenClaw gateway as a **paired device**, not
by borrowing the gateway's shared token. Pair once:

```sh
sudo -n cat /var/lib/labby/credentials/gateway-token | node scripts/pair-openclaw.mjs
ROOST_SOURCE=openclaw npm start
```

The shared token is read on stdin, used once for bootstrap authentication, and
written nowhere. What roost keeps is its own device token, scoped
`operator.read` and nothing more, stored 0600 beside the Ed25519 key it is bound
to in `~/.local/state/roost/openclaw-device.json`.

That scope is exactly what a presence panel needs — `sessions.list`,
`sessions.subscribe`, read-only events. roost cannot start a run, send a
message, or answer an approval. Revoke it on its own, without disturbing any
other paired client:

```sh
openclaw devices revoke --device <id> --role operator
```

The token is **not** kept in a password manager. It is useless without the local
private key, so a vault would hold half a credential; recovery is re-pairing,
which is the one command above.

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

`npm test` runs 155 tests with Node's built-in runner. Aggregation and the log are
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
  the next milestone. Nothing built; read §6 first, it gates the rest.
- [`docs/desk-agent-presence-plan.md`](docs/desk-agent-presence-plan.md) — why
  this exists at all; start at the TL;DR, then §5, then §3
- [`docs/slice1-delivery-plan.md`](docs/slice1-delivery-plan.md) — flows and
  edge-case decisions
