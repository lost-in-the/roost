import { fingerprint } from '../daemon/openclaw/ed25519.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadOrCreateDeviceIdentity, saveDeviceToken, readDeviceToken } from '../daemon/openclaw/device-identity.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'roost-devid-'));

test('mints an ed25519 identity when none is stored yet', () => {
  const file = path.join(tmp(), 'device.json');
  const id = loadOrCreateDeviceIdentity(file);

  assert.match(id.privateKeyPem, /^-----BEGIN PRIVATE KEY-----/);
  assert.match(id.publicKeyPem, /^-----BEGIN PUBLIC KEY-----/);
  assert.ok(id.deviceId.length > 0, 'a device id is required by the connect frame');
});

test('reuses the stored identity, because a fresh one would orphan the approved pairing', () => {
  const file = path.join(tmp(), 'device.json');
  const first = loadOrCreateDeviceIdentity(file);
  const second = loadOrCreateDeviceIdentity(file);

  assert.equal(second.deviceId, first.deviceId);
  assert.equal(second.privateKeyPem, first.privateKeyPem);
});

test('the device id is derived from the public key, so it never drifts from the keypair', () => {
  const a = path.join(tmp(), 'device.json');
  const b = path.join(tmp(), 'device.json');
  const one = loadOrCreateDeviceIdentity(a);
  const two = loadOrCreateDeviceIdentity(b);

  assert.notEqual(one.deviceId, two.deviceId, 'different keypairs must not collide');

  // Re-deriving from the same stored key must reproduce the same id.
  fs.writeFileSync(b, fs.readFileSync(a));
  assert.equal(loadOrCreateDeviceIdentity(b).deviceId, one.deviceId);
});

test('the stored private key is not readable by other local accounts', () => {
  const file = path.join(tmp(), 'device.json');
  loadOrCreateDeviceIdentity(file);
  const mode = fs.statSync(file).mode & 0o777;
  assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
});

test('creates the containing directory rather than failing on a fresh machine', () => {
  const file = path.join(tmp(), 'nested', 'deeper', 'device.json');
  const id = loadOrCreateDeviceIdentity(file);
  assert.ok(fs.existsSync(file));
  assert.ok(id.deviceId);
});

// ── Device token persistence ────────────────────────────────────────────────
//
// The device token is bound to the keypair above: the gateway minted it for
// THIS device id. It cannot be moved to another machine or restored from a
// backup independently of the private key, so it is stored in the same file.

test('reports no device token before pairing has happened', () => {
  const file = path.join(tmp(), 'device.json');
  loadOrCreateDeviceIdentity(file);
  assert.equal(readDeviceToken(file), null);
});

test('stores the device token alongside the identity it is bound to', () => {
  const file = path.join(tmp(), 'device.json');
  loadOrCreateDeviceIdentity(file);
  saveDeviceToken(file, 'minted-token', ['operator.read']);

  const stored = readDeviceToken(file);
  assert.equal(stored.token, 'minted-token');
  assert.deepEqual(stored.scopes, ['operator.read']);
});

test('preserves the keypair when storing the token, because losing it forces re-approval', () => {
  const file = path.join(tmp(), 'device.json');
  const before = loadOrCreateDeviceIdentity(file);
  saveDeviceToken(file, 'minted-token', ['operator.read']);

  const after = loadOrCreateDeviceIdentity(file);
  assert.equal(after.deviceId, before.deviceId);
  assert.equal(after.privateKeyPem, before.privateKeyPem);
});

test('the file stays owner-only after the token is written', () => {
  const file = path.join(tmp(), 'device.json');
  loadOrCreateDeviceIdentity(file);
  saveDeviceToken(file, 'minted-token', ['operator.read']);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('the device id is OpenClaw\'s own fingerprint, so every tool on the host agrees what device this is', () => {
  const file = path.join(tmp(), 'device.json');
  const id = loadOrCreateDeviceIdentity(file);
  assert.equal(id.deviceId, fingerprint(id.publicKeyPem));
});
