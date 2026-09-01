import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONFIRM_MS,
  canSubmit,
  readDecisionResponse,
  promptView,
  reducePhase,
  outcomeMessage,
} from '../renderer/components/approval-controls.js';

const NOW = Date.parse('2026-08-30T16:00:00Z');

function prompt(overrides = {}) {
  return {
    id: 'labby:appr-1',
    kind: 'approve_reject',
    reversible: true,
    expires_at: '2026-08-30T16:05:00Z',
    ...overrides,
  };
}

function view(overrides = {}) {
  return promptView({
    prompt: prompt(),
    state: 'needs_attention',
    stale: false,
    now: NOW,
    phase: {},
    ...overrides,
  });
}

test('approve_reject draws exactly deny and allow-once', () => {
  const result = view();
  assert.equal(result.visible, true);
  assert.deepEqual(result.buttons.map((button) => button.decision), ['deny', 'allow-once']);
  assert.equal(result.buttons.some((button) => button.decision === 'allow-always'), false);
});

test('approval attribution names the actor and exposes only the queue count', () => {
  const result = view({ prompt: prompt({
    actor: { gateway: 'Omar', name: 'Claude' },
    queue: { position: 1, total: 3 },
  }) });
  assert.equal(result.meta, 'Omar · Claude · 3 decisions waiting');
});

test('handoff draws no buttons and tells the operator to answer elsewhere', () => {
  const result = view({ prompt: prompt({ kind: 'handoff', reversible: false }) });
  assert.equal(result.visible, true);
  assert.deepEqual(result.buttons, []);
  assert.match(result.line, /elsewhere/i);
});

test('unknown prompt kind is treated as no prompt at all', () => {
  const result = view({ prompt: prompt({ kind: 'plugin' }) });
  assert.equal(result.visible, false);
  assert.deepEqual(result.buttons, []);
});

test('missing, null, and malformed prompts are treated as absent', () => {
  assert.equal(view({ prompt: null }).visible, false);
  assert.equal(view({ prompt: { kind: 'approve_reject', reversible: true } }).visible, false);
  assert.equal(view({ prompt: prompt({ expires_at: 'not-a-date' }) }).visible, false);
});

test('reversible true allows once in one tap', () => {
  const result = view({ prompt: prompt({ reversible: true }) });
  const allow = result.buttons.find((button) => button.decision === 'allow-once');
  assert.equal(allow.confirm, false);
  assert.equal(allow.text, 'Allow once');
});

test('reversible false arms a second confirm for allow once', () => {
  let phase = reducePhase({}, { type: 'arm-confirm', promptId: 'labby:appr-1' }, NOW);
  const result = view({ prompt: prompt({ reversible: false }), phase });
  const allow = result.buttons.find((button) => button.decision === 'allow-once');
  assert.equal(allow.confirm, true);
  assert.equal(allow.armed, true);
  assert.match(allow.text, /confirm/i);
});

test('the second confirm disarms on its own after a few seconds', () => {
  let phase = reducePhase({}, { type: 'arm-confirm', promptId: 'labby:appr-1' }, NOW);
  phase = reducePhase(phase, { type: 'tick' }, NOW + CONFIRM_MS + 1);
  const result = view({ prompt: prompt({ reversible: false }), phase, now: NOW + CONFIRM_MS + 1 });
  const allow = result.buttons.find((button) => button.decision === 'allow-once');
  assert.equal(allow.armed, false);
  assert.equal(allow.text, 'Allow once');
});

test('changing prompt id resets the armed confirm state', () => {
  let phase = reducePhase({}, { type: 'arm-confirm', promptId: 'labby:appr-1' }, NOW);
  phase = reducePhase(phase, { type: 'prompt-changed', promptId: 'labby:appr-2' }, NOW + 1000);
  const result = view({ prompt: prompt({ id: 'labby:appr-2', reversible: false }), phase, now: NOW + 1000 });
  const allow = result.buttons.find((button) => button.decision === 'allow-once');
  assert.equal(allow.armed, false);
});

test('stale panels and offline state disable both controls', () => {
  for (const result of [
    view({ stale: true }),
    view({ state: 'offline' }),
  ]) {
    assert.equal(result.disabled, true);
    assert.equal(result.buttons.every((button) => button.disabled), true);
  }
});

test('expired prompts disable themselves by local clock without a new message', () => {
  const result = view({
    now: Date.parse('2026-08-30T16:06:00Z'),
    prompt: prompt({ expires_at: '2026-08-30T16:05:00Z' }),
  });
  assert.equal(result.disabled, true);
  assert.match(result.line, /expired/i);
});

test('one in-flight answer disables both controls', () => {
  const phase = reducePhase({}, { type: 'submit-start', promptId: 'labby:appr-1' }, NOW);
  const result = view({ phase });
  assert.equal(result.disabled, true);
  assert.equal(result.buttons.every((button) => button.disabled), true);
  assert.match(result.line, /sending/i);
});

