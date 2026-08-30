import test from 'node:test';
import assert from 'node:assert/strict';
import { SESSION_VIEWER_PRESENCE_MAX_KEYS } from '@openclaw/gateway-protocol/schema';
import { OpenClawStateSource, selectViewerSessionKeys } from '../daemon/sources/openclaw.js';

const sess = (key, active) => ({ key, displayName: key, hasActiveRun: active, archived: false, lastActivityAt: 1 });

/** Fake GatewayClient: records requests, lets the test drive callbacks. */
function fakeGateway({ sessions = [], onRequest } = {}) {
  const state = { requests: [], requestParams: [], options: null, started: 0, stopped: 0, sessions };
  const create = (options) => {
    state.options = options;
    return {
      start() { state.started += 1; },
      stop() { state.stopped += 1; },
      request(method, params) {
        state.requests.push(method);
        state.requestParams.push({ method, params });
        if (onRequest) {
          const handled = onRequest(method, params, state);
          if (handled !== undefined) return handled;
        }
        if (method === 'sessions.list') return Promise.resolve({ sessions: state.sessions, count: state.sessions.length });
        if (method === 'sessions.viewers.set' && params.sessionKeys.length > SESSION_VIEWER_PRESENCE_MAX_KEYS) {
          return Promise.reject(new Error('Too many session keys'));
        }
        return Promise.resolve({});
      },
    };
  };
  return { create, state };
}

const settle = () => new Promise((r) => setTimeout(r, 10));

