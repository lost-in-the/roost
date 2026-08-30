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
    () => createOpenClawSource({ alias: 'labby', deviceFile }),
    /pair-openclaw/,
    'an unpaired daemon must say how to pair, not just fail',
  );
});

test('builds a source once a device token is stored', () => {
  const deviceFile = path.join(tmp(), 'device.json');
  loadOrCreateDeviceIdentity(deviceFile);
  saveDeviceToken(deviceFile, 'tok', ['operator.read']);

  const source = createOpenClawSource({ alias: 'labby', deviceFile, url: 'ws://127.0.0.1:19789' });
  assert.equal(typeof source.start, 'function');
  assert.equal(typeof source.stop, 'function');
});

test('the labby device file defaults under XDG_STATE_HOME, matching the laptop-open log', () => {
  assert.equal(
    resolveDeviceFile('labby', { XDG_STATE_HOME: '/xdg' }),
    path.join('/xdg', 'roost', 'openclaw-device.json'),
  );
});

test('an explicit labby device file path overrides the default', () => {
  assert.equal(
    resolveDeviceFile('labby', { ROOST_OPENCLAW_DEVICE_FILE: '/custom/dev.json' }),
    '/custom/dev.json',
  );
});

test('per-alias device file overrides take precedence', () => {
  assert.equal(
    resolveDeviceFile('omar', { ROOST_OPENCLAW_DEVICE_FILE_OMAR: '/custom/omar.json' }),
    '/custom/omar.json',
  );
});

test('the legacy unqualified device override applies only to labby', () => {
  assert.equal(
    resolveDeviceFile('labby', { ROOST_OPENCLAW_DEVICE_FILE: '/custom/labby.json' }),
    '/custom/labby.json',
  );
  assert.equal(
    resolveDeviceFile('omar', { ROOST_OPENCLAW_DEVICE_FILE: '/custom/labby.json', XDG_STATE_HOME: '/xdg' }),
    path.join('/xdg', 'roost', 'openclaw-omar-device.json'),
  );
});

test('labby and omar can never resolve to the same default device file', () => {
  assert.notEqual(
    resolveDeviceFile('labby', { XDG_STATE_HOME: '/xdg' }),
    resolveDeviceFile('omar', { XDG_STATE_HOME: '/xdg' }),
  );
});
