#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { loadConfig } from './config.js';
import { aggregate } from './aggregate.js';
import { StatePublisher } from './publisher.js';
import { startHttpServer } from './http.js';
import { LaptopLog } from './laptop-log.js';
import { instrumentPayload } from './instrument.js';
import { MockStateSource, SCRIPTS } from './sources/mock.js';
import { createOpenClawSource, resolveDeviceFile, resolveGatewayUrl } from './openclaw/connect.js';
import { assertGatewayApprovalsNotExposed } from './approval-exposure.js';
import { MultiGatewaySource } from './sources/coordinator.js';

const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);

/**
 * The roost state daemon.
 *
 *   StateSource -> aggregate() -> MQTT (retained, LWT, heartbeat)
 *                              -> loopback HTTP for the renderer
 *
 * This process is the ONLY place aggregation happens.
 */

const log = (msg) => console.log(`[roost] ${new Date().toISOString()} ${msg}`);

function buildSource(config) {
  if (config.source === 'openclaw') {
    const children = config.openclawGateways.map((alias) => {
      const deviceFile = resolveDeviceFile(alias);
      const url = resolveGatewayUrl(alias);
      log(`openclaw gateway=${alias} device=${deviceFile} url=${url}`);
      return { alias, source: createOpenClawSource({ alias, deviceFile, url }) };
    });
    const source = new MultiGatewaySource(children);
    source.on('warning', (m) => log(`WARNING ${m}`));
    log(`using OpenClawStateSource gateways=${config.openclawGateways.join(',')}`);
    return source;
  }
  const script = SCRIPTS[config.mockScript];
  if (!script) throw new Error(`unknown ROOST_MOCK_SCRIPT ${JSON.stringify(config.mockScript)}`);
  log(`using MockStateSource, script=${config.mockScript}`);
  return new MockStateSource({ script });
}

async function main() {
  const config = loadConfig();
  log(`topic=${config.mqtt.topic} broker=${config.mqtt.host}:${config.mqtt.port} source=${config.source}`);

  // Before ANYTHING listens. The scopes live in the device file rather than the
  // environment, so this cannot fold into loadConfig(), and it has to run ahead
  // of startHttpServer() below — a check after listen() would leave the port
  // open on every interface for the moments before the process exits.
  //
  // Only the openclaw source reaches the gateway, so only it can carry the
  // authority the guard exists to contain. An unpaired roost reads as no scopes
  // and is let through here; buildSource() is what reports that, with the
  // pairing instructions.
  if (config.source === 'openclaw') {
    assertGatewayApprovalsNotExposed({
      host: config.http.host,
      deviceFiles: config.openclawGateways.map((alias) => resolveDeviceFile(alias)),
    });
  }

  // The current full agent set. Aggregation is a pure function of this.
  let agents = [];

  const publisher = new StatePublisher({
    url: config.mqtt.url,
    topic: config.mqtt.topic,
    username: config.mqtt.username,
    password: config.mqtt.password,
    heartbeatMs: config.heartbeatMs,
    // Called at publish time so `ts` is always the moment of publication,
    // including on heartbeats where nothing changed.
    buildPayload: () => aggregate(agents),
  });
  publisher.onLog = log;

  const laptopLog = new LaptopLog({ path: config.laptopLogPath });
  log(`laptop-open log: ${laptopLog.path} (${laptopLog.count()} recorded)`);

  const publishInstrument = () => {
    const payload = instrumentPayload(laptopLog);
    if (publisher.publishRetained(config.mqtt.instrumentTopic, payload)) {
      log(`instrument: count=${payload.count} -> ${config.mqtt.instrumentTopic}`);
    }
  };

  // Republish the retained counter on every (re)connect, so a broker that was
  // restarted (and lost its retained set) gets the current value back.
  publisher.onConnected = publishInstrument;
  const source = buildSource(config);

  const http = await startHttpServer({
    host: config.http.host,
    port: config.http.port,
    laptopLog,
    rendererConfig: config.renderer,
    getStatus: () => ({
      source: config.source,
      version: pkg.version,
      mqtt: {
        connected: publisher.connected,
        topic: config.mqtt.topic,
      },
      gateways: config.source === 'openclaw'
        ? config.openclawGateways.map((alias) => ({
          alias,
          stale: source.staleAliases().includes(alias),
        }))
        : [],
    }),
    onLog: log,
    onRecorded: publishInstrument,
  });
  log(`renderer served at http://${config.http.host}:${http.port}/`);
  source.on('agents', (next) => {
    agents = next;
    // onWarn only here, not in buildPayload. aggregate() fails closed on a
    // malformed prompt, and failing closed quietly is the actual hazard — but
    // this handler runs once per change whereas buildPayload also runs on every
    // heartbeat, which would turn one bad prompt into a line every 10 seconds.
    // Every change passes through here first, so nothing is missed.
    const payload = aggregate(agents, { onWarn: (msg) => log(`WARNING ${msg}`) });
    log(`state=${payload.state} count=${payload.count} urgency=${payload.urgency} prompt=${payload.prompt ? `${payload.prompt.kind}:${payload.prompt.id}` : 'none'} label=${JSON.stringify(payload.label)}`);
    publisher.touch();
  });

  // The mock's daemon-death scenario. Dies WITHOUT a clean disconnect so the
  // broker actually fires our Last Will, which is the thing worth testing.
  source.on('die', () => {
    log('scripted hard death: killing self so the broker publishes Last Will');
    process.kill(process.pid, 'SIGKILL');
  });

  publisher.start();
  source.start();

  const shutdown = (signal) => {
    log(`${signal}: shutting down`);
    source.stop();
    publisher.stop();
    http.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error(`[roost] fatal: ${err.message}`);
  process.exit(1);
});
