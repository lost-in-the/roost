# Decisions

Choices made during the M1 build that the brief left open, plus the ones the
build itself forced. Each records **what was assumed** and **what would change
if the assumption is wrong**, so a wrong call is cheap to reverse.

Decisions the brief settled in advance (heartbeat and staleness numbers, the
aggregation order, `label` truncation in the daemon, the Last Will shape,
1Password for secrets, no service ordering against the broker, pinning by
monitor description, web view over GTK, no UI framework) are **not** re-litigated
here. They are implemented as specified.

---

## D-000 — The project is called `roost`, not `perch`

**Decision.** Every identifier uses `roost`: the MQTT topic
`roost/agents/state`, the env prefix `ROOST_*`, the Hyprland workspace
`name:roost`, the systemd units `roost-daemon` / `roost-panel`, the state
directory `~/.local/state/roost/`.

**Why.** The task named the project `perch` throughout but was prefixed with an
explicit rename note, and the repository is `lost-in-the/roost`. The rename is
newer than the body of the brief, so it wins.

**What changes if wrong.** A find-and-replace of `roost` → `perch` across the
repo, plus renaming the two unit files and the state directory. The MQTT topic
would have to change on every subscriber at the same time, but nothing
subscribes yet (see D-002), so today that cost is zero. This gets expensive only
once the Stream Deck or Home Assistant start reading the topic.

---

## D-001 — Which OpenClaw mechanism supplies state: ~~unresolved~~ **RESOLVED 2026-08-23: the gateway, subscribed**

**Decision.** `OpenClawStateSource` is a stub that emits no agents and logs a
warning. M1 ships driven by `MockStateSource`. `ROOST_SOURCE` defaults to
`mock`.

**Why.** OpenClaw is not installed on this machine, so there was nothing to
build against and nothing to inspect:

```
$ command -v openclaw                          # not on PATH
$ ls -d ~/.openclaw ~/.config/openclaw          # neither exists
$ pacman -Qq | grep -iE 'claw|deck'             # no packages
$ systemctl --user list-units | grep -iE 'claw|deck'   # no units
```

The brief describes an existing Stream Deck integration that already consumes
agent state, which would have been the ground truth for the mechanism, but it is
not running here either. Guessing between hooks, a webhook plugin, and a gateway
would have meant building everything downstream against a fiction.

**Assumption.** OpenClaw will arrive on this machine later, and whichever
mechanism it offers can produce "the full set of currently-known agents" on
change. The `StateSource` interface requires the complete set on every emission,
never a delta, so the daemon holds no state it has no business holding.

**Preference when it comes to choosing.** Hooks, because the brief describes
OpenClaw as already *pushing* state to the Stream Deck, and a push mechanism has
no polling latency. A webhook plugin is the same shape with different
configuration. A gateway/API poll is the fallback — most robust to missed
events, worst latency, and the only option needing credentials.

**What changes if wrong.** Only `daemon/sources/openclaw.js`. Aggregation, the
publisher, staleness, Last Will, the Hyprland setup and the entire renderer are
built and tested behind the interface and do not care. Expect one genuinely new
piece of work: **`stalled` almost certainly has to be derived here** — as "a run
is active but has produced no output for N seconds" — rather than being reported
by OpenClaw, because it is a judgement about silence rather than an event.

> ### ✅ RESOLVED 2026-08-23 — the gateway, subscribed, as a paired device
>
> OpenClaw arrived as the Labby gateway: `openclaw-labby.service`, openclaw
> **2026.7.2-beta.7**, loopback `127.0.0.1:19789`, running as the `labby`
> service user. `daemon/sources/openclaw.js` is no longer a stub.
>
> **It is the gateway, not hooks.** The preference above was wrong, and it was
> wrong for a reason worth keeping: the "already pushes state to the Stream
> Deck" premise never held on this machine. The gateway turned out to push
> anyway — `sessions.subscribe` plus change events — so the latency objection
> that made hooks attractive does not apply. The gateway is loopback on this
> same host.
>
> **Verified live**, not from the bundle's string registry: `sessions.list`,
> `agents.list` and `health.summary` all answered real calls, and during an
> actual Labby chat the panel tracked `idle → thinking → idle → thinking →
> idle` in step with the conversation turns. Those transitions are event-driven;
> a poll would have held the startup snapshot.
>
> **Credential.** roost pairs as a device and holds its own token scoped
> `operator.read`, revocable alone. It does NOT borrow the shared gateway token,
> which is the same credential the iPhone and Control UI use. The gateway's own
> docs are explicit: "Do not create a per-client bearer token by hand-editing
> `openclaw.json` ... let device pairing mint the client token."
>
> **Snapshot, not delta.** Every emission is a full `sessions.list`. Keeping a
> local projection would add state this daemon has no business holding and would
> drift from the gateway on any missed event — and nothing is queued for a
> disconnected client, so a missed event can never be recovered by waiting.
>
> **The `stalled` prediction is still open, and now looks likely wrong.**
> `session.stalled` and `session.stuck` both exist in the gateway's registry, so
> OpenClaw may well report it rather than leaving it to be derived from silence.
> But every session observed live reported only `done` or `timeout`, so it is
> still unknown whether those are status *values* or *event* names. It is
> deliberately unmapped: distinguishing thinking from stalled is the reason
> roost exists, and a wrong mapping is worse than an absent one. Settling it
> needs a run that actually hangs.

