# M2 — Touch approvals: design note

**Status:** protocol spike completed 2026-08-27; Claude-native approvals passed
on both Gateways, but the required Omar Codex ACP/harness projection failed, so
feature implementation remains stopped pending a scope decision or runtime
fix. Written 2026-08-21, immediately after M1 shipped, while the reasoning was
fresh. The 2026-08-23 hardware blocker is resolved. Homelab backlog 128 calls
this work M3; this repository retains the original Roost milestone name, M2.

Built so far, in the order §8 required:

- **The bind-address guard** (2026-08-25). `daemon/approval-exposure.js`. Refuses
  to start when roost holds `operator.approvals` on a non-loopback bind.
- **The `prompt` contract field** (2026-08-25). §5 below, in `aggregate.js`, the
  schema, and the mock's demo loop.
- **The §2 handoff rule** (2026-08-25). `prompt.kind: "handoff"`, decided at the
  same boundary that truncates. §2 records the shape and why.

Not built yet: the return path (§3) and the renderer's buttons. Nothing on the
panel draws a button today; a `prompt` in the payload is currently a field only
the schema and the tests observe.

**Goal:** answer an agent's approve/reject prompt from the panel, without
opening a laptop. That is the second half of the project's success metric —
M1 made agent activity *visible*, M2 makes the common case *answerable*.

> Read this cold in a month and you should be able to start building without
> re-deriving anything. The one thing you cannot start without is §6.

---

## ✅ UNBLOCKED 2026-08-24 — touch works

The blocker recorded here on 2026-08-23 is resolved. It was two problems, and
only the first was the one originally diagnosed:

1. **The USB touch lead was not connected.** These panels carry video on HDMI
   and touch on a separate USB cable. Connecting it made
   `WaveShare WS170120` (USB `0eef:0005`) appear.
2. **Touch was not bound to the panel's output**, which is the part that would
   have wasted a day if the cable had been the only fix. Hyprland scales
   normalised touch coordinates onto whichever monitor has FOCUS, so with the
   cable connected but no binding, taps still landed on `sunshine-vd` —
   measured at 2127,613 for a tap on the centre of the glass. Fixed in
   `config/hypr/roost.lua` section 1b, per-device so Sunshine's virtual
   `touch-passthrough` keeps targeting `sunshine-vd`.

Verified end to end: three taps on the `lc-corner` button drove the counter
0→1→2→3 through `POST /api/laptop-open`. **So the tap path in §3 is proven on
real glass**, which was the part of this design that could not be tested before.

Labby presence remains the sole production connection. The Labby scope upgrade,
separate Omar pairing, and owner-authorized protocol spike are complete, but
pairing alone does not make Roost dual-Gateway. §6 remains blocked on the
missing Codex projection; implementation must wire the two existing identities
only after that scope decision or runtime repair.

---

## 1. What M1 already gives you

More than you might expect. The contract was designed with this in mind.

| Already there | Why it matters here |
|---|---|
| `state: needs_attention` | A distinct, persistent, deliberately loud state. Already the only state permitted to be loud. |
| **`primary_run_id`** | Correlates visible panel state with one run. It is not an approval handle: resolution uses the approval id and kind through the same Gateway connection that emitted it. |
| `urgency: blocking` | Already separates "needs a decision from you" from "worth a glance". |
| The daemon's loopback HTTP server | A return path already exists and is already trusted. See §3. |
| `data-stale` on the renderer root | Free kill switch for the buttons. See §4.4 — this one matters more than it looks. |
| 1024×600 touch glass | Two ~480×220 targets. Enormous. Touch is connected and bound; the tap path is verified end to end. |

**The panel is the easy half.** Everything hard is in §3 to §6.

---

## 2. The 64-character rule, which is load-bearing — ✅ built 2026-08-25

**Do not add a `detail` field to make longer approvals fit. The cap is the
feature.**

`label` is capped at 64 characters, truncated in the daemon. That is enough for:

> Approve deploy photopush to staging?

It is nowhere near enough for:

> approve this destructive migration

The plan already settled what to do about that, twice:

> Full content review / complex approvals → Phone and browser own this. Only the
> binary case is local.
>
> Label too long for the panel → Truncate at the schema level, not the renderer.
> **Long content is a handoff, by design.**

### The rule that falls out

**If the decision cannot be safely made from a 64-character summary, it is not
approvable on glass.** It becomes the "sent to your phone" handoff, which the
plan treats as *designed behaviour, not a limitation*:

> Needs real review → Shows "sent to your phone," then returns to idle. The
> handoff principle, made visible. Not a failure state.

