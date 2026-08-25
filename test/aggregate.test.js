import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregate, MAX_LABEL_LENGTH } from '../daemon/aggregate.js';

// An agent record as a StateSource emits it.
const agent = (over = {}) => ({
  id: 'a1',
  state: 'idle',
  label: null,
  runId: null,
  urgency: 'ambient',
  since: 1000,
  ...over,
});

test('no agents at all aggregates to idle', () => {
  const out = aggregate([]);
  assert.equal(out.state, 'idle');
  assert.equal(out.count, 0);
  assert.equal(out.label, null);
  assert.equal(out.urgency, 'ambient');
  assert.equal(out.primary_run_id, null);
});

test('all-idle agents aggregate to idle with a zero count', () => {
  const out = aggregate([agent({ id: 'a' }), agent({ id: 'b' })]);
  assert.equal(out.state, 'idle');
  assert.equal(out.count, 0, 'count is non-idle agents, not total agents');
});

test('count is the number of non-idle agents, not the total', () => {
  const out = aggregate([
    agent({ id: 'a', state: 'thinking' }),
    agent({ id: 'b', state: 'idle' }),
    agent({ id: 'c', state: 'listening' }),
  ]);
  assert.equal(out.count, 2);
});

test('needs_attention outranks every other state', () => {
  const out = aggregate([
    agent({ id: 'a', state: 'thinking' }),
    agent({ id: 'b', state: 'stalled' }),
    agent({ id: 'c', state: 'needs_attention', label: 'Approve deploy?', runId: 'r-c' }),
    agent({ id: 'd', state: 'listening' }),
  ]);
  assert.equal(out.state, 'needs_attention');
  assert.equal(out.label, 'Approve deploy?');
  assert.equal(out.primary_run_id, 'r-c');
});

test('stalled outranks thinking', () => {
  const out = aggregate([
    agent({ id: 'a', state: 'thinking', label: 'working', runId: 'r-a' }),
    agent({ id: 'b', state: 'stalled', label: 'stuck on lock', runId: 'r-b' }),
  ]);
  assert.equal(out.state, 'stalled');
  assert.equal(out.label, 'stuck on lock');
  assert.equal(out.primary_run_id, 'r-b');
});

test('thinking outranks listening', () => {
  const out = aggregate([
    agent({ id: 'a', state: 'listening', runId: 'r-a' }),
    agent({ id: 'b', state: 'thinking', runId: 'r-b' }),
  ]);
  assert.equal(out.state, 'thinking');
  assert.equal(out.primary_run_id, 'r-b');
});

test('listening outranks idle', () => {
  const out = aggregate([
    agent({ id: 'a', state: 'idle', runId: 'r-a' }),
    agent({ id: 'b', state: 'listening', runId: 'r-b' }),
  ]);
  assert.equal(out.state, 'listening');
  assert.equal(out.primary_run_id, 'r-b');
});

test('label and primary_run_id come from the agent that won, not any other', () => {
  const out = aggregate([
    agent({ id: 'a', state: 'thinking', label: 'loser label', runId: 'r-a' }),
    agent({ id: 'b', state: 'needs_attention', label: 'winner label', runId: 'r-b' }),
  ]);
  assert.equal(out.label, 'winner label');
  assert.equal(out.primary_run_id, 'r-b');
});

test('ties on state break toward the agent that entered it earliest', () => {
  const out = aggregate([
    agent({ id: 'new', state: 'stalled', label: 'newer', runId: 'r-new', since: 5000 }),
    agent({ id: 'old', state: 'stalled', label: 'older', runId: 'r-old', since: 2000 }),
  ]);
  assert.equal(out.label, 'older', 'the longest-running instance of the winning state wins');
  assert.equal(out.primary_run_id, 'r-old');
});

test('ties on state and timestamp break deterministically by agent id', () => {
  const forward = aggregate([
    agent({ id: 'b', state: 'stalled', runId: 'r-b', since: 2000 }),
    agent({ id: 'a', state: 'stalled', runId: 'r-a', since: 2000 }),
  ]);
  const reversed = aggregate([
    agent({ id: 'a', state: 'stalled', runId: 'r-a', since: 2000 }),
    agent({ id: 'b', state: 'stalled', runId: 'r-b', since: 2000 }),
  ]);
  assert.equal(forward.primary_run_id, reversed.primary_run_id, 'input order must not change output');
});

