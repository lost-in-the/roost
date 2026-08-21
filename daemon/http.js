import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A small loopback HTTP server with two jobs:
 *   1. serve the renderer, so the page has an origin and can open a WebSocket
 *   2. accept "had to open the laptop" taps and persist them
 *
 * It never touches agent state. Aggregation and publishing live elsewhere.
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

const json = (res, status, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
};

export async function startHttpServer({ host, port, laptopLog, rendererConfig, onLog = () => {} }) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${host}`);
    const path = url.pathname;

    if (path === '/api/config') {
      return json(res, 200, rendererConfig);
    }

    if (path === '/api/laptop-open') {
      if (req.method === 'POST') {
        const count = laptopLog.record(Date.now());
        onLog(`laptop-open recorded (total ${count})`);
        return json(res, 200, { count, recordedAt: new Date().toISOString() });
      }
      if (req.method === 'GET') {
        return json(res, 200, { count: laptopLog.count(), entries: laptopLog.entries().slice(0, 10) });
      }
      return json(res, 405, { error: 'method not allowed' });
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

  await new Promise((resolve) => server.listen(port, host, resolve));

  return {
    server,
    port: server.address().port,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
