import test from 'node:test';
import assert from 'node:assert/strict';
import { StateSource } from '../daemon/sources/state-source.js';
import { MultiGatewaySource } from '../daemon/sources/coordinator.js';

class FakeSource extends StateSource {
  constructor() {
    super();
    this.started = 0;
    this.stopped = 0;
    this.resolved = [];
  }

  start() {
    this.started += 1;
  }

  stop() {
    this.stopped += 1;
  }

  async resolveApproval(request) {
    this.resolved.push(request);
    return { ok: true, request };
  }
}

const agent = (id, state, extra = {}) => ({
  id,
  state,
  label: extra.label ?? id,
  runId: Object.hasOwn(extra, 'runId') ? extra.runId : `${id}-run`,
  urgency: extra.urgency ?? 'ambient',
  since: extra.since ?? 1,
});

test('merges complete snapshots in configured alias order', () => {
  const labby = new FakeSource();
  const omar = new FakeSource();
  const source = new MultiGatewaySource([
    { alias: 'labby', source: labby },
    { alias: 'omar', source: omar },
  ]);
  const seen = [];
  source.on('agents', (agents) => seen.push(agents));

  source.start();
  omar.emit('agents', [agent('o1', 'thinking')]);
  labby.emit('agents', [agent('l1', 'idle')]);

  assert.deepEqual(seen.at(-1), [
    { id: 'labby:l1', gateway: 'labby', state: 'idle', label: 'l1', runId: 'labby:l1-run', urgency: 'ambient', since: 1 },
    { id: 'omar:o1', gateway: 'omar', state: 'thinking', label: 'o1', runId: 'omar:o1-run', urgency: 'ambient', since: 1 },
  ]);
});

test('qualifies id and non-null runId but preserves a null runId', () => {
  const labby = new FakeSource();
  const source = new MultiGatewaySource([{ alias: 'labby', source: labby }]);
  const seen = [];
  source.on('agents', (agents) => seen.push(agents));

  source.start();
  labby.emit('agents', [
    agent('a', 'needs_attention', { runId: null, label: 'hello', urgency: 'blocking', since: 99 }),
  ]);

  assert.deepEqual(seen.at(-1), [
    {
      id: 'labby:a',
      gateway: 'labby',
      state: 'needs_attention',
      label: 'hello',
      runId: null,
      urgency: 'blocking',
      since: 99,
    },
  ]);
});

test('preserves prompt and future fields while qualifying id and runId', () => {
  const labby = new FakeSource();
  const source = new MultiGatewaySource([{ alias: 'labby', source: labby }]);
  const seen = [];
  const prompt = {
    id: 'prompt-1',
    kind: 'approve_reject',
    reversible: true,
    expiresAt: 12345,
  };
  source.on('agents', (agents) => seen.push(agents));

  source.start();
  labby.emit('agents', [
    {
      ...agent('a', 'needs_attention', { runId: 'run-1' }),
      prompt,
      futureField: { ok: true },
    },
  ]);

  assert.deepEqual(seen.at(-1), [
    {
      id: 'labby:a',
      gateway: 'labby',
      state: 'needs_attention',
      label: 'a',
      runId: 'labby:run-1',
      urgency: 'ambient',
      since: 1,
      prompt: { ...prompt, id: 'labby:prompt-1' },
      futureField: { ok: true },
    },
  ]);
  assert.deepEqual(seen.at(-1)[0].prompt, { ...prompt, id: 'labby:prompt-1' });
});

test('routes approval resolution only to the owning alias', async () => {
  const labby = new FakeSource();
  const omar = new FakeSource();
  const source = new MultiGatewaySource([
    { alias: 'labby', source: labby },
    { alias: 'omar', source: omar },
  ]);
  source.start();
  await source.resolveApproval('omar:prompt-9', 'deny');
  assert.deepEqual(labby.resolved, []);
  assert.deepEqual(omar.resolved, [{ id: 'prompt-9', decision: 'deny' }]);
});

