import { join } from 'node:path';

const TARGETS = Object.freeze({
  labby: Object.freeze({
    alias: 'labby',
    url: 'ws://127.0.0.1:19789',
    deviceFileName: 'openclaw-device.json',
    approvalPrefix: [
      'sudo', '-n', '-u', 'labby', 'env',
      'HOME=/var/lib/labby',
      'PATH=/opt/labby/runtime/node_modules/.bin:/usr/bin',
      'node', '/opt/labby/runtime/node_modules/openclaw/openclaw.mjs',
      '--profile', 'labby', 'devices', 'approve',
    ],
  }),
  omar: Object.freeze({
    alias: 'omar',
    url: 'ws://127.0.0.1:19791',
    deviceFileName: 'openclaw-omar-device.json',
    approvalPrefix: ['/opt/omar/bin/openclaw-omar-admin', 'oo', 'devices', 'approve'],
  }),
});

export const GATEWAY_ALIASES = Object.freeze(Object.keys(TARGETS));

export function gatewayAliasFromArgv(argv) {
  const values = [];
  for (let index = 0; index < (argv ?? []).length; index += 1) {
    const arg = String(argv[index]);
    if (arg === '--gateway') {
      values.push(argv[index + 1]);
      index += 1;
    } else if (arg.startsWith('--gateway=')) {
      values.push(arg.slice('--gateway='.length));
    }
  }
  if (values.length !== 1 || !values[0]) {
    throw new Error('exactly one --gateway labby|omar is required');
  }
  if (!Object.hasOwn(TARGETS, values[0])) {
    throw new Error(`unknown gateway alias: ${values[0]}`);
  }
  return values[0];
}

export function parseGatewayAliases(value, fallback = ['labby']) {
  if (value === undefined || value === '') return [...fallback];
  const aliases = String(value)
    .split(',')
    .map((alias) => alias.trim())
    .filter(Boolean);
  if (aliases.length === 0) return [...fallback];

  const seen = new Set();
  for (const alias of aliases) {
    if (!Object.hasOwn(TARGETS, alias)) throw new Error(`unknown gateway alias: ${alias}`);
    if (seen.has(alias)) throw new Error(`duplicate gateway alias: ${alias}`);
    seen.add(alias);
  }
  return aliases;
}

export function resolveGatewayTarget(alias, stateHome) {
  if (!Object.hasOwn(TARGETS, alias)) throw new Error(`unknown gateway alias: ${alias}`);
  const target = TARGETS[alias];
  return {
    ...target,
    deviceFile: join(stateHome, 'roost', target.deviceFileName),
  };
}

export function approvalCommand(target, requestId) {
  if (!/^[A-Za-z0-9._:-]+$/.test(String(requestId))) {
    throw new Error('gateway returned an unsafe pairing request id');
  }
  return [...target.approvalPrefix, String(requestId)].join(' ');
}
