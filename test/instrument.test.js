import test from 'node:test';
import assert from 'node:assert/strict';
import mqtt from 'mqtt';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startBroker, waitFor } from './helpers/broker.js';
import { StatePublisher } from '../daemon/publisher.js';
import { instrumentPayload } from '../daemon/instrument.js';
import { LaptopLog } from '../daemon/laptop-log.js';
import { startHttpServer } from '../daemon/http.js';

const STATE_TOPIC = 'roost/agents/state';
const INSTRUMENT_TOPIC = 'roost/instrument/laptop-opens';

const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), 'roost-instr-'));
  return { dir, path: join(dir, 'laptop-opens.log'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

// ---- payload shape --------------------------------------------------------

test('the instrument payload carries the count and when it last happened', () => {
  const s = scratch();
  try {
    const log = new LaptopLog({ path: s.path });
    log.record(Date.parse('2026-08-21T18:00:00Z'));
    log.record(Date.parse('2026-08-21T19:30:15Z'));
    assert.deepEqual(instrumentPayload(log), {
      v: 1, count: 2, last: '2026-08-21T19:30:15Z',
    });
  } finally { s.cleanup(); }
});

test('an empty log reports zero with no last timestamp', () => {
  const s = scratch();
  try {
    assert.deepEqual(instrumentPayload(new LaptopLog({ path: s.path })), { v: 1, count: 0, last: null });
  } finally { s.cleanup(); }
});

test('the instrument payload is versioned separately from agent state', () => {
  const s = scratch();
  try {
    assert.equal(instrumentPayload(new LaptopLog({ path: s.path })).v, 1);
  } finally { s.cleanup(); }
});

// ---- publishing -----------------------------------------------------------

test('a retained publish reaches a subscriber that connects afterwards', async () => {
  const broker = await startBroker();
  const pub = new StatePublisher({
    url: broker.url, topic: STATE_TOPIC, heartbeatMs: 50_000,
    buildPayload: () => ({ v: 1, state: 'idle' }),
  });
  try {
    pub.start();
    await waitFor(() => pub.connected);
    pub.publishRetained(INSTRUMENT_TOPIC, { v: 1, count: 7, last: null });

    const sub = mqtt.connect(broker.url);
    const got = await new Promise((resolve) => {
      sub.on('connect', () => sub.subscribe(INSTRUMENT_TOPIC));
      sub.on('message', (_t, m) => resolve(JSON.parse(m)));
    });
    sub.end(true);
    assert.equal(got.count, 7, 'a screen that starts late must still see the count');
  } finally { pub.stop(); await broker.close(); }
});

test('the counter does not go out on the agent state topic', async () => {
  const broker = await startBroker();
  const pub = new StatePublisher({
    url: broker.url, topic: STATE_TOPIC, heartbeatMs: 50_000,
    buildPayload: () => ({ v: 1, state: 'idle', count: 0 }),
  });
  const onState = [];
  const sub = mqtt.connect(broker.url);
  await new Promise((r) => sub.on('connect', () => sub.subscribe(STATE_TOPIC, r)));
  sub.on('message', (_t, m) => onState.push(JSON.parse(m)));
  try {
    pub.start();
    await waitFor(() => pub.connected);
    pub.publishRetained(INSTRUMENT_TOPIC, { v: 1, count: 7, last: null });
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(
      onState.every((m) => m.state !== undefined),
      'agent state must stay about agents; the instrument gets its own topic',
    );
  } finally { sub.end(true); pub.stop(); await broker.close(); }
});

test('nothing is published while disconnected', () => {
  const pub = new StatePublisher({
    url: 'mqtt://127.0.0.1:1', topic: STATE_TOPIC, heartbeatMs: 50_000,
    buildPayload: () => ({ v: 1 }),
  });
  try {
    pub.start();
    assert.equal(pub.publishRetained(INSTRUMENT_TOPIC, { v: 1, count: 1 }), false);
  } finally { pub.stop(); }
});

// ---- the tap path end to end ---------------------------------------------

test('recording a tap notifies the caller so it can republish the count', async () => {
  const s = scratch();
  const published = [];
  const server = await startHttpServer({
    host: '127.0.0.1', port: 0,
    laptopLog: new LaptopLog({ path: s.path }),
    rendererConfig: {},
    onRecorded: (payload) => published.push(payload),
  });
  try {
    await fetch(`http://127.0.0.1:${server.port}/api/laptop-open`, { method: 'POST' });
    assert.equal(published.length, 1, 'a tap must trigger exactly one republish');
    assert.equal(published[0].count, 1);
    assert.equal(published[0].v, 1);
  } finally { await server.close(); s.cleanup(); }
});

test('reading the counter does not trigger a republish', async () => {
  const s = scratch();
  const published = [];
  const server = await startHttpServer({
    host: '127.0.0.1', port: 0,
    laptopLog: new LaptopLog({ path: s.path }),
    rendererConfig: {},
    onRecorded: (payload) => published.push(payload),
  });
  try {
    await fetch(`http://127.0.0.1:${server.port}/api/laptop-open`);
    assert.equal(published.length, 0);
  } finally { await server.close(); s.cleanup(); }
});

test('the renderer is told which topic carries the counter', async () => {
  const s = scratch();
  const server = await startHttpServer({
    host: '127.0.0.1', port: 0,
    laptopLog: new LaptopLog({ path: s.path }),
    rendererConfig: { instrumentTopic: INSTRUMENT_TOPIC },
  });
  try {
    const cfg = await (await fetch(`http://127.0.0.1:${server.port}/api/config`)).json();
    assert.equal(cfg.instrumentTopic, INSTRUMENT_TOPIC);
  } finally { await server.close(); s.cleanup(); }
});
