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

// REPLACED. This asserted `since` came from lastActivityAt, which encoded the
// bug that made the panel read "thinking for 76 hours": lastActivityAt tracks
// the last HUMAN interaction and was observed 85 hours stale on a session whose
// updatedAt was 0.3 hours old. See the `since` block at the end of this file.
test('a session timestamp never becomes since, however tempting the field name', () => {
  const [agent] = mapSessionsToAgents(
    [session({ hasActiveRun: true, lastActivityAt: 1_700_000_005_000 })],
    undefined, new Map(), 42_000,
  );
  assert.equal(agent.since, 42_000);
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

// Observed live: session keys come in at least two shapes.
//   agent:labby:test-101-final   a routed agent session
//   explicit:roost-stall-probe   one created with --session-id
// Both carry a prefix that means nothing to someone glancing at a 7" panel.

test('strips the explicit: prefix too, since --session-id produces that shape', () => {
  const [agent] = mapSessionsToAgents([session({
    hasActiveRun: true, displayName: null, key: 'explicit:roost-stall-probe',
  })]);
  assert.equal(agent.label, 'roost-stall-probe');
});

test('an agent key keeps its session name whole, even if that name contains a colon', () => {
  const [agent] = mapSessionsToAgents([session({
    hasActiveRun: true, displayName: null, key: 'agent:labby:deploy:staging',
  })]);
  assert.equal(agent.label, 'deploy:staging');
});

test('a key with no prefix at all is used unchanged', () => {
  const [agent] = mapSessionsToAgents([session({
    hasActiveRun: true, displayName: null, key: 'plain-key',
  })]);
  assert.equal(agent.label, 'plain-key');
});

// The REAL key of the --session-id run, read back off the gateway afterwards.
// The earlier test guessed a bare `explicit:...`; the gateway actually nests it
// under the agent prefix, so stripping one prefix was not enough.
test('strips a nested agent+explicit prefix, the shape --session-id really produces', () => {
  const [agent] = mapSessionsToAgents([session({
    hasActiveRun: true, displayName: null,
    key: 'agent:labby:explicit:roost-stall-probe',
  })]);
  assert.equal(agent.label, 'roost-stall-probe');
});

test('a session name that merely contains a colon is never treated as a prefix', () => {
  const [agent] = mapSessionsToAgents([session({
    hasActiveRun: true, displayName: null, key: 'agent:labby:deploy:staging',
  })]);
  assert.equal(agent.label, 'deploy:staging', 'only known routing keywords are stripped');
});

test('an iPhone session key has no prefix and is left alone', () => {
  const [agent] = mapSessionsToAgents([session({
    hasActiveRun: true, displayName: null,
    key: 'ios-342694d8-da30-4fe3-a52d-2e129eb6e0dc',
  })]);
  assert.equal(agent.label, 'ios-342694d8-da30-4fe3-a52d-2e129eb6e0dc');
});

// ── Observer digests ────────────────────────────────────────────────────────
//
// `sessions.list` cannot distinguish a healthy long run from a hung one: every
// progress field is null or frozen while active. The session.observer digest is
// the only thing that can, so when one exists it outranks the hasActiveRun read.

const digest = (over = {}) => ({ headline: 'reindexing the media library', health: 'grinding', ...over });

test('a stuck digest makes the agent stalled, which hasActiveRun alone can never say', () => {
  const [agent] = mapSessionsToAgents(
    [session({ key: 'k', hasActiveRun: true })],
    new Map([['k', digest({ health: 'stuck' })]]),
  );
  assert.equal(agent.state, 'stalled');
  assert.equal(agent.urgency, 'notify');
});

test('a waiting-on-user digest blocks, so the panel is allowed to be loud', () => {
  const [agent] = mapSessionsToAgents(
    [session({ key: 'k', hasActiveRun: true })],
    new Map([['k', digest({ health: 'waiting-on-user' })]]),
  );
  assert.equal(agent.state, 'needs_attention');
  assert.equal(agent.urgency, 'blocking');
});

test('the digest headline becomes the label, since it beats a scraped session key', () => {
  const [agent] = mapSessionsToAgents(
    [session({ key: 'agent:labby:whatever', hasActiveRun: true })],
    new Map([['agent:labby:whatever', digest({ headline: 'deploying photopush to k3s' })]]),
  );
  assert.equal(agent.label, 'deploying photopush to k3s');
});

test('an unrecognised health falls back to the hasActiveRun reading rather than crashing', () => {
  const [agent] = mapSessionsToAgents(
    [session({ key: 'k', hasActiveRun: true })],
    new Map([['k', digest({ health: 'teleporting' })]]),
  );
  assert.equal(agent.state, 'thinking');
});

test('a digest for a quiet session still applies, because done and failed are real answers', () => {
  const [agent] = mapSessionsToAgents(
    [session({ key: 'k', hasActiveRun: false })],
    new Map([['k', digest({ health: 'failed', headline: 'migration aborted' })]]),
  );
  assert.equal(agent.state, 'needs_attention');
  assert.equal(agent.label, 'migration aborted');
});

test('no digest map at all behaves exactly as before, so the caller may omit it', () => {
  const [agent] = mapSessionsToAgents([session({ key: 'k', hasActiveRun: true })]);
  assert.equal(agent.state, 'thinking');
});

// ── `since` ─────────────────────────────────────────────────────────────────
//
// Observed live: agent:labby:main carried lastActivityAt from 85 HOURS earlier
// while updatedAt and startedAt were 0.3 hours old. lastActivityAt tracks the
// last human interaction, not run activity, so reading `since` off the session
// made the panel announce "thinking for 76 hours". The contract says `since` is
// when the agent entered THIS state, which no gateway field expresses.

test('since is when roost first saw this state, not a session timestamp', () => {
  const agents = mapSessionsToAgents(
    [session({ key: 'k', hasActiveRun: true, lastActivityAt: 1 })],   // 1970
    undefined, new Map(), 5_000,
  );
  assert.equal(agents[0].since, 5_000, 'a 1970 timestamp must not reach the panel');
});

test('since is preserved while the state is unchanged, so elapsed keeps counting up', () => {
  const prev = new Map([['k', { state: 'thinking', since: 1_000 }]]);
  const agents = mapSessionsToAgents(
    [session({ key: 'k', hasActiveRun: true })], undefined, prev, 9_000,
  );
  assert.equal(agents[0].since, 1_000);
});

test('since resets when the state changes, because that is a new state to time', () => {
  const prev = new Map([['k', { state: 'idle', since: 1_000 }]]);
  const agents = mapSessionsToAgents(
    [session({ key: 'k', hasActiveRun: true })], undefined, prev, 9_000,
  );
  assert.equal(agents[0].state, 'thinking');
  assert.equal(agents[0].since, 9_000);
});

test('a digest that changes the state also restarts the clock', () => {
  const prev = new Map([['k', { state: 'thinking', since: 1_000 }]]);
  const agents = mapSessionsToAgents(
    [session({ key: 'k', hasActiveRun: true })],
    new Map([['k', { health: 'stuck', headline: 'x' }]]),
    prev, 9_000,
  );
  assert.equal(agents[0].state, 'stalled');
  assert.equal(agents[0].since, 9_000);
});
