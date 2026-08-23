import crypto from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { pairDevice } from '../daemon/openclaw/pairing.js';

// A stand-in for GatewayClient. Matches its real surface: constructed with an
// options object carrying the callbacks, then driven by start()/stop().
function fakeClientFactory(script) {
  const calls = { options: null, started: 0, stopped: 0 };
  const factory = (options) => {
    calls.options = options;
    return {
      start() { calls.started += 1; queueMicrotask(() => script(options, calls)); },
      stop() { calls.stopped += 1; },
    };
  };
  return { factory, calls };
}

const identity = { deviceId: 'dev-1', privateKeyPem: 'priv', publicKeyPem: 'pub' };
const base = { url: 'ws://127.0.0.1:19789', gatewayToken: 'shared-token', deviceIdentity: identity };

const pairingRequiredError = (requestId) => Object.assign(new Error('pairing required'), {
  code: 'PAIRING_REQUIRED',
  details: { requestId, recommendedNextStep: 'wait_then_retry', retryable: true },
});

test('resolves with the device token the gateway mints', async () => {
  const { factory } = fakeClientFactory((o) =>
    o.onHelloOk({ auth: { deviceToken: 'dev-token', role: 'operator', scopes: ['operator.read'] } }));

  const result = await pairDevice({ ...base, createClient: factory });
  assert.equal(result.deviceToken, 'dev-token');
  assert.deepEqual(result.scopes, ['operator.read']);
});

test('reports the pairing request id and keeps waiting, because approval is out-of-band', async () => {
  const seen = [];
  const { factory } = fakeClientFactory((o) => {
    if (seen.length === 0) {
      o.onConnectError(pairingRequiredError('req-42'));
      // The real client keeps reconnecting; approval then lets hello-ok through.
      queueMicrotask(() => o.onHelloOk({ auth: { deviceToken: 'after-approval', scopes: ['operator.read'] } }));
    }
  });

  const result = await pairDevice({
    ...base, createClient: factory,
    onPairingRequired: (id) => seen.push(id),
  });

  assert.deepEqual(seen, ['req-42'], 'the request id must reach the human who approves it');
  assert.equal(result.deviceToken, 'after-approval');
});

test('asks for operator.read only, because M1 is a read-only presence panel', async () => {
  const { factory, calls } = fakeClientFactory((o) =>
    o.onHelloOk({ auth: { deviceToken: 't', scopes: ['operator.read'] } }));

  await pairDevice({ ...base, createClient: factory });
  assert.deepEqual(calls.options.scopes, ['operator.read']);
  assert.equal(calls.options.role, 'operator');
});

test('rejects a hello-ok with no device token, because roost would silently keep using the bootstrap credential', async () => {
  const { factory } = fakeClientFactory((o) =>
    o.onHelloOk({ auth: { role: 'operator', scopes: ['operator.read'] } }));

  await assert.rejects(
    () => pairDevice({ ...base, createClient: factory }),
    /device token/i,
  );
});

test('stops the client once pairing completes, so a one-shot run leaves no open socket', async () => {
  const { factory, calls } = fakeClientFactory((o) =>
    o.onHelloOk({ auth: { deviceToken: 't', scopes: ['operator.read'] } }));

  await pairDevice({ ...base, createClient: factory });
  assert.equal(calls.stopped, 1);
});

test('supplies working device signing deps, without which the real client refuses to connect', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const { factory, calls } = fakeClientFactory((o) =>
    o.onHelloOk({ auth: { deviceToken: 't', scopes: ['operator.read'] } }));

  await pairDevice({
    ...base, createClient: factory,
    deviceIdentity: { deviceId: 'd', privateKeyPem: privateKey, publicKeyPem: publicKey },
  });

  const deps = calls.options.hostDeps;
  assert.equal(typeof deps?.signDevicePayload, 'function', 'GatewayClient throws without this');
  assert.equal(typeof deps?.publicKeyRawBase64UrlFromPem, 'function');

  // Behavioural, not just present: the gateway verifies these for real.
  const sig = Buffer.from(deps.signDevicePayload(privateKey, 'payload'), 'base64url');
  assert.ok(crypto.verify(null, Buffer.from('payload', 'utf8'), crypto.createPublicKey(publicKey), sig));
  assert.equal(Buffer.from(deps.publicKeyRawBase64UrlFromPem(publicKey), 'base64url').length, 32);
});

test('identifies with an id and mode the gateway registry actually allows', async () => {
  const { GATEWAY_CLIENT_IDS, GATEWAY_CLIENT_MODES } = await import('@openclaw/gateway-protocol/client-info');
  const { factory, calls } = fakeClientFactory((o) =>
    o.onHelloOk({ auth: { deviceToken: 't', scopes: ['operator.read'] } }));

  await pairDevice({ ...base, createClient: factory });

  assert.ok(Object.values(GATEWAY_CLIENT_IDS).includes(calls.options.clientName),
    `client id ${calls.options.clientName} is not in the gateway's registry`);
  assert.ok(Object.values(GATEWAY_CLIENT_MODES).includes(calls.options.mode),
    `client mode ${calls.options.mode} is not in the gateway's registry`);
});

test('does not claim the trusted backend identity, which would bypass pairing entirely', async () => {
  const { factory, calls } = fakeClientFactory((o) =>
    o.onHelloOk({ auth: { deviceToken: 't', scopes: ['operator.read'] } }));

  await pairDevice({ ...base, createClient: factory });

  // protocol.md: client.id "gateway-client" WITH mode "backend" may omit the
  // device identity on loopback. That path is reserved for internal
  // control-plane RPCs; roost is a third-party operator client and pairs.
  const bypass = calls.options.clientName === 'gateway-client' && calls.options.mode === 'backend';
  assert.equal(bypass, false, 'roost must go through normal device pairing');
});

test('labels itself roost, so the human approving the pairing knows what it is', async () => {
  const { factory, calls } = fakeClientFactory((o) =>
    o.onHelloOk({ auth: { deviceToken: 't', scopes: ['operator.read'] } }));

  await pairDevice({ ...base, createClient: factory });
  assert.match(calls.options.clientDisplayName, /roost/i);
});

test('sends the shared gateway token as `token`, because `bootstrapToken` means a setup code', async () => {
  const { factory, calls } = fakeClientFactory((o) =>
    o.onHelloOk({ auth: { deviceToken: 't', scopes: ['operator.read'] } }));

  await pairDevice({ ...base, createClient: factory });

  // The gateway rejects the shared token in bootstrapToken with
  // "bootstrap token invalid or expired (scan a fresh setup code)": that field
  // is for the qr/setup-code handoff, which is a different credential.
  assert.equal(calls.options.token, 'shared-token');
  assert.equal(calls.options.bootstrapToken, undefined);
});
