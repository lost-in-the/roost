import { Aedes } from 'aedes';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Start an in-process MQTT broker on a private Unix socket. */
export async function startBroker() {
  const aedes = await Aedes.createBroker();
  const sockets = new Set();
  const dir = mkdtempSync(join(tmpdir(), 'roost-broker-'));
  const socketPath = join(dir, 'broker.sock');
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    aedes.handle(socket);
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));

  // `server.close()` only completes once every connection is gone, so any
  // shutdown has to destroy the sockets first or it deadlocks.
  const destroySockets = () => {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
  };
  const cleanupSocketDir = () => rmSync(dir, { recursive: true, force: true });

  return {
    aedes,
    server,
    sockets,
    socketPath,
    url: `mqtt+unix://${socketPath}`,
    /** Cut every live connection and stop listening, as a broker outage would. */
    async cutOff() {
      destroySockets();
      await new Promise((r) => server.close(() => r()));
      cleanupSocketDir();
    },
    async close() {
      destroySockets();
      if (server.listening) await new Promise((r) => server.close(() => r()));
      await new Promise((r) => aedes.close(() => r()));
      cleanupSocketDir();
    },
  };
}

export const waitFor = async (predicate, { timeout = 5000, interval = 20 } = {}) => {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error('waitFor: timed out waiting for condition');
};
