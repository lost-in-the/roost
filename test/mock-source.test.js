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

// ── prompts in the demo loop ─────────────────────────────────────────────────

/** Every agent set the source actually emits over one full loop. */
function emittedOverOneLoop(script) {
  const emitted = [];
  const src = new MockStateSource({ script });
  src.on('agents', (a) => emitted.push(a));
  for (let t = 0; t <= scriptDuration(script); t += 100) src.sample(t);
  src.stop();
  return emitted;
}

test('a scripted relative expiry is emitted as wall-clock, not left relative', () => {
  // The bug this exists to prevent: a relative expiry reaching aggregate() is a
  // 1970 timestamp, so every demo prompt would be dropped as expired and the
  // panel would silently never show a button.
  const emitted = emittedOverOneLoop(DEMO_SCRIPT);
  const withPrompt = emitted.flat().filter((a) => a.prompt);
  assert.ok(withPrompt.length > 0, 'the demo loop must exercise prompts at all');
  for (const a of withPrompt) {
    assert.ok(a.prompt.expiresAt > a.since, 'expiry must be after the state started');
    assert.ok(a.prompt.expiresAt > Date.now(), 'and still in the future when emitted');
  }
});

test('the demo loop reaches a step where the panel would draw buttons', () => {
  const now = Date.now();
  const withButtons = emittedOverOneLoop(DEMO_SCRIPT)
    .map((agents) => aggregate(agents, { now }))
    .filter((out) => out.prompt !== null);
  assert.ok(withButtons.length > 0, 'no step in the demo loop yields a prompt');
  for (const out of withButtons) {
    assert.equal(out.state, 'needs_attention', 'a prompt without needs_attention is incoherent');
    assert.equal(out.prompt.kind, 'approve_reject');
    assert.equal(out.primary_run_id, 'run-1d7e', 'the prompt belongs to the agent on the glass');
  }
});

test('the demo loop also reaches needs_attention with no prompt', () => {
  // The degraded rendering is a real state the panel must handle, so the demo
  // has to show it rather than only ever showing the happy path.
  const now = Date.now();
  const degraded = emittedOverOneLoop(DEMO_SCRIPT)
    .map((agents) => aggregate(agents, { now }))
    .filter((out) => out.state === 'needs_attention' && out.prompt === null);
  assert.ok(degraded.length > 0, 'demo never shows needs_attention without buttons');
});

test('no scripted prompt is ever dropped as malformed', () => {
  // A typo in DEMO_SCRIPT would otherwise show up only as a panel that quietly
  // never draws a button.
  const now = Date.now();
  const warnings = [];
  for (const agents of emittedOverOneLoop(DEMO_SCRIPT)) {
    aggregate(agents, { now, onWarn: (m) => warnings.push(m) });
  }
  assert.deepEqual(warnings, []);
});

test('an agent with no scripted prompt does not gain one on emission', () => {
  const emitted = emittedOverOneLoop(tinyScript).flat();
  assert.ok(emitted.length > 0);
  for (const a of emitted) {
    assert.ok(!('prompt' in a), 'absent must stay absent, not become undefined');
  }
});

test('a prompt survives the simultaneous-transition step it spans', () => {
  // The race step changes two other agents. The asking agent is untouched, so
  // its question must not blink out and back.
  const asking = DEMO_SCRIPT
    .map((step) => step.agents.find((a) => a.prompt))
    .filter(Boolean);
  assert.ok(asking.length >= 2, 'the prompt must span more than one step');
  const ids = new Set(asking.map((a) => a.prompt.id));
  assert.equal(ids.size, 1, 'the same question keeps the same id across steps');
});

test('the demo script has one run asking two different questions', () => {
  // This is why answering names the prompt id rather than the run id.
  const questions = new Set(
    DEMO_SCRIPT
      .flatMap((step) => step.agents)
      .filter((a) => a.runId === 'run-1d7e' && a.state === 'needs_attention')
      .map((a) => a.label),
  );
  assert.ok(questions.size >= 2, `run-1d7e only ever asked ${questions.size} question(s)`);
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
