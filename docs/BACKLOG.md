# Roost backlog

These are observed gaps and deliberately deferred ideas.  They are not implied
authorisation to widen the state contract, reveal more Gateway data, or turn a
renderer into an aggregator.

## Acceptance — exercise a genuinely gated Omar Claude request on glass

**Observed 2026-08-31.** Both configured Gateways are healthy and visible to
Roost, but Omar's normal Discord Bash path is not approval-gated: it executes
or is rejected by its service/filesystem boundary without emitting a
`session.approval`.  A request through its stated approval-capable broker path
did not create a pending projection during the on-device check.

**Classification.** This did not establish a broken Omar approval path.
D-015's owner-authorized spike already proved Claude-native pending, replay,
expiry and source-local resolution on Omar. Omar-Codex is deliberately
approval-free, a filesystem denial grants no authority, and typed-broker
signatures are a separate surface.

**Exercised 2026-09-01.** Omar has configured Claude models and Roost's paired
device holds `operator.approvals`. Its policy was changed from `ask=off` to
`ask=on-miss` for one harmless stdout-only Claude turn. The request produced a
pending projection on the physical panel, survived reviewer reconnect, and was
denied source-locally without executing; the policy was then verified restored
to `ask=off` for Omar, Omar-Codex, and Omar-Review. Labby passed the same drill
under its existing `ask=on-miss` policy. Terminal removal reached Roost in well
under one second on both Gateways.

The item remains open for one precise reason: both live cards were generic
`Claude native tool: Bash` handoffs, with no answer buttons. Transport and Omar
policy feasibility are no longer unknown. Do not tick “a harmless approval from
each Gateway is answered from the panel” until OpenClaw supplies the bounded
purpose summary described below and the resulting safe card is actually
answered on glass.

**Boundaries.** Select an actual policy-gated Omar Claude operation; do not
consume legacy raw approval events, borrow another Gateway's device identity,
or treat a filesystem refusal as an approval.

## Partial — attribution shipped; upstream-safe purpose summary still needed

**Observed 2026-08-31.** The live card read `Claude native tool: Bash`.  That
identifies the tool family, not the calling agent or the decision being asked
of the operator.

**Current constraint.** The full Gateway presentation is sensitive.  Roost
must not expose raw commands, arguments, paths, patches, details, session keys,
or reviewer bindings to MQTT, logs, browser state, or fixtures.  The existing
64-character cap is a safety boundary: a summary that does not fit becomes a
handoff rather than an approvable question.

**Shipped 2026-08-31.** D-017 adds reviewer-safe actor plus Gateway attribution,
an always-visible actor roster, and a prompt-local bounded summary field. Raw
description/detail remains excluded. Generic Claude-native titles are now
handoffs because `Bash` is not enough information to approve an action.

**Remaining upstream work.** OpenClaw needs to supply an explicitly bounded,
persistence-safe purpose summary. Roost must not derive one by parsing commands
or serialized tool input. When that exists, add it to the allowlist and keep the
64-character handoff boundary.

The projection requirements remain:

- a stable, human-readable actor identity (including the owning Gateway where
  useful), not an opaque run or session id;
- a short, safe action summary that tells the operator what the decision means;
- composition rules for identity plus summary within the 64-character boundary.

The renderer should display only the daemon-projected fields.  It must never
derive agent identity or action safety from a raw Gateway label.

## Done 2026-08-31 — show approval time remaining

**Observed 2026-08-31.** The footer counts upward from the winning agent's
`since` time.  For an approval this is useful context, but it does not tell the
operator how long remains before the request expires.

**Current capability.** `prompt.expires_at` is already in the safe contract.
The renderer independently disables a prompt at that instant, even if the
daemon cannot republish.

When `expires_at` is non-null, the renderer now shows a clearly labelled
wall-clock countdown such as `expires in 1m 42s`; it must reach zero at the
same boundary that disables the controls.  Do not derive it from MQTT
heartbeat timestamps.  Define an honest alternative for non-expiring prompts
instead of inventing a deadline.

## Done 2026-08-31 — daemon-owned multi-agent approval queue and roster

Roost still carries one selected `prompt`, now backed by a daemon-owned queue:

1. Every source-local pending projection reaches aggregation.
2. `aggregate()` orders them by earliest expiry, creation time, then qualified
   prompt id.
3. MQTT carries the selected prompt plus `{position: 1, total}`. The renderer
   draws one full card and says how many more decisions wait.
4. The daemon publishes an always-visible roster grouped by actor and Gateway.
   It contains state/counts, never session ids or per-run labels.

There is deliberately no touch navigation. Expiry, cancellation, or resolution
elsewhere removes the authoritative item and lets the next one surface. Tests
cover three prompts, equal deadlines, per-session ordering, qualified ids, and
first-answer races.

## Future — 1Password request handling on Roost

The operator would eventually like to accept 1Password requests from the
panel.  This is a separate capability, not a generic reuse of M2 controls:
it needs its own source integration, a reviewed safe projection, least-privilege
authority, expiry/replay behaviour, and a decision about what (if any) request
metadata can be shown on glass.  Do not put 1Password credentials or raw
request payloads in the renderer or MQTT contract.

## Deferred — Stream Deck compatibility observation

M2 does not add, migrate, or modify a Stream Deck integration. The device is a
legacy compact status surface alongside Roost, not an approval surface, and the
MQTT contract was deliberately kept additive so an existing subscriber can
continue unchanged.

The USB device is attached on the panel host, but no local process or service
currently owns its HID interface. Hardware presence alone cannot satisfy the
acceptance item. If the old integration is located or restored, observe one
ordinary agent-state transition and record whether it still updates without a
configuration change. If that integration has been retired, revise the
acceptance item explicitly; do not build a new Stream Deck integration solely
to manufacture backwards-compatibility evidence.

## Low priority — determine why compositor captures retain a pointer

Exact-output `grim` captures of the 1024×600 panel include a pointer near the
centre even though the renderer declares `cursor: none` and `grim` is called
without its include-cursor option. Treat this as a capture/Hyprland diagnostic
until it is confirmed on the physical glass; do not post-process debugging
captures in a way that makes them stop representing the real output.
