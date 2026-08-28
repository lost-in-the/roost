/**
 * One-shot device pairing against the OpenClaw gateway.
 *
 * Connect with the Ed25519 identity and shared Gateway token. The Gateway may
 * return `hello-ok` with a device token immediately, as both pinned local
 * Gateways did on 2026-08-27. If it instead returns `PAIRING_REQUIRED`, report
 * the request id and keep reconnecting until the source-local approval occurs.
 *
 * The shared gateway token is used ONCE, here. Everything afterwards uses the minted
 * device token, which is scoped and independently revocable.
 *
 * This flow also performs a scope upgrade. On 2026-08-27 the pinned local
 * Gateways auto-approved both an existing Labby identity's wider scopes and a
 * fresh Omar identity when authenticated with the shared Gateway token. Keep
 * the PAIRING_REQUIRED retry path for endpoints that require it, but do not
 * assume a human approval is guaranteed. Reusing the identity is what makes it
 * an upgrade rather than a second device: a new keypair would orphan the
 * approved pairing and leave a stale entry behind on the gateway.
 */

import { deviceSigningDeps } from './ed25519.js';
import { READ_ONLY_SCOPES } from './scopes.js';

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
