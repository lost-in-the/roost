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
  const fetchJson = async (path, init = {}) => {
    const res = await requestOverSocket({ socketPath: server.socketPath, path, ...init });
    return { ...res, json: JSON.parse(res.body) };
  };
  try { await fn({ fetch: (path, init) => requestOverSocket({ socketPath: server.socketPath, path, ...init }), fetchJson, log, server }); }
  finally { await server.close(); rmSync(dir, { recursive: true, force: true }); }
}

function requestOverSocket({ socketPath, path, method = 'GET', headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
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
    assert.deepEqual(body.gateways, []);

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
    assert.deepEqual(body.gateways, [{ alias: 'labby', stale: false }, { alias: 'omar', stale: true }]);
  }, {
    getStatus: () => ({
      source: 'openclaw',
      version: '1.2.3-test',
      mqtt: { connected: true, topic: 'roost/custom/topic' },
      gateways: [{ alias: 'labby', stale: false }, { alias: 'omar', stale: true }],
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

test('approval resolution is unavailable for the mock source', async () => {
  await withServer(async ({ fetchJson }) => {
    const res = await fetchJson('/api/approval', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'labby:appr-1', decision: 'deny' }),
    });
    assert.equal(res.status, 501);
    assert.deepEqual(res.json, {
      ok: false,
      code: 'approvals_unavailable',
      error: 'approval resolution is unavailable for this source',
    });
  });
});

test('approval route rejects non-POST methods', async () => {
  await withServer(async ({ fetchJson }) => {
    const res = await fetchJson('/api/approval');
    assert.equal(res.status, 405);
    assert.deepEqual(res.json, {
      ok: false,
      code: 'method_not_allowed',
      error: 'method not allowed',
    });
  });
});

test('approval route resolves both supported decisions', async () => {
  const calls = [];
  const logs = [];
  await withServer(async ({ fetchJson }) => {
    const deny = await fetchJson('/api/approval', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ id: 'labby:appr-1', decision: 'deny' }),
    });
    const allow = await fetchJson('/api/approval', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'labby:appr-2', decision: 'allow-once' }),
    });
    assert.equal(deny.status, 200);
    assert.deepEqual(deny.json, { ok: true, id: 'labby:appr-1', decision: 'deny', status: 'denied' });
    assert.equal(allow.status, 200);
    assert.deepEqual(allow.json, { ok: true, id: 'labby:appr-2', decision: 'allow-once', status: 'allowed' });
  }, {
    resolveApproval: async (id, decision) => {
      calls.push({ id, decision });
      return {
        approval: {
          id: id.split(':').slice(1).join(':'),
          status: decision === 'deny' ? 'denied' : 'allowed',
          decision,
        },
      };
    },
    onLog: (line) => logs.push(line),
  });
  assert.deepEqual(calls, [
    { id: 'labby:appr-1', decision: 'deny' },
    { id: 'labby:appr-2', decision: 'allow-once' },
  ]);
  assert.equal(logs.some((line) => /Approve short change\?|title|detail|command/i.test(line)), false);
});

test('approval route reports the applied decision from the canonical gateway result', async () => {
  await withServer(async ({ fetchJson }) => {
    const res = await fetchJson('/api/approval', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'labby:appr-1', decision: 'allow-once' }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { ok: true, id: 'labby:appr-1', decision: 'deny', status: 'denied' });
  }, {
    resolveApproval: async () => ({
      approval: {
        id: 'appr-1',
        status: 'denied',
        decision: 'deny',
      },
    }),
  });
});

test('approval route rejects non-json, invalid json, and oversized bodies', async () => {
  await withServer(async ({ fetchJson }) => {
    const nonJson = await fetchJson('/api/approval', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'nope',
    });
    const malformed = await fetchJson('/api/approval', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"id":',
    });
    const oversized = await fetchJson('/api/approval', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'x'.repeat(5000), decision: 'deny' }),
    });
    assert.deepEqual([nonJson.status, malformed.status, oversized.status], [400, 400, 400]);
    assert.equal(nonJson.json.code, 'bad_request');
    assert.equal(malformed.json.code, 'bad_request');
    assert.equal(oversized.json.code, 'bad_request');
  }, {
    resolveApproval: async () => ({ approval: { status: 'denied' } }),
  });
});

test('approval route maps stable source error codes without exposing raw presentation fields', async () => {
  const logs = [];
  const cases = [
    ['unknown_prompt', 404],
    ['expired', 409],
    ['not_actionable', 409],
    ['gateway_stale', 409],
    ['already_answered', 409],
    ['transport_uncertain', 502],
  ];
  await withServer(async ({ fetchJson }) => {
    for (const [code, status] of cases) {
      const res = await fetchJson('/api/approval', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'labby:appr-1', decision: 'deny' }),
      });
      assert.equal(res.status, status);
      assert.equal(res.json.ok, false);
      assert.equal(res.json.code, code);
      assert.equal(JSON.stringify(res.json).includes('Approve short change?'), false);
    }
  }, {
    resolveApproval: (() => {
      let index = 0;
      return async () => {
        const code = cases[index++][0];
        const err = new Error('Approve short change? should never leak');
        err.code = code;
        throw err;
      };
    })(),
    onLog: (line) => logs.push(line),
  });
  assert.equal(logs.some((line) => /Approve short change\?|detail|command/i.test(line)), false);
});

test('approval route defaults unexpected failures to transport_uncertain', async () => {
  await withServer(async ({ fetchJson }) => {
    const res = await fetchJson('/api/approval', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'labby:appr-1', decision: 'deny' }),
    });
    assert.equal(res.status, 502);
    assert.deepEqual(res.json, {
      ok: false,
      code: 'transport_uncertain',
      error: 'approval resolution status is uncertain',
    });
  }, {
    resolveApproval: async () => {
      throw new TypeError('boom');
    },
  });
});

test('approval route logs source-provided failure correlations', async () => {
  const logs = [];
  await withServer(async ({ fetchJson }) => {
    const res = await fetchJson('/api/approval', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'labby:appr-1', decision: 'deny' }),
    });
    assert.equal(res.status, 409);
  }, {
    resolveApproval: async () => {
      const err = new Error('already answered elsewhere');
      err.code = 'already_answered';
      err.correlation = 'appr_abcd1234';
      throw err;
    },
    onLog: (line) => logs.push(line),
  });
  assert.equal(logs.some((line) => line.includes('correlation=appr_abcd1234')), true);
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
