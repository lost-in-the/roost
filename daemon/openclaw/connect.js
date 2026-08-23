import { homedir } from 'node:os';
import { join } from 'node:path';
import { GatewayClient } from '@openclaw/gateway-client';
import { loadOrCreateDeviceIdentity, readDeviceToken } from './device-identity.js';
import { OpenClawStateSource } from '../sources/openclaw.js';

/**
 * Wiring: turn "roost is paired" into a live StateSource.
 *
 * Kept apart from OpenClawStateSource so the source itself stays injectable and
 * testable without a real socket or a real device file.
 */

export function resolveDeviceFile(env = process.env) {
  if (env.ROOST_OPENCLAW_DEVICE_FILE) return env.ROOST_OPENCLAW_DEVICE_FILE;
  const stateHome = env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
  return join(stateHome, 'roost', 'openclaw-device.json');
}

export function createOpenClawSource({ deviceFile = resolveDeviceFile(), url, env = process.env } = {}) {
  const stored = readDeviceToken(deviceFile);
  if (!stored?.token) {
    // Failing here with instructions beats connecting anonymously and reporting
    // an empty agent set, which would look exactly like "nothing is running".
    throw new Error(
      `roost is not paired with the OpenClaw gateway (no device token at ${deviceFile}).\n` +
      'Pair once:\n' +
      '  sudo -n cat /var/lib/labby/credentials/gateway-token | node scripts/pair-openclaw.mjs',
    );
  }

  return new OpenClawStateSource({
    createClient: (opts) => new GatewayClient(opts),
    url: url || env.ROOST_OPENCLAW_URL || 'ws://127.0.0.1:19789',
    deviceToken: stored.token,
    deviceIdentity: loadOrCreateDeviceIdentity(deviceFile),
    scopes: stored.scopes?.length ? stored.scopes : undefined,
  });
}