**The daemon decides which it is**, at the same boundary where it truncates.
Approving something you could not fully read is the exact failure this cap
exists to prevent, and the moment a `detail` field appears the panel starts
becoming the third monitor the whole project is trying not to build.

### The shape it took

`prompt.kind: "handoff"` — a second kind, not a boolean flag, and not a dropped
prompt. `aggregate.js` applies it whenever the winning agent's label had to be
truncated, or is missing entirely.

**Why a kind rather than a flag.** A flag like `approvable: false` is unsafe
under this project's own tolerate-unknown-fields rule: a renderer that ignores
the flag it does not know draws approve and reject buttons on an unreadable
question, which is precisely the failure §2 exists to prevent. A new `kind`
fails the other way. The schema has always required a renderer to treat an
unknown kind as *no prompt*, so an old renderer seeing `handoff` shows
`needs_attention` with no buttons — already almost the right rendering. The
contract degrades toward safety instead of away from it.

**Why downgrade rather than drop.** Dropping the prompt would make a handoff
indistinguishable from an error, or from a daemon that predates prompts. The
plan wants the panel to *show* the handoff — "the handoff principle, made
visible. Not a failure state" — and it cannot show what it was not told.

**No label at all is the same rule, more so.** There is nothing to read, so
there is nothing to approve. A missing or blank label forces a handoff too.

**Validity is checked before the downgrade.** A malformed or expired prompt is
still dropped, not handed off: a dead question is not a decision waiting for you
anywhere, and showing one would send you to a phone for nothing.

**The invariant:** the daemon can only ever make a prompt *less* approvable,
never more. A source may assert `handoff` itself when it already knows a
decision needs real review, and a short label must never promote that back to
one tap. There is a test named for it.

> ⚠ **The daemon does not itself send anything anywhere.** `handoff` asserts
> "not answerable here" and nothing more. Whether the question actually reaches
> a phone is OpenClaw's business, through its own notification channels. So a
> renderer must be careful about the words on the glass: "sent to your phone"
> claims a delivery roost has not made and cannot observe. Something like
> "not for the glass — check OpenClaw" is honest. **Decide this when the
> renderer is built**; the contract does not depend on it either way.

---

## 3. The return path

Everything in M1 flows one way: OpenClaw → daemon → MQTT → panel. An approval
has to travel back.

### Recommended shape

```
panel  ──POST──▶  daemon  ──▶  OpenClaw
       loopback   (relays, validates, republishes)
```

The panel POSTs to the daemon's existing loopback HTTP server. The daemon
validates the answer, relays it to OpenClaw, and immediately republishes state
so every surface updates at once.

### Why not let the panel publish to an MQTT command topic

It would be tidier on paper, and it is wrong here. M1 deliberately gives the
browser a **subscribe-only** broker credential (see `DECISIONS.md` D-004 and
`.env.example`), on the reasoning that *a page that can publish can also forge
the metric*. That applies far more forcefully to approvals: a page that can
publish could approve a production migration.

Keeping the daemon as the only publisher and the only thing that talks to
OpenClaw preserves that posture for free.

⚠ **Open question.** Home Assistant will eventually want to answer too. Either
each surface gets its own trusted path to the daemon, or the daemon subscribes
to a command topic locked down by an EMQX ACL. Decide this before a second
answering surface exists, not after.

---

## 4. Four things that must be right

### 4.1 Only some prompts get one tap

The edge-case table already decided:

> Accidental touch approves something → Only reversible actions get one-tap.
> Destructive ones require a second confirm.

So the payload must carry **which kind it is**, and — same rule as aggregation —
**the daemon asserts it, the renderer never decides.** A renderer that infers
"this looks destructive" from the label text is a renderer that will eventually
get it wrong silently.

### 4.2 A prompt must not be answerable twice

The browser retries on failure (the laptop counter already does this). If a
retry re-answers a prompt, you approve things twice.

The daemon must reject an answer for a prompt id it has already resolved, and
say so plainly enough that the panel can show "already answered" rather than
failing mysteriously.

### 4.3 A prompt answered elsewhere must go dead

If you answer on your laptop, or the run times out, the buttons must stop
working. Otherwise you approve a corpse.

Two mechanisms, covering different failures, exactly like Last Will and
staleness in M1:

- **OpenClaw tells the daemon** the prompt is resolved → daemon republishes
  without it → panel removes the buttons. Fast, and the normal case.
- **`expires_at` in the payload** → the panel dims the buttons on its own,
  without needing a message. The backstop for when the first mechanism fails.

### 4.4 ⚠ A stale panel must never approve anything

