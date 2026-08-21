/**
 * Staleness: has the panel stopped hearing from the daemon?
 *
 * Two different failures are covered by two different mechanisms, and this is
 * only one of them:
 *
 *   - the DAEMON dies    -> the broker publishes Last Will, we render `offline`
 *   - the BROKER goes    -> nothing arrives at all, and only this can notice
 *
 * Measured from message ARRIVAL, never from the payload's `ts`. A retained
 * payload can legitimately be minutes old and still be the current truth; what
 * matters is whether the daemon is still talking to us. It also means a long
 * `thinking` turn is not stale, because heartbeats keep arriving underneath it.
 *
 * Extracted from app.js so it can be tested without a browser.
 */

/**
 * How long the panel has been hearing nothing.
 *
 * With no message ever received, this counts from page load — otherwise a panel
 * that starts while the broker is unreachable would sit on "connecting"
 * indefinitely, which is a frozen panel wearing a friendlier word.
 */
export function silentFor({ now, lastMessageAt, startedAt }) {
  return now - (lastMessageAt || startedAt);
}

export function isStale({ now, lastMessageAt, startedAt, staleMs }) {
  return silentFor({ now, lastMessageAt, startedAt }) > staleMs;
}
