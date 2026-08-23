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
 * key carries the only meaningful name. Two key shapes have been seen live:
 *
 *   agent:labby:test-101-final    a routed agent session
 *   explicit:roost-stall-probe    one created with --session-id
 *
 * Both lead with routing information that means nothing to someone glancing at
 * a 7" panel across the room. The agent shape is stripped first and by name, so
 * a session called `deploy:staging` keeps its colon; anything else loses just
 * one leading `prefix:`. A key with no prefix is used unchanged.
 */
export function sessionLabel(s) {
  if (s?.displayName) return s.displayName;
  const key = s?.key;
  if (typeof key !== 'string') return null;
  const agentShape = /^agent:[^:]+:(.+)$/.exec(key);
  if (agentShape) return agentShape[1];
  const prefixed = /^[^:]+:(.+)$/.exec(key);
  return prefixed ? prefixed[1] : key;
}

export function mapSessionsToAgents(sessions = []) {
  return sessions
    // An archived conversation is not an agent doing something now. This is a
    // real flag on the record, not an arbitrary recency cutoff.
    .filter((s) => !s?.archived)
    .map((s) => {
      const working = Boolean(s?.hasActiveRun);
      return {
        id: s?.key ?? s?.sessionId,
        state: working ? 'thinking' : 'idle',
        // Idle agents carry no label or run id: aggregate() ignores idle
        // agents entirely, and the mock establishes null for both.
        label: working ? sessionLabel(s) : null,
        runId: working ? (s?.activeRunIds?.[0] ?? null) : null,
        urgency: 'ambient',
        since: s?.lastActivityAt ?? s?.updatedAt ?? s?.startedAt ?? null,
      };
    });
}
