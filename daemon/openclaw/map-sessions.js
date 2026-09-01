import { healthToState } from './health.js';

/**
 * OpenClaw sessions -> roost agent records.
 *
 * Pure, so the mapping can be tested without a gateway. The shapes come from a
 * live `sessions.list` against openclaw 2026.7.2-beta.7, not from guesswork:
 *
 *   key  sessionId  displayName  hasActiveRun  archived  status
 *   startedAt  endedAt  lastActivityAt  lastInteractionAt  updatedAt
 *   abortedLastRun  lastRunError  agentRuntime  model  kind  pinned  unread
 *
 * WHAT IS DELIBERATELY NOT MAPPED YET, and why:
 *
 *   stalled          `session.stalled` and `session.stuck` exist in the gateway's
 *                    registry, but every session observed live reported only
 *                    `done` or `timeout`, with hasActiveRun false throughout. So
 *                    it is still unknown whether those are status VALUES or
 *                    EVENT names. Mapping them now would be a guess, and the
 *                    whole point of roost is distinguishing thinking from
 *                    stalled — getting it wrong is worse than not showing it.
 *
 *   needs_attention  That is an approval prompt. M2 work; it arrives on the
 *                    approvals surface, not in a session record.
 *
 *   listening        No field observed distinguishes "woken, awaiting input"
 *                    from "quiet". Claiming it would be decoration.
 *
 * The result is honest rather than complete: the panel shows working versus
 * quiet, which the mock's own script calls ~95% of real runtime.
 */

/**
 * A human-readable name for a session.
 *
 * `displayName` is null on every real session observed on this gateway, so the
 * key carries the only meaningful name. Four key shapes have been seen live:
 *
 *   main                                      the default session
 *   ios-342694d8-da30-4fe3-a52d-2e129eb6e0dc  from the paired iPhone
 *   agent:labby:test-101-final                a routed agent session
 *   agent:labby:explicit:roost-stall-probe    created with --session-id
 *
 * Only KNOWN routing keywords are stripped, and only from the front. Stripping
 * any `word:` generically would mangle a session legitimately named
 * `deploy:staging` down to `staging`, so the rule is deliberately narrow: an
 * `agent:<agentId>:` prefix, then an `explicit:` prefix, and nothing else.
 * Whatever survives is what a human named, which is what belongs on a 7" panel
 * seen across a room.
 */
const ROUTING_PREFIXES = [
  /^agent:[^:]+:/,   // routed to a named agent
  /^explicit:/,      // created with --session-id
];

/** The routed OpenClaw actor, never the remainder of an opaque session key. */
export function sessionActorId(s) {
  if (typeof s?.agentId === 'string' && s.agentId.trim() !== '') return s.agentId.trim();
  const match = typeof s?.key === 'string' ? /^agent:([^:]+):/.exec(s.key) : null;
  return match?.[1] ?? null;
}

/** Carry `since` forward while the state holds; restart the clock when it changes. */
function sinceFor(previous, id, state, now) {
  const prior = previous?.get(id);
  return prior && prior.state === state ? prior.since : now;
}

export function sessionLabel(s) {
  if (s?.displayName) return s.displayName;
  let key = s?.key;
  if (typeof key !== 'string') return null;
  for (const prefix of ROUTING_PREFIXES) key = key.replace(prefix, '');
  return key || s.key;
}

/**
 * @param {Array} sessions        from `sessions.list`
 * @param {Map} [digests]         sessionKey -> latest session.observer digest
 * @param {Map} [previous]        id -> { state, since } from the last emission
 * @param {number} [now]          injectable clock
 *
 * A digest OUTRANKS the hasActiveRun reading. hasActiveRun can only say whether
 * a run exists; the observer has read the transcript and can say whether it is
 * going anywhere. Where they disagree, the observer is better informed.
 *
 * `since` is tracked HERE rather than read off the session, because no gateway
 * field means what the contract means. Observed live: agent:labby:main reported
 * lastActivityAt from 85 hours earlier while updatedAt was 0.3 hours old —
 * lastActivityAt follows human interaction, not run activity. Reading it made
 * the panel announce "thinking for 76 hours". The contract wants the moment the
 * agent entered THIS state, so roost times it from its own clock and carries it
 * forward for as long as the state holds.
 */
export function mapSessionsToAgents(sessions = [], digests, previous, now = Date.now()) {
  return sessions
    // An archived conversation is not an agent doing something now. This is a
    // real flag on the record, not an arbitrary recency cutoff.
    .filter((s) => !s?.archived)
    .map((s) => {
      const working = Boolean(s?.hasActiveRun);
      const d = digests?.get(s?.key);
      // null when the health value is unrecognised, so a future gateway release
      // adding an eighth value degrades to the hasActiveRun reading.
      const judged = healthToState(d?.health);
      const state = judged ? judged.state : (working ? 'thinking' : 'idle');
      return {
        id: s?.key ?? s?.sessionId,
        actorId: sessionActorId(s),
        state,
        // Idle agents carry no label or run id: aggregate() ignores idle
        // agents entirely, and the mock establishes null for both.
        // The observer's headline is written for exactly this surface, so it
        // beats a session key scraped for something human-readable.
        label: d?.headline ?? (working || judged ? sessionLabel(s) : null),
        runId: working ? (s?.activeRunIds?.[0] ?? null) : null,
        urgency: judged ? judged.urgency : 'ambient',
        since: sinceFor(previous, s?.key ?? s?.sessionId, state, now),
      };
    });
}
