import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregate } from '../daemon/aggregate.js';
import { PendingApprovalStore, projectApproval } from '../daemon/openclaw/approvals.js';

const longLabel = 'Long approval label that must stay whole until aggregate decides whether it fits on the glass or becomes a handoff for safety.';

function rawApproval(over = {}) {
  return {
    id: 'appr-1',
    status: 'pending',
    expiresAtMs: 5000,
    presentation: {
      kind: 'plugin',
      allowedDecisions: ['allow-once', 'allow-always', 'deny'],
      title: 'Approve tiny change?',
      metadata: { reversible: true },
    },
    ...over,
  };
}

test('projection keeps only safe fields and filters allowed decisions to allow-once and deny', () => {
  assert.deepEqual(projectApproval(rawApproval()), {
    id: 'appr-1',
    gatewayKind: 'plugin',
    reversible: true,
    status: 'pending',
    expiresAtMs: 5000,
    allowedDecisions: ['allow-once', 'deny'],
    label: 'Approve tiny change?',
    actionable: true,
  });
});

test('projection drops an unknown status instead of guessing', () => {
  assert.equal(projectApproval(rawApproval({ status: 'mystery' })), null);
});

test('projection drops codex provenance only by pluginId and logs the correlation hash', () => {
  const seen = [];
  assert.equal(projectApproval(rawApproval({ pluginId: 'openclaw-codex-app-server' }), {
    onDrop: (msg) => seen.push(msg),
  }), null);
  assert.equal(projectApproval(rawApproval({
    pluginId: 'different-plugin',
    presentation: { ...rawApproval().presentation, title: 'Codex asking something' },
  }))?.id, 'appr-1');
  assert.match(seen[0], /correlation=/);
  assert.doesNotMatch(seen[0], /Approve tiny change/);
});

test('a long label survives projection untruncated and later downgrades to handoff in aggregate', () => {
  const projected = projectApproval(rawApproval({
    presentation: {
      kind: 'plugin',
      allowedDecisions: ['allow-once', 'deny'],
      title: longLabel,
      metadata: { reversible: true },
    },
  }));
  assert.equal(projected.label, longLabel);
  const out = aggregate([{
    id: 'agent-1',
    state: 'needs_attention',
    label: projected.label,
    runId: 'run-1',
    urgency: 'blocking',
    since: 1,
    prompt: {
      id: projected.id,
      kind: 'approve_reject',
      reversible: projected.reversible,
      expiresAt: projected.expiresAtMs,
    },
  }], { now: 1000 });
  assert.equal(out.prompt.kind, 'handoff');
});

test('reversible defaults to false when it cannot be determined', () => {
  assert.equal(projectApproval(rawApproval({
    presentation: {
      kind: 'plugin',
      allowedDecisions: ['allow-once', 'deny'],
      title: 'Unclear action',
    },
  })).reversible, false);
});

test('a plugin approval still projects to roost approve_reject and survives aggregate', () => {
  const projected = projectApproval(rawApproval({
    presentation: {
      kind: 'plugin',
      allowedDecisions: ['allow-once', 'deny'],
      title: 'Approve short change?',
      metadata: { reversible: true },
    },
  }));
  const out = aggregate([{
    id: 'agent-1',
    state: 'needs_attention',
    label: projected.label,
    runId: 'run-1',
    urgency: 'blocking',
    since: 1,
    prompt: {
      id: projected.id,
      kind: 'approve_reject',
      reversible: projected.reversible,
      expiresAt: projected.expiresAtMs,
    },
  }], { now: 1000 });

  assert.equal(projected.gatewayKind, 'plugin');
  assert.equal(out.prompt.kind, 'approve_reject');
});

test('a missing or blank label downgrades to a non-actionable handoff instead of disappearing', () => {
  assert.deepEqual(projectApproval(rawApproval({
    presentation: {
      kind: 'plugin',
      allowedDecisions: ['allow-once', 'deny'],
      title: '   ',
      metadata: { reversible: true },
    },
  })), {
    id: 'appr-1',
    gatewayKind: 'plugin',
    reversible: true,
    status: 'pending',
    expiresAtMs: 5000,
    allowedDecisions: ['allow-once', 'deny'],
    label: null,
    actionable: true,
  });
});

test('a truncated replay keeps unseen entries non-actionable and never resurrects an omitted authoritative entry', () => {
  const store = new PendingApprovalStore();
  const expiresAtMs = Date.now() + 5000;
  const a = projectApproval(rawApproval({ id: 'a', expiresAtMs }));
  const b = projectApproval(rawApproval({ id: 'b', expiresAtMs }));
  store.replaceReplay('sess-1', [a, b], { truncated: false });
  store.replaceReplay('sess-1', [a], { truncated: true });
  assert.equal(store.getPrompt('sess-1').id, 'a');
  const unseen = store.pendingBySession.get('sess-1').get('b');
  assert.equal(unseen.actionable, false);
  store.replaceReplay('sess-1', [], { truncated: false });
  assert.equal(store.getPrompt('sess-1'), null);
});

test('expiry kills an entry without a new message', () => {
  let now = 1000;
  const store = new PendingApprovalStore({ now: () => now });
  store.replaceReplay('sess-1', [projectApproval(rawApproval({ expiresAtMs: 1200 }))], { truncated: false });
  assert.equal(store.getPrompt('sess-1')?.id, 'appr-1');
  now = 1200;
  assert.equal(store.getPrompt('sess-1'), null);
  assert.deepEqual(store.getResolved('appr-1'), {
    status: 'expired',
    decision: null,
    resolvedAtMs: 1200,
    correlation: store.getResolved('appr-1')?.correlation,
  });
  assert.equal(typeof store.getResolved('appr-1')?.correlation, 'string');
  assert.ok((store.getResolved('appr-1')?.correlation?.length ?? 0) > 0);
});

test('remembering a terminal answer makes a second answer reject distinguishably', () => {
  const store = new PendingApprovalStore();
  store.rememberResolved('appr-1', { status: 'denied', decision: 'deny' });
  assert.deepEqual(store.getResolved('appr-1'), { status: 'denied', decision: 'deny' });
});

test('resolved retention is bounded fifo so already-answered stays distinct without unbounded growth', () => {
  const store = new PendingApprovalStore({ maxResolved: 2 });
  store.rememberResolved('appr-1', { status: 'denied', decision: 'deny' });
  store.rememberResolved('appr-2', { status: 'allowed', decision: 'allow-once' });
  store.rememberResolved('appr-3', { status: 'expired', decision: null });

  assert.equal(store.getResolved('appr-1'), null);
  assert.deepEqual(store.getResolved('appr-2'), { status: 'allowed', decision: 'allow-once' });
  assert.deepEqual(store.getResolved('appr-3'), { status: 'expired', decision: null });
});
