import { readDeviceToken } from './openclaw/device-identity.js';
import { satisfies } from './openclaw/scopes.js';

/**
 * The guard that must exist before roost is granted `operator.approvals`.
 *
 * WHY THIS IS NOT OPTIONAL
 * On OpenClaw 2026.7.2-beta.7, an approval record with no explicit reviewer
 * device list is answerable by ANY paired device holding `operator.approvals`,
 * not only by the device that raised it. Traced statically end to end in the
 * installed package: `canAccessOperatorApproval` returns true unconditionally
 * when `reviewerDeviceIds` is empty, and `loadVisibleApproval` — the single gate
 * for both reading and resolving — is never passed the requesting device at all,
 * so no requester match can exist anywhere on that path.
 *
 * So the scope is not "roost may answer roost's approvals". It is "roost may
 * answer EVERY pending approval on the gateway", including a production deploy
 * raised by some other agent.
 *
 * The daemon's HTTP server has no authentication of any kind — it serves the
 * renderer and accepts laptop-open taps, both of which are harmless to anyone
 * who can already reach the machine. Once the approvals scope is held, that same
 * unauthenticated server is the ONLY thing standing in front of gateway-wide
 * approval authority. Bound off-loopback, answering an approval becomes an
 * unauthenticated HTTP request from anywhere on the network.
 *
 * WHY THE CHECK IS THE COMBINATION, NOT THE ROUTE
 * The obvious shape is "refuse to serve the approval route when the bind is
 * exposed". That guard cannot be written yet — M2's route does not exist — and
 * worse, it would be a guard someone has to remember to attach. Refusing at
 * STARTUP on scope-plus-bind needs no route, fires the moment the scope is
 * granted, and cannot be forgotten by whoever eventually writes the route.
 *
 * Fail closed: anything not positively recognised as loopback is treated as
 * exposed.
 */

export const APPROVALS_SCOPE = 'operator.approvals';

/** IPv4 dotted-quad inside 127.0.0.0/8, the whole loopback block. */
function isLoopbackIpv4(host) {
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  if (!parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)) return false;
  return parts[0] === '127';
}

/**
 * Whether the daemon bound somewhere only this machine can reach.
 *
 * `0.0.0.0` and `::` are the wildcards that matter most here and both fall
 * through to `false`, which is the entire point of the guard.
 *
 * `localhost` is accepted because `.env.example` documents it and `config.js`
 * already treats it as loopback. It is a name, so a rewritten hosts file could
 * in principle point it elsewhere — an attacker who can edit `/etc/hosts`
 * already owns the machine, so that is not the threat this guard addresses.
 */
export function isLoopbackHost(host) {
  const h = String(host ?? '').trim().toLowerCase();
  if (!h) return false;                      // Node binds every interface on an empty host
  if (h === 'localhost') return true;
  // Node accepts a bracketed IPv6 literal in some places and a bare one in
  // others; normalise so both spellings classify the same.
  const bare = h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
  if (bare === '::1') return true;
  // IPv4-mapped IPv6, e.g. ::ffff:127.0.0.1
  if (bare.startsWith('::ffff:')) return isLoopbackIpv4(bare.slice('::ffff:'.length));
  return isLoopbackIpv4(bare);
}

/**
 * Whether these scopes carry approval authority.
 *
 * Uses the documented satisfaction rules rather than a bare `includes`, so
 * `operator.admin` — which "satisfies every operator.* scope" — is caught too.
 * Missing that would let the single most privileged token skip the guard.
 */
export function holdsApprovalsScope(scopes) {
  return satisfies(scopes ?? [], APPROVALS_SCOPE);
}

/**
 * The reason this configuration must not start, or `null` if it is safe.
 *
 * Returned rather than thrown so the decision is testable without catching, and
 * so the caller owns how loudly it fails.
 */
export function approvalExposureError({ host, scopes }) {
  if (!holdsApprovalsScope(scopes)) return null;
  if (isLoopbackHost(host)) return null;

  return (
    `roost holds ${APPROVALS_SCOPE} but ROOST_HTTP_HOST is ${JSON.stringify(host ?? '')}, ` +
    'which is not loopback.\n' +
    'An approval with no explicit reviewer device list is answerable by any paired device ' +
    `holding ${APPROVALS_SCOPE}, so this token can answer EVERY pending approval on the ` +
    'gateway. The daemon\'s HTTP server has no authentication and would be the only thing ' +
    'in front of that.\n' +
    'Fix it either way round:\n' +
    '  - bind to loopback: unset ROOST_HTTP_HOST, or set it to 127.0.0.1\n' +
    '  - or drop the scope: revoke this identity through its source Gateway, delete its device file, and re-pair with operator.read; see README "Connecting to OpenClaw"'
  );
}

/** `approvalExposureError`, as the startup assertion the daemon actually calls. */
export function assertApprovalsNotExposed({ host, scopes }) {
  const problem = approvalExposureError({ host, scopes });
  if (problem) throw new Error(problem);
}

export function assertGatewayApprovalsNotExposed({
  host,
  deviceFiles,
  readDeviceTokenFn = readDeviceToken,
}) {
  for (const deviceFile of deviceFiles ?? []) {
    const stored = readDeviceTokenFn(deviceFile);
    assertApprovalsNotExposed({ host, scopes: stored?.scopes ?? [] });
  }
}
