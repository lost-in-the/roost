import { Aedes } from 'aedes';
import { createServer } from 'node:net';

/** Start an in-process MQTT broker on an ephemeral port. */
export async function startBroker() {
  const aedes = await Aedes.createBroker();
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    aedes.handle(socket);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  // `server.close()` only completes once every connection is gone, so any
  // shutdown has to destroy the sockets first or it deadlocks.
  const destroySockets = () => {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
  };

  return {
    aedes,
    server,
    sockets,
    port: server.address().port,
    url: `mqtt://127.0.0.1:${server.address().port}`,
    /** Cut every live connection and stop listening, as a broker outage would. */
    async cutOff() {
      destroySockets();
      await new Promise((r) => server.close(() => r()));
    },
    async close() {
      destroySockets();
      if (server.listening) await new Promise((r) => server.close(() => r()));
      await new Promise((r) => aedes.close(() => r()));
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
