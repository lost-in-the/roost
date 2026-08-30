import test from 'node:test';
import assert from 'node:assert/strict';
import {
  approvalCommand,
  gatewayAliasFromArgv,
  parseGatewayAliases,
  resolveGatewayTarget,
} from '../daemon/openclaw/gateway-targets.js';

test('gateway alias is mandatory, singular, and exact', () => {
  assert.equal(gatewayAliasFromArgv(['--gateway', 'labby']), 'labby');
  assert.equal(gatewayAliasFromArgv(['--gateway=omar']), 'omar');
  assert.throws(() => gatewayAliasFromArgv([]), /exactly one/);
  assert.throws(() => gatewayAliasFromArgv(['--gateway', 'hash']), /unknown gateway alias/);
  assert.throws(
    () => gatewayAliasFromArgv(['--gateway', 'labby', '--gateway', 'omar']),
    /exactly one/,
  );
});

test('each Gateway has a fixed URL, distinct device file, and source-local approval command', () => {
  const labby = resolveGatewayTarget('labby', '/state');
  const omar = resolveGatewayTarget('omar', '/state');

  assert.equal(labby.url, 'ws://127.0.0.1:19789');
  assert.equal(labby.deviceFile, '/state/roost/openclaw-device.json');
  assert.match(approvalCommand(labby, 'request-1'), /^sudo -n -u labby /);
  assert.match(approvalCommand(labby, 'request-1'), /--profile labby devices approve request-1$/);

  assert.equal(omar.url, 'ws://127.0.0.1:19791');
  assert.equal(omar.deviceFile, '/state/roost/openclaw-omar-device.json');
  assert.match(
    approvalCommand(omar, 'request-2'),
    /^\/opt\/omar\/bin\/openclaw-omar-admin oo devices approve request-2$/,
  );
  assert.notEqual(labby.deviceFile, omar.deviceFile);
});

test('approval command refuses an unsafe request id', () => {
  const target = resolveGatewayTarget('omar', '/state');
  assert.throws(() => approvalCommand(target, 'id; echo nope'), /unsafe pairing request id/);
});

test('gateway alias lists default to the provided fallback', () => {
  assert.deepEqual(parseGatewayAliases(undefined, ['labby']), ['labby']);
  assert.deepEqual(parseGatewayAliases('', ['labby']), ['labby']);
});

test('gateway alias lists preserve the given order and trim whitespace', () => {
  assert.deepEqual(parseGatewayAliases(' omar, labby ', ['labby']), ['omar', 'labby']);
});

test('gateway alias lists accept both known aliases', () => {
  assert.deepEqual(parseGatewayAliases('labby,omar', ['labby']), ['labby', 'omar']);
});

test('gateway alias lists reject an unknown alias', () => {
  assert.throws(() => parseGatewayAliases('labby,hash', ['labby']), /unknown gateway alias/);
});

test('gateway alias lists reject a duplicate alias', () => {
  assert.throws(() => parseGatewayAliases('labby, omar, labby', ['labby']), /duplicate gateway alias/);
});
