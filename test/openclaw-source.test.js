import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenClawStateSource } from '../daemon/sources/openclaw.js';

const sess = (key, active) => ({ key, displayName: key, hasActiveRun: active, archived: false, lastActivityAt: 1 });

/** Fake GatewayClient: records requests, lets the test drive callbacks. */
function fakeGateway({ sessions = [] } = {}) {
  const state = { requests: [], options: null, started: 0, stopped: 0, sessions };
  const create = (options) => {
    state.options = options;
    return {
      start() { state.started += 1; },
      stop() { state.stopped += 1; },
      request(method, params) {
        state.requests.push(method);
        if (method === 'sessions.list') return Promise.resolve({ sessions: state.sessions, count: state.sessions.length });
        return Promise.resolve({});
      },
    };
  };
  return { create, state };
}

const settle = () => new Promise((r) => setTimeout(r, 10));

const makeSource = (gw) => new OpenClawStateSource({
  createClient: gw.create, url: 'ws://x', deviceToken: 'tok',
  deviceIdentity: { deviceId: 'd', privateKeyPem: 'p', publicKeyPem: 'q' },
  debounceMs: 0,
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
