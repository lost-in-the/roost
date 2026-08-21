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

## How to change the schema

1. Edit `schema/agent-state.vN.schema.json`.
2. Add an entry here saying **what changed and why**, not just what.
3. Update `daemon/aggregate.js` and its tests in `test/aggregate.test.js`.
   Aggregation is the only producer, so the schema boundary is that one file.
4. Update `renderer/app.js` if the field is displayed. The renderer must keep
   working against a daemon that does not yet send it.
5. Run `npm test`.
