#!/usr/bin/env node
import { loadConfig } from './config.js';
import { aggregate } from './aggregate.js';
import { StatePublisher } from './publisher.js';
import { startHttpServer } from './http.js';
import { LaptopLog } from './laptop-log.js';
import { MockStateSource, SCRIPTS } from './sources/mock.js';
import { OpenClawStateSource } from './sources/openclaw.js';

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
    const source = new OpenClawStateSource();
    source.on('warning', (m) => log(`WARNING ${m}`));
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

  const http = await startHttpServer({
    host: config.http.host,
    port: config.http.port,
    laptopLog,
    rendererConfig: config.renderer,
    onLog: log,
  });
  log(`renderer served at http://${config.http.host}:${http.port}/`);

  const source = buildSource(config);
  source.on('agents', (next) => {
    agents = next;
    const payload = aggregate(agents);
    log(`state=${payload.state} count=${payload.count} urgency=${payload.urgency} label=${JSON.stringify(payload.label)}`);
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
