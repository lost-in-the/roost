import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregate, STATE_PRIORITY } from '../daemon/aggregate.js';
import { MockStateSource, DEMO_SCRIPT, scriptedAgentsAt, scriptDuration } from '../daemon/sources/mock.js';

const tinyScript = [
  { after: 0, agents: [{ id: 'a', state: 'idle', urgency: 'ambient', since: 0 }] },
  { after: 100, agents: [{ id: 'a', state: 'thinking', urgency: 'ambient', since: 100 }] },
  { after: 200, agents: [{ id: 'a', state: 'stalled', urgency: 'notify', since: 200 }] },
];

test('a script yields its first step at elapsed zero', () => {
  assert.equal(scriptedAgentsAt(tinyScript, 0)[0].state, 'idle');
});

test('a step holds until the next step is due', () => {
  assert.equal(scriptedAgentsAt(tinyScript, 99)[0].state, 'idle');
  assert.equal(scriptedAgentsAt(tinyScript, 100)[0].state, 'thinking');
  assert.equal(scriptedAgentsAt(tinyScript, 199)[0].state, 'thinking');
});

test('a script loops so the panel keeps demonstrating indefinitely', () => {
  const period = scriptDuration(tinyScript);
  assert.equal(scriptedAgentsAt(tinyScript, period)[0].state, 'idle', 'wraps back to the first step');
  assert.equal(scriptedAgentsAt(tinyScript, period + 100)[0].state, 'thinking');
});

test('the source emits only when the scripted step actually changes', () => {
  const seen = [];
  const src = new MockStateSource({ script: tinyScript });
  src.on('agents', (agents) => seen.push(agents[0].state));

  src.sample(0);
  src.sample(50);   // same step, must not re-emit
  src.sample(100);
  src.sample(150);  // same step, must not re-emit
  src.sample(200);

  assert.deepEqual(seen, ['idle', 'thinking', 'stalled']);
});

test('stop halts emission', () => {
  const seen = [];
  const src = new MockStateSource({ script: tinyScript });
  src.on('agents', (a) => seen.push(a[0].state));
  src.sample(0);
  src.stop();
  src.sample(100);
  assert.deepEqual(seen, ['idle'], 'no further emissions after stop');
});

test('the demo script exercises every state the daemon can produce', () => {
  const produced = new Set();
  for (let t = 0; t <= scriptDuration(DEMO_SCRIPT); t += 250) {
    produced.add(aggregate(scriptedAgentsAt(DEMO_SCRIPT, t)).state);
  }
  for (const state of STATE_PRIORITY) {
    assert.ok(produced.has(state), `demo script never displays ${state}`);
  }
});

test('the demo script contains a thinking to stalled transition on one agent', () => {
  let found = false;
  for (let i = 1; i < DEMO_SCRIPT.length; i++) {
    const before = DEMO_SCRIPT[i - 1].agents;
    const after = DEMO_SCRIPT[i].agents;
    for (const a of after) {
      const prior = before.find((b) => b.id === a.id);
      if (prior?.state === 'thinking' && a.state === 'stalled') found = true;
    }
  }
  assert.ok(found, 'the stalled-vs-thinking distinction is the point of the panel');
});

test('the demo script has a step where several agents change at once', () => {
  let maxSimultaneous = 0;
  for (let i = 1; i < DEMO_SCRIPT.length; i++) {
    const before = DEMO_SCRIPT[i - 1].agents;
    const changed = DEMO_SCRIPT[i].agents.filter((a) => {
      const prior = before.find((b) => b.id === a.id);
      return !prior || prior.state !== a.state;
    }).length;
    maxSimultaneous = Math.max(maxSimultaneous, changed);
  }
  assert.ok(maxSimultaneous >= 2, 'must exercise the simultaneous-transition race');
});

test('every scripted step aggregates without throwing', () => {
  for (let t = 0; t <= scriptDuration(DEMO_SCRIPT); t += 100) {
    assert.doesNotThrow(() => aggregate(scriptedAgentsAt(DEMO_SCRIPT, t)));
  }
});

test('the demo script reaches a count above one so the count field is exercised', () => {
  let maxCount = 0;
  for (let t = 0; t <= scriptDuration(DEMO_SCRIPT); t += 100) {
    maxCount = Math.max(maxCount, aggregate(scriptedAgentsAt(DEMO_SCRIPT, t)).count);
  }
  assert.ok(maxCount >= 2, `demo script only ever reached count ${maxCount}`);
});

test('a scripted death step is reported as a fatal event, not as an agent state', () => {
  const script = [
    { after: 0, agents: [{ id: 'a', state: 'thinking', urgency: 'ambient', since: 0 }] },
    { after: 100, die: true, agents: [{ id: 'a', state: 'thinking', urgency: 'ambient', since: 0 }] },
  ];
  const src = new MockStateSource({ script });
  let died = false;
  src.on('die', () => { died = true; });
  src.sample(0);
  assert.equal(died, false);
  src.sample(100);
  assert.ok(died, 'the daemon-death scenario must surface so LWT can be exercised');
});