**This is the one most likely to be missed, and it is free.**

If the panel has not heard a heartbeat in 30 seconds it is already rendering
"no signal" — it does not know what is true. Buttons on that panel must be
dead. Approving from a surface you have explicitly declared untrustworthy is
precisely the failure mode M1's staleness work exists to prevent.

The renderer already sets `data-stale="yes"` on the root element. Disabling the
buttons is a CSS rule and a guard in the handler. Do not skip it because it is
small.

---

## 5. Contract changes — ✅ built 2026-08-25

Additive, so `v` stays **1**. Renderers are already required to tolerate unknown
fields.

Producer is `daemon/aggregate.js`, as with every other field; the schema is
`schema/agent-state.v1.schema.json` and the reasoning is in
`schema/CHANGELOG.md`. Two things settled during the build that this design note
did not specify:

- **`null` is not the same as absent.** Null means this daemon supports prompts
  and there is none; absent means the daemon predates the field. Only the first
  means buttons are ever possible, so a renderer that cannot tell them apart has
  to guess about its own capabilities.
- **A malformed or expired prompt is dropped, not thrown.** `aggregate.js` throws
  on an unrankable `state`, because a wrong state actively misleads. A prompt is
  different: dropping it lands on the documented degradation below, whereas
  throwing would take the entire state feed down over one bad approval — strictly
  worse and no safer. Every drop is logged, since failing closed *quietly* is the
  real hazard.

```json
{
  "v": 1,
  "ts": "2026-08-21T18:04:11Z",
  "state": "needs_attention",
  "count": 1,
  "label": "Approve deploy photopush to staging?",
  "urgency": "blocking",
  "primary_run_id": "run-1d7e",
  "since": "2026-08-21T18:04:02Z",

  "prompt": {
    "id": "prm_8f2a",
    "kind": "approve_reject",
    "reversible": true,
    "expires_at": "2026-08-21T18:09:02Z"
  }
}
```

| Field | Why |
|---|---|
| `prompt.id` | Distinct from `primary_run_id`: one run can ask several questions in sequence. Answering needs to name the *question*, not the run. |
| `prompt.kind` | Leaves room for later kinds without another contract change. M2 ships `approve_reject` only. |
| `prompt.reversible` | Drives one-tap vs second-confirm. Asserted by the daemon (§4.1). |
| `prompt.expires_at` | The independent backstop from §4.3. |

### The degradation property is the point

**A renderer that does not understand `prompt` shows `needs_attention` with no
buttons.** That is the correct fallback: it says "something needs you" and sends
you to a laptop. Old surfaces stay safe rather than breaking, which is exactly
what the tolerate-unknown-fields rule is for.

The Stream Deck keeps working untouched throughout. Do not modify it.

---

## 6. ⚠ The protocol gate — revised against the pinned runtime

The 2026-08-22 conclusion was right that Roost must be a persistent Gateway
client and wrong about which approval projection a new client should consume.
The raw `exec.approval.*` and `plugin.approval.*` events are compatibility APIs.
They can carry full commands, paths, patches, and prompts, and their list/event
visibility depends on requester and reviewer bindings.

OpenClaw **2026.7.2-beta.7** now provides the safer operator surface:

- Subscribe to an exact session with
  `sessions.messages.subscribe { key, agentId?, includeApprovals: true }`.
- Replace the local pending set from the response's authoritative
  `approvalReplay` whenever `truncated` is false.
- Apply later sanitized `session.approval` pending and terminal events.
- Answer through `approval.resolve { id, kind, decision }` and trust the
  returned canonical approval, including when another surface answered first.

The projection omits raw request objects and reviewer-device bindings, but it
is not content-free. `session.approval` carries `sessionKey` and sometimes
`sourceSessionKey`; `approval.presentation` may carry sanitized command text,
title, description, or detail. Treat the complete projection as sensitive:
route it only through the owning Gateway connection plus its local alias,
derive the 64-character panel label in memory, and never persist the full
presentation to logs, MQTT, browser state, or fixtures. Subscribing remains
observational and does not append transcript rows or wake an agent. Roost must
not consume or log the legacy raw approval event families unless a separate
review proves that a required request has no session audience.

### Two gateways are part of the minimum

Roost currently has one Gateway URL, one device identity, and one complete
source snapshot. Repointing it from Labby (`127.0.0.1:19789`) to Omar
(`127.0.0.1:19791`) would silently remove Labby. M2 therefore requires:

