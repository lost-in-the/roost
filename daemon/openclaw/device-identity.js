import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fingerprint } from './ed25519.js';

/**
 * The Ed25519 identity roost presents to the OpenClaw gateway.
 *
 * The gateway mints a device token against THIS keypair. Pairing is approved
 * once, by a human running `openclaw devices approve <requestId>`. If roost
 * ever generates a second keypair it becomes a different device: the approved
 * pairing is orphaned and someone has to approve a new request by hand. So the
 * identity is written once and reused forever, and losing this file costs a
 * manual re-approval.
 *
 * See docs/gateway/clients.md in the installed openclaw package: "Persist an
 * Ed25519 device identity in the client."
 */

// Derived from the public key rather than randomly generated, so the id can
// never drift from the keypair it names. `fingerprint` hashes the RAW key
// exactly as OpenClaw's own fingerprintPublicKey does, so every tool on the
// host names this device identically.
export function loadOrCreateDeviceIdentity(file) {
  if (fs.existsSync(file)) {
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      deviceId: fingerprint(stored.publicKeyPem),
      privateKeyPem: stored.privateKeyPem,
      publicKeyPem: stored.publicKeyPem,
    };
  }

  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  fs.mkdirSync(path.dirname(file), { recursive: true });
  // mode on writeFileSync is applied at CREATE time only, so an existing file
  // would keep its old mode. There is no existing file on this path.
  fs.writeFileSync(file, JSON.stringify({ privateKeyPem: privateKey, publicKeyPem: publicKey }, null, 2), { mode: 0o600 });

  return { deviceId: fingerprint(publicKey), privateKeyPem: privateKey, publicKeyPem: publicKey };
}

/**
 * The minted device token lives in the same file as the keypair, deliberately.
 *
 * The gateway issued it for THIS device id, against THIS public key. It is not
 * portable: copying it to another machine without the private key is useless,
 * and a backup that restored one without the other would be broken. Storing
 * them together makes that binding structural rather than a convention.
 *
 * Recovery, if the file is lost, is to pair again: generate a new identity and
 * have someone run `openclaw devices approve <requestId>` once.
 */
export function readDeviceToken(file) {
  if (!fs.existsSync(file)) return null;
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!stored.deviceToken) return null;
  return { token: stored.deviceToken, scopes: stored.scopes ?? [] };
}

export function saveDeviceToken(file, token, scopes = []) {
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  stored.deviceToken = token;
  stored.scopes = scopes;
  // writeFileSync's `mode` applies only when CREATING a file, and this path
  // always rewrites an existing one, so the mode is set explicitly afterwards.
  fs.writeFileSync(file, JSON.stringify(stored, null, 2));
  fs.chmodSync(file, 0o600);
}
