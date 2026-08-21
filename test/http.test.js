import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHttpServer } from '../daemon/http.js';
import { LaptopLog } from '../daemon/laptop-log.js';

async function withServer(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'roost-http-'));
  const log = new LaptopLog({ path: join(dir, 'laptop-opens.log') });
  const server = await startHttpServer({
    host: '127.0.0.1',
    port: 0,
    laptopLog: log,
    rendererConfig: { wsUrl: 'ws://broker.example:8083/mqtt', topic: 'roost/agents/state', staleMs: 30_000, username: 'panel', password: 'pw' },
  });
  const url = (p) => `http://127.0.0.1:${server.port}${p}`;
  try { await fn({ url, log, server }); }
  finally { await server.close(); rmSync(dir, { recursive: true, force: true }); }
}

test('the renderer page is served over http so the browser can open a websocket', async () => {
  await withServer(async ({ url }) => {
    const res = await fetch(url('/'));
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(await res.text(), /<html/i);
  });
});

test('the renderer is told where the broker is, so no config is baked into the page', async () => {
  await withServer(async ({ url }) => {
    const cfg = await (await fetch(url('/api/config'))).json();
    assert.equal(cfg.wsUrl, 'ws://broker.example:8083/mqtt');
    assert.equal(cfg.topic, 'roost/agents/state');
    assert.equal(cfg.staleMs, 30_000);
  });
});

test('tapping the laptop button records an open and returns the new total', async () => {
  await withServer(async ({ url, log }) => {
    const res = await fetch(url('/api/laptop-open'), { method: 'POST' });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).count, 1);
    assert.equal(log.count(), 1, 'the tap must reach durable storage, not just the response');
  });
});

test('the counter can be read back without recording anything', async () => {
  await withServer(async ({ url, log }) => {
    log.record(Date.parse('2026-08-21T18:00:00Z'));
    assert.equal((await (await fetch(url('/api/laptop-open'))).json()).count, 1);
    assert.equal(log.count(), 1, 'a read must not increment');
  });
});

test('repeated taps accumulate', async () => {
  await withServer(async ({ url }) => {
    await fetch(url('/api/laptop-open'), { method: 'POST' });
    await fetch(url('/api/laptop-open'), { method: 'POST' });
    const res = await fetch(url('/api/laptop-open'), { method: 'POST' });
    assert.equal((await res.json()).count, 3);
  });
});

test('an unknown path is a plain 404, not a stack trace', async () => {
  await withServer(async ({ url }) => {
    const res = await fetch(url('/nope'));
    assert.equal(res.status, 404);
  });
});

test('path traversal out of the renderer directory is refused', async () => {
  await withServer(async ({ url }) => {
    const res = await fetch(url('/../package.json'));
    assert.ok(res.status === 404 || res.status === 400, `expected a refusal, got ${res.status}`);
  });
});

test('the stylesheet and script are served with usable content types', async () => {
  await withServer(async ({ url }) => {
    assert.match((await fetch(url('/style.css'))).headers.get('content-type'), /text\/css/);
    assert.match((await fetch(url('/app.js'))).headers.get('content-type'), /javascript/);
  });
});
