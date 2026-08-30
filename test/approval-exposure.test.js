import test from 'node:test';
import assert from 'node:assert/strict';
import {
  APPROVALS_SCOPE,
  assertGatewayApprovalsNotExposed,
  isLoopbackHost,
  holdsApprovalsScope,
  approvalExposureError,
  assertApprovalsNotExposed,
} from '../daemon/approval-exposure.js';

const READ = ['operator.read'];
const APPROVALS = ['operator.read', APPROVALS_SCOPE];

// ── Loopback classification ──────────────────────────────────────────────────

test('the documented loopback spellings are all recognised', () => {
  for (const h of ['127.0.0.1', 'localhost', 'LOCALHOST', '::1', '[::1]', ' 127.0.0.1 ']) {
    assert.equal(isLoopbackHost(h), true, `${JSON.stringify(h)} should be loopback`);
  }
});

test('the whole 127.0.0.0/8 block is loopback, not just 127.0.0.1', () => {
  // A second loopback address is a legitimate way to separate services on one
  // host. Rejecting it would push someone toward 0.0.0.0 to get unstuck, which
  // is the exact outcome this guard exists to prevent.
  for (const h of ['127.0.0.2', '127.1.2.3', '127.255.255.254']) {
    assert.equal(isLoopbackHost(h), true, `${h} is inside 127.0.0.0/8`);
  }
});

test('an ipv4-mapped ipv6 loopback address is loopback', () => {
  assert.equal(isLoopbackHost('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackHost('::ffff:10.0.0.5'), false, 'the mapping does not make it local');
});

test('the wildcard binds are NOT loopback, which is the whole point', () => {
  for (const h of ['0.0.0.0', '::', '[::]']) {
    assert.equal(isLoopbackHost(h), false, `${h} binds every interface`);
  }
});

test('an absent or empty host is treated as exposed, because node binds everything', () => {
  // `server.listen(port, undefined)` listens on all interfaces. Reading a
  // missing value as "probably local" would be the one wrong guess to make.
  for (const h of [undefined, null, '', '   ']) {
    assert.equal(isLoopbackHost(h), false);
  }
});

test('a routable address is not loopback', () => {
  for (const h of ['198.51.100.9', '10.0.0.5', 'roost.local', '203.0.113.7']) {
    assert.equal(isLoopbackHost(h), false);
  }
});

test('an address that merely starts with 127 is not loopback', () => {
  // Guards against a `startsWith('127')` shortcut: this is a public address.
  assert.equal(isLoopbackHost('127.0.0.1.example.com'), false);
  assert.equal(isLoopbackHost('1270.0.0.1'), false);
  assert.equal(isLoopbackHost('12.7.0.1'), false);
});

test('an out-of-range octet is not a valid address and so is not loopback', () => {
  assert.equal(isLoopbackHost('127.0.0.999'), false);
});

// ── Scope detection ──────────────────────────────────────────────────────────

test('the read-only scope carries no approval authority', () => {
  assert.equal(holdsApprovalsScope(READ), false);
});

test('the approvals scope is detected', () => {
  assert.equal(holdsApprovalsScope(APPROVALS), true);
});

test('operator.admin carries approval authority, since it satisfies every operator scope', () => {
  // The most privileged token must not be the one that slips past the guard.
  assert.equal(holdsApprovalsScope(['operator.admin']), true);
});

test('operator.write does NOT imply approvals', () => {
  // operator-scopes.md: unknown future operator.* scopes need an exact match.
  // Treating write as approvals here would fire the guard on a daemon that has
  // no approval authority at all.
  assert.equal(holdsApprovalsScope(['operator.write']), false);
});

test('a missing scope list is not authority', () => {
  assert.equal(holdsApprovalsScope(undefined), false);
  assert.equal(holdsApprovalsScope([]), false);
});

// ── The combination the guard actually cares about ───────────────────────────

test('approvals on a loopback bind is the supported configuration', () => {
  assert.equal(approvalExposureError({ host: '127.0.0.1', scopes: APPROVALS }), null);
});

test('an exposed bind WITHOUT the scope is allowed, since there is no authority to protect', () => {
  // The HTTP server serves the renderer and a tap counter. Exposing that is a
  // choice someone may legitimately make; it only becomes a security question
  // once approval authority sits behind it.
  assert.equal(approvalExposureError({ host: '0.0.0.0', scopes: READ }), null);
});

test('approvals on an exposed bind is refused', () => {
  const problem = approvalExposureError({ host: '0.0.0.0', scopes: APPROVALS });
  assert.ok(problem, 'the dangerous combination must be reported');
});

test('the refusal names both ways out, not just one', () => {
  // Naming only the bind fix would push someone holding the scope for a reason
  // toward giving up the guard instead of giving up the scope.
  const problem = approvalExposureError({ host: '198.51.100.9', scopes: APPROVALS });
  assert.match(problem, /ROOST_HTTP_HOST/, 'names the variable to change');
  assert.match(problem, /127\.0\.0\.1/, 'names the safe value');
  assert.match(problem, /revoke/, 'names the source-side revocation step');
  assert.match(problem, /delete/, 'names the local credential deletion step');
  assert.match(problem, /re-pair/, 'names the way to mint a reduced-scope identity');
});

test('the refusal quotes the offending host, so the message is actionable', () => {
  assert.match(approvalExposureError({ host: '198.51.100.9', scopes: APPROVALS }), /198\.51\.100\.9/);
});

test('operator.admin on an exposed bind is refused too', () => {
  assert.ok(approvalExposureError({ host: '0.0.0.0', scopes: ['operator.admin'] }));
});

test('an empty host with the scope is refused, since that binds every interface', () => {
  assert.ok(approvalExposureError({ host: '', scopes: APPROVALS }));
  assert.ok(approvalExposureError({ host: undefined, scopes: APPROVALS }));
});

// ── The assertion form the daemon calls ──────────────────────────────────────

test('the assertion throws on the dangerous combination and is silent otherwise', () => {
  assert.throws(
    () => assertApprovalsNotExposed({ host: '0.0.0.0', scopes: APPROVALS }),
    /operator\.approvals/,
  );
  assert.doesNotThrow(() => assertApprovalsNotExposed({ host: '127.0.0.1', scopes: APPROVALS }));
  assert.doesNotThrow(() => assertApprovalsNotExposed({ host: '0.0.0.0', scopes: READ }));
});

test('the multi-gateway assertion checks every configured device file, not just the first', () => {
  const seen = [];
  assert.throws(() => assertGatewayApprovalsNotExposed({
    host: '0.0.0.0',
    deviceFiles: ['/tmp/labby.json', '/tmp/omar.json'],
    readDeviceTokenFn(file) {
      seen.push(file);
      return file.endsWith('labby.json') ? { scopes: READ } : { scopes: APPROVALS };
    },
  }), /operator\.approvals/);
  assert.deepEqual(seen, ['/tmp/labby.json', '/tmp/omar.json']);
});