test('urgency is the maximum across all non-idle agents, not the winner own urgency', () => {
  const out = aggregate([
    agent({ id: 'a', state: 'needs_attention', urgency: 'notify', runId: 'r-a' }),
    agent({ id: 'b', state: 'thinking', urgency: 'blocking', runId: 'r-b' }),
  ]);
  assert.equal(out.state, 'needs_attention', 'winner is still the highest state');
  assert.equal(out.urgency, 'blocking', 'but urgency is the max across non-idle agents');
});

test('idle agents do not contribute their urgency to the maximum', () => {
  const out = aggregate([
    agent({ id: 'a', state: 'thinking', urgency: 'ambient', runId: 'r-a' }),
    agent({ id: 'b', state: 'idle', urgency: 'blocking', runId: 'r-b' }),
  ]);
  assert.equal(out.urgency, 'ambient');
});

test('label longer than the contract maximum is truncated in the daemon', () => {
  const long = 'x'.repeat(200);
  const out = aggregate([agent({ id: 'a', state: 'thinking', label: long })]);
  assert.equal(out.label.length, MAX_LABEL_LENGTH);
  assert.equal(MAX_LABEL_LENGTH, 64);
});

test('a truncated label ends in an ellipsis so the cut is visible', () => {
  const out = aggregate([agent({ id: 'a', state: 'thinking', label: 'y'.repeat(200) })]);
  assert.ok(out.label.endsWith('…'));
});

test('a label already within the maximum is left completely alone', () => {
  const exact = 'z'.repeat(64);
  const out = aggregate([agent({ id: 'a', state: 'thinking', label: exact })]);
  assert.equal(out.label, exact);
  assert.ok(!out.label.endsWith('…'));
});

test('the aggregated payload carries the schema version and a timestamp', () => {
  const out = aggregate([agent({ id: 'a', state: 'thinking' })], { now: Date.parse('2026-08-21T17:46:43Z') });
  assert.equal(out.v, 1);
  assert.equal(out.ts, '2026-08-21T17:46:43Z');
});

test('an unknown state from a source is rejected rather than silently ranked', () => {
  assert.throws(
    () => aggregate([agent({ id: 'a', state: 'contemplating' })]),
    /contemplating/,
  );
});

test('offline is never produced by aggregation because only the broker declares it', () => {
  assert.throws(
    () => aggregate([agent({ id: 'a', state: 'offline' })]),
    /offline/,
  );
});

test('the payload carries when the winning agent entered its state, for elapsed time', () => {
  const out = aggregate([
    agent({ id: 'a', state: 'thinking', runId: 'r-a', since: Date.parse('2026-08-21T17:40:00Z') }),
  ], { now: Date.parse('2026-08-21T17:46:43Z') });
  assert.equal(out.since, '2026-08-21T17:40:00Z', 'elapsed is derived from this, not from ts');
});

test('since is null when nothing is running, so the renderer shows no timer', () => {
  assert.equal(aggregate([]).since, null);
});

test('since tracks the winner, not the agent that has been running longest overall', () => {
  const out = aggregate([
    agent({ id: 'old', state: 'thinking', runId: 'r-old', since: Date.parse('2026-08-21T17:00:00Z') }),
    agent({ id: 'new', state: 'needs_attention', runId: 'r-new', since: Date.parse('2026-08-21T17:46:00Z') }),
  ]);
  assert.equal(out.since, '2026-08-21T17:46:00Z');
});

// ── prompt (M2 contract addition) ────────────────────────────────────────────

const NOW = Date.parse('2026-08-21T18:04:11Z');
const LATER = Date.parse('2026-08-21T18:09:02Z');

const prompt = (over = {}) => ({
  id: 'prm_8f2a',
  kind: 'approve_reject',
  reversible: true,
  expiresAt: LATER,
  ...over,
});

const asking = (over = {}) => agent({
  id: 'cutty',
  state: 'needs_attention',
  label: 'Approve deploy photopush to staging?',
  runId: 'run-1d7e',
  urgency: 'blocking',
  prompt: prompt(),
  ...over,
});

test('a well-formed prompt reaches the payload, with expiry as an iso string', () => {
  const out = aggregate([asking()], { now: NOW });
  assert.deepEqual(out.prompt, {
    id: 'prm_8f2a',
    kind: 'approve_reject',
    reversible: true,
    expires_at: '2026-08-21T18:09:02Z',
  });
});

test('prompt is null, not absent, when nothing is asking', () => {
  const out = aggregate([agent({ id: 'a', state: 'thinking', runId: 'r' })], { now: NOW });
  assert.equal(out.prompt, null);
  assert.ok('prompt' in out, 'absent would mean "daemon predates prompts", a different fact');
});

