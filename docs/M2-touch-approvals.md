# M2 — Touch approvals: design note

**Status:** design only, nothing built. Written 2026-08-21, immediately after M1
shipped, while the reasoning was fresh. **Blocked on hardware as of 2026-08-23 —
see the blocker below.** The §6 gateway dependency is resolved; roost is paired
and reading live agent state.

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

§6's gateway dependency is also resolved: roost is paired and reading live agent
state. What M2 still needs is the approvals scope (`operator.approvals`), which
raises a fresh pairing request rather than silently widening the existing token.

---

## 1. What M1 already gives you

More than you might expect. The contract was designed with this in mind.

| Already there | Why it matters here |
|---|---|
| `state: needs_attention` | A distinct, persistent, deliberately loud state. Already the only state permitted to be loud. |
| **`primary_run_id`** | The handle for answering **one specific run**, not "whatever is on screen". This is the field that makes approvals possible at all. |
| `urgency: blocking` | Already separates "needs a decision from you" from "worth a glance". |
| The daemon's loopback HTTP server | A return path already exists and is already trusted. See §3. |
| `data-stale` on the renderer root | Free kill switch for the buttons. See §4.4 — this one matters more than it looks. |
| 1024×600 touch glass | Two ~480×220 targets. Enormous. Touch is connected and bound; the tap path is verified end to end. |

**The panel is the easy half.** Everything hard is in §3 to §6.

---

## 2. The 64-character rule, which is load-bearing

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

## 5. Contract changes

Additive, so `v` stays **1**. Renderers are already required to tolerate unknown
fields.

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

## 6. ⚠ The dependency that gates everything

**M2 cannot be finished until the OpenClaw mechanism is resolved** — see
`DECISIONS.md` D-001, still open because OpenClaw is not installed on this
machine.

Approvals ask **more** of that interface than M1 does:

| | M1 | M2 |
|---|---|---|
| Needs | OpenClaw to **push** state out | OpenClaw to **accept** an answer in |
| Hooks | Sufficient | Probably not — a hook can fire on an event, but does not obviously give you a way to hand a decision back |
| Consequence | — | May force the gateway/API option, even though it lost on latency for reads |

> ### ✅ RESOLVED 2026-08-22 — it is the gateway client, and the socket is a trap
>
> Investigated against a live OpenClaw **2026.7.2-beta.7** runtime on the same machine roost runs on.
> The dependency above is settled; §6 no longer gates M2.
>
> **Build a gateway operator client. Do not build a socket responder.**
>
> There is an `exec-approvals.sock` path in the approvals config, and it looks exactly like the
> answer: OpenClaw connects as the client, the responder binds, one JSONL line each way
> (`{"type":"request",token,id,request}` → `{"type":"decision",decision}`). **It is dead code in this
> release.** `requestExecApprovalViaSocket` has *zero* call sites — four files mention it, being the
> definition plus three re-export barrels, one of them a `.d.ts`. No socket file exists on disk. The
> path *is* consumed, but by `requestExecHostViaSocket`, a different protocol gated on
> `platform === "darwin"`: it is the Mac companion **exec transport**, not an approval responder.
> The name is a red herring and would cost you the milestone.
>
> **The real surface**, both verified live:
>
> | Flow | Methods |
> |---|---|
> | Claude-native tools (Bash, Read, …) | `plugin.approval.request` → `plugin.approval.waitDecision` / `.list` / `.resolve` |
> | OpenClaw's own exec tool | `exec.approval.request` / `.waitDecision` / `.resolve`, broadcast as `exec.approval.requested` |
>
> Answer both; they are different agents' paths. Demonstrated end to end: a prompt was raised,
> answered in a browser client, and resolved in **4944 ms**.
>
> **Latency is no longer the objection it was.** The concern above assumed a remote gateway. The
> local gateway is loopback on this same host, so the gateway/API option does not pay the cost that
> made it lose for reads.
>
> **Four constraints that change the design — read these before §2:**
>
> 1. **An approval needs a *connected* client at the moment it is raised.** With none connected the
>    gateway returns no id and the call denies in ~5 s with reason `unavailable`. **Nothing is
>    queued**, and `approvals pending` stays empty. So roost must hold a persistent connection, not
>    poll. A roost outage means denials, not a backlog.
> 2. **`Bash` can never earn allow-always.** The decision set is forced to `["allow-once","deny"]`
>    whenever the tool is `Bash`. Every single run prompts; roost cannot mint a durable grant, and
>    any UI affordance implying "always allow" would be lying.
> 3. **Late-decision auto-answer must match on content, not ids.** An expired approval cannot be
>    re-opened — but a retry raises a *fresh* one, which is how "approve after the fact" is
>    achievable at all. `toolCallId` is regenerated per retry and there is no deterministic id on the
>    native path, so match on `agentId` + `toolName` + `detail` (which carries the compact command
>    JSON).
> 4. **Timeouts:** 120 s default for a plugin approval (600 s max). Oversized Bash inputs are denied
>    outright *before* any prompt is raised, so some requests will never reach the panel.
>
> Evidence and the fuller reasoning: `homelab` repo, `docs/open-questions-2026-08-22.md` Q3, and
> backlog item 074.

**This is the only part that cannot be designed around now.** Everything in §2
to §5 can be built and verified against the mock first, exactly as M1 was: extend
`MockStateSource` to emit approval-shaped prompts, build the UI, wire the tap to
the daemon, and stub the OpenClaw relay behind the same `StateSource`-style seam.

A working two-button prompt driven by a mock is a legitimate M2 milestone, for
the same reason it was in M1.

---

## 7. Decide before building

1. **Which OpenClaw mechanism accepts an answer.** Gates everything. Read the
   existing Stream Deck integration first, read-only, for how state gets out
   today.
2. **How a second answering surface (Home Assistant) authenticates.** §3.
3. **Whether `reject` needs a reason.** Probably not on glass — a reason is
   long-form content, which by §2 is a handoff.
4. **Prompt timeout length**, and what OpenClaw does when nobody answers. This is
   OpenClaw's policy, not the panel's, but the panel has to display the result.

## 8. Do not

- Add a `detail` field to fit longer approvals on the panel. §2.
- Let the renderer decide whether something is reversible. §4.1.
- Give the browser a broker credential that can publish. §3.
- Allow approvals while the panel is stale. §4.4.
- Serve an approval route from a non-loopback `ROOST_HTTP_HOST`. Already enforced
  at startup by `daemon/approval-exposure.js`, which refuses the scope-plus-bind
  combination before anything listens — so the route does not need its own check,
  but do not weaken that guard to make a remote panel work.
- Modify or migrate the Stream Deck integration. It keeps running unchanged.

## 9. Definition of done, when it is built

- [ ] A reversible prompt is approved from the panel and the run continues
- [ ] A destructive prompt requires a deliberate second confirm
- [ ] Answering the same prompt twice is rejected by the daemon, not the browser
- [ ] Answering on the laptop makes the panel buttons disappear within 5 seconds
- [ ] Blocking the broker for 35 seconds makes the buttons dead, not just stale-looking
- [ ] A prompt past `expires_at` is dead with no new message required
- [ ] A label that cannot be summarised in 64 characters becomes a phone handoff
      instead of an approvable prompt
- [ ] The Stream Deck still works, unchanged and unmodified
