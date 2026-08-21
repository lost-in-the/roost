import test from 'node:test';
import assert from 'node:assert/strict';
import mqtt from 'mqtt';
import { startBroker, waitFor } from './helpers/broker.js';
import { StatePublisher, lwtPayload, backoffDelay } from '../daemon/publisher.js';

const TOPIC = 'roost/agents/state';

// ---- pure behaviour -------------------------------------------------------

test('the Last Will payload carries no timestamp', () => {
  assert.ok(!('ts' in lwtPayload()), 'a ts frozen at connect time would corrupt staleness logic');
});

test('the Last Will payload matches the agreed offline shape', () => {
  assert.deepEqual(lwtPayload(), {
    v: 1, state: 'offline', count: 0, label: null, urgency: 'ambient', primary_run_id: null,
  });
});

test('reconnect backoff grows exponentially', () => {
  assert.ok(backoffDelay(1) < backoffDelay(2));
  assert.ok(backoffDelay(2) < backoffDelay(3));
  assert.ok(backoffDelay(3) < backoffDelay(5));
});

test('reconnect backoff is capped so it always keeps retrying', () => {
  assert.ok(backoffDelay(50) <= 60_000, 'an uncapped backoff eventually stops reconnecting in practice');
  assert.ok(backoffDelay(50) >= 1_000);
});

// ---- against a real broker ------------------------------------------------

test('a late subscriber immediately receives the current state, because it is retained', async () => {
  const broker = await startBroker();
  const pub = new StatePublisher({
    url: broker.url, topic: TOPIC, heartbeatMs: 50_000,
    buildPayload: () => ({ v: 1, ts: '2026-08-21T17:46:43Z', state: 'thinking', count: 1, label: 'building', urgency: 'ambient', primary_run_id: 'r1' }),
  });
  try {
    pub.start();
    await waitFor(() => pub.connected);
    pub.touch();
    await waitFor(() => pub.publishCount > 0);

    const sub = mqtt.connect(broker.url);
    const got = await new Promise((resolve) => {
      sub.on('connect', () => sub.subscribe(TOPIC));
      sub.on('message', (_t, m) => resolve(JSON.parse(m)));
    });
    sub.end(true);
    assert.equal(got.state, 'thinking', 'a panel that starts late must not sit blank');
  } finally {
    pub.stop(); await broker.close();
  }
});

test('the daemon keeps publishing on a heartbeat even when nothing changes', async () => {
  const broker = await startBroker();
  let tick = 0;
  const pub = new StatePublisher({
    url: broker.url, topic: TOPIC, heartbeatMs: 60,
    buildPayload: () => ({ v: 1, ts: `2026-08-21T17:46:${String(tick++).padStart(2, '0')}Z`, state: 'idle', count: 0, label: null, urgency: 'ambient', primary_run_id: null }),
  });
  const seen = [];
  const sub = mqtt.connect(broker.url);
  await new Promise((r) => sub.on('connect', () => sub.subscribe(TOPIC, r)));
  sub.on('message', (_t, m) => seen.push(JSON.parse(m)));
  try {
    pub.start();
    await waitFor(() => seen.length >= 3, { timeout: 4000 });
    assert.notEqual(seen[0].ts, seen[2].ts, 'each heartbeat must carry a fresh timestamp');
  } finally {
    sub.end(true); pub.stop(); await broker.close();
  }
});

test('nothing is published while the broker is unreachable', async () => {
  const pub = new StatePublisher({
    url: 'mqtt://127.0.0.1:1',   // nothing listens here
    topic: TOPIC, heartbeatMs: 30,
    buildPayload: () => ({ v: 1, state: 'idle' }),
  });
  try {
    pub.start();
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(pub.connected, false);
    assert.equal(pub.publishCount, 0, 'publishing before connect would queue a lie');
  } finally { pub.stop(); }
});

test('an ungraceful death makes the broker publish offline on the daemon behalf', async () => {
  const broker = await startBroker();
  const pub = new StatePublisher({
    url: broker.url, topic: TOPIC, heartbeatMs: 50_000,
    buildPayload: () => ({ v: 1, ts: '2026-08-21T17:46:43Z', state: 'thinking', count: 1, label: 'mid-run', urgency: 'ambient', primary_run_id: 'r1' }),
  });
  const seen = [];
  const sub = mqtt.connect(broker.url);
  await new Promise((r) => sub.on('connect', () => sub.subscribe(TOPIC, r)));
  sub.on('message', (_t, m) => seen.push(JSON.parse(m)));
  try {
    pub.start();
    await waitFor(() => pub.connected);
    pub.touch();
    await waitFor(() => seen.some((m) => m.state === 'thinking'));

    pub.simulateHardDeath();   // socket destroyed, no DISCONNECT packet

    const offline = await waitFor(() => seen.find((m) => m.state === 'offline'));
    assert.equal(offline.count, 0);
    assert.ok(!('ts' in offline), 'the will must arrive without a stale timestamp');
  } finally {
    sub.end(true); pub.stop(); await broker.close();
  }
});

test('the publisher keeps retrying after the broker goes away', async () => {
  const broker = await startBroker();
  const pub = new StatePublisher({
    url: broker.url, topic: TOPIC, heartbeatMs: 50_000, reconnectPeriodMs: 100,
    buildPayload: () => ({ v: 1, state: 'idle' }),
  });
  try {
    pub.start();
    await waitFor(() => pub.connected);
    const publishesBeforeOutage = pub.publishCount;
    await broker.cutOff();
    await waitFor(() => pub.connected === false, { timeout: 4000 });
    // Retrying is the behaviour under test, so wait for it rather than
    // sampling the instant the socket closed.
    const attempts = await waitFor(() => pub.reconnectAttempts > 0 && pub.reconnectAttempts, { timeout: 4000 });
    assert.ok(attempts > 0, 'must be actively retrying, not sitting dead');
    assert.equal(pub.publishCount, publishesBeforeOutage, 'must not publish while disconnected');
  } finally { pub.stop(); await broker.close(); }
});
