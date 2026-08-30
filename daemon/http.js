import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { instrumentPayload } from './instrument.js';
import { approvalCorrelation } from './openclaw/approval-spike.js';
import { codedError } from './sources/openclaw.js';

/**
 * A small loopback HTTP server with three jobs:
 *   1. serve the renderer, so the page has an origin and can open a WebSocket
 *   2. accept "had to open the laptop" taps and persist them
 *   3. relay approval decisions to the active source
 *
 * Aggregation and publishing live elsewhere, and this route does not publish.
 */

const RENDERER_DIR = fileURLToPath(new URL('../renderer/', import.meta.url));

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};
const APPROVAL_BODY_LIMIT = 4096;
const JSON_CONTENT_TYPE = /^application\/json(?:\s*;|$)/i;
const APPROVAL_ERRORS = new Map([
  ['method_not_allowed', { status: 405, error: 'method not allowed' }],
  ['bad_request', { status: 400, error: 'bad approval request' }],
  ['unknown_prompt', { status: 404, error: 'approval prompt not found' }],
  ['already_answered', { status: 409, error: 'approval already answered' }],
  ['expired', { status: 409, error: 'approval expired' }],
  ['not_actionable', { status: 409, error: 'approval is not actionable' }],
  ['gateway_stale', { status: 409, error: 'approval source is stale' }],
  ['transport_uncertain', { status: 502, error: 'approval resolution status is uncertain' }],
]);

const json = (res, status, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
};

function jsonError(res, status, code, error) {
  return json(res, status, { ok: false, code, error });
}

async function readJsonBody(req, { maxBytes = APPROVAL_BODY_LIMIT } = {}) {
  const contentType = req.headers['content-type'];
  if (!JSON_CONTENT_TYPE.test(String(contentType ?? ''))) {
    throw codedError('bad_request', 'request body must be application/json');
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        req.removeAllListeners('data');
        req.on('data', () => {});
        req.resume();
        fail(codedError('bad_request', `request body exceeds ${maxBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        fail(codedError('bad_request', 'request body must be valid json'));
      }
    });
    req.on('error', (err) => fail(err));
  });
}

export async function startHttpServer({ host, port, socketPath, laptopLog, rendererConfig, resolveApproval, onLog = () => {}, onRecorded = () => {}, getStatus = () => ({}) }) {
  const startedAt = new Date();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${host}`);
    const path = url.pathname;

    if (path === '/api/config') {
      return json(res, 200, rendererConfig);
    }

    if (path === '/status') {
      if (req.method === 'GET') {
        const status = getStatus() ?? {};
        return json(res, 200, {
          ok: true,
          pid: process.pid,
          uptimeSec: Math.max(0, Math.floor((Date.now() - startedAt.getTime()) / 1000)),
          startedAt: startedAt.toISOString(),
          version: status.version,
          source: status.source,
          mqtt: {
            connected: status.mqtt?.connected ?? false,
            topic: status.mqtt?.topic,
          },
          gateways: Array.isArray(status.gateways) ? status.gateways : [],
        });
      }
      return json(res, 405, { error: 'method not allowed' });
    }

    if (path === '/api/laptop-open') {
      if (req.method === 'POST') {
        const count = laptopLog.record(Date.now());
        onLog(`laptop-open recorded (total ${count})`);
        // Republish the retained counter so every screen updates, not just the
        // one that was tapped.
        onRecorded(instrumentPayload(laptopLog));
        return json(res, 200, { count, recordedAt: new Date().toISOString() });
      }
      if (req.method === 'GET') {
        return json(res, 200, { count: laptopLog.count(), entries: laptopLog.entries().slice(0, 10) });
      }
      return json(res, 405, { error: 'method not allowed' });
    }

    if (path === '/api/approval') {
      if (req.method !== 'POST') {
        const mapped = APPROVAL_ERRORS.get('method_not_allowed');
        return jsonError(res, mapped.status, 'method_not_allowed', mapped.error);
      }
      if (typeof resolveApproval !== 'function') {
        return jsonError(res, 501, 'approvals_unavailable', 'approval resolution is unavailable for this source');
      }
      try {
        const body = await readJsonBody(req);
        const id = typeof body?.id === 'string' ? body.id : null;
        const decision = typeof body?.decision === 'string' ? body.decision : null;
        if (!id || !decision) {
          return jsonError(res, 400, 'bad_request', 'approval request must include id and decision');
        }
        const result = await resolveApproval(id, decision);
        const status = typeof result?.approval?.status === 'string' ? result.approval.status : null;
        const appliedDecision = typeof result?.approval?.decision === 'string' ? result.approval.decision : decision;
        const correlation = (() => {
          try {
            const approvalId = typeof result?.approval?.id === 'string'
              ? result.approval.id
              : (typeof id === 'string' && id.includes(':') ? id.split(':').slice(1).join(':') : id);
            return approvalCorrelation(approvalId);
          } catch {
            return null;
          }
        })();
        onLog(`approval resolved${correlation ? ` correlation=${correlation}` : ''} decision=${appliedDecision} status=${status ?? 'unknown'}`);
        return json(res, 200, { ok: true, id, decision: appliedDecision, status });
      } catch (err) {
        const code = APPROVAL_ERRORS.has(err?.code) ? err.code : 'transport_uncertain';
        const mapped = APPROVAL_ERRORS.get(code) ?? APPROVAL_ERRORS.get('transport_uncertain');
        const correlation = typeof err?.correlation === 'string'
          ? err.correlation
          : (() => {
            try {
              return approvalCorrelation(typeof err?.id === 'string' ? err.id : undefined);
            } catch {
              return null;
            }
          })();
        onLog(`approval failed code=${code}${correlation ? ` correlation=${correlation}` : ''}`);
        return jsonError(res, mapped.status, code, mapped.error);
      }
    }

    // Static renderer files. Resolve then verify containment, so `..` cannot
    // reach outside the renderer directory.
    const relative = normalize(path === '/' ? 'index.html' : path.replace(/^\/+/, ''));
    const absolute = join(RENDERER_DIR, relative);
    if (!absolute.startsWith(RENDERER_DIR)) {
      return json(res, 400, { error: 'bad path' });
    }
    try {
      const body = await readFile(absolute);
      res.writeHead(200, { 'content-type': CONTENT_TYPES[extname(absolute)] || 'application/octet-stream' });
      return res.end(body);
    } catch {
      return json(res, 404, { error: 'not found' });
    }
  });

  await new Promise((resolve) => {
    if (socketPath) {
      server.listen(socketPath, resolve);
      return;
    }
    server.listen(port, host, resolve);
  });

  return {
    server,
    port: typeof server.address() === 'object' ? server.address().port : undefined,
    socketPath,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