test('each response code maps to the documented message and keeps the prompt disabled', () => {
  const cases = [
    [{ ok: true, decision: 'deny' }, /denied/i],
    [{ ok: true, decision: 'allow-once' }, /allowed once/i],
    [{ ok: false, code: 'already_answered' }, /already answered/i],
    [{ ok: false, code: 'expired' }, /no longer answerable here/i],
    [{ ok: false, code: 'not_actionable' }, /no longer answerable here/i],
    [{ ok: false, code: 'gateway_stale' }, /no longer answerable here/i],
    [{ ok: false, code: 'transport_uncertain' }, /check on a laptop/i],
    [{ ok: false, code: 'bad_request' }, /failed/i],
    [{ ok: false, code: 'network_failure' }, /failed/i],
    [{ ok: false, code: 'http_501' }, /failed/i],
  ];

  for (const [outcome, pattern] of cases) {
    const phase = reducePhase({}, {
      type: 'submit-result',
      promptId: 'labby:appr-1',
      ...outcome,
    }, NOW);
    const result = view({ phase });
    assert.equal(result.disabled, true);
    assert.match(result.message, pattern);
  }
});

test('a new prompt clears the disabled lock left by a failed or answered one', () => {
  let phase = reducePhase({}, {
    type: 'submit-result',
    promptId: 'labby:appr-1',
    ok: false,
    code: 'already_answered',
  }, NOW);
  phase = reducePhase(phase, { type: 'prompt-changed', promptId: 'labby:appr-2' }, NOW + 1000);
  const result = view({ prompt: prompt({ id: 'labby:appr-2' }), phase, now: NOW + 1000 });
  assert.equal(result.disabled, false);
  assert.equal(result.message, '');
});

test('the pure control logic never queues anything for later', () => {
  const phase = reducePhase({}, { type: 'submit-result', promptId: 'labby:appr-1', ok: false, code: 'network_failure' }, NOW);
  assert.equal('pending' in phase, false);
  assert.equal('queue' in phase, false);
});

test('outcomeMessage is stable for plain failure cases', () => {
  assert.equal(outcomeMessage({ ok: false, code: 'bad_request' }), 'Approval failed.');
  assert.equal(outcomeMessage({ ok: false, code: 'transport_uncertain' }), 'Result unknown. Check on a laptop.');
});

test('canSubmit refuses stale, offline, disabled, unknown, and unavailable decisions', () => {
  const snapshot = {
    prompt: prompt(),
    label: 'Approve deploy?',
    state: 'needs_attention',
    stale: false,
  };
  const submitView = promptView({ ...snapshot, now: NOW, phase: {} });

  assert.equal(canSubmit({ view: submitView, snapshot: { ...snapshot, stale: true }, decision: 'deny' }), false);
  assert.equal(canSubmit({ view: submitView, snapshot: { ...snapshot, state: 'offline' }, decision: 'deny' }), false);

  const disabledView = promptView({
    ...snapshot,
    now: NOW,
    phase: reducePhase({}, { type: 'submit-start', promptId: 'labby:appr-1' }, NOW),
  });
  assert.equal(canSubmit({ view: disabledView, snapshot, decision: 'deny' }), false);
  assert.equal(canSubmit({ view: submitView, snapshot, decision: 'allow-always' }), false);

  const handoffView = promptView({
    prompt: prompt({ kind: 'handoff', reversible: false }),
    state: 'needs_attention',
    stale: false,
    now: NOW,
    phase: {},
  });
  assert.equal(canSubmit({ view: handoffView, snapshot: { ...snapshot, prompt: prompt({ kind: 'handoff', reversible: false }) }, decision: 'deny' }), false);
});

test('readDecisionResponse accepts only panel-supported applied decisions', () => {
  assert.deepEqual(
    readDecisionResponse({ ok: true, status: 200, body: { ok: true, decision: 'deny', status: 'denied' } }),
    { ok: true, decision: 'deny', code: null },
  );
  assert.deepEqual(
    readDecisionResponse({ ok: true, status: 200, body: { ok: true, decision: 'allow-once', status: 'allowed' } }),
    { ok: true, decision: 'allow-once', code: null },
  );
  assert.deepEqual(
    readDecisionResponse({ ok: true, status: 200, body: { ok: true } }),
    { ok: false, decision: null, code: 'transport_uncertain' },
  );
  assert.deepEqual(
    readDecisionResponse({ ok: true, status: 200, body: { ok: true, decision: 'allow-always' } }),
    { ok: false, decision: null, code: 'transport_uncertain' },
  );
  assert.deepEqual(
    readDecisionResponse({ ok: true, status: 200, body: { ok: true, decision: 'deny', status: 'allowed' } }),
    { ok: false, decision: null, code: 'transport_uncertain' },
  );
  assert.deepEqual(
    readDecisionResponse({ ok: true, status: 200, body: { ok: true, decision: 'deny', status: 'pending' } }),
    { ok: false, decision: null, code: 'transport_uncertain' },
  );
  assert.deepEqual(
    readDecisionResponse({ ok: true, status: 200, body: { ok: true, decision: 'deny', status: null } }),
    { ok: false, decision: null, code: 'transport_uncertain' },
  );
  assert.deepEqual(
    readDecisionResponse({ ok: true, status: 200, body: { ok: true, decision: 'deny', status: 'weird-unknown-status' } }),
    { ok: false, decision: null, code: 'transport_uncertain' },
  );
  assert.deepEqual(
    readDecisionResponse({ ok: true, status: 200, body: null }),
    { ok: false, decision: null, code: 'transport_uncertain' },
  );

  for (const code of ['already_answered', 'expired', 'not_actionable', 'gateway_stale', 'transport_uncertain', 'bad_request']) {
    assert.deepEqual(
      readDecisionResponse({ ok: false, status: 409, body: { ok: false, code } }),
      { ok: false, decision: null, code },
    );
  }

  assert.deepEqual(
    readDecisionResponse({ ok: false, status: 501, body: null }),
    { ok: false, decision: null, code: 'http_501' },
  );
});
