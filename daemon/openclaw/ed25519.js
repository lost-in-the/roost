import crypto from 'node:crypto';

/**
 * Ed25519 primitives for the gateway's device handshake.
 *
 * These mirror OpenClaw's own implementation (its dist ships
 * `signEd25519Payload`, `publicKeyRawBase64UrlFromEd25519Pem` and
 * `fingerprintPublicKey`, but the published @openclaw packages do not export
 * them). The encodings are not ours to choose: the gateway verifies the
 * signature and reads the public key, so both must match byte for byte.
 *
 * Notably the device fingerprint hashes the RAW 32-byte key, not the PEM text.
 * Hashing the PEM would be stable and unique too, and would still look correct
 * locally, while producing a device id no other OpenClaw tool agrees with.
 */

// SPKI for an Ed25519 public key is a fixed 12-byte prefix then the 32-byte key.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function rawPublicKey(publicKeyPem) {
  const der = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  const prefix = der.subarray(0, ED25519_SPKI_PREFIX.length);
  if (!prefix.equals(ED25519_SPKI_PREFIX)) {
    throw new Error('not an ed25519 public key: unexpected SPKI prefix');
  }
  return der.subarray(ED25519_SPKI_PREFIX.length);
}

export function publicKeyBase64Url(publicKeyPem) {
  return rawPublicKey(publicKeyPem).toString('base64url');
}

// `crypto.sign(null, …)` is correct for Ed25519: the algorithm is fixed by the
// key type and passing a digest name is an error.
export function signPayload(privateKeyPem, payload) {
  const signature = crypto.sign(null, Buffer.from(payload, 'utf8'), crypto.createPrivateKey(privateKeyPem));
  return signature.toString('base64url');
}

export function fingerprint(publicKeyPem) {
  return crypto.createHash('sha256').update(rawPublicKey(publicKeyPem)).digest('hex');
}
