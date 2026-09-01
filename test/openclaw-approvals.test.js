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
    createdAtMs: null,
    expiresAtMs: 5000,
    allowedDecisions: ['allow-once', 'deny'],
    label: 'Approve tiny change?',
    actorId: null,
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
    createdAtMs: null,
    expiresAtMs: 5000,
    allowedDecisions: ['allow-once', 'deny'],
    label: null,
    actorId: null,
    actionable: false,
  });
});

test('Claude native generic titles carry actor identity but are handoff-only', () => {
  const projected = projectApproval(rawApproval({
    createdAtMs: 1234,
    presentation: {
      kind: 'plugin',
      allowedDecisions: ['allow-once', 'deny'],
      title: 'Claude native tool: Bash',
      description: '{"command":"SECRET path"}',
      detail: 'SECRET detail',
      toolName: 'Bash',
      agentId: 'omar',
    },
  }));
  assert.equal(projected.label, 'Claude native tool: Bash');
  assert.equal(projected.actorId, 'omar');
  assert.equal(projected.createdAtMs, 1234);
  assert.equal(projected.actionable, false);
  assert.doesNotMatch(JSON.stringify(projected), /SECRET|command|path/);
});

test('a generic Claude tool title fails closed when toolName is omitted or inconsistent', () => {
  for (const toolName of [undefined, 'Shell']) {
    const projected = projectApproval(rawApproval({
      presentation: {
        kind: 'plugin',
        allowedDecisions: ['allow-once', 'deny'],
        title: 'Claude native tool: Bash',
        toolName,
      },
    }));
    assert.equal(projected.label, 'Claude native tool: Bash');
    assert.equal(projected.actionable, false);
  }
});

test('an unsafe title cannot spoof the panel and a clean fallback label is accepted', () => {
  const projected = projectApproval(rawApproval({
    presentation: {
      kind: 'plugin',
      allowedDecisions: ['allow-once', 'deny'],
      title: 'Allow\u202eDeny',
      label: 'Approve safe bounded action?',
    },
  }));
  assert.equal(projected.label, 'Approve safe bounded action?');
  assert.equal(projected.actionable, true);
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

test('one session exposes its earliest-expiring pending approval, then breaks otherwise-equal entries by id', () => {
  const store = new PendingApprovalStore({ now: () => 1000 });
  const late = projectApproval(rawApproval({ id: 'late', expiresAtMs: 5000 }));
  const earlyZ = projectApproval(rawApproval({ id: 'z-early', expiresAtMs: 3000 }));
  const earlyA = projectApproval(rawApproval({ id: 'a-early', expiresAtMs: 3000 }));
  store.replaceReplay('sess-1', [late, earlyZ, earlyA], { truncated: false });

  // This remains source-local ordering. aggregate() later merges every source
  // projection into the daemon-owned global order.
  assert.equal(store.getPrompt('sess-1').id, 'a-early');
});

test('one session exposes every pending approval in deadline order for daemon queueing', () => {
  const store = new PendingApprovalStore({ now: () => 1000 });
  store.replaceReplay('sess-1', [
    projectApproval(rawApproval({ id: 'late', createdAtMs: 1100, expiresAtMs: 5000 })),
    projectApproval(rawApproval({ id: 'new', createdAtMs: 1300, expiresAtMs: 3000 })),
    projectApproval(rawApproval({ id: 'old', createdAtMs: 1200, expiresAtMs: 3000 })),
  ]);
  assert.deepEqual(store.getPrompts('sess-1').map(({ id }) => id), ['old', 'new', 'late']);
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