function fakeTimers() {
  let now = 0;
  let nextId = 1;
  const pending = new Map();
  const fired = [];
  return {
    fired,
    setTimeoutFn(fn, delay = 0) {
      const handle = {
        id: nextId++,
        runAt: now + delay,
        fn,
        delay,
        cleared: false,
        unref() {},
      };
      pending.set(handle.id, handle);
      return handle;
    },
    clearTimeoutFn(handle) {
      if (!handle) return;
      handle.cleared = true;
      pending.delete(handle.id);
    },
    count(delay) {
      return [...pending.values()].filter((timer) => timer.delay === delay).length;
    },
    async tick(ms) {
      const target = now + ms;
      while (true) {
        const due = [...pending.values()]
          .filter((timer) => timer.runAt <= target)
          .sort((a, b) => a.runAt - b.runAt || a.id - b.id)[0];
        if (!due) break;
        pending.delete(due.id);
        if (due.cleared) continue;
        now = due.runAt;
        fired.push(due.delay);
        due.fn();
        await Promise.resolve();
        await Promise.resolve();
      }
      now = target;
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

const makeSource = (gw, overrides = {}) => new OpenClawStateSource({
  createClient: gw.create, url: 'ws://x', deviceToken: 'tok',
  deviceIdentity: { deviceId: 'd', privateKeyPem: 'p', publicKeyPem: 'q' },
  debounceMs: 0,
  ...overrides,
});

test('emits the full agent set once connected, because aggregate needs the whole set', async () => {
  const gw = fakeGateway({ sessions: [sess('a', true), sess('b', false)] });
  const source = makeSource(gw);
  const seen = [];
  source.on('agents', (a) => seen.push(a));

  source.start();
  gw.state.options.onHelloOk({ auth: { scopes: ['operator.read'] } });
  await settle();

  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].map((x) => [x.id, x.state]), [['a', 'thinking'], ['b', 'idle']]);
  source.stop();
});

test('subscribes to sessions instead of polling, because the gateway pushes changes', async () => {
  const gw = fakeGateway({ sessions: [] });
  const source = makeSource(gw);
  source.start();
  gw.state.options.onHelloOk({ auth: {} });
  await settle();

  assert.ok(gw.state.requests.includes('sessions.subscribe'), 'must subscribe');
  source.stop();
});

test('re-snapshots when a session changes, so the panel follows live activity', async () => {
  const gw = fakeGateway({ sessions: [sess('a', false)] });
  const source = makeSource(gw);
  const seen = [];
  source.on('agents', (a) => seen.push(a));
  source.start();
  gw.state.options.onHelloOk({ auth: {} });
  await settle();

  gw.state.sessions = [sess('a', true)];
  gw.state.options.onEvent({ event: 'sessions.changed', payload: {} });
  await settle();

  assert.equal(seen.length, 2, 'a change event must produce a fresh emission');
  assert.equal(seen[1][0].state, 'thinking');
  source.stop();
});

test('a working snapshot schedules exactly one trailing re-snapshot and it fires', async () => {
  const timers = fakeTimers();
  const gw = fakeGateway({ sessions: [sess('a', true)] });
  const source = makeSource(gw, { setTimeoutFn: timers.setTimeoutFn, clearTimeoutFn: timers.clearTimeoutFn });
  const seen = [];
  source.on('agents', (a) => seen.push(a));

  source.start();
  gw.state.options.onHelloOk({ auth: {} });
  await settle();

  assert.equal(seen.length, 1);
  assert.equal(timers.count(2000), 1, 'one trailing timer should be armed');

  await timers.tick(2000);

  assert.equal(seen.length, 2, 'the trailing timer should trigger one more snapshot');
  assert.equal(timers.count(2000), 0, 'the trailing snapshot must not chain into another trailing timer');
  source.stop();
});

test('an idle snapshot schedules no trailing or reconcile timers', async () => {
  const timers = fakeTimers();
  const gw = fakeGateway({ sessions: [sess('a', false)] });
  const source = makeSource(gw, { setTimeoutFn: timers.setTimeoutFn, clearTimeoutFn: timers.clearTimeoutFn });

  source.start();
  gw.state.options.onHelloOk({ auth: {} });
  await settle();

  assert.equal(timers.count(2000), 0);
  assert.equal(timers.count(60000), 0);
  source.stop();
});

test('the reconcile timer runs only while working and stops after an idle snapshot', async () => {
  const timers = fakeTimers();
  const gw = fakeGateway({ sessions: [sess('a', true)] });
  const source = makeSource(gw, {
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    trailingSnapshotMs: 120000,
  });
  const seen = [];
  source.on('agents', (a) => seen.push(a));

  source.start();
  gw.state.options.onHelloOk({ auth: {} });
  await settle();

  assert.equal(timers.count(60000), 1, 'working state should arm reconcile');
  await timers.tick(60000);
  assert.equal(seen.length, 2, 'reconcile should fire while working');
  assert.equal(timers.count(60000), 1, 'reconcile should re-arm while work continues');

  gw.state.sessions = [sess('a', false)];
  gw.state.options.onEvent({ event: 'sessions.changed', payload: {} });
  await timers.tick(0);
  await settle();

  assert.equal(seen.at(-1)[0].state, 'idle');
  assert.equal(timers.count(60000), 0, 'idle state should clear reconcile');
  source.stop();
});

test('a real event before the trailing timer replaces it instead of double-snapshotting', async () => {
  const timers = fakeTimers();
  const gw = fakeGateway({ sessions: [sess('a', true)] });
  const source = makeSource(gw, { setTimeoutFn: timers.setTimeoutFn, clearTimeoutFn: timers.clearTimeoutFn });
  const seen = [];
  source.on('agents', (a) => seen.push(a));

  source.start();
  gw.state.options.onHelloOk({ auth: {} });
  await settle();
  assert.equal(timers.count(2000), 1);

  gw.state.options.onEvent({ event: 'sessions.changed', payload: {} });
  await timers.tick(0);
  await settle();
  assert.equal(seen.length, 2, 'the real event should trigger the replacement snapshot');
  assert.equal(timers.count(2000), 1, 'exactly one replacement trailing timer should remain');

  await timers.tick(2000);
  await settle();
  assert.equal(seen.length, 3, 'only the replacement trailing timer should fire');
  await timers.tick(2000);
  await settle();
  assert.equal(seen.length, 3, 'no canceled trailing timer should still fire later');
  source.stop();
});

test('re-runs a coalesced refresh after an in-flight snapshot resolves, so a started run is not lost', async () => {
  let resolveList;
  const gw = fakeGateway({
    sessions: [sess('a', false)],
    onRequest(method, params, state) {
      if (method !== 'sessions.list') return undefined;
      return new Promise((resolve) => {
        resolveList = (sessions = state.sessions) => resolve({ sessions, count: sessions.length });
      });
    },
  });
  const timers = fakeTimers();
  const source = makeSource(gw, {
    debounceMs: 150,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });
  const seen = [];
  source.on('agents', (a) => seen.push(a));

  source.start();
  gw.state.options.onHelloOk({ auth: {} });
  await settle();
  assert.equal(gw.state.requests.filter((m) => m === 'sessions.list').length, 1, 'the first snapshot should be in flight');

  gw.state.sessions = [sess('a', true)];
  gw.state.options.onEvent({ event: 'sessions.changed', payload: {} });
  await timers.tick(150);

  assert.equal(gw.state.requests.filter((m) => m === 'sessions.list').length, 1,
    'the debounced refresh should coalesce behind the in-flight snapshot');

  resolveList([sess('a', false)]);
  await Promise.resolve();
  await Promise.resolve();
  await settle();

  assert.equal(gw.state.requests.filter((m) => m === 'sessions.list').length, 2,
    'the owed refresh should re-run once the stale snapshot finishes');
  assert.equal(seen[0][0].state, 'idle', 'the first snapshot still reflects the old session set');

  resolveList([sess('a', true)]);
  await settle();

  assert.equal(seen.at(-1)[0].state, 'thinking', 'the second snapshot should emit the started run');
  source.stop();
});

test('re-snapshots after a reconnect, because nothing is queued for a disconnected client', async () => {
  const gw = fakeGateway({ sessions: [sess('a', false)] });
  const source = makeSource(gw);
  const seen = [];
  source.on('agents', (a) => seen.push(a));
  source.start();
  gw.state.options.onHelloOk({ auth: {} });
  await settle();

  // A reconnect surfaces as a second hello-ok on the same client.
  gw.state.sessions = [sess('a', true), sess('c', true)];
  gw.state.options.onHelloOk({ auth: {} });
  await settle();

  assert.equal(seen.length, 2);
  assert.equal(seen[1].length, 2, 'the post-reconnect snapshot replaces the old projection');
  assert.ok(gw.state.requests.filter((m) => m === 'sessions.subscribe').length >= 2,
    'the subscription must be re-established after reconnect');
  source.stop();
});

test('stop is idempotent and silences further emissions', async () => {
  const gw = fakeGateway({ sessions: [sess('a', true)] });
  const source = makeSource(gw);
  const seen = [];
  source.on('agents', (a) => seen.push(a));
  source.start();
  gw.state.options.onHelloOk({ auth: {} });
  await settle();

  source.stop();
  source.stop();
  gw.state.options.onEvent({ event: 'sessions.changed', payload: {} });
  await settle();

  assert.equal(seen.length, 1, 'no emissions after stop');
  assert.equal(gw.state.stopped, 1, 'the client is stopped exactly once');
});

test('advertises tool-events, without which the gateway silently sends no live progress', async () => {
  const { GATEWAY_CLIENT_CAPS } = await import('@openclaw/gateway-protocol/client-info');
  const gw = fakeGateway({ sessions: [] });
  const source = makeSource(gw);
  source.start();
  gw.state.options.onHelloOk({ auth: {} });
  await settle();

  // The gateway registers only connections advertising this capability as
  // recipients for a run's structured tool events, and says nothing if you
  // omit it. Every progress field on a session record is null or frozen while
  // a run is active, so these events are the ONLY live progress signal.
  assert.ok(Array.isArray(gw.state.options.caps), 'caps must be declared, not left undefined');
  assert.ok(gw.state.options.caps.includes(GATEWAY_CLIENT_CAPS.TOOL_EVENTS),
    `caps ${JSON.stringify(gw.state.options.caps)} is missing tool-events`);
  source.stop();
});

test('declares only capabilities it implements, per the gateway guidance', async () => {
  const { GATEWAY_CLIENT_CAPS } = await import('@openclaw/gateway-protocol/client-info');
  const known = new Set(Object.values(GATEWAY_CLIENT_CAPS));
  const gw = fakeGateway({ sessions: [] });
  const source = makeSource(gw);
  source.start();
  gw.state.options.onHelloOk({ auth: {} });
  await settle();

  for (const c of gw.state.options.caps) {
    assert.ok(known.has(c), `${c} is not in the gateway's capability registry`);
  }
  // roost is read-only at M1: it must not claim approval capabilities it has
  // neither the scope nor the UI to honour.
  assert.equal(gw.state.options.caps.includes(GATEWAY_CLIENT_CAPS.APPROVALS), false);
  assert.equal(gw.state.options.caps.includes(GATEWAY_CLIENT_CAPS.EXEC_APPROVALS), false);
  source.stop();
});

test('declares observer visibility on connect, without which no digest is ever sent to it', async () => {
  const gw = fakeGateway({ sessions: [] });
  const source = makeSource(gw);
  source.start();
  gw.state.options.onHelloOk({ auth: {} });
  await settle();

  // The gateway broadcasts session.observer only to connections in the
  // audience, and joining is opt-in. Silent, with no error, if you skip it.
  assert.ok(gw.state.requests.includes('sessions.observer.visibility'),
    `requests were ${JSON.stringify(gw.state.requests)}`);
  source.stop();
});

test('re-declares visibility after a reconnect, since audience membership is per connection', async () => {
  const gw = fakeGateway({ sessions: [] });
  const source = makeSource(gw);
  source.start();
  gw.state.options.onHelloOk({ auth: {} });
  await settle();
  gw.state.options.onHelloOk({ auth: {} });
  await settle();

  const n = gw.state.requests.filter((m) => m === 'sessions.observer.visibility').length;
  assert.ok(n >= 2, `visibility declared ${n} times, expected at least 2`);
  source.stop();
});

test('an observer digest reaches the emitted agent set', async () => {
  const gw = fakeGateway({ sessions: [sess('a', true)] });
  const source = makeSource(gw);
  const seen = [];
  source.on('agents', (x) => seen.push(x));
  source.start();
  gw.state.options.onHelloOk({ auth: {} });
  await settle();

  gw.state.options.onEvent({
    event: 'session.observer',
    payload: { sessionKey: 'a', health: 'stuck', headline: 'retrying a failing push' },
  });
  await settle();

  const last = seen[seen.length - 1];
  assert.equal(last[0].state, 'stalled');
  assert.equal(last[0].label, 'retrying a failing push');
  source.stop();
});

test('digests for sessions that vanish are pruned, so the map cannot grow forever', async () => {
  const gw = fakeGateway({ sessions: [sess('a', true)] });
  const source = makeSource(gw);
  source.start();
  gw.state.options.onHelloOk({ auth: {} });
  await settle();

  gw.state.options.onEvent({ event: 'session.observer', payload: { sessionKey: 'a', health: 'stuck', headline: 'x' } });
  await settle();
  assert.equal(source.digests.size, 1);

  gw.state.sessions = [sess('b', false)];          // 'a' is gone from the gateway
  gw.state.options.onEvent({ event: 'sessions.changed', payload: {} });
  await settle();
  assert.equal(source.digests.has('a'), false, 'a vanished session must not keep its digest');
  source.stop();
});

test('declares itself a viewer of the live sessions, because the audience is per session', async () => {
  const gw = fakeGateway({ sessions: [sess('a', true), sess('b', false)] });
  const source = makeSource(gw);
  source.start();
  gw.state.options.onHelloOk({ auth: {} });
  await settle();

  // session.observer is broadcast to audience.recipients(sessionKey, agentId),
  // not to every subscriber. observer.visibility is a global opt-in; viewers.set
  // is what names the sessions. Declaring only the former yields silence.
  assert.ok(gw.state.requests.includes('sessions.viewers.set'),
    `requests were ${JSON.stringify(gw.state.requests)}`);
  const call = gw.state.requestParams.find((r) => r.method === 'sessions.viewers.set');
  assert.deepEqual(call.params.sessionKeys, ['a', 'b'], 'must name every live session');
  const approvalCalls = gw.state.requestParams.filter((r) => r.method === 'sessions.messages.subscribe');
  assert.deepEqual(approvalCalls.map((r) => r.params), [
    { key: 'a', includeApprovals: true },
    { key: 'b', includeApprovals: true },
  ]);
  source.stop();
});

test('projects a pending approval onto the matching agent without exposing raw presentation fields', async () => {
  const gw = fakeGateway({
    sessions: [sess('a', true)],
    onRequest(method, params) {
      if (method !== 'sessions.messages.subscribe') return undefined;
      return Promise.resolve({
        approvalReplay: {
          approvals: [{
            id: 'appr-1',
            status: 'pending',
            expiresAtMs: Date.now() + 5000,
            presentation: {
              kind: 'plugin',
              allowedDecisions: ['allow-once', 'deny'],
              title: 'Approve short change?',
              detail: 'hidden detail',
              metadata: { reversible: true },
            },
          }],
          truncated: false,
        },
      });
    },
  });
  const source = makeSource(gw);
  const seen = [];
  source.on('agents', (a) => seen.push(a));
  source.start();
  gw.state.options.onHelloOk({ auth: {} });
  await settle();
  gw.state.options.onEvent({ event: 'sessions.changed', payload: {} });
  await settle();

  const agent = seen.at(-1)[0];
  assert.equal(agent.prompt.id, 'appr-1');
  assert.equal(agent.prompt.kind, 'approve_reject');
  assert.equal(agent.prompt.reversible, true);
  assert.equal(agent.label, 'Approve short change?');
  assert.equal(JSON.stringify(agent).includes('hidden detail'), false);
  source.stop();
});

test('a blank approval label becomes a visible handoff instead of disappearing', async () => {
  const gw = fakeGateway({
    sessions: [sess('a', true)],
    onRequest(method) {
      if (method !== 'sessions.messages.subscribe') return undefined;
      return Promise.resolve({
        approvalReplay: {
          approvals: [{
            id: 'appr-1',
            status: 'pending',
            expiresAtMs: Date.now() + 5000,
            presentation: {
              kind: 'plugin',
              allowedDecisions: ['allow-once', 'deny'],
              title: '   ',
              metadata: { reversible: true },
            },
          }],
          truncated: false,
        },
      });
    },
  });
  const source = makeSource(gw);
  const seen = [];
  source.on('agents', (a) => seen.push(a));
  source.start();
  gw.state.options.onHelloOk({ auth: {} });
  await settle();

  const agent = seen.at(-1)[0];
  assert.equal(agent.state, 'needs_attention');
  assert.equal(agent.label, null);
  assert.equal(agent.prompt.kind, 'handoff');
  source.stop();
});

test('a stale or reconciling source makes approvals non-actionable', async () => {
  const gw = fakeGateway({
    sessions: [sess('a', true)],
    onRequest(method) {
      if (method !== 'sessions.messages.subscribe') return undefined;
      return Promise.resolve({
        approvalReplay: {
          approvals: [{
            id: 'appr-1',
            status: 'pending',
            expiresAtMs: Date.now() + 5000,
            presentation: {
              kind: 'plugin',
              allowedDecisions: ['allow-once', 'deny'],
              title: 'Approve short change?',
              metadata: { reversible: true },
            },
          }],
          truncated: false,
        },
      });
    },
  });
  const source = makeSource(gw);
  const seen = [];
  source.on('agents', (a) => seen.push(a));
  source.start();
  gw.state.options.onHelloOk({ auth: {} });
  await settle();
  gw.state.options.onReconnectPaused();
  gw.state.options.onEvent({ event: 'sessions.changed', payload: {} });
  await settle();
  assert.equal(seen.at(-1)[0].prompt.kind, 'handoff');
  source.stop();
});

test('resolution sends exactly one approval.resolve and an ambiguous failure freezes instead of retrying', async () => {
  const gw = fakeGateway({
    sessions: [sess('a', true)],
    onRequest(method) {
      if (method === 'sessions.messages.subscribe') {
        return Promise.resolve({
          approvalReplay: {
            approvals: [{
              id: 'appr-1',
              status: 'pending',
              expiresAtMs: Date.now() + 5000,
              presentation: {
                kind: 'plugin',
                allowedDecisions: ['allow-once', 'deny'],
                title: 'Approve short change?',
                metadata: { reversible: true },
              },
            }],
            truncated: false,
          },
        });
      }
      if (method === 'approval.resolve') return Promise.reject(new Error('socket closed'));
      return undefined;
    },
  });
  const source = makeSource(gw);
  source.start();
  gw.state.options.onHelloOk({ auth: {} });
  await settle();
  source.setConnectionState('connected');
  await assert.rejects(() => source.resolveApproval({ id: 'appr-1', decision: 'deny' }), /socket closed/);
  await assert.rejects(() => source.resolveApproval({ id: 'appr-1', decision: 'deny' }), /not actionable/);
  assert.equal(gw.state.requests.filter((m) => m === 'approval.resolve').length, 1);
  assert.deepEqual(gw.state.requestParams.find((r) => r.method === 'approval.resolve')?.params, {
    id: 'appr-1',
    kind: 'plugin',
    decision: 'deny',
  });
  source.stop();
});

test('another surface winning surfaces the canonical terminal decision rather than the local attempt', async () => {
  const gw = fakeGateway({
    sessions: [sess('a', true)],
    onRequest(method) {
      if (method === 'sessions.messages.subscribe') {
        return Promise.resolve({
          approvalReplay: {
            approvals: [{
              id: 'appr-1',
              status: 'pending',
              expiresAtMs: Date.now() + 5000,
              presentation: {
                kind: 'plugin',
                allowedDecisions: ['allow-once', 'deny'],
                title: 'Approve short change?',
                metadata: { reversible: true },
              },
            }],
            truncated: false,
          },
        });
      }
      if (method === 'approval.resolve') {
        return Promise.resolve({
          applied: false,
          approval: {
            id: 'appr-1',
            status: 'denied',
            decision: 'deny',
            resolvedAtMs: 4000,
            presentation: { kind: 'plugin', allowedDecisions: ['allow-once', 'deny'] },
          },
        });
      }
      return undefined;
    },
  });
  const source = makeSource(gw);
  source.start();
  gw.state.options.onHelloOk({ auth: {} });
  await settle();
  source.setConnectionState('connected');
  const result = await source.resolveApproval({ id: 'appr-1', decision: 'allow-once' });
  assert.equal(result.applied, false);
  await assert.rejects(() => source.resolveApproval({ id: 'appr-1', decision: 'deny' }), /already answered/);
  assert.equal(source.approvals.getResolved('appr-1').decision, 'deny');
  source.stop();
});

test('prompt-bearing agents keep the same since across snapshots until the final state really changes', async () => {
  let now = 1000;
  const realNow = Date.now;
  Date.now = () => now;
  try {
    const gw = fakeGateway({
      sessions: [sess('a', true)],
      onRequest(method) {
        if (method !== 'sessions.messages.subscribe') return undefined;
        return Promise.resolve({
          approvalReplay: {
            approvals: [{
              id: 'appr-1',
              status: 'pending',
              expiresAtMs: 5000,
              presentation: {
                kind: 'plugin',
                allowedDecisions: ['allow-once', 'deny'],
                title: 'Approve short change?',
                metadata: { reversible: true },
              },
            }],
            truncated: false,
          },
        });
      },
    });
    const source = makeSource(gw);
    const seen = [];
    source.on('agents', (a) => seen.push(a));
    source.start();
    gw.state.options.onHelloOk({ auth: {} });
    await settle();

    now = 2000;
    gw.state.options.onEvent({ event: 'sessions.changed', payload: {} });
    await settle();
    now = 3000;
    gw.state.options.onEvent({ event: 'sessions.changed', payload: {} });
    await settle();

    assert.equal(seen[0][0].since, 1000);
    assert.equal(seen[1][0].since, 1000);
    assert.equal(seen[2][0].since, 1000);

    gw.state.options.onEvent({ event: 'session.approval', payload: {
      sessionKey: 'a',
      phase: 'terminal',
      approval: { id: 'appr-1', status: 'denied', decision: 'deny', resolvedAtMs: 3500, presentation: { kind: 'plugin' } },
    } });
    now = 4000;
    gw.state.options.onEvent({ event: 'sessions.changed', payload: {} });
    await settle();

    assert.equal(seen.at(-1)[0].state, 'thinking');
    assert.equal(seen.at(-1)[0].since, 4000);
    source.stop();
  } finally {
    Date.now = realNow;
  }
});

test('prunes approval sessions that vanish from the live snapshot', async () => {
  const gw = fakeGateway({
    sessions: [sess('a', true)],
    onRequest(method) {
      if (method !== 'sessions.messages.subscribe') return undefined;
      return Promise.resolve({
        approvalReplay: {
          approvals: [{
            id: 'appr-1',
            status: 'pending',
            expiresAtMs: Date.now() + 5000,
            presentation: {
              kind: 'plugin',
              allowedDecisions: ['allow-once', 'deny'],
              title: 'Approve short change?',
              metadata: { reversible: true },
            },
          }],
          truncated: false,
        },
      });
    },
  });
  const source = makeSource(gw);
  source.start();
  gw.state.options.onHelloOk({ auth: {} });
  await settle();
  assert.equal(source.approvals.pendingBySession.has('a'), true);

  gw.state.sessions = [sess('b', false)];
  gw.state.options.onEvent({ event: 'sessions.changed', payload: {} });
  await settle();

  assert.equal(source.approvals.pendingBySession.has('a'), false);
  source.stop();
});

test('does not re-subscribe unchanged approval viewers on later snapshots', async () => {
  const gw = fakeGateway({ sessions: [sess('a', true), sess('b', false)] });
  const source = makeSource(gw);
  source.start();
  gw.state.options.onHelloOk({ auth: {} });
  await settle();
  assert.equal(gw.state.requests.filter((m) => m === 'sessions.messages.subscribe').length, 2);

  gw.state.options.onEvent({ event: 'sessions.changed', payload: {} });
  await settle();

  assert.equal(gw.state.requests.filter((m) => m === 'sessions.messages.subscribe').length, 2);
  source.stop();
});

test('one approval subscription failure warns per key and does not block later subscriptions', async () => {
  const gw = fakeGateway({
    sessions: [sess('a', true), sess('b', true), sess('c', false)],
    onRequest(method, params) {
      if (method !== 'sessions.messages.subscribe') return undefined;
      if (params.key === 'b') return Promise.reject(new Error('boom'));
      return Promise.resolve({ approvalReplay: { approvals: [], truncated: false } });
    },
  });
  const source = makeSource(gw);
  const warnings = [];
  source.on('warning', (warning) => warnings.push(warning));
  source.start();
  gw.state.options.onHelloOk({ auth: {} });
  await settle();

  const approvals = gw.state.requestParams.filter((r) => r.method === 'sessions.messages.subscribe');
  assert.deepEqual(approvals.map((r) => r.params.key), ['a', 'b', 'c']);
  assert.equal(source.subscribedApprovalKeys.has('a'), true);
  assert.equal(source.subscribedApprovalKeys.has('b'), false);
  assert.equal(source.subscribedApprovalKeys.has('c'), true);
  assert.match(warnings.find((warning) => warning.includes('"b"')) ?? '', /boom/);
  source.stop();
});

test('selects viewer keys deterministically when the catalog exceeds the gateway cap', () => {
  const sessions = Array.from({ length: SESSION_VIEWER_PRESENCE_MAX_KEYS + 5 }, (_, i) => ({
    ...sess(`idle-${String(i).padStart(2, '0')}`, false),
    lastActivityAt: i + 1,
  }));
  sessions.push(
    { ...sess('active-late', true), lastActivityAt: 0 },
    { ...sess('digested-late', false), lastActivityAt: 0 },
  );
  const keys = selectViewerSessionKeys(sessions, new Map([['digested-late', { health: 'stuck' }]]));

  assert.equal(keys.length, SESSION_VIEWER_PRESENCE_MAX_KEYS);
  assert.equal(keys[0], 'active-late', 'an active run must outrank older idle catalog entries');
  assert.equal(keys[1], 'digested-late', 'an observed session remains relevant for digest continuity');
  assert.equal(keys.includes('idle-00'), false, 'the least relevant idle session is dropped first');
});

test('caps viewers.set without warning while still emitting the full agent set', async () => {
  const sessions = Array.from({ length: SESSION_VIEWER_PRESENCE_MAX_KEYS + 4 }, (_, i) => ({
    ...sess(`idle-${String(i).padStart(2, '0')}`, false),
    lastActivityAt: i + 1,
  }));
  sessions.push({ ...sess('active-beyond-cap', true), lastActivityAt: 0 });
  const gw = fakeGateway({ sessions });
  const source = makeSource(gw);
  const seen = [];
  const warnings = [];
  source.on('agents', (a) => seen.push(a));
  source.on('warning', (w) => warnings.push(w));

  source.start();
  gw.state.options.onHelloOk({ auth: {} });
  await settle();

  const call = gw.state.requestParams.find((r) => r.method === 'sessions.viewers.set');
  assert.equal(call.params.sessionKeys.length, SESSION_VIEWER_PRESENCE_MAX_KEYS);
  assert.ok(call.params.sessionKeys.includes('active-beyond-cap'), 'the active session remains in viewer presence');
  assert.equal(warnings.length, 0, `unexpected warnings: ${warnings.join('\n')}`);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].length, sessions.length, 'viewer presence cap must not truncate the Roost state projection');
  assert.equal(seen[0].find((agent) => agent.id === 'active-beyond-cap')?.state, 'thinking');
  source.stop();
});
