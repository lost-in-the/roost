import test from 'node:test';
import assert from 'node:assert/strict';
import { mapSessionsToAgents } from '../daemon/openclaw/map-sessions.js';
import { aggregate, STATE_PRIORITY } from '../daemon/aggregate.js';

const session = (over = {}) => ({
  key: 'sess-1', sessionId: 's1', displayName: 'photopush deploy',
  hasActiveRun: false, archived: false, status: 'done',
  lastActivityAt: 1_700_000_000_000, ...over,
});

test('a session with an active run is thinking, which is the state the panel exists to show', () => {
  const [agent] = mapSessionsToAgents([session({ hasActiveRun: true })]);
  assert.equal(agent.state, 'thinking');
});

test('a session with no active run is idle, so aggregate drops it from the count', () => {
  const [agent] = mapSessionsToAgents([session({ hasActiveRun: false })]);
  assert.equal(agent.state, 'idle');
  assert.equal(aggregate(mapSessionsToAgents([session()])).count, 0);
});

test('archived sessions are dropped, because an archived conversation is not a current agent', () => {
  assert.deepEqual(mapSessionsToAgents([session({ archived: true })]), []);
});

test('the id is the session key, because it must stay stable across emissions', () => {
  const [agent] = mapSessionsToAgents([session({ key: 'stable-key' })]);
  assert.equal(agent.id, 'stable-key');
});

test('a working agent is labelled with its session name, so the panel says what is happening', () => {
  const [agent] = mapSessionsToAgents([session({ hasActiveRun: true, displayName: 'reindex media' })]);
  assert.equal(agent.label, 'reindex media');
});

test('an idle agent carries no label and no run id, matching the mock contract', () => {
  const [agent] = mapSessionsToAgents([session({ hasActiveRun: false })]);
  assert.equal(agent.label, null);
  assert.equal(agent.runId, null);
});

test('since comes from the session activity time, so the panel can say how long', () => {
  const [agent] = mapSessionsToAgents([session({ hasActiveRun: true, lastActivityAt: 1_700_000_005_000 })]);
  assert.equal(agent.since, 1_700_000_005_000);
});

test('every state produced is one aggregate can rank, so a live gateway cannot crash the daemon', () => {
  const mixed = [
    session({ key: 'a', hasActiveRun: true }),
    session({ key: 'b', hasActiveRun: false, status: 'timeout' }),
    session({ key: 'c', hasActiveRun: false, status: 'done' }),
    session({ key: 'd', hasActiveRun: true, status: 'error', lastRunError: 'boom' }),
  ];
  for (const agent of mapSessionsToAgents(mixed)) {
    assert.ok(STATE_PRIORITY.includes(agent.state), `unrankable state ${agent.state}`);
  }
  assert.doesNotThrow(() => aggregate(mapSessionsToAgents(mixed)));
});

test('a session missing optional fields still maps, because the gateway is not ours to control', () => {
  const [agent] = mapSessionsToAgents([{ key: 'k', hasActiveRun: true }]);
  assert.equal(agent.state, 'thinking');
  assert.ok('label' in agent && 'runId' in agent && 'since' in agent && 'urgency' in agent);
});

// Real sessions on this gateway carry displayName: null and a structured key
// like "agent:labby:test-101-final". Without a fallback the panel shows
// "thinking" with no indication of what is being thought about.

test('falls back to the session name in the key, because real sessions have no displayName', () => {
  const [agent] = mapSessionsToAgents([session({
    hasActiveRun: true, displayName: null, key: 'agent:labby:test-101-final',
  })]);
  assert.equal(agent.label, 'test-101-final');
});

test('prefers displayName when the gateway actually provides one', () => {
  const [agent] = mapSessionsToAgents([session({
    hasActiveRun: true, displayName: 'Deploying photopush', key: 'agent:labby:whatever',
  })]);
  assert.equal(agent.label, 'Deploying photopush');
});

test('uses the whole key when it is not the agent:<id>:<name> shape', () => {
  const [agent] = mapSessionsToAgents([session({
    hasActiveRun: true, displayName: null, key: 'some-other-key',
  })]);
  assert.equal(agent.label, 'some-other-key');
});

test('an idle agent still carries no label, even though a name is derivable', () => {
  const [agent] = mapSessionsToAgents([session({
    hasActiveRun: false, displayName: null, key: 'agent:labby:quiet',
  })]);
  assert.equal(agent.label, null);
});
