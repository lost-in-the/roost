import { defaultLogPath } from './laptop-log.js';

/**
 * Configuration comes from plain environment variables.
 *
 * The systemd unit supplies them via `op run --env-file`, so secrets live in
 * 1Password and never touch the repo or the unit file. Nothing here reads a
 * secret from disk itself.
 */

export const VALID_SOURCES = ['mock', 'openclaw'];

const int = (value, fallback) => {
  if (value === undefined || value === '') return fallback;
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) throw new Error(`expected an integer, got ${JSON.stringify(value)}`);
  return n;
};

export function loadConfig(env = process.env) {
  const host = env.ROOST_MQTT_HOST;
  if (!host) throw new Error('ROOST_MQTT_HOST is required (see .env.example)');

  const port = int(env.ROOST_MQTT_PORT, 1883);
  const topic = env.ROOST_MQTT_TOPIC || 'roost/agents/state';
  // The laptop-open counter rides its own topic. It is a different kind of fact
  // from agent state, with no heartbeat and no staleness rule. See
  // daemon/instrument.js for why they are kept apart.
  const instrumentTopic = env.ROOST_MQTT_INSTRUMENT_TOPIC || 'roost/instrument/laptop-opens';
  const heartbeatMs = int(env.ROOST_HEARTBEAT_MS, 10_000);
  const staleMs = int(env.ROOST_STALE_MS, 30_000);

  // Staleness has to tolerate at least one dropped heartbeat, otherwise the
  // panel cries stale during normal operation and gets ignored.
  if (staleMs < heartbeatMs * 2) {
    throw new Error(`ROOST_STALE_MS (${staleMs}) must be at least twice ROOST_HEARTBEAT_MS (${heartbeatMs})`);
  }

  const source = env.ROOST_SOURCE || 'mock';
  if (!VALID_SOURCES.includes(source)) {
    throw new Error(`ROOST_SOURCE ${JSON.stringify(source)} is not one of: ${VALID_SOURCES.join(', ')}`);
  }

  return {
    source,
    mockScript: env.ROOST_MOCK_SCRIPT || 'demo',
    heartbeatMs,
    mqtt: {
      url: `mqtt://${host}:${port}`,
      host,
      port,
      topic,
      instrumentTopic,
      username: env.ROOST_MQTT_USER || undefined,
      password: env.ROOST_MQTT_PASSWORD || undefined,
    },
    http: {
      host: env.ROOST_HTTP_HOST || '127.0.0.1',
      port: int(env.ROOST_HTTP_PORT, 8477),
    },
    laptopLogPath: env.ROOST_LAPTOP_LOG || defaultLogPath(),
    renderer: {
      // Browsers cannot speak raw MQTT over TCP, so the panel connects over
      // WebSocket. EMQX exposes this on 8083 by default.
      wsUrl: env.ROOST_MQTT_WS_URL || `ws://${host}:8083/mqtt`,
      topic,
      instrumentTopic,
      staleMs,
      // Which spiked layout the panel mounts. `corner` or `header`.
      // A ?instrument= query parameter on the page overrides this, so both can
      // be compared without restarting the daemon.
      instrumentVariant: env.ROOST_INSTRUMENT_VARIANT || 'corner',
      // Prefer a separate subscribe-only credential: this one is handed to a
      // browser page, so it should not be able to publish to the topic.
      username: env.ROOST_MQTT_RENDERER_USER || env.ROOST_MQTT_USER || undefined,
      password: env.ROOST_MQTT_RENDERER_PASSWORD || env.ROOST_MQTT_PASSWORD || undefined,
    },
  };
}
