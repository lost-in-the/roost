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
