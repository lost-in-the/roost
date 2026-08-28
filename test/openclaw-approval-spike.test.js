import test from 'node:test';
import assert from 'node:assert/strict';
import {
  approvalCorrelation,
  assertSpikeDecision,
  safeApprovalSummary,
  safeReplaySummary,
  safeResolutionSummary,
} from '../daemon/openclaw/approval-spike.js';

const raw = {
  id: 'plugin:secret-id',
  status: 'pending',
  createdAtMs: 10,
  expiresAtMs: 20,
  urlPath: '/approve/plugin:secret-id',
  presentation: {
    kind: 'plugin',
    allowedDecisions: ['allow-once', 'allow-always', 'deny'],
    commandText: 'curl https://secret.example',
    path: '/secret/path',
    prompt: 'sensitive prompt',
    detail: 'sensitive detail',
  },
};

test('approval spike summary is an allowlist that excludes presentation content and raw ids', () => {
  const json = JSON.stringify(safeApprovalSummary(raw));
  assert.deepEqual(safeApprovalSummary(raw), {
    correlation: approvalCorrelation(raw.id),
    kind: 'plugin',
    status: 'pending',
    allowedDecisions: ['allow-once', 'deny'],
    createdAtMs: 10,
    expiresAtMs: 20,
  });
  for (const forbidden of ['secret-id', 'secret.example', '/secret/path', 'sensitive prompt', 'sensitive detail']) {
    assert.equal(json.includes(forbidden), false, `summary leaked ${forbidden}`);
  }
});

test('replay and resolution summaries never expose raw approval objects', () => {
  const replay = safeReplaySummary({ sessionKey: 'secret-session', approvals: [raw], truncated: false });
  const resolution = safeResolutionSummary({ applied: true, approval: { ...raw, status: 'denied', decision: 'deny' } });
  const json = JSON.stringify({ replay, resolution });
  assert.deepEqual(replay, { count: 1, truncated: false, correlations: [approvalCorrelation(raw.id)] });
  assert.equal(json.includes('secret-session'), false);
  assert.equal(json.includes('secret-id'), false);
  assert.equal(json.includes('commandText'), false);
});

test('the spike can only issue the two panel decisions', () => {
  assert.equal(assertSpikeDecision('allow-once'), 'allow-once');
  assert.equal(assertSpikeDecision('deny'), 'deny');
  assert.throws(() => assertSpikeDecision('allow-always'));
  assert.throws(() => assertSpikeDecision('approved'));
});

