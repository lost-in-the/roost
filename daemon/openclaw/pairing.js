/**
 * One-shot device pairing against the OpenClaw gateway.
 *
 * The flow is the one documented in the installed openclaw package,
 * docs/gateway/clients.md, "Choose scopes and pair the device":
 *
 *   1. connect with the Ed25519 device identity + the SHARED gateway token
 *      (bootstrap auth only)
 *   2. the gateway answers PAIRING_REQUIRED with a request id
 *   3. a human runs `openclaw devices approve <requestId>` on the host
 *   4. the client reconnects and hello-ok carries auth.deviceToken
 *
 * Step 2 is retryable by design: the protocol spec says to keep reconnecting
 * with the same bootstrap token until the request is approved. The real
 * GatewayClient reconnects on its own, so this waits rather than giving up,
 * and reports the request id exactly once per distinct id so the caller can
 * tell the human what to approve.
 *
 * The shared gateway token is used ONCE, here. Everything afterwards uses the minted
 * device token, which is scoped and independently revocable.
 */

import { deviceSigningDeps } from './ed25519.js';

const READ_ONLY_SCOPES = ['operator.read'];

export function pairDevice({
  createClient,
  url,
  gatewayToken,
  deviceIdentity,
  scopes = READ_ONLY_SCOPES,
  clientVersion = '1.0.0',
  onPairingRequired = () => {},
}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const reported = new Set();

    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      try { client.stop(); } catch { /* stopping is best-effort */ }
      fn(arg);
    };

    const client = createClient({
      url,
      // The SHARED gateway token, used once for bootstrap authentication.
      // Not `bootstrapToken`: that field carries a qr/setup-code, a different
      // credential the gateway rejects this one as.
      token: gatewayToken,
      deviceIdentity,
      role: 'operator',
      scopes,
      // `client.id` and `client.mode` are CLOSED registries the gateway
      // schema-validates; "roost" is rejected outright. `gateway-client` is
      // the id for third-party clients built on @openclaw/gateway-client.
      //
      // Mode is deliberately NOT "backend": per protocol.md, id
      // `gateway-client` together with mode `backend` is the trusted
      // same-process path that may skip device pairing on loopback, and it is
      // reserved for internal control-plane RPCs. roost is a third-party
      // operator client and goes through real pairing. The human-facing name
      // rides on clientDisplayName instead.
      clientName: 'gateway-client',
      clientDisplayName: 'roost',
      clientVersion,
      mode: 'cli',
      hostDeps: deviceSigningDeps,

      onHelloOk: (hello) => {
        const deviceToken = hello?.auth?.deviceToken;
        if (!deviceToken) {
          // Authenticating on the bootstrap token alone would appear to work
          // and then break the moment that shared token is rotated. Fail loudly.
          finish(reject, new Error(
            'gateway accepted the connection but issued no device token; ' +
            'roost will not run on the shared bootstrap credential'));
          return;
        }
        finish(resolve, { deviceToken, scopes: hello.auth.scopes ?? scopes });
      },

      onConnectError: (err) => {
        if (err?.code === 'PAIRING_REQUIRED') {
          const requestId = err?.details?.requestId;
          // Retryable: the client keeps reconnecting until someone approves.
          if (requestId && !reported.has(requestId)) {
            reported.add(requestId);
            onPairingRequired(requestId);
          }
          return;
        }
        finish(reject, err);
      },
    });

    client.start();
  });
}
