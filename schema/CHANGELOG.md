# State contract changelog

The contract is the asset; renderers are disposable. Every screen (this panel,
the Stream Deck, Home Assistant later) subscribes to the same payload, so
changes here are the expensive ones.

## Compatibility rules

- **Renderers MUST tolerate unknown fields.** That is what makes additive
  changes free.
- **Additive change** (a new optional field): keep `v` the same. Old renderers
  ignore the field, new ones use it. Record it below.
- **Breaking change** (removing a field, renaming one, changing a type, or
  adding an enum value old renderers cannot handle): bump `v`, add a new
  `agent-state.vN.schema.json`, and publish both versions until every
  subscriber is updated.
- Adding a value to `state` or `urgency` is **breaking in practice** even though
  it looks additive, because a renderer that switches on the value has no
  branch for it. The panel degrades unknown states to `idle` rather than
  breaking, but do not rely on other subscribers being that forgiving.

## v1 — 2026-08-21

Initial contract. Topic `roost/agents/state`, retained, with a Last Will.

| Field | Type | Notes |
|---|---|---|
| `v` | `1` | Schema version |
| `ts` | ISO 8601, second resolution | Publication time. **Absent on the Last Will payload.** |
| `state` | enum | `idle` `thinking` `listening` `needs_attention` `stalled` `offline` |
| `count` | integer | Number of **non-idle** agents |
| `label` | string ≤64 or null | Truncated **in the daemon** |
| `urgency` | enum | `ambient` `notify` `blocking`; max across non-idle agents |
| `primary_run_id` | string or null | Run id of the agent that won the state race |

### Additive within v1

- **`since`** (2026-08-21, same day as initial). ISO 8601 or null. When the
  winning agent entered its current state.

  Added because the delivery plan requires elapsed time on the panel
  ("elapsed time is what makes seconds-to-tens-of-seconds legible instead of
  alarming") and no v1 field could express it: `ts` is publication time and
  therefore resets on every 10-second heartbeat, which would make an elapsed
  timer built on it permanently read near zero.

  Additive, so `v` stays 1. A renderer that does not know the field falls back
  to timing from when it first saw the state, which is less accurate across a
  renderer restart but never wrong in a way that misleads.

- **`prompt`** (2026-08-25). Object or null. The open question from the agent
  named by `primary_run_id`: `{ id, kind, reversible, expires_at }`.

  Added for M2 (touch approvals). No v1 field could express it: `state:
  needs_attention` says a human is needed, and `primary_run_id` names the run,
  but one run can ask several questions in sequence — so answering has to name
  the *question*, and nothing in v1 did.

  Additive, so `v` stays 1, and the degradation is the point: a renderer that
  does not understand `prompt` shows `needs_attention` with no buttons. That is
  the correct fallback rather than a broken one — it says something needs you and
  sends you to a laptop. The Stream Deck keeps working untouched.

  Three properties that are load-bearing rather than incidental:

  - **`null` is not the same as absent.** Null means this daemon supports prompts
    and there is none; absent means the daemon predates the field. Only the first
    means buttons are ever possible, and a renderer that cannot tell them apart
    has to guess about its own capabilities.
  - **`reversible` is asserted by the daemon.** It drives one-tap versus a second
    confirm. A renderer inferring it from label text will eventually infer it
    wrong and silently one-tap something destructive.
  - **An invalid or expired prompt is dropped, not published.** `aggregate.js`
    fails closed to no prompt and logs why. It deliberately does NOT throw the
    way an unrankable `state` does: a wrong state misleads, whereas a missing
    prompt lands on the documented degraded rendering, so taking the whole state
    feed down over a malformed approval would be strictly worse and no safer.

- **`prompt.kind: "handoff"`** (2026-08-25). A second value for `prompt.kind`,
  meaning the question exists and is not answerable on this surface. The renderer
  says a decision is waiting and draws no buttons.

  The daemon applies it whenever the winning agent's `label` had to be truncated,
  or is missing entirely, at the same boundary where truncation happens. The
  64-character cap is a feature rather than a budget: if a decision cannot be
  made safely from a 64-character summary, it is not approvable on glass. See §2
  of `docs/M2-touch-approvals.md`, which is where the rule comes from.

  **This is additive, despite the rule above about enum values.** Adding a value
  to `state` or `urgency` is breaking in practice because renderers switch on
  them with no branch for the new value. `prompt.kind` is different, and
  deliberately so: the schema has always required a renderer to treat an unknown
  kind as *no prompt*. So a renderer that has never heard of `handoff` shows
  `needs_attention` with no buttons — which is already almost exactly the right
  rendering, and is safe in the direction that matters. That requirement is the
  thing that makes new kinds cheap, so do not relax it.

  Two properties worth keeping:

  - **Downgrade, do not drop.** A dropped prompt is indistinguishable from an
    error or from a daemon that predates prompts. The panel is supposed to show
    that a decision is waiting elsewhere; that is designed behaviour, not a
    failure state, and it cannot show what it was not told.
  - **The daemon can only ever make a prompt less approvable, never more.** A
    source may assert `handoff` itself when it knows a decision needs real
    review, and a short label must never promote that back to one tap. Validity
    is checked *before* the downgrade, so a malformed or expired prompt is still
    dropped rather than surfacing as a handoff — a dead question is not a
    decision waiting for you anywhere.

### Decisions baked into v1

- **`primary_run_id`, not `run_id`.** The old name implied a single run in a
  payload that aggregates many.
- **The Last Will carries no `ts`.** The will is fixed at connect time, so a
  timestamp in it would be arbitrarily stale by the time the broker sent it and
  would corrupt any staleness calculation downstream. Subscribers treat
  `state: "offline"` with no `ts` as "offline as of now", handling the missing
  field explicitly rather than defaulting it.
- **`offline` is never produced by aggregation.** It describes the daemon, not
  an agent. `daemon/aggregate.js` throws if a source ever reports it.
- **`count` counts non-idle agents.** "3 agents, all idle" is not information a
  glanceable panel should shout about.

## Instrument topic v1 — 2026-08-21

Topic `roost/instrument/laptop-opens`, **retained**, **no heartbeat**, **no Last Will**.

```json
{ "v": 1, "count": 4, "last": "2026-08-21T23:15:17Z" }
```

| Field | Type | Notes |
|---|---|---|
| `v` | `1` | Versioned independently of the agent-state contract |
| `count` | integer | Total recorded laptop-opens |
| `last` | ISO 8601 or null | When the most recent one happened |

### Why this is not part of the agent-state payload

- **Different subject.** Agent state is about agents. A human-tapped counter is
  a different kind of fact, and folding it in would mean every agent state
  change republishes an unrelated number.
- **Opposite failure semantics.** Agent state goes stale and must be disbelieved
  after 30 seconds. The counter does not: it changes only when a human taps it,
  so a retained value from last week is still exactly correct. One topic cannot
  carry both rules honestly.
- **Therefore no heartbeat and no Last Will here.** A dead daemon leaves the
  last count retained, which remains true, because a tap cannot be recorded
  while the daemon is down (the browser queues it and retries).

Subscribers must not treat a message on this topic as evidence the state feed is
alive. `renderer/topics.js` enforces that, with a test.

## How to change the schema

1. Edit `schema/agent-state.vN.schema.json`.
2. Add an entry here saying **what changed and why**, not just what.
3. Update `daemon/aggregate.js` and its tests in `test/aggregate.test.js`.
   Aggregation is the only producer, so the schema boundary is that one file.
4. Update `renderer/app.js` if the field is displayed. The renderer must keep
   working against a daemon that does not yet send it.
5. Run `npm test`.
