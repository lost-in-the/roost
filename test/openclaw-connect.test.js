import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOpenClawSource, resolveDeviceFile } from '../daemon/openclaw/connect.js';
import { loadOrCreateDeviceIdentity, saveDeviceToken } from '../daemon/openclaw/device-identity.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'roost-conn-'));

test('refuses to start unpaired, and names the command that fixes it', () => {
  const deviceFile = path.join(tmp(), 'device.json');
  assert.throws(
    () => createOpenClawSource({ deviceFile }),
    /pair-openclaw/,
    'an unpaired daemon must say how to pair, not just fail',
  );
});

test('builds a source once a device token is stored', () => {
  const deviceFile = path.join(tmp(), 'device.json');
  loadOrCreateDeviceIdentity(deviceFile);
  saveDeviceToken(deviceFile, 'tok', ['operator.read']);

  const source = createOpenClawSource({ deviceFile, url: 'ws://127.0.0.1:19789' });
  assert.equal(typeof source.start, 'function');
  assert.equal(typeof source.stop, 'function');
});

test('the device file defaults under XDG_STATE_HOME, matching the laptop-open log', () => {
  assert.equal(
    resolveDeviceFile({ XDG_STATE_HOME: '/xdg' }),
    path.join('/xdg', 'roost', 'openclaw-device.json'),
  );
});

test('an explicit device file path overrides the default', () => {
  assert.equal(
    resolveDeviceFile({ ROOST_OPENCLAW_DEVICE_FILE: '/custom/dev.json' }),
    '/custom/dev.json',
  );
});
