import test from 'node:test';
import assert from 'node:assert/strict';
import { routeTopic, countsAsLiveness } from '../renderer/topics.js';

const TOPICS = { stateTopic: 'roost/agents/state', instrumentTopic: 'roost/instrument/laptop-opens' };

test('the agent state topic routes to state', () => {
  assert.equal(routeTopic('roost/agents/state', TOPICS), 'state');
});

test('the instrument topic routes to instrument', () => {
  assert.equal(routeTopic('roost/instrument/laptop-opens', TOPICS), 'instrument');
});

test('an unrecognised topic is routed nowhere rather than guessed at', () => {
  assert.equal(routeTopic('zigbee2mqtt/kitchen', TOPICS), 'unknown');
});

test('only agent state counts as proof the feed is alive', () => {
  // The counter changes only when a human taps it, so it can be silent for
  // days. Letting it refresh the liveness clock would mask a dead state feed:
  // one tap would make a broken panel look healthy for another 30 seconds.
  assert.equal(countsAsLiveness('state'), true);
  assert.equal(countsAsLiveness('instrument'), false);
  assert.equal(countsAsLiveness('unknown'), false);
});
