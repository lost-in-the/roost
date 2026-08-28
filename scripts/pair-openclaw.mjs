#!/usr/bin/env node
/**
 * One-shot: pair roost with the local OpenClaw gateway.
 *
 * The gateway's SHARED token is used once, for bootstrap auth only. It is read from STDIN so it
 * never appears in argv, in shell history, or in a process listing:
 *
 *   sudo -n cat /var/lib/labby/credentials/gateway-token \
 *     | node scripts/pair-openclaw.mjs --gateway labby
 *
 * The run leaves behind ONE thing: roost's own device token, scoped
 * `operator.read` by default, stored 0600 next to the Ed25519 key it is bound
 * to. The shared token is never written anywhere.
 *
 * Ask for a wider scope set with --scopes. M2 (touch approvals) needs
 * `operator.approvals` on top of the read scope:
 *
 *   sudo -n cat /var/lib/labby/credentials/gateway-token \
 *     | node scripts/pair-openclaw.mjs --gateway labby --scopes operator.read,operator.approvals
 *
 * Running that against an ALREADY-PAIRED roost performs a scope upgrade rather
 * than refusing. The Ed25519 identity is reused, so this stays the same device
 * to the gateway and the old pairing is not orphaned. Live local pairing on
 * 2026-08-27 auto-approved both a Labby scope upgrade and Omar's fresh identity
 * when the shared Gateway token was supplied. Treat possession and use of that
 * token as the authorization step; do not expect a separate human prompt.
 *
 * While pairing is pending this prints a request id. Approve it on the host:
 *
 * The printed approval command is selected by the required --gateway alias.
 * Device identities, URLs, and approval commands are never shared across
 * Gateways.
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
import { mergeScopes, missingScopes, scopesFromArgv } from '../daemon/openclaw/scopes.js';
import {
  approvalCommand,
  gatewayAliasFromArgv,
  resolveGatewayTarget,
} from '../daemon/openclaw/gateway-targets.js';

const stateHome = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state');

const log = (...a) => console.error('[pair-openclaw]', ...a);

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8').trim();
}

const argv = process.argv.slice(2);
let gatewayAlias;
let target;
try {
  gatewayAlias = gatewayAliasFromArgv(argv);
  target = resolveGatewayTarget(gatewayAlias, stateHome);
} catch (err) {
  log(err.message);
  log('usage: node scripts/pair-openclaw.mjs --gateway labby|omar [--scopes operator.read,operator.approvals]');
  process.exit(1);
}

const { deviceFile: DEVICE_FILE, url: URL } = target;
const requested = scopesFromArgv(argv);
if (requested === null) {
  log('--scopes was given with no value.');
  log('usage: node scripts/pair-openclaw.mjs --gateway labby|omar --scopes operator.read,operator.approvals');
  process.exit(1);
}

const existing = readDeviceToken(DEVICE_FILE);

// Scopes actually asked for on the wire. On an upgrade this is the UNION, not
// the newly-requested set: the gateway negotiates exactly what connect asks
// for, so requesting only the new scope would drop the ones roost already runs on.
let scopes = requested;

if (existing) {
  const missing = missingScopes(existing.scopes, requested);
  if (missing.length === 0) {
    log(`already paired; device token present with scopes [${existing.scopes.join(', ')}]`);
    log('the requested scopes are already covered. nothing to do.');
    log('to replace or reduce this identity, revoke it through its source Gateway, then delete its device file and re-pair; see README "Connecting to OpenClaw".');
    process.exit(0);
  }
  scopes = mergeScopes(existing.scopes, requested);
  log(`already paired with scopes [${existing.scopes.join(', ')}]`);
  log(`scope upgrade: adding [${missing.join(', ')}]`);
  log(`requesting [${scopes.join(', ')}] on the EXISTING device identity`);
  log('the shared Gateway token may auto-approve this upgrade; if pairing is required, the source-local approval command will be printed.');
}

const gatewayToken = await readStdin();
if (!gatewayToken) {
  log('no gateway token on stdin.');
  log(`no ${gatewayAlias} gateway token on stdin.`);
  log(`usage: <${gatewayAlias} gateway token on stdin> | node scripts/pair-openclaw.mjs --gateway ${gatewayAlias}`);
  process.exit(1);
}

const identity = loadOrCreateDeviceIdentity(DEVICE_FILE);
log(`device id ${identity.deviceId.slice(0, 16)}… (identity at ${DEVICE_FILE})`);
log(`connecting to ${URL}`);

try {
  const { deviceToken, scopes: negotiated } = await pairDevice({
    createClient: (opts) => new GatewayClient(opts),
    url: URL,
    gatewayToken,
    deviceIdentity: identity,
    scopes,
    onPairingRequired: (requestId) => {
      log('');
      log(`APPROVAL NEEDED. request id: ${requestId}`);
      log('run this on the host, then leave this process running:');
      log(`  ${approvalCommand(target, requestId)}`);
      log('');
    },
  });

  // Record what the gateway NEGOTIATED, never what was requested. The gateway
  // can return a narrower set than was asked for, and a roost that believed the
  // wider set would fail later with an authorization error that reads like a
  // daemon bug rather than a pairing decision.
  saveDeviceToken(DEVICE_FILE, deviceToken, negotiated);
  log(`paired. device token stored 0600 at ${DEVICE_FILE}, scopes [${negotiated.join(', ')}]`);
  const shortfall = missingScopes(negotiated, scopes);
  if (shortfall.length > 0) log(`NOTE: requested but not granted: [${shortfall.join(', ')}]`);
  log('the shared bootstrap token was not written anywhere.');
  process.exit(0);
} catch (err) {
  log(`pairing failed: ${err?.message ?? err}`);
  process.exit(1);
}
