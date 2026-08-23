import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { rawPublicKey, publicKeyBase64Url, signPayload, fingerprint } from '../daemon/openclaw/ed25519.js';

const keys = () => crypto.generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

test('the raw public key is the 32-byte ed25519 key, not its 44-byte SPKI wrapper', () => {
  const { publicKey } = keys();
  assert.equal(rawPublicKey(publicKey).length, 32);
});

test('a signature verifies against the public key, which is the only thing the gateway checks', () => {
  const { publicKey, privateKey } = keys();
  const payload = 'connect-challenge-payload';
  const sig = Buffer.from(signPayload(privateKey, payload), 'base64url');

  assert.ok(crypto.verify(null, Buffer.from(payload, 'utf8'), crypto.createPublicKey(publicKey), sig));
});

test('a signature over different bytes does not verify, so the test above is not vacuous', () => {
  const { publicKey, privateKey } = keys();
  const sig = Buffer.from(signPayload(privateKey, 'one thing'), 'base64url');

  assert.equal(crypto.verify(null, Buffer.from('another thing', 'utf8'), crypto.createPublicKey(publicKey), sig), false);
});

test('encodings are base64url, because they travel inside a JSON connect frame', () => {
  const { publicKey, privateKey } = keys();
  for (const s of [publicKeyBase64Url(publicKey), signPayload(privateKey, 'x')]) {
    assert.doesNotMatch(s, /[+/=]/, 'base64url uses -_ and no padding');
  }
});

test('the fingerprint hashes the RAW key, matching OpenClaw fingerprintPublicKey', () => {
  const { publicKey } = keys();
  // Derived independently here rather than reusing the implementation.
  const der = crypto.createPublicKey(publicKey).export({ type: 'spki', format: 'der' });
  const expected = crypto.createHash('sha256').update(der.subarray(der.length - 32)).digest('hex');

  assert.equal(fingerprint(publicKey), expected);
});