---

## D-002 — `roost/agents/state` does not collide on the shared broker

**Decision.** Use `roost/agents/state`, as specified.

**Why.** Collision could not be checked directly: there is **no broker on this
machine**. Port 1883 is closed, and no `emqx` or `beam.smp` process is running,
so EMQX lives on another host (Tailscale is up, which is the likely route).
Without credentials there was no way to enumerate existing topics.

Indirect evidence says the risk is negligible: the broker is shared with Home
Assistant (`homeassistant/…`) and Zigbee2MQTT (`zigbee2mqtt/…`), both of which
use their own well-known prefixes, and the delivery plan states nothing
currently subscribes to this topic — the rollout is explicitly additive.

**How to check before first real run.**

```sh
mosquitto_sub -h "$ROOST_MQTT_HOST" -u "$ROOST_MQTT_USER" -P "$ROOST_MQTT_PASSWORD" \
  -t 'roost/#' -v -W 5
```

Silence means the namespace is free. (EMQX's dashboard topic browser answers the
same question.)

**What changes if wrong.** `ROOST_MQTT_TOPIC` is a single environment variable
and the renderer receives it from `/api/config`, so a rename is one edit in
`.env` and a daemon restart. Nothing is hardcoded.

---

## D-003 — Language and runtime: **Node.js**

**Decision.** Node.js for the daemon, plain ES modules, no build step, no
TypeScript, no transpiler.

**Why.** The brief explicitly warned that being a Rails engineer is not an
argument for Ruby, and asked for operational simplicity in a long-lived user
service. What was actually available:

| Runtime | Present | Weighed |
|---|---|---|
| Python 3.14.7 | yes | System Python on Arch. Minor-version bumps break virtualenvs, which is a recurring maintenance event for a service meant to run untouched for months. |
| Node 26.7.0 | yes | Pure-JS dependencies survive interpreter upgrades. Already needed for the renderer. |
| Deno 2.9.5 | yes | Single binary is attractive, but an MQTT client still comes from npm, so the dependency story is no simpler. |
| Go / Rust | **no** | Not installed. A single static binary would be the best answer operationally, but adding a toolchain to the critical path contradicts the plan's "no toolkit learning on the critical path" constraint. |

Node won mainly on **one language across daemon and renderer**. The renderer is
JavaScript by decree (plain HTML/CSS/JS in a browser), so choosing anything else
for the daemon means two toolchains for ~700 lines of code.

Dependencies are deliberately tiny: `mqtt` at runtime, `aedes` and `ws` for
tests only. Tests use the **built-in** `node:test` runner, so there is no test
framework to keep current.

**What changes if wrong.** The daemon is small and its seams are clean
(`aggregate.js` is pure, `publisher.js` wraps the client, `http.js` is stdlib).
A rewrite in Go would be roughly a day and would not touch the contract, the
renderer, or the Hyprland setup. The reason to do it would be dropping
`node_modules` from a long-lived service, not performance.

---

## D-004 — The renderer subscribes to MQTT directly, over WebSocket

**Decision.** The panel connects to the broker itself using a **vendored**
`mqtt.js` browser bundle (`renderer/vendor/mqtt.esm.js`, committed). It does not
receive state from the daemon over a side channel.

**Why.** This is what makes the Last Will meaningful. If the daemon fed the page
over SSE or a WebSocket of its own, then "daemon dead" and "transport dead"
would be the same event, and the broker's `offline` message could never reach
the panel — the mechanism the plan calls non-negotiable would be decorative.
Subscribing directly also makes the panel exactly the same kind of client as the
Stream Deck and Home Assistant, which is the property that keeps renderers
disposable.

Browsers cannot speak MQTT over raw TCP, hence WebSocket (EMQX serves it on
8083 at `/mqtt` by default).

**Consequences, both accepted.**

