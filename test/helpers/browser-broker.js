import { Aedes } from 'aedes';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { WebSocketServer, createWebSocketStream } from 'ws';

function closeServer(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}

/**
 * An isolated MQTT broker with the same split transport as production:
 * daemon traffic over TCP and panel traffic over WebSocket.
 */
export async function startBrowserBroker() {
  const aedes = await Aedes.createBroker();
  const tcpSockets = new Set();
  const webSockets = new Set();

  const tcpServer = createTcpServer((socket) => {
    tcpSockets.add(socket);
    socket.on('close', () => tcpSockets.delete(socket));
    aedes.handle(socket);
  });
  await new Promise((resolve) => tcpServer.listen(0, '127.0.0.1', resolve));

  const httpServer = createHttpServer();
  const wss = new WebSocketServer({ server: httpServer, path: '/mqtt' });
  wss.on('connection', (socket) => {
    webSockets.add(socket);
    socket.on('close', () => webSockets.delete(socket));
    aedes.handle(createWebSocketStream(socket));
  });
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));

  const tcpPort = tcpServer.address().port;
  const wsPort = httpServer.address().port;

  return {
    aedes,
    tcpUrl: `mqtt://127.0.0.1:${tcpPort}`,
    wsUrl: `ws://127.0.0.1:${wsPort}/mqtt`,

    /** Break only the renderer's broker path; daemon MQTT remains healthy. */
    async cutOffPanelPath() {
      for (const socket of webSockets) socket.terminate();
      webSockets.clear();
      await closeServer(httpServer);
    },

    async close() {
      for (const socket of webSockets) socket.terminate();
      webSockets.clear();
      for (const socket of tcpSockets) socket.destroy();
      tcpSockets.clear();
      await closeServer(httpServer);
      await closeServer(tcpServer);
      await new Promise((resolve) => wss.close(() => resolve()));
      await new Promise((resolve) => aedes.close(() => resolve()));
    },
  };
}