test('refuses approval resolution for a stale alias', async () => {
  const labby = new FakeSource();
  const source = new MultiGatewaySource([{ alias: 'labby', source: labby }]);
  source.start();
  labby.emit('connection', { state: 'reconciling' });
  await assert.rejects(() => source.resolveApproval('labby:prompt-1', 'deny'), /stale or reconciling/);
});

test('qualifies an undefined runId to null', () => {
  const labby = new FakeSource();
  const source = new MultiGatewaySource([{ alias: 'labby', source: labby }]);
  const seen = [];
  source.on('agents', (agents) => seen.push(agents));

  source.start();
  labby.emit('agents', [
    {
      ...agent('a', 'idle'),
      runId: undefined,
    },
  ]);

  assert.deepEqual(seen.at(-1), [
    {
      id: 'labby:a',
      gateway: 'labby',
      state: 'idle',
      label: 'a',
      runId: null,
      urgency: 'ambient',
      since: 1,
    },
  ]);
});

test('a second emission from one alias replaces only that alias snapshot', () => {
  const labby = new FakeSource();
  const omar = new FakeSource();
  const source = new MultiGatewaySource([
    { alias: 'labby', source: labby },
    { alias: 'omar', source: omar },
  ]);
  const seen = [];
  source.on('agents', (agents) => seen.push(agents));

  source.start();
  labby.emit('agents', [agent('l1', 'idle')]);
  omar.emit('agents', [agent('o1', 'thinking')]);
  labby.emit('agents', [agent('l2', 'listening')]);

  assert.deepEqual(seen.at(-1), [
    { id: 'labby:l2', gateway: 'labby', state: 'listening', label: 'l2', runId: 'labby:l2-run', urgency: 'ambient', since: 1 },
    { id: 'omar:o1', gateway: 'omar', state: 'thinking', label: 'o1', runId: 'omar:o1-run', urgency: 'ambient', since: 1 },
  ]);
});

test('one alias disconnecting clears only its own records and marks it stale', () => {
  const labby = new FakeSource();
  const omar = new FakeSource();
  const source = new MultiGatewaySource([
    { alias: 'labby', source: labby },
    { alias: 'omar', source: omar },
  ]);
  const seen = [];
  const warnings = [];
  source.on('agents', (agents) => seen.push(agents));
  source.on('warning', (warning) => warnings.push(warning));

  source.start();
  labby.emit('agents', [agent('l1', 'idle')]);
  omar.emit('agents', [agent('o1', 'thinking')]);
  omar.emit('connection', { state: 'reconciling' });

  assert.deepEqual(seen.at(-1), [
    { id: 'labby:l1', gateway: 'labby', state: 'idle', label: 'l1', runId: 'labby:l1-run', urgency: 'ambient', since: 1 },
  ]);
  assert.deepEqual(source.staleAliases(), ['omar']);
  assert.match(warnings.at(-1), /\[omar\].*reconciling/i);
});

test('warnings are prefixed with the alias', () => {
  const labby = new FakeSource();
  const source = new MultiGatewaySource([{ alias: 'labby', source: labby }]);
  const warnings = [];
  source.on('warning', (warning) => warnings.push(warning));

  source.start();
  labby.emit('warning', 'sessions.list failed');

  assert.deepEqual(warnings, ['[labby] sessions.list failed']);
});

test('stop is idempotent and stops every child once', () => {
  const labby = new FakeSource();
  const omar = new FakeSource();
  const source = new MultiGatewaySource([
    { alias: 'labby', source: labby },
    { alias: 'omar', source: omar },
  ]);

  source.start();
  source.stop();
  source.stop();

  assert.equal(labby.started, 1);
  assert.equal(omar.started, 1);
  assert.equal(labby.stopped, 1);
  assert.equal(omar.stopped, 1);
});
