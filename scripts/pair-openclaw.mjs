#!/usr/bin/env node
/**
 * One-shot: pair roost with the local OpenClaw gateway.
 *
 * The gateway's SHARED token is used once, for bootstrap auth only. It is read from STDIN so it
 * never appears in argv, in shell history, or in a process listing:
 *
 *   sudo -n cat /var/lib/labby/credentials/gateway-token \
 *     | node scripts/pair-openclaw.mjs
 *
 * The run leaves behind ONE thing: roost's own device token, scoped
 * `operator.read`, stored 0600 next to the Ed25519 key it is bound to. The
 * shared token is never written anywhere.
 *
 * While pairing is pending this prints a request id. Approve it on the host:
 *
 *   sudo -u labby env HOME=/var/lib/labby PATH=/opt/labby/runtime/node_modules/.bin:/usr/bin \
 *     node /opt/labby/runtime/node_modules/openclaw/openclaw.mjs \
 *     --profile labby devices approve <requestId>
 *
 * It keeps reconnecting until approved, which is what the protocol spec asks
 * for (PAIRING_REQUIRED is retryable with recommendedNextStep wait_then_retry).
 * Re-running after success is a no-op.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { GatewayClient } from '@openclaw/gateway-client';
import { loadOrCreateDeviceIdentity, readDeviceToken, saveDeviceToken } from '../daemon/openclaw/device-identity.js';
import { pairDevice } from '../daemon/openclaw/pairing.js';

const stateHome = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
const DEVICE_FILE = process.env.ROOST_OPENCLAW_DEVICE_FILE || join(stateHome, 'roost', 'openclaw-device.json');
const URL = process.env.ROOST_OPENCLAW_URL || 'ws://127.0.0.1:19789';

const log = (...a) => console.error('[pair-openclaw]', ...a);

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8').trim();
}

const existing = readDeviceToken(DEVICE_FILE);
if (existing) {
  log(`already paired; device token present with scopes [${existing.scopes.join(', ')}]`);
  log(`nothing to do. delete ${DEVICE_FILE} to force re-pairing.`);
  process.exit(0);
}

const gatewayToken = await readStdin();
if (!gatewayToken) {
  log('no gateway token on stdin.');
  log('usage: sudo -n cat /var/lib/labby/credentials/gateway-token | node scripts/pair-openclaw.mjs');
  process.exit(1);
}

const identity = loadOrCreateDeviceIdentity(DEVICE_FILE);
log(`device id ${identity.deviceId.slice(0, 16)}… (identity at ${DEVICE_FILE})`);
log(`connecting to ${URL}`);

try {
  const { deviceToken, scopes } = await pairDevice({
    createClient: (opts) => new GatewayClient(opts),
    url: URL,
    gatewayToken,
    deviceIdentity: identity,
    onPairingRequired: (requestId) => {
      log('');
      log(`APPROVAL NEEDED. request id: ${requestId}`);
      log('run this on the host, then leave this process running:');
      log(`  sudo -u labby env HOME=/var/lib/labby PATH=/opt/labby/runtime/node_modules/.bin:/usr/bin \\`);
      log(`    node /opt/labby/runtime/node_modules/openclaw/openclaw.mjs \\`);
      log(`    --profile labby devices approve ${requestId}`);
      log('');
    },
  });

  saveDeviceToken(DEVICE_FILE, deviceToken, scopes);
  log(`paired. device token stored 0600 at ${DEVICE_FILE}, scopes [${scopes.join(', ')}]`);
  log('the shared bootstrap token was not written anywhere.');
  process.exit(0);
} catch (err) {
  log(`pairing failed: ${err?.message ?? err}`);
  process.exit(1);
}
