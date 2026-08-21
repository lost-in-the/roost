#!/usr/bin/env node
/**
 * A local MQTT broker for development and verification.
 *
 * The real deployment uses the EMQX instance shared with Home Assistant and
 * Zigbee2MQTT. This exists so a fresh checkout can be run and verified end to
 * end - including Last Will and staleness - without touching that broker.
 *
 * Listens for TCP (daemon) and WebSocket (renderer) on separate ports.
 */
import { Aedes } from 'aedes';
import { createServer as createTcpServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { WebSocketServer, createWebSocketStream } from 'ws';

const TCP_PORT = Number(process.env.ROOST_DEV_BROKER_PORT || 1883);
const WS_PORT = Number(process.env.ROOST_DEV_BROKER_WS_PORT || 8083);

const aedes = await Aedes.createBroker();

createTcpServer(aedes.handle).listen(TCP_PORT, '127.0.0.1', () =>
  console.log(`[dev-broker] mqtt://127.0.0.1:${TCP_PORT}`));

const httpServer = createHttpServer();
const wss = new WebSocketServer({ server: httpServer, path: '/mqtt' });
wss.on('connection', (ws) => aedes.handle(createWebSocketStream(ws)));
httpServer.listen(WS_PORT, '127.0.0.1', () =>
  console.log(`[dev-broker] ws://127.0.0.1:${WS_PORT}/mqtt`));

aedes.on('client', (c) => console.log(`[dev-broker] + ${c.id}`));
aedes.on('clientDisconnect', (c) => console.log(`[dev-broker] - ${c.id}`));
aedes.on('publish', (packet, client) => {
  if (!client) return;
  console.log(`[dev-broker] ${client.id} -> ${packet.topic} ${packet.payload.toString().slice(0, 160)}`);
});
