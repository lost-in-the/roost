/**
 * OpenClaw's session-observer health -> roost state.
 *
 * The gateway runs an LLM observer over every visible session whose system
 * prompt reads, verbatim: "You judge the trajectory of a running AI agent
 * session for an operator status surface. Judge whether the agent is
 * progressing, grinding through necessary work, stuck in a repeated failing
 * loop, waiting on the user, wrapping up, done, or failed."
 *
 * That is roost's job, already done, by something that can read the transcript.
 * It draws the distinction roost exists for — grinding through necessary work
 * versus stuck in a repeated failing loop — which no silence timer can make.
 * Measured before finding it: a five-second run and a ten-minute hang are
 * byte-identical in `sessions.list`.
 *
 * The digest arrives as the `session.observer` broadcast, shaped
 * `{ headline, assessment?, health, planProgress? }` (ModelDigestSchema in the
 * gateway's session-observer-model). It reaches only connections that have
 * joined the audience via `sessions.observer.visibility`.
 */

/** The gateway's enum, in source order. A test pins this to the values it ships. */
export const OBSERVER_HEALTH_VALUES = [
  'on-track', 'grinding', 'stuck', 'waiting-on-user', 'wrapping-up', 'done', 'failed',
];

const MAPPING = {
  // Working. The observer distinguishes these three; the panel does not need to.
  'on-track': { state: 'thinking', urgency: 'ambient' },
  'grinding': { state: 'thinking', urgency: 'ambient' },
  'wrapping-up': { state: 'thinking', urgency: 'ambient' },

  // "Stuck in a repeated failing loop". Worth a glance, not an interruption.
  'stuck': { state: 'stalled', urgency: 'notify' },

  // A human is the blocker, so this is the one state allowed to be loud.
  'waiting-on-user': { state: 'needs_attention', urgency: 'blocking' },

  // Wants a look, but nothing is waiting on an answer, so it does not block.
  'failed': { state: 'needs_attention', urgency: 'notify' },

  'done': { state: 'idle', urgency: 'ambient' },
};

/**
 * @returns {{state: string, urgency: string} | null} null when the value is not
 * recognised. aggregate() throws on an unrankable state, so a future gateway
 * release adding an eighth health value must leave the panel with no opinion
 * rather than taking the daemon down. Callers fall back to `hasActiveRun`.
 */
export function healthToState(health) {
  return MAPPING[health] ?? null;
}