test('prompt is null when nothing is running at all', () => {
  const out = aggregate([], { now: NOW });
  assert.equal(out.prompt, null);
  assert.ok('prompt' in out);
});

test('the prompt comes from the agent that won the state race, not any other', () => {
  // Otherwise the buttons answer a question the panel is not showing.
  const out = aggregate([
    agent({ id: 'quiet', state: 'thinking', runId: 'r-q', prompt: prompt({ id: 'prm_wrong' }) }),
    asking(),
  ], { now: NOW });
  assert.equal(out.prompt.id, 'prm_8f2a');
  assert.equal(out.primary_run_id, 'run-1d7e', 'the prompt and the run id describe one agent');
});

test('a prompt past its expiry is dropped rather than advertised', () => {
  // The panel has its own expires_at backstop; this is the daemon doing its
  // half, so a corpse is never published in the first place.
  const out = aggregate([asking()], { now: LATER + 1000 });
  assert.equal(out.prompt, null);
  assert.equal(out.state, 'needs_attention', 'the state still says a human is needed');
});

test('a prompt expiring exactly now is already dead', () => {
  assert.equal(aggregate([asking()], { now: LATER }).prompt, null);
});

test('a prompt with no expiry is allowed and carries a null expires_at', () => {
  const out = aggregate([asking({ prompt: prompt({ expiresAt: null }) })], { now: NOW });
  assert.equal(out.prompt.expires_at, null, 'no expiry supplied is not the same as expired');
  assert.equal(out.prompt.id, 'prm_8f2a');
});

test('a prompt whose reversible is missing is dropped, never defaulted', () => {
  // Defaulting either way is a guess. True would silently one-tap something
  // destructive; false would demand a confirm the daemon never asserted.
  const p = prompt();
  delete p.reversible;
  assert.equal(aggregate([asking({ prompt: p })], { now: NOW }).prompt, null);
});

test('a truthy non-boolean reversible is dropped, not coerced', () => {
  for (const bad of ['true', 1, {}]) {
    assert.equal(aggregate([asking({ prompt: prompt({ reversible: bad }) })], { now: NOW }).prompt, null);
  }
});

test('an irreversible prompt survives, carrying false through for the second confirm', () => {
  const out = aggregate([asking({ prompt: prompt({ reversible: false }) })], { now: NOW });
  assert.equal(out.prompt.reversible, false, 'false is an assertion, not a missing value');
});

test('a prompt of an unknown kind is dropped, since the panel cannot draw it', () => {
  for (const kind of ['approve_reject_maybe', 'text_input', undefined, null, '']) {
    assert.equal(aggregate([asking({ prompt: prompt({ kind }) })], { now: NOW }).prompt, null);
  }
});

test('a prompt with no usable id is dropped, since an answer must name the question', () => {
  for (const id of ['', undefined, null, 42]) {
    assert.equal(aggregate([asking({ prompt: prompt({ id }) })], { now: NOW }).prompt, null);
  }
});

test('a non-numeric expiry is dropped rather than treated as no expiry', () => {
  for (const expiresAt of ['2026-08-21T18:09:02Z', NaN, Infinity]) {
    assert.equal(aggregate([asking({ prompt: prompt({ expiresAt }) })], { now: NOW }).prompt, null);
  }
});

test('dropping a prompt is reported, so failing closed is never silent', () => {
  const warnings = [];
  const out = aggregate([asking({ prompt: prompt({ kind: 'nope' }) })], {
    now: NOW,
    onWarn: (m) => warnings.push(m),
  });
  assert.equal(out.prompt, null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /prm_8f2a/, 'the message names the prompt that was dropped');
  assert.match(warnings[0], /nope/, 'and why');
});

test('a valid prompt reports nothing', () => {
  const warnings = [];
  aggregate([asking()], { now: NOW, onWarn: (m) => warnings.push(m) });
  assert.deepEqual(warnings, []);
});

test('aggregate still works with no onWarn supplied', () => {
  assert.doesNotThrow(() => aggregate([asking({ prompt: prompt({ kind: 'nope' }) })], { now: NOW }));
});

test('a malformed prompt never takes down the rest of the payload', () => {
  // The whole reason this fails closed instead of throwing the way an
  // unrankable state does.
  const out = aggregate([asking({ prompt: { garbage: true } })], { now: NOW });
  assert.equal(out.prompt, null);
  assert.equal(out.state, 'needs_attention');
  assert.equal(out.label, 'Approve deploy photopush to staging?');
  assert.equal(out.urgency, 'blocking');
  assert.equal(out.count, 1);
});