- Three variables beyond the brief's list: `ROOST_MQTT_WS_URL`,
  `ROOST_MQTT_RENDERER_USER`, `ROOST_MQTT_RENDERER_PASSWORD`.
- **A broker credential is handed to a browser page.** It is served only over
  loopback, and `.env.example` documents that this should be a separate
  subscribe-only account with an EMQX ACL that cannot publish. If unset it falls
  back to the daemon credential, which works but is worse — the page would then
  hold a credential that can write to the topic every surface trusts.

**What changes if wrong** (say EMQX has no WebSocket listener and one cannot be
enabled): the fallback is an SSE endpoint on the daemon, and the panel then
needs its own dead-man's-switch, because it would no longer be able to see the
Last Will. That is strictly worse and would want writing down as a known gap.

---

## D-005 — `since` added to the v1 payload

**Decision.** The payload carries an optional `since` — when the winning agent
entered its current state. `v` stays `1`.

**Why.** The delivery plan requires elapsed time on the panel ("elapsed time is
what makes seconds-to-tens-of-seconds legible instead of alarming"), and no
field in the contract as specified could express it. `ts` is *publication* time,
so it is rewritten by every 10-second heartbeat; an elapsed timer built on it
would permanently read under ten seconds. Additive, and the contract already
requires renderers to tolerate unknown fields.

**What changes if wrong.** A renderer that does not know the field falls back to
timing from when it first saw the state — less accurate across a renderer
restart, never misleading. Removing it would be a `v` bump.

---

## D-006 — Tie-breaking within the same state

**Decision.** When several agents share the winning state, the one that entered
it **earliest** wins, then by agent id.

**Why.** The specified order settles precedence *between* states but not within
one. Oldest-first means the agent that has been stalled longest, or waiting on a
human longest, is the one named — which is the one most likely to need
attention. The id fallback exists purely so input ordering can never change
output; there is a test asserting exactly that.

**What changes if wrong.** One comparator in `daemon/aggregate.js` and its test.

---

## D-007 — Truncation marks the cut with an ellipsis

**Decision.** `label` is cut to 63 characters plus `…`, so the result is never
longer than the 64-character contract maximum.

**Why.** The brief fixes the maximum but not the manner. A silent cut mid-word
reads as a corrupted string; a visible `…` reads as "there is more, and it is
elsewhere", which matches the handoff principle — long content is meant to go to
your phone, not onto the panel.

**What changes if wrong.** One function, `truncateLabel`.

---

## D-008 — The panel workspace required changing two Omarchy keybindings

**Decision.** `config/hypr/roost.lua` rebinds `SUPER+TAB`, `SUPER+SHIFT+TAB` and
`SUPER+scroll` from `workspace e+1/e-1` to `workspace m+1/m-1`.

**Why.** The requirement that the panel workspace not appear in cycling could
not be met any other way on Hyprland 0.56.2. Omarchy's defaults cycle **every
workspace across all monitors**, which was verified to land on `roost` and drag
focus onto the panel output. No workspace rule on this version hides a workspace
from cycling. The monitor-scoped dispatcher does exactly what is wanted and
behaves identically on the main monitor.

**What changes if wrong.** Delete that section of `roost.lua`. The panel still
works; it just becomes reachable with TAB. Flagged prominently in
`config/README.md` because it touches daily-driver keybindings.

---

## D-009 — Panel placement is done by a script, not purely by window rules

**Decision.** `scripts/launch-panel.sh` performs two placement steps that the
declarative config could not.

**Why.** Both verified by hand on 0.56.2 and documented in `config/README.md`:
a `fullscreen = true` window rule is accepted but does not apply (the window
maps at 1024×574 instead of 1024×600), and a `default = true` workspace rule
does not claim an output that a numbered workspace already owns — which is
always, because Hyprland assigns one as the monitor connects.

**What changes if wrong** (or once a later Hyprland fixes these): delete steps 5
and 6 of the script. The window rules are already in place and would simply
start working.

---

## D-010 — ~~Verified against a headless output, not the real panel~~ **CLOSED 2026-08-23: verified on the panel**

**Decision.** All Hyprland verification used a Hyprland headless output sized to
1024×600. `config/hypr/roost-monitor.lua` ships a **placeholder** description
with `verified = false`.

**Why.** The Waveshare panel was not plugged in: all three DisplayPorts read
`disconnected` and `HDMI-A-1` held the Dell ultrawide.

**What this does and does not prove.** It proves the workspace binding, the
window rule, fullscreen geometry at exactly 1024×600, reload survival, and the
cycling fix. It does **not** prove description matching for *this* panel, because
headless outputs report an empty description. Description matching was verified
separately against the Dell, which has one.

**Remaining step.** Plug the panel in, run `./scripts/derive-monitor.sh`, copy
the result to `~/.config/hypr/`, and `hyprctl reload`. Nothing else should need
to change.

> ### ✅ CLOSED 2026-08-23 — done, and nothing else did need to change
>
> The panel is connected on `HDMI-A-1`. `derive-monitor.sh` → copy →
> `hyprctl reload` was exactly the whole procedure, `hyprctl configerrors`
> printed nothing, and the renderer came up fullscreen at 1024×600 on the first
> attempt. `roost-monitor.lua` now carries the real description and
> `verified = true`.
>
> **Description matching is now proven for this panel**, which is the part the
> headless stand-in could not prove. The description is
> `Lenovo Group Limited LEN L1950wD B3432845` — a **cloned EDID**, not a real
> Lenovo: serial `0x01010101` is a placeholder and the max image size is
> 15cm × 10cm, a 7" panel. The name is fiction but the string is stable, which
> is all the selector needs. One consequence worth noting: a genuine
> L1950wD attached later would collide.
>
> **Two things the stand-in could not have surfaced:**
>
> 1. The EDID advertises 1920x1080, 1440x900 and 1280x720. The hardware refuses
>    to sync all three; the output stays at 1024x600. No fallback should assume
>    otherwise.
> 2. **There is no touch input.** Video is connected, touch is not — these
>    panels carry touch on a separate USB lead and it has never enumerated. See
>    the blocker at the top of `docs/M2-touch-approvals.md`.
>
> The stand-in technique itself is still documented in `config/README.md` and
> still works; it remains the way to exercise this on hardware without a panel.

---

## D-011 — An in-process broker for development and tests

**Decision.** `scripts/dev-broker.js` runs `aedes` on loopback (TCP 1883,
WebSocket 8083), as a **dev dependency only**.

**Why.** There is no broker on this machine, and pointing tests at the shared
EMQX would publish test traffic onto an instance that Home Assistant and
Zigbee2MQTT depend on. A local broker also makes Last Will and reconnection
genuinely testable — `test/publisher.test.js` cuts real sockets and asserts on
what a real subscriber receives, rather than mocking the client.

**What changes if wrong.** Nothing in the daemon; the broker is test scaffolding
and the daemon has no idea it exists.

---

## D-012 — roost holds its own device token, stored locally, not the shared gateway token in 1Password

**Decision.** roost pairs with the OpenClaw gateway as a **device** and keeps the
token that pairing mints, scoped `operator.read`. That token lives at
`~/.local/state/roost/openclaw-device.json`, mode 0600, beside the Ed25519
private key it is bound to. It is **not** stored in 1Password.

**Why not the shared gateway token.** The obvious route was to copy
`/var/lib/labby/credentials/gateway-token` into the Homelab vault and reference
it from `.env`, which is how every other roost credential works. It would have
worked. It was still wrong on two counts:

- It is the **same credential** the iPhone and the Control UI use. Rotating it
  because roost was compromised would break all three at once.
- It carries far more than roost needs. roost reads presence; that token can do
  anything the gateway permits.

The gateway's own client guide settles it: *"Do not create a per-client bearer
token by hand-editing `openclaw.json` … let device pairing mint the client
token."* Device pairing gives a named, scoped, independently revocable
credential — `openclaw devices revoke` kills roost's access alone.

**Why not 1Password, given every other secret here is a `op://` reference.** The
device token is bound to an Ed25519 private key that must exist on this machine.
The token is useless without that key, and the key cannot meaningfully live in a
vault, so 1Password would hold **half a credential** — enough to feel backed up,
not enough to restore. Recovery is re-pairing, which is one command. This
deliberately departs from the `.env` + `op run` pattern used for the broker
credentials, and the departure is the point: those are portable secrets, this is
a machine-bound one.

**How the shared token is still used.** Once, for bootstrap authentication
during pairing, piped on stdin so it never reaches argv, shell history or a
process listing. It is written nowhere.

**Scope.** `operator.read` covers `sessions.list`, `sessions.subscribe` and
read-only events, and nothing else — roost cannot start a run, send a message or
answer an approval. M2 needs `operator.approvals`; per the gateway docs a scope
upgrade raises a **fresh pairing request** rather than silently widening an
existing token, so that is an approval step, not a rebuild.

**What changes if wrong.** Re-pair. `scripts/pair-openclaw.mjs` is idempotent and
refuses to run twice; deleting the device file forces a fresh identity and a new
pairing request.