| Gateway | Device identity | Required behavior |
|---|---|---|
| Labby | Existing identity retained and scope-upgraded | Presence plus authorized session approvals |
| Omar | New, separate identity | Presence plus authorized session approvals |

The daemon holds two connections and merges their complete projections.
Gateway aliases qualify every session, run, and approval identifier. Loss of
one connection marks only that Gateway's projection stale; it cannot erase or
relabel the other. Neither device file may be reused against the other Gateway.
No approval, reviewer identity, owner grant, or authorization claim crosses
between Gateways: Roost resolves each approval only through the same connection
that emitted it. The merge is a presentation projection, not federation or an
approval bridge.

Both paired devices require `operator.approvals` to opt into approval replay.
That scope also grants approval-resolution authority; it is not an observe-only
credential. The daemon must expose only the two reviewed decisions supported by
this panel (`allow-once` and `deny`) and must continue refusing a non-loopback
HTTP bind whenever either configured identity has approval authority.

### Native Codex binding is explicitly out of scope

The pinned Codex plugin declines interactive command/file approval requests in
native `/codex bind` conversations. Those requests create no Gateway approval
record, so Roost cannot observe or answer them. The missing Discord-button bug
needs its own runtime fix; Roost must not claim to repair it.

Codex ACP/harness requests were expected to become durable approvals, but the
current Omar harness did not emit one: the live spike failed closed at the
native PreToolUse relay before any `session.approval` existed. Treat this class
as unsupported until the relay is repaired and the spike passes. For any future
repaired path, classify provenance from the stable harness discriminator
`pluginId == "openclaw-codex-app-server"`, never from titles or labels; raw
payloads remain memory-only.

### Mandatory owner-authorized protocol spike

Feature implementation starts only after a live diagnostic proves the exact
behavior on **both** Gateways. This is not read-only: pairing/scope upgrades,
disposable writes, and approval decisions mutate live state and require an
explicitly authorized window plus cleanup.

`scripts/pair-openclaw.mjs` requires `--gateway labby|omar`, selects the fixed
URL, distinct device file, and source-Gateway approval command from that alias,
and refuses unknown or duplicate aliases. Never override those mappings during
the spike.

For each Gateway:

1. Pair or scope-upgrade the final Roost-specific identity; do not create an
   untracked throwaway credential.
2. Subscribe to the intended session with `includeApprovals: true` before
   raising a harmless request.
3. Trigger one harmless read/no-prompt control, one disposable write prompt,
   and one harmless command prompt through the actual runtime used there.
4. Verify pending replay, terminal events, expiry, disconnect/reconnect, and
   canonical first-answer behavior without recording raw payloads.
5. Verify whether the subscription alone counts as an available approval route.
   If a legacy approval-delivery capability is required to keep requests
   pending, do not advertise it until Roost's resolver and failure handling are
   ready; document the connected/disconnected routing change.
6. On Omar, verify ACP/harness approvals appear and native `/codex bind`
   remains absent. On Labby, verify Claude-native approvals acquire a durable,
   authorized session audience. Stop if either required class cannot be
   projected safely.

The spike records only event family, safe presentation kind, offered decisions,
timestamps, and redacted correlation identifiers. No commands, arguments,
paths, patches, prompts, environment values, credentials, or raw JSON may be
persisted.

### Spike result — 2026-08-27

The owner-authorized spike ran against the final paired identities, not
throwaway credentials. Labby retained its identity; Omar received a distinct
identity and device file. Both hold exactly `operator.read` and
`operator.approvals`.

| Probe | Labby | Omar |
|---|---|---|
| No-tool control | No approval projected | No approval projected |
| Claude-native disposable write | Pending `plugin` projection; denied before execution | Pending `plugin` projection; denied before execution |
| Disconnect/reconnect | Replay contained the same pending correlation | Replay contained the same pending correlation |
| Source-local resolution | `applied: true`, then terminal denied | `applied: true`, then terminal denied |
| Two-reviewer harmless command | Winner applied deny; loser returned the same canonical deny without applying | Winner applied deny; loser returned the same canonical deny without applying |
| Unresolved harmless `printf` | Terminal expired at exactly 120 seconds | Terminal expired at exactly 120 seconds |

The diagnostic emitted only the fields allowed by this section. Disposable
markers were absent after every denied/expired run. It did not consume legacy
raw approval events, and it did not log full presentations or session keys.

The subscription used no delivery capability for the passing Claude-native
probes. Because Discord's production approval route remained enabled, this
proves the exact-session subscription can observe and resolve the request; it
does not prove that the subscription alone is what kept it pending. The spike
did not disable a working production route to manufacture that distinction.

The required Codex class failed before the safe projection boundary:

