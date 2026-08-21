/**
 * The "had to open the laptop" instrument, as a published value.
 *
 * It rides its own topic rather than being folded into the agent-state payload,
 * for two reasons:
 *
 *   1. The agent-state contract is about AGENTS. A human-tapped counter is a
 *      different kind of fact with a different lifecycle, and mixing them would
 *      mean every agent-state change re-publishes an unrelated number.
 *
 *   2. Their failure semantics are opposites. Agent state goes stale and must
 *      be disbelieved after 30 seconds. The counter does NOT: it changes only
 *      when a human taps it, so a retained value from an hour ago is still
 *      exactly correct. Giving it its own topic keeps that difference honest
 *      instead of forcing one staleness rule onto both.
 *
 * Consequently this topic has NO heartbeat and NO Last Will. A dead daemon
 * leaves the last count retained on the broker, which remains true: a tap
 * cannot be recorded while the daemon is down (the browser queues it locally
 * and retries), so the retained value is always correct as of the last tap.
 */

export const INSTRUMENT_VERSION = 1;

/**
 * Build the retained payload from the durable log.
 * @param {import('./laptop-log.js').LaptopLog} laptopLog
 */
export function instrumentPayload(laptopLog) {
  const entries = laptopLog.entries();
  return {
    v: INSTRUMENT_VERSION,
    count: entries.length,
    last: entries[0] ?? null,
  };
}
