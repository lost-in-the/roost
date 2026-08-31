import { defaultLogPath } from './laptop-log.js';
import { parseGatewayAliases } from './openclaw/gateway-targets.js';

/**
 * Configuration comes from plain environment variables.
 *
 * The systemd unit supplies them from two `EnvironmentFile=` entries: `.env`
 * for non-secret settings, and `~/.config/roost/credentials.env` for the
 * broker passwords. Secrets still never touch the repo or the unit file, and
 * nothing here reads a secret from disk itself.
 */

export const VALID_SOURCES = ['mock', 'openclaw'];

const int = (value, fallback) => {
  if (value === undefined || value === '') return fallback;
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) throw new Error(`expected an integer, got ${JSON.stringify(value)}`);
  return n;
};

/**
 * Is this the local dev broker? `scripts/dev-broker.js` is the only thing that
 * serves WebSocket on 8083, so the derived default below is only ever right
 * for loopback.
 */
const isLoopback = (host) => ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host);

const CREDENTIALS_HINT =
  'Restore it while 1Password is unlocked:\n' +
  '  ./scripts/provision-credentials.sh';

/**
 * The passwords come from ~/.config/roost/credentials.env, a provisionable
 * CACHE whose source of truth is 1Password. That file can legitimately be
 * absent after an environment reset, so a missing password is a real state and
 * not a programming error — but it must fail HERE, naming the restore, rather
 * than surfacing later as a bare "not authorized" from the broker.
 */
function requireCredential(user, password, userVar, passVar) {
  if (!user) return;                       // anonymous broker: nothing to check
  if (!password) {
    throw new Error(
      `${userVar} is set but ${passVar} is empty. It comes from ` +
      `~/.config/roost/credentials.env, which is missing or incomplete.\n${CREDENTIALS_HINT}`);
  }
  if (password.startsWith('op://')) {
    throw new Error(
      `${passVar} is an unresolved 1Password reference (${password.split('/')[2] ?? 'op://…'}). ` +
      'Something passed the reference through instead of the value.\n' + CREDENTIALS_HINT);
  }
}

export function loadConfig(env = process.env) {
  const host = env.ROOST_MQTT_HOST;
  if (!host) throw new Error('ROOST_MQTT_HOST is required (see .env.example)');

  // Refused rather than guessed, for the same reason the host is required: a
  // wrong WebSocket URL does not error anywhere. The daemon connects happily
  // over TCP, the panel simply never subscribes, and the display sits on its
  // last retained message looking healthy.
  //
  // 8083 is the EMQX convention and what dev-broker.js serves. The real broker
  // here is Mosquitto, whose WebSocket listener is 9001 — measured: 1883 open,
  // 8083/9001/8080/8883/8884 all refused before the listener was added.
  if (!isLoopback(host) && !env.ROOST_MQTT_WS_URL) {
    throw new Error(
      `ROOST_MQTT_WS_URL is required for a remote broker (host ${host}). ` +
      'There is no portable default: EMQX uses 8083, Mosquitto uses 9001. ' +
      'Set it explicitly, e.g. ws://mqtt.example.internal:9001/mqtt');
  }

  requireCredential(env.ROOST_MQTT_USER, env.ROOST_MQTT_PASSWORD,
    'ROOST_MQTT_USER', 'ROOST_MQTT_PASSWORD');
  requireCredential(env.ROOST_MQTT_RENDERER_USER, env.ROOST_MQTT_RENDERER_PASSWORD,
    'ROOST_MQTT_RENDERER_USER', 'ROOST_MQTT_RENDERER_PASSWORD');

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

  // Conservative by default: the running daemon is paired to Labby only today.
  // Flipping production to labby,omar is the later deploy change, but typos in
  // the configured list should still fail at load even before OpenClaw is used.
  const openclawGateways = parseGatewayAliases(env.ROOST_OPENCLAW_GATEWAYS, ['labby']);

  return {
    openclawGateways,
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
      // WebSocket. The fallback only applies to loopback, where it matches
      // scripts/dev-broker.js; a remote host is rejected above.
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