1. A headless `omar-codex` turn denied without emitting any Gateway approval.
2. Advertising the legacy `approvals` capability on the Roost spike client did
   not create a record.
3. Marking the turn's initiating channel as Discord let Codex attempt
   `exec_command`, but its native PreToolUse relay failed closed as unavailable.
   No `session.approval` pending event or replay row appeared and no file was
   written.

This is a gate failure, not a reason to fall back to raw events. Choose one
before implementation: explicitly narrow M2 to Claude-native approvals and keep
Codex unsupported, or repair the Omar Codex native hook relay and rerun this
class of the spike. Native `/codex bind` remains unsupported for the independent
reason already stated above: it creates no Gateway approval record.

### Reconnect and first-answer rules

- Subscribe before declaring the source healthy. With `truncated: false`, the
  replay replaces that session's pending set atomically.
- With `truncated: true`, keep unseen local entries non-actionable until
  canonical lookup or terminal events settle them.
- Disable controls while either source is reconciling or stale.
- Enforce `expiresAtMs` locally as a backstop and re-check immediately before
  resolving.
- Send one `approval.resolve`; never retry automatically after an ambiguous
  transport failure. Freeze controls and reconcile instead.
- Trust the returned canonical approval. If another surface won, display its
  recorded terminal result rather than the local attempted decision.
- Never auto-answer a new approval by matching its content to an expired one.
  The old content-matching proposal is unsafe and is rejected.

A notification-only slice may be built as an internal precursor, but it does
not complete backlog 128 or M2 because it leaves the unavailable approval with
no answering surface.

---

## 7. Build sequence after the spike passes

1. Add dual-Gateway configuration, separate device files, Gateway-qualified
   identifiers, and a coordinator that merges complete source snapshots.
2. Add sanitized approval replay/event projection and canonical resolution,
   with no legacy raw payload crossing the projection boundary.
3. Add the loopback POST route, idempotency/expiry checks, and first-answer
   reconciliation.
4. Add renderer controls: deny is one tap; allow-once follows the existing
   reversible/second-confirm rule. Never offer `allow-always` in M2.
5. Test each Gateway independently, simultaneous operation, collision cases,
   stale/reconnect behavior, resolution elsewhere, ambiguous transport failure,
   and payload absence from MQTT/log/browser state.
6. Deploy only after the pairing/scope change and runtime configuration receive
   separate approval.

Home Assistant as a second answering surface and rejection reasons remain later
decisions. They do not block the panel's first complete approval path.

## 8. Do not

- Add a `detail` field to fit longer approvals on the panel. §2.
- Let the renderer decide whether something is reversible. §4.1.
- Give the browser a broker credential that can publish. §3.
- Allow approvals while the panel is stale. §4.4.
- Consume legacy raw approval events as normal application state. §6.
- Reuse one Gateway device identity or unqualified session id across Labby and Omar. §6.
- Claim that Roost can surface native `/codex bind` approvals. §6.
- Auto-answer a retry by matching command or prompt content. §6.
- Serve an approval route from a non-loopback `ROOST_HTTP_HOST`. Already enforced
  at startup by `daemon/approval-exposure.js`, which refuses the scope-plus-bind
  combination before anything listens — so the route does not need its own check,
  but do not weaken that guard to make a remote panel work.
- Modify or migrate the Stream Deck integration. It keeps running unchanged.

## 9. Definition of done, when it is built

- [ ] A reversible prompt is approved from the panel and the run continues
- [ ] Labby and Omar remain visible simultaneously through separate identities
- [ ] A harmless approval from each Gateway is answered from the panel
- [ ] Native `/codex bind` approvals remain absent and are documented as unsupported
- [ ] A destructive prompt requires a deliberate second confirm
- [ ] Answering the same prompt twice is rejected by the daemon, not the browser
- [ ] Answering on the laptop makes the panel buttons disappear within 5 seconds
- [ ] Another surface winning is shown from the canonical terminal record
- [ ] Reconnecting replaces pending state from authoritative replay without resurrection
- [ ] Blocking the broker for 35 seconds makes the buttons dead, not just stale-looking
- [ ] A prompt past `expires_at` is dead with no new message required
- [ ] A label that cannot be summarised in 64 characters becomes a phone handoff
      — *daemon half done: it emits `kind: "handoff"`. Needs the renderer to show
      it, and needs the wording decided (see the warning in §2).*
      instead of an approvable prompt
- [ ] The Stream Deck still works, unchanged and unmodified
- [ ] MQTT, logs, fixtures, and browser state contain no raw approval payloads
