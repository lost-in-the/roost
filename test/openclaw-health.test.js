import test from 'node:test';
import assert from 'node:assert/strict';
import { healthToState, OBSERVER_HEALTH_VALUES } from '../daemon/openclaw/health.js';
import { STATE_PRIORITY, URGENCY_PRIORITY } from '../daemon/aggregate.js';

test('the health values match the gateway enum exactly, in source order', () => {
  assert.deepEqual(OBSERVER_HEALTH_VALUES, [
    'on-track', 'grinding', 'stuck', 'waiting-on-user', 'wrapping-up', 'done', 'failed',
  ]);
});

test('progressing work is thinking, however the observer phrases it', () => {
  for (const h of ['on-track', 'grinding', 'wrapping-up']) {
    assert.equal(healthToState(h).state, 'thinking', `${h} should be thinking`);
  }
});

test('stuck is stalled, which is the distinction the whole panel exists for', () => {
  assert.equal(healthToState('stuck').state, 'stalled');
  assert.equal(healthToState('stuck').urgency, 'notify');
});

test('waiting-on-user is needs_attention and blocks, because a human is the blocker', () => {
  assert.equal(healthToState('waiting-on-user').state, 'needs_attention');
  assert.equal(healthToState('waiting-on-user').urgency, 'blocking');
});

test('failed wants attention but is not blocking, because nothing is waiting on an answer', () => {
  assert.equal(healthToState('failed').state, 'needs_attention');
  assert.equal(healthToState('failed').urgency, 'notify');
});

test('done is idle, so aggregate drops it from the count', () => {
  assert.equal(healthToState('done').state, 'idle');
});

test('every mapped state and urgency is one aggregate can rank', () => {
  for (const h of OBSERVER_HEALTH_VALUES) {
    const { state, urgency } = healthToState(h);
    assert.ok(STATE_PRIORITY.includes(state), `${h} -> unrankable state ${state}`);
    assert.ok(URGENCY_PRIORITY.includes(urgency), `${h} -> unknown urgency ${urgency}`);
  }
});

test('an unrecognised health value yields no opinion rather than crashing the daemon', () => {
  // aggregate() throws on an unrankable state. A future gateway release adding
  // an eighth health value must degrade to "we do not know", not take the panel
  // down. Callers fall back to their hasActiveRun reading.
  assert.equal(healthToState('teleporting'), null);
  assert.equal(healthToState(undefined), null);
  assert.equal(healthToState(null), null);
});
