import { request } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHttpServer } from '../../daemon/http.js';
import { LaptopLog } from '../../daemon/laptop-log.js';

export async function withServer(fn, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'roost-http-'));
  const socketPath = join(dir, 'roost.sock');
  const log = new LaptopLog({ path: join(dir, 'laptop-opens.log') });
  let server;
  let originalError;
  try {
    server = await startHttpServer({
      host: '127.0.0.1',
      port: 0,
      socketPath,
      laptopLog: log,
      rendererConfig: {
        wsUrl: 'ws://broker.example:8083/mqtt',
        topic: 'roost/agents/state',
        staleMs: 30_000,
        username: 'panel',
        password: 'pw',
      },
      ...options,
    });
    const fetchJson = async (path, init = {}) => {
      const res = await requestOverSocket({ socketPath: server.socketPath, path, ...init });
      return { ...res, json: JSON.parse(res.body) };
    };
    await fn({
      fetch: (path, init) => requestOverSocket({ socketPath: server.socketPath, path, ...init }),
      fetchJson,
      log,
      server,
    });
  } catch (err) {
    originalError = err;
    throw err;
  } finally {
    const teardownErrors = [];
    if (server) {
      try {
        server.server.closeAllConnections?.();
      } catch (err) {
        teardownErrors.push(err);
      }
      try {
        await server.close();
      } catch (err) {
        teardownErrors.push(err);
      }
    }
    rmSync(dir, { recursive: true, force: true });
    if (!originalError && teardownErrors.length > 0) {
      throw teardownErrors[0];
    }
  }
}

export function requestOverSocket({ socketPath, path, method = 'GET', headers = {}, body, timeoutMs = 3_000 }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      fn(value);
    };
    const req = request({ socketPath, path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => settle(resolve, {
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', (err) => settle(reject, err));
    timeout = setTimeout(() => {
      req.destroy();
      settle(reject, new Error(`timed out after ${timeoutMs}ms waiting for ${method} ${path}`));
    }, timeoutMs);
    if (body !== undefined) req.write(body);
    req.end();
  });
}
