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
