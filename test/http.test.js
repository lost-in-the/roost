import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHttpServer } from '../daemon/http.js';
import { LaptopLog } from '../daemon/laptop-log.js';

async function withServer(fn, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'roost-http-'));
  const socketPath = join(dir, 'roost.sock');
  const log = new LaptopLog({ path: join(dir, 'laptop-opens.log') });
  const server = await startHttpServer({
    host: '127.0.0.1',
    port: 0,
    socketPath,
    laptopLog: log,
    rendererConfig: { wsUrl: 'ws://broker.example:8083/mqtt', topic: 'roost/agents/state', staleMs: 30_000, username: 'panel', password: 'pw' },
    ...options,
  });
  const fetchJson = async (path, { method = 'GET' } = {}) => {
    const res = await requestOverSocket({ socketPath: server.socketPath, path, method });
    return { ...res, json: JSON.parse(res.body) };
  };
  try { await fn({ fetch: (path, init) => requestOverSocket({ socketPath: server.socketPath, path, method: init?.method }), fetchJson, log, server }); }
  finally { await server.close(); rmSync(dir, { recursive: true, force: true }); }
}

function requestOverSocket({ socketPath, path, method = 'GET' }) {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, method }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('the renderer page is served over http so the browser can open a websocket', async () => {
  await withServer(async ({ fetch }) => {
    const res = await fetch('/');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.match(res.body, /<html/i);
  });
});

test('the renderer is told where the broker is, so no config is baked into the page', async () => {
  await withServer(async ({ fetchJson }) => {
    const cfg = (await fetchJson('/api/config')).json;
    assert.equal(cfg.wsUrl, 'ws://broker.example:8083/mqtt');
    assert.equal(cfg.topic, 'roost/agents/state');
    assert.equal(cfg.staleMs, 30_000);
  });
});

test('status reports health metadata without exposing renderer secrets', async () => {
  await withServer(async ({ fetchJson }) => {
    const res = await fetchJson('/status');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /application\/json/);

    const body = res.json;
    assert.equal(body.ok, true);
    assert.equal(body.pid, process.pid);
    assert.equal(typeof body.startedAt, 'string');
    assert.match(body.startedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(Number.isInteger(body.uptimeSec), true);
    assert.ok(body.uptimeSec >= 0);
    assert.deepEqual(body.mqtt, { connected: false });

    const serialized = JSON.stringify(body);
    assert.doesNotMatch(serialized, /"username":/);
    assert.doesNotMatch(serialized, /"password":/);
    assert.doesNotMatch(serialized, /panel/);
    assert.doesNotMatch(serialized, /pw/);
  });
});

test('status surfaces injected daemon-owned status values', async () => {
  await withServer(async ({ fetchJson }) => {
    const body = (await fetchJson('/status')).json;
    assert.equal(body.source, 'openclaw');
    assert.equal(body.version, '1.2.3-test');
    assert.deepEqual(body.mqtt, { connected: true, topic: 'roost/custom/topic' });
  }, {
    getStatus: () => ({
      source: 'openclaw',
      version: '1.2.3-test',
      mqtt: { connected: true, topic: 'roost/custom/topic' },
    }),
  });
});

test('status reflects a disconnected mqtt publisher when injected that way', async () => {
  await withServer(async ({ fetchJson }) => {
    const body = (await fetchJson('/status')).json;
    assert.deepEqual(body.mqtt, { connected: false, topic: 'roost/custom/topic' });
  }, {
    getStatus: () => ({
      source: 'mock',
      version: '1.2.3-test',
      mqtt: { connected: false, topic: 'roost/custom/topic' },
    }),
  });
});

test('status rejects non-GET methods with the existing api error shape', async () => {
  await withServer(async ({ fetchJson }) => {
    const res = await fetchJson('/status', { method: 'POST' });
    assert.equal(res.status, 405);
    assert.deepEqual(res.json, { error: 'method not allowed' });
  });
});

test('tapping the laptop button records an open and returns the new total', async () => {
  await withServer(async ({ fetchJson, log }) => {
    const res = await fetchJson('/api/laptop-open', { method: 'POST' });
    assert.equal(res.status, 200);
    assert.equal(res.json.count, 1);
    assert.equal(log.count(), 1, 'the tap must reach durable storage, not just the response');
  });
});

test('the counter can be read back without recording anything', async () => {
  await withServer(async ({ fetchJson, log }) => {
    log.record(Date.parse('2026-08-21T18:00:00Z'));
    assert.equal((await fetchJson('/api/laptop-open')).json.count, 1);
    assert.equal(log.count(), 1, 'a read must not increment');
  });
});

test('repeated taps accumulate', async () => {
  await withServer(async ({ fetchJson }) => {
    await fetchJson('/api/laptop-open', { method: 'POST' });
    await fetchJson('/api/laptop-open', { method: 'POST' });
    const res = await fetchJson('/api/laptop-open', { method: 'POST' });
    assert.equal(res.json.count, 3);
  });
});

test('an unknown path is a plain 404, not a stack trace', async () => {
  await withServer(async ({ fetch }) => {
    const res = await fetch('/nope');
    assert.equal(res.status, 404);
  });
});

test('path traversal out of the renderer directory is refused', async () => {
  await withServer(async ({ fetch }) => {
    const res = await fetch('/../package.json');
    assert.ok(res.status === 404 || res.status === 400, `expected a refusal, got ${res.status}`);
  });
});

test('the stylesheet and script are served with usable content types', async () => {
  await withServer(async ({ fetch }) => {
    assert.match((await fetch('/style.css')).headers['content-type'], /text\/css/);
    assert.match((await fetch('/app.js')).headers['content-type'], /javascript/);
  });
});
