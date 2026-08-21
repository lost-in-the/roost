/**
 * Aggregation: many agents in, one reconciled state out.
 *
 * This module is the only place aggregation happens. Renderers subscribe to the
 * result and never re-derive it, because two surfaces that can disagree make
 * both untrustworthy.
 */

/** Displayed-state precedence. Higher index wins. */
export const STATE_PRIORITY = ['idle', 'listening', 'thinking', 'stalled', 'needs_attention'];

/** Urgency precedence. Higher index wins. */
export const URGENCY_PRIORITY = ['ambient', 'notify', 'blocking'];

/** Contract maximum for `label`. Enforced here, at the schema boundary. */
export const MAX_LABEL_LENGTH = 64;

const ELLIPSIS = '…';

/** Second-resolution ISO 8601. The contract shows no milliseconds. */
function isoSeconds(epochMs) {
  if (epochMs == null) return null;
  return new Date(epochMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Truncate to the contract maximum, marking the cut so the renderer can trust the string. */
export function truncateLabel(label) {
  if (typeof label !== 'string') return null;
  if (label.length <= MAX_LABEL_LENGTH) return label;
  return label.slice(0, MAX_LABEL_LENGTH - 1) + ELLIPSIS;
}

function rankState(state) {
  const rank = STATE_PRIORITY.indexOf(state);
  if (rank === -1) {
    // `offline` is deliberately absent: only the broker declares offline, via LWT.
    throw new Error(`aggregate: unrankable state ${JSON.stringify(state)} from a state source`);
  }
  return rank;
}

function rankUrgency(urgency) {
  const rank = URGENCY_PRIORITY.indexOf(urgency);
  return rank === -1 ? 0 : rank;
}

/**
 * @param {Array} agents  Agent records: { id, state, label, runId, urgency, since }
 * @param {{now?: number}} [opts]
 * @returns {object} a v1 state-contract payload
 */
export function aggregate(agents, opts = {}) {
  const now = opts.now ?? Date.now();
  const ranked = agents.map((a) => ({ ...a, _rank: rankState(a.state) }));
  const active = ranked.filter((a) => a.state !== 'idle');

  // Deterministic winner: highest state, then longest time in it, then id.
  // Input order must never change the output.
  const winner = active.slice().sort((x, y) =>
    y._rank - x._rank ||
    (x.since ?? 0) - (y.since ?? 0) ||
    String(x.id).localeCompare(String(y.id))
  )[0];

  // Urgency is the max across ALL non-idle agents, independent of who won the
  // state race. A quietly-thinking agent that is blocking still raises urgency.
  const urgency = active.reduce(
    (max, a) => (rankUrgency(a.urgency) > rankUrgency(max) ? a.urgency : max),
    'ambient',
  );

  return {
    v: 1,
    ts: isoSeconds(now),
    state: winner ? winner.state : 'idle',
    count: active.length,
    label: winner ? truncateLabel(winner.label) : null,
    urgency,
    primary_run_id: winner ? (winner.runId ?? null) : null,
    // Additive to the v1 contract: when the winning agent entered its current
    // state. `ts` is publish time and cannot express elapsed. Renderers that
    // predate this field ignore it, per the tolerate-unknown-fields rule.
    since: winner ? isoSeconds(winner.since ?? null) : null,
  };
}
