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

/**
 * Does this label survive the cap intact, so a human can read the whole question
 * on the glass?
 *
 * The cap is the feature (§2 of docs/M2-touch-approvals.md). A question that has
 * to be cut short is a question you would be approving without having read it,
 * which is the exact failure the cap exists to prevent. No label at all is the
 * same failure, more so: there is nothing to read.
 */
export function labelFitsOnGlass(label) {
  return typeof label === 'string' && label.trim() !== '' && label.length <= MAX_LABEL_LENGTH;
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
 * Prompt kinds the panel knows how to render.
 *
 * `approve_reject` draws two buttons. `handoff` draws none: it says this question
 * exists and is not answerable here, so go and read it properly somewhere with
 * room for it (§2). A source may assert `handoff` directly when it already knows
 * a decision needs real review; the daemon also applies it on its own, below.
 */
export const PROMPT_KINDS = ['approve_reject', 'handoff'];

/** The kind for a question that cannot be answered from the glass. */
export const HANDOFF_KIND = 'handoff';

/**
 * Normalise the winning agent's prompt, or return null.
 *
 * FAIL CLOSED, AND DO NOT THROW. `rankState` above throws on a bad state because
 * a payload with the wrong state is actively misleading. A prompt is different:
 * dropping it yields `needs_attention` with no buttons, which §5 of
 * docs/M2-touch-approvals.md already defines as the correct degraded rendering.
 * Throwing instead would take the whole state feed down over a malformed
 * approval — strictly worse, and no safer.
 *
 * Every rejection below is a case where rendering a button would be a guess.
 * The daemon asserts what is approvable; the renderer never decides (§4.1).
 */
function normalisePrompt(prompt, label, now, warn) {
  if (prompt == null) return null;
  const reject = (why) => {
    warn(`dropping prompt ${JSON.stringify(prompt?.id ?? null)}: ${why}`);
    return null;
  };

  if (typeof prompt.id !== 'string' || prompt.id === '') return reject('no usable id');
  // Answering names the QUESTION, not the run, so an unidentified prompt cannot
  // be answered even if it rendered.
  if (!PROMPT_KINDS.includes(prompt.kind)) return reject(`unknown kind ${JSON.stringify(prompt.kind)}`);
  // A kind the panel does not know is a kind it cannot draw the right controls
  // for. Room for later kinds is the point of the field; guessing is not.
  if (typeof prompt.reversible !== 'boolean') return reject('reversible is not a boolean');
  // Absent MUST NOT read as "reversible", which is the one-tap path. A missing
  // assertion is not a safe default in either direction, so there is no prompt.

  const expiresAt = prompt.expiresAt ?? null;
  if (expiresAt !== null && !Number.isFinite(expiresAt)) return reject('expiresAt is not a timestamp');
  // Already dead. §4.3 gives the panel its own `expires_at` backstop for when
  // the daemon cannot republish; this is the daemon doing its half, so a corpse
  // is never advertised in the first place.
  if (expiresAt !== null && expiresAt <= now) return reject('already expired');

  // §2, at the same boundary that truncates, because it is the same judgement:
  // a question that does not fit is a question you cannot fully read, and
  // approving something you could not fully read is what the cap exists to
  // prevent. Downgrade rather than drop — the panel should say a decision is
  // waiting and is not for the glass, which is designed behaviour and not a
  // failure state. Dropping it would make that indistinguishable from an error.
  //
  // Only ever DOWNGRADES. Nothing here can turn a handoff into something
  // answerable by one tap; the daemon can make a prompt less approvable and
  // never more.
  const kind = labelFitsOnGlass(label) ? prompt.kind : HANDOFF_KIND;

  return {
    id: prompt.id,
    kind,
    reversible: prompt.reversible,
    expires_at: isoSeconds(expiresAt),
  };
}

const MAX_ACTOR_LENGTH = 32;

function safeActorPart(value) {
  if (typeof value !== 'string') return null;
  const clean = value.trim();
  // Identity is a security cue. Reject ASCII/C1 controls, line separators and
  // bidi-direction controls rather than letting an actor visually rewrite the
  // order or apparent owner of the text beside an approval button.
  const unsafe = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
  if (clean === '' || clean.length > MAX_ACTOR_LENGTH || unsafe.test(clean)) return null;
  return clean[0].toUpperCase() + clean.slice(1);
}

function actorFor(agent, prompt = null) {
  const gateway = safeActorPart(agent?.gateway);
  const name = safeActorPart(prompt?.actorId) ?? safeActorPart(agent?.actorId) ?? gateway;
  if (!gateway && !name) return null;
  return { gateway: gateway ?? name, name: name ?? gateway };
}

function sourcePrompts(agent) {
  if (Array.isArray(agent?.prompts)) return agent.prompts;
  return agent?.prompt ? [agent.prompt] : [];
}

function promptOrder(a, b) {
  return (Number.isFinite(a.prompt?.expiresAt) ? a.prompt.expiresAt : Number.POSITIVE_INFINITY)
    - (Number.isFinite(b.prompt?.expiresAt) ? b.prompt.expiresAt : Number.POSITIVE_INFINITY)
    || (Number.isFinite(a.prompt?.createdAt) ? a.prompt.createdAt : Number.POSITIVE_INFINITY)
    - (Number.isFinite(b.prompt?.createdAt) ? b.prompt.createdAt : Number.POSITIVE_INFINITY)
    || String(a.prompt?.id).localeCompare(String(b.prompt?.id));
}

function rosterFor(agents, winner, promptCandidates) {
  const grouped = new Map();
  const pendingByAgent = new Map();
  for (const candidate of promptCandidates) {
    pendingByAgent.set(candidate.agent.id, (pendingByAgent.get(candidate.agent.id) ?? 0) + 1);
  }

  for (const agent of agents) {
    const actor = actorFor(agent);
    if (!actor) continue;
    const key = `${actor.gateway}\u0000${actor.name}`;
    const existing = grouped.get(key);
    const candidate = {
      gateway: actor.gateway,
      name: actor.name,
      state: agent.state,
      active: agent.state === 'idle' ? 0 : 1,
      pending: pendingByAgent.get(agent.id) ?? 0,
      primary: agent.id === winner?.id,
    };
    if (!existing) {
      grouped.set(key, candidate);
      continue;
    }
    existing.active += candidate.active;
    existing.pending += candidate.pending;
    existing.primary ||= candidate.primary;
    if (rankState(candidate.state) > rankState(existing.state)) existing.state = candidate.state;
  }

  return [...grouped.values()].sort((a, b) =>
    Number(b.primary) - Number(a.primary)
    || rankState(b.state) - rankState(a.state)
    || a.gateway.localeCompare(b.gateway)
    || a.name.localeCompare(b.name)
  );
}

/**
 * @param {Array} agents  Agent records: { id, state, label, runId, urgency, since, prompt }
 * @param {{now?: number, onWarn?: (msg: string) => void}} [opts]
 * @returns {object} a v1 state-contract payload
 */
export function aggregate(agents, opts = {}) {
  const now = opts.now ?? Date.now();
  // Defaults to a no-op so aggregate() stays pure and callable from a test with
  // no wiring. The daemon passes its logger, so a dropped prompt is never silent
  // in production — the whole hazard of failing closed is doing it quietly.
  const warn = opts.onWarn ?? (() => {});
  const ranked = agents.map((a) => ({ ...a, _rank: rankState(a.state) }));
  const active = ranked.filter((a) => a.state !== 'idle');

  // Deterministic ordinary-state winner: highest state, then longest time in
  // it, then id. Input order must never change the output.
  const stateWinner = active.slice().sort((x, y) =>
    y._rank - x._rank ||
    (x.since ?? 0) - (y.since ?? 0) ||
    String(x.id).localeCompare(String(y.id))
  )[0];

  // A source may have several pending approvals in one session. Validate every
  // candidate before it can contribute to the queue, then order the complete
  // cross-Gateway queue by the deadline that can be lost first, creation time,
  // and finally the already-qualified prompt id.
  const promptCandidates = ranked
    .filter((agent) => agent.state === 'needs_attention')
    .flatMap((agent) => sourcePrompts(agent).map((prompt) => {
      const label = prompt.label ?? agent.label;
      const normalized = normalisePrompt(prompt, label, now, warn);
      return normalized ? { agent, prompt, label, normalized } : null;
    }))
    .filter(Boolean)
    .sort(promptOrder);

  const selected = promptCandidates[0] ?? null;
  const winner = selected?.agent ?? stateWinner;
  const winnerLabel = selected?.label ?? winner?.label ?? null;

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
    label: winner ? truncateLabel(winnerLabel) : null,
    urgency,
    primary_run_id: winner ? (winner.runId ?? null) : null,
    // Additive to the v1 contract: when the winning agent entered its current
    // state. `ts` is publish time and cannot express elapsed. Renderers that
    // predate this field ignore it, per the tolerate-unknown-fields rule.
    since: winner ? isoSeconds(winner.since ?? null) : null,
    // Additive to v1, from the agent that won the state race — the same agent
    // `label` and `primary_run_id` describe, so the buttons cannot end up
    // answering a question the panel is not showing.
    //
    // `null` rather than absent: it lets a renderer tell "this daemon supports
    // prompts and there is none" from "this daemon predates prompts entirely"
    // (undefined). Only the first means buttons are ever possible, and a panel
    // that cannot tell them apart has to guess about its own capabilities.
    //
    // Judged against the RAW label, not the truncated one above: a truncated
    // label fits by construction, so passing it would make the §2 rule
    // unconditionally true and quietly answerable.
    prompt: selected ? {
      ...selected.normalized,
      actor: actorFor(selected.agent, selected.prompt),
      summary: truncateLabel(selected.label),
      queue: { position: 1, total: promptCandidates.length },
    } : null,
    // Additive v1 projection. Sessions are grouped into human actors so a
    // pipeline with several runs does not turn into a wall of session keys.
    // No per-session labels or ids are published here.
    roster: rosterFor(ranked, winner, promptCandidates),
  };
}
