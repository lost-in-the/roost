/**
 * Which subscription a message arrived on, and what that implies.
 *
 * The panel subscribes to two topics with very different lifecycles, and
 * conflating them would break staleness detection.
 */

export function routeTopic(topic, { stateTopic, instrumentTopic }) {
  if (topic === stateTopic) return 'state';
  if (topic === instrumentTopic) return 'instrument';
  return 'unknown';
}

/**
 * Whether a message of this kind proves the state feed is still alive.
 *
 * Only agent state does. The laptop counter changes when a human taps it and
 * can legitimately be silent for days, so letting it refresh the liveness clock
 * would mask a dead feed: a single tap would make a broken panel look healthy
 * for another 30 seconds.
 */
export function countsAsLiveness(route) {
  return route === 'state';
}
