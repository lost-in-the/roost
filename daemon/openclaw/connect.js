import { homedir } from 'node:os';
import { join } from 'node:path';
import { GatewayClient } from '@openclaw/gateway-client';
import { loadOrCreateDeviceIdentity, readDeviceToken } from './device-identity.js';
import { OpenClawStateSource } from '../sources/openclaw.js';
import { resolveGatewayTarget } from './gateway-targets.js';

/**
 * Wiring: turn "roost is paired" into a live StateSource.
 *
 * Kept apart from OpenClawStateSource so the source itself stays injectable and
 * testable without a real socket or a real device file.
 */

export function resolveDeviceFile(alias, env = process.env) {
  const stateHome = env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
  const target = resolveGatewayTarget(alias, stateHome);
  const qualifiedOverride = env[`ROOST_OPENCLAW_DEVICE_FILE_${alias.toUpperCase()}`];
  if (qualifiedOverride) return qualifiedOverride;
  // Legacy unqualified overrides stay scoped to Labby only. Applying one path
  // to both Gateways would be the exact device reuse this split is preventing.
  if (alias === 'labby' && env.ROOST_OPENCLAW_DEVICE_FILE) return env.ROOST_OPENCLAW_DEVICE_FILE;
  return target.deviceFile;
}

export function resolveGatewayUrl(alias, env = process.env) {
  const stateHome = env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
  const target = resolveGatewayTarget(alias, stateHome);
  const qualifiedOverride = env[`ROOST_OPENCLAW_URL_${alias.toUpperCase()}`];
  if (qualifiedOverride) return qualifiedOverride;
  if (alias === 'labby' && env.ROOST_OPENCLAW_URL) return env.ROOST_OPENCLAW_URL;
  return target.url;
}

export function createOpenClawSource({
  alias,
  deviceFile,
  url,
  env = process.env,
  reversibleApprovalTools = [],
} = {}) {
  if (!alias) throw new Error('createOpenClawSource requires a gateway alias');
  const resolvedDeviceFile = deviceFile || resolveDeviceFile(alias, env);
  const stored = readDeviceToken(resolvedDeviceFile);
  if (!stored?.token) {
    // Failing here with instructions beats connecting anonymously and reporting
    // an empty agent set, which would look exactly like "nothing is running".
    throw new Error(
      `roost is not paired with the ${alias} OpenClaw gateway (no device token at ${resolvedDeviceFile}).\n` +
      'Pair once:\n' +
      `  node scripts/pair-openclaw.mjs --gateway ${alias}`,
    );
  }

  return new OpenClawStateSource({
    createClient: (opts) => new GatewayClient(opts),
    url: url || resolveGatewayUrl(alias, env),
    deviceToken: stored.token,
    deviceIdentity: loadOrCreateDeviceIdentity(resolvedDeviceFile),
    scopes: stored.scopes?.length ? stored.scopes : undefined,
    reversibleApprovalTools,
  });
}
