import test from 'node:test';
import assert from 'node:assert/strict';
import mqtt from 'mqtt';
import { aggregate } from '../daemon/aggregate.js';
import { StatePublisher } from '../daemon/publisher.js';
import { OpenClawStateSource } from '../daemon/sources/openclaw.js';
import { MultiGatewaySource } from '../daemon/sources/coordinator.js';
import {
  canSubmit,
  outcomeMessage,
  promptView,
  readDecisionResponse,
  reducePhase,
} from '../renderer/components/approval-controls.js';
import { readQueue } from '../renderer/components/laptop-counter.js';
import { startBroker, waitFor as waitForBroker } from './helpers/broker.js';
import { fakeGateway, settle } from './helpers/openclaw-gateway.js';
import { requestOverSocket, withServer } from './helpers/http.js';

const NOW = Date.parse('2026-08-30T18:00:00Z');
const STALE_MS = 30_000;
const FUTURE_MS = () => Date.now() + 5 * 60_000;

function session(key, { active = true, lastActivityAt = NOW } = {}) {
  return {
    key,
    displayName: key,
    hasActiveRun: active,
    archived: false,
    lastActivityAt,
  };
}

function approval(id, over = {}) {
  return {
    id,
    status: 'pending',
    expiresAtMs: FUTURE_MS(),
    presentation: {
      kind: 'plugin',
      allowedDecisions: ['allow-once', 'deny'],
      title: `Approve ${id}?`,
      metadata: { reversible: true },
    },
    ...over,
  };
}

function createSource(gateway, overrides = {}) {
  return new OpenClawStateSource({
    createClient: gateway.create,
    url: 'ws://example.invalid',
    deviceToken: 'tok',
    deviceIdentity: { deviceId: 'd', privateKeyPem: 'p', publicKeyPem: 'q' },
    debounceMs: 0,
    trailingSnapshotMs: 100_000,
    reconcileMs: 100_000,
    ...overrides,
  });
}

async function startStack({
  labbyGateway,
  omarGateway,
  onLog = () => {},
  rendererConfig = { wsUrl: 'ws://broker.example:8083/mqtt', topic: 'roost/agents/state', staleMs: STALE_MS, username: 'panel', password: 'pw' },
} = {}) {
  const labby = createSource(labbyGateway);
  const omar = createSource(omarGateway);
  const coordinator = new MultiGatewaySource([
    { alias: 'labby', source: labby },
    { alias: 'omar', source: omar },
  ]);
  const snapshots = [];
  coordinator.on('agents', (agents) => snapshots.push(agents));
  coordinator.start();
  labbyGateway.state.options.onHelloOk({ auth: {} });
  omarGateway.state.options.onHelloOk({ auth: {} });
  await waitFor(() => snapshots.length > 0);
  labbyGateway.state.options.onEvent({ event: 'sessions.changed', payload: {} });
  omarGateway.state.options.onEvent({ event: 'sessions.changed', payload: {} });
  await waitFor(() => snapshots.length > 2);

  const latestAgents = () => snapshots.at(-1) ?? [];
  const latestPayload = (now = NOW) => aggregate(latestAgents(), { now });
  const stop = async () => coordinator.stop();

  const withHttp = async (fn, options = {}) => withServer(fn, {
    rendererConfig,
    resolveApproval: coordinator.resolveApproval.bind(coordinator),
    onLog,
    ...options,
  });

  return {
    coordinator,
    labby,
    omar,
    snapshots,
    latestAgents,
    latestPayload,
    stop,
    withHttp,
  };
}

async function waitFor(predicate, { attempts = 20 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await settle();
  }
  throw new Error('timed out waiting for integration state');
}

function rendererSnapshot(payload, over = {}) {
  return {
    prompt: payload.prompt,
    label: payload.label ?? '',
    state: payload.state,
    stale: false,
    ...over,
  };
}

const STATE_TOPIC = 'roost/agents/state';

async function receiveRetainedMessage(url, topic, { timeoutMs = 2_000 } = {}) {
  const sub = mqtt.connect(url);
  try {
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        settleMessage(reject, new Error(`timed out waiting ${timeoutMs}ms for retained MQTT message on ${topic}`));
      }, timeoutMs);

      const settleMessage = (fn, value) => {
        clearTimeout(timeout);
        sub.removeListener('error', onError);
        sub.removeListener('connect', onConnect);
        sub.removeListener('message', onMessage);
        fn(value);
      };
      const onError = (err) => settleMessage(reject, err);
      const onConnect = () => {
        sub.subscribe(topic, { qos: 1 }, (err) => {
          if (err) settleMessage(reject, err);
        });
      };
      const onMessage = (_topic, message) => settleMessage(resolve, message.toString('utf8'));

      sub.once('error', onError);
      sub.on('connect', onConnect);
      sub.on('message', onMessage);
    });
  } finally {
    sub.end(true);
  }
}

function assertNoLeak(lines, needles, why) {
  assert.ok(lines.length > 0, why);
  for (const line of lines) {
    for (const needle of needles) assert.equal(line.includes(needle), false);
  }
}

test('approval integration: each gateway independently qualifies ids and routes approval.resolve only to its owner', async () => {
  const labbyGateway = fakeGateway({
    sessions: [session('labby-session')],
    onRequest(method) {
      if (method === 'sessions.messages.subscribe') {
        return Promise.resolve({ approvalReplay: { approvals: [approval('labby-1')], truncated: false } });
      }
      if (method === 'approval.resolve') {
        return Promise.resolve({
          applied: true,
          approval: {
            id: 'labby-1',
            status: 'denied',
            decision: 'deny',
            resolvedAtMs: Date.now(),
            presentation: { kind: 'plugin', allowedDecisions: ['allow-once', 'deny'] },
          },
        });
      }
      return undefined;
    },
  });
  const omarGateway = fakeGateway({ sessions: [session('omar-session')] });
  const stack = await startStack({ labbyGateway, omarGateway });

  try {
    const payload = stack.latestPayload();
    assert.equal(payload.prompt?.id, 'labby:labby-1');

    await stack.withHttp(async ({ fetchJson }) => {
      const res = await fetchJson('/api/approval', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'labby:labby-1', decision: 'deny' }),
      });
      assert.equal(res.status, 200);
      assert.deepEqual(res.json, { ok: true, id: 'labby:labby-1', decision: 'deny', status: 'denied' });
    }, {
      resolveApproval: async (id, decision) => stack.coordinator.resolveApproval(id, decision),
    });

    assert.equal(labbyGateway.state.requests.filter((m) => m === 'approval.resolve').length, 1);
    assert.equal(omarGateway.state.requests.filter((m) => m === 'approval.resolve').length, 0);

    const labbyResolve = labbyGateway.state.requestParams.find((entry) => entry.method === 'approval.resolve');
    assert.deepEqual(labbyResolve?.params, { id: 'labby-1', kind: 'plugin', decision: 'deny' });
  } finally {
    await stack.stop();
  }

  const labbyGateway2 = fakeGateway({ sessions: [session('labby-session')] });
  const omarGateway2 = fakeGateway({
    sessions: [session('omar-session')],
    onRequest(method) {
      if (method === 'sessions.messages.subscribe') {
        return Promise.resolve({ approvalReplay: { approvals: [approval('omar-1')], truncated: false } });
      }
      if (method === 'approval.resolve') {
        return Promise.resolve({
          applied: true,
          approval: {
            id: 'omar-1',
            status: 'allowed',
            decision: 'allow-once',
            resolvedAtMs: Date.now(),
            presentation: { kind: 'plugin', allowedDecisions: ['allow-once', 'deny'] },
          },
        });
      }
      return undefined;
    },
  });
  const stack2 = await startStack({ labbyGateway: labbyGateway2, omarGateway: omarGateway2 });
  try {
    const payload = stack2.latestPayload();
    assert.equal(payload.prompt?.id, 'omar:omar-1');

    await stack2.withHttp(async ({ fetchJson }) => {
      const res = await fetchJson('/api/approval', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'omar:omar-1', decision: 'allow-once' }),
      });
      assert.equal(res.status, 200);
      assert.deepEqual(res.json, { ok: true, id: 'omar:omar-1', decision: 'allow-once', status: 'allowed' });
    }, {
      resolveApproval: async (id, decision) => stack2.coordinator.resolveApproval(id, decision),
    });

    assert.equal(labbyGateway2.state.requests.filter((m) => m === 'approval.resolve').length, 0);
    assert.equal(omarGateway2.state.requests.filter((m) => m === 'approval.resolve').length, 1);
  } finally {
    await stack2.stop();
  }
});

test('approval integration: simultaneous approvals stay separately qualified and answering one leaves the other actionable', async () => {
  const labbyGateway = fakeGateway({
    sessions: [session('labby-session')],
    onRequest(method) {
      if (method === 'sessions.messages.subscribe') {
        return Promise.resolve({ approvalReplay: { approvals: [approval('labby-1')], truncated: false } });
      }
      if (method === 'approval.resolve') {
        return Promise.resolve({
          applied: true,
          approval: {
            id: 'labby-1',
            status: 'denied',
            decision: 'deny',
            resolvedAtMs: Date.now(),
            presentation: { kind: 'plugin', allowedDecisions: ['allow-once', 'deny'] },
          },
        });
      }
      return undefined;
    },
  });
  const omarGateway = fakeGateway({
    sessions: [session('omar-session')],
    onRequest(method) {
      if (method === 'sessions.messages.subscribe') {
        return Promise.resolve({ approvalReplay: { approvals: [approval('omar-1')], truncated: false } });
      }
      return undefined;
    },
  });
  const stack = await startStack({ labbyGateway, omarGateway });

  try {
    const prompts = stack.latestAgents()
      .filter((agent) => agent.prompt)
      .map((agent) => agent.prompt.id)
      .sort();
    assert.deepEqual(prompts, ['labby:labby-1', 'omar:omar-1']);

    await stack.withHttp(async ({ fetchJson }) => {
      const res = await fetchJson('/api/approval', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'labby:labby-1', decision: 'deny' }),
      });
      assert.equal(res.status, 200);
    }, {
      resolveApproval: async (id, decision) => stack.coordinator.resolveApproval(id, decision),
    });
    await settle();

    const payload = stack.latestPayload();
    assert.equal(payload.prompt?.id, 'omar:omar-1');
    const view = promptView({ ...rendererSnapshot(payload), now: NOW, phase: {} });
    assert.equal(canSubmit({ view, snapshot: rendererSnapshot(payload), decision: 'deny' }), true);
    assert.equal(labbyGateway.state.requests.filter((m) => m === 'approval.resolve').length, 1);
    assert.equal(omarGateway.state.requests.filter((m) => m === 'approval.resolve').length, 0);
  } finally {
    await stack.stop();
  }
});

test('approval integration: answering the same prompt twice is rejected by the daemon, and opposite in-flight decisions do not join', async () => {
  let resolveGateway;
  const labbyGateway = fakeGateway({
    sessions: [session('labby-session')],
    onRequest(method) {
      if (method === 'sessions.messages.subscribe') {
        return Promise.resolve({ approvalReplay: { approvals: [approval('dup-1')], truncated: false } });
      }
      if (method === 'approval.resolve') {
        return new Promise((resolve) => {
          resolveGateway = () => resolve({
            applied: true,
            approval: {
              id: 'dup-1',
              status: 'allowed',
              decision: 'allow-once',
              resolvedAtMs: NOW + 1000,
              presentation: { kind: 'plugin', allowedDecisions: ['allow-once', 'deny'] },
            },
          });
        });
      }
      return undefined;
    },
  });
  const omarGateway = fakeGateway({ sessions: [session('omar-session')] });
  const stack = await startStack({ labbyGateway, omarGateway });

  try {
    await stack.withHttp(async ({ server }) => {
      let firstFulfilled = false;
      const firstRequest = requestOverSocket({
        socketPath: server.socketPath,
        path: '/api/approval',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'labby:dup-1', decision: 'allow-once' }),
      });
      const first = firstRequest.then((res) => {
        firstFulfilled = true;
        return res;
      });

      try {
        const oppositeRequest = requestOverSocket({
          socketPath: server.socketPath,
          path: '/api/approval',
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: 'labby:dup-1', decision: 'deny' }),
        });
        const opposite = await Promise.race([oppositeRequest, first]);
        assert.equal(opposite.status, 409);
        assert.deepEqual(JSON.parse(opposite.body), {
          ok: false,
          code: 'already_answered',
          error: 'approval already answered',
        });
        assert.equal(readDecisionResponse({ ok: false, status: 409, body: JSON.parse(opposite.body) }).code, 'already_answered');

        resolveGateway();
        const firstRes = await first;
        assert.equal(firstRes.status, 200);

        const second = await requestOverSocket({
          socketPath: server.socketPath,
          path: '/api/approval',
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: 'labby:dup-1', decision: 'allow-once' }),
        });
        assert.equal(second.status, 409);
        const secondJson = JSON.parse(second.body);
        assert.deepEqual(secondJson, {
          ok: false,
          code: 'already_answered',
          error: 'approval already answered',
          status: 'allowed',
          decision: 'allow-once',
        });
        assert.equal(
          outcomeMessage(readDecisionResponse({ ok: false, status: second.status, body: secondJson })),
          'Already answered: allowed once.',
        );
      } finally {
        resolveGateway?.();
        if (!firstFulfilled) await first.catch(() => {});
      }
    }, {
      resolveApproval: async (id, decision) => stack.coordinator.resolveApproval(id, decision),
    });

    assert.equal(labbyGateway.state.requests.filter((m) => m === 'approval.resolve').length, 1);
  } finally {
    await stack.stop();
  }
});

test('approval integration: stale surfaces refuse submission, reconnect replay replaces atomically, and truncated replay keeps unseen entries non-actionable', async () => {
  let subscribeCount = 0;
  const labbyGateway = fakeGateway({
    sessions: [session('labby-session')],
    onRequest(method) {
      if (method !== 'sessions.messages.subscribe') return undefined;
      subscribeCount += 1;
      if (subscribeCount === 1) {
        return Promise.resolve({
          approvalReplay: {
            approvals: [approval('a-1'), approval('b-1', { expiresAtMs: NOW + 6 * 60_000 })],
            truncated: false,
          },
        });
      }
      if (subscribeCount === 2) {
        return Promise.resolve({
          approvalReplay: {
            approvals: [approval('c-1')],
            truncated: false,
          },
        });
      }
      return Promise.resolve({
        approvalReplay: {
          approvals: [approval('c-1')],
          truncated: true,
        },
      });
    },
  });
  const omarGateway = fakeGateway({ sessions: [session('omar-session')] });
  const stack = await startStack({ labbyGateway, omarGateway });

  try {
    const firstPayload = stack.latestPayload();
    const staleView = promptView({
      ...rendererSnapshot(firstPayload, { stale: true }),
      now: NOW + STALE_MS + 1,
      phase: {},
    });
    assert.equal(canSubmit({ view: staleView, snapshot: rendererSnapshot(firstPayload, { stale: true }), decision: 'deny' }), false);
    assert.equal(staleView.line, 'This panel cannot answer right now.');

    labbyGateway.state.options.onReconnectPaused();
    labbyGateway.state.options.onHelloOk({ auth: {} });
    await settle();
    const replacedPayload = stack.latestPayload();
    assert.equal(replacedPayload.prompt?.id, 'labby:c-1');
    assert.equal(stack.labby.approvals.findPending('a-1'), null);
    assert.equal(stack.labby.approvals.findPending('b-1'), null);

    stack.labby.approvals.upsertPending('labby-session', {
      id: 'orphan-1',
      gatewayKind: 'plugin',
      reversible: true,
      status: 'pending',
      expiresAtMs: FUTURE_MS(),
      allowedDecisions: ['allow-once', 'deny'],
      label: 'Approve orphan?',
      actionable: true,
    });
    labbyGateway.state.options.onReconnectPaused();
    labbyGateway.state.options.onHelloOk({ auth: {} });
    await settle();

    const orphan = stack.labby.approvals.findPending('orphan-1');
    assert.equal(orphan?.approval?.actionable, false);
    await assert.rejects(
      () => stack.coordinator.resolveApproval('labby:orphan-1', 'deny'),
      (err) => err?.code === 'not_actionable',
    );
  } finally {
    await stack.stop();
  }
});

test('approval integration: a terminal event from elsewhere removes the prompt and later refusal trusts the canonical terminal record', async () => {
  const labbyGateway = fakeGateway({
    sessions: [session('labby-session')],
    onRequest(method) {
      if (method !== 'sessions.messages.subscribe') return undefined;
      return Promise.resolve({ approvalReplay: { approvals: [approval('elsewhere-1')], truncated: false } });
    },
  });
  const omarGateway = fakeGateway({ sessions: [session('omar-session')] });
  const stack = await startStack({ labbyGateway, omarGateway });

  try {
    assert.equal(stack.latestPayload().prompt?.id, 'labby:elsewhere-1');

    labbyGateway.state.options.onEvent({
      event: 'session.approval',
      payload: {
        sessionKey: 'labby-session',
        phase: 'terminal',
        approval: {
          id: 'elsewhere-1',
          status: 'denied',
          decision: 'deny',
          resolvedAtMs: NOW + 1500,
          presentation: { kind: 'plugin', allowedDecisions: ['allow-once', 'deny'] },
        },
      },
    });
    await settle();

    assert.equal(stack.latestPayload().prompt, null);
    await stack.labby.resolveApproval({ id: 'elsewhere-1', decision: 'allow-once' })
      .then(
        () => assert.fail('expected already_answered after canonical terminal event'),
        (err) => {
          assert.equal(err?.code, 'already_answered');
          assert.equal(err?.status, 'denied');
          assert.equal(err?.decision, 'deny');
        },
      );

    await stack.withHttp(async ({ fetchJson }) => {
      const res = await fetchJson('/api/approval', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'labby:elsewhere-1', decision: 'allow-once' }),
      });
      assert.equal(res.status, 409);
      assert.deepEqual(res.json, {
        ok: false,
        code: 'already_answered',
        error: 'approval already answered',
        status: 'denied',
        decision: 'deny',
      });
    }, {
      resolveApproval: async (id, decision) => stack.coordinator.resolveApproval(id, decision),
    });
  } finally {
    await stack.stop();
  }
});

test('approval integration: an ambiguous transport failure freezes the prompt, returns 502 transport_uncertain, and never retries automatically', async () => {
  const labbyGateway = fakeGateway({
    sessions: [session('labby-session')],
    onRequest(method) {
      if (method === 'sessions.messages.subscribe') {
        return Promise.resolve({ approvalReplay: { approvals: [approval('uncertain-1')], truncated: false } });
      }
      if (method === 'approval.resolve') return Promise.reject(new Error('socket closed'));
      return undefined;
    },
  });
  const omarGateway = fakeGateway({ sessions: [session('omar-session')] });
  const stack = await startStack({ labbyGateway, omarGateway });

  try {
    await stack.withHttp(async ({ fetchJson }) => {
      const res = await fetchJson('/api/approval', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'labby:uncertain-1', decision: 'deny' }),
      });
      assert.equal(res.status, 502);
      assert.deepEqual(res.json, {
        ok: false,
        code: 'transport_uncertain',
        error: 'approval resolution status is uncertain',
      });
      assert.equal(
        outcomeMessage(readDecisionResponse({ ok: false, status: res.status, body: res.json })),
        'Result unknown. Check on a laptop.',
      );

      const retry = await fetchJson('/api/approval', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'labby:uncertain-1', decision: 'deny' }),
      });
      assert.equal(retry.status, 409);
      assert.equal(retry.json.code, 'not_actionable');
    }, {
      resolveApproval: async (id, decision) => stack.coordinator.resolveApproval(id, decision),
    });
    await settle();

    assert.equal(labbyGateway.state.requests.filter((m) => m === 'approval.resolve').length, 1);
    const payload = stack.latestPayload();
    const view = promptView({ ...rendererSnapshot(payload), now: NOW, phase: {} });
    assert.equal(payload.prompt?.kind, 'handoff');
    assert.equal(canSubmit({ view, snapshot: rendererSnapshot(payload), decision: 'deny' }), false);
  } finally {
    await stack.stop();
  }
});

test('approval integration: raw approval payload strings stay out of published MQTT, exercised log lines, and renderer view state, including long-label handoff cases', async () => {
  const secret = 'SECRET_TOKEN_DO_NOT_LEAK_12345';
  const detailSecret = `detail ${secret}`;
  const metadataSecret = `metadata ${secret}`;
  const longLabel = 'Approve a dangerously verbose migration summary that exceeds the sixty-four character glass cap on purpose for handoff coverage.';
  const approvableBaseExpiresAtMs = Date.now() + 5 * 60_000;
  const broker = await startBroker();
  const priorLocalStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  try {
  const publisherLogs = [];
  const httpLogs = [];
  const localStore = new Map();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
    getItem(key) {
      return localStore.has(key) ? localStore.get(key) : null;
    },
    setItem(key, value) {
      localStore.set(key, String(value));
    },
    removeItem(key) {
      localStore.delete(key);
    },
    },
  });

  async function publishRawMessage(stack, topic) {
    const publisher = new StatePublisher({
      url: broker.url,
      topic,
      heartbeatMs: 50_000,
      buildPayload: () => stack.latestPayload(),
    });
    publisher.onLog = (line) => publisherLogs.push(line);
    try {
      const received = receiveRetainedMessage(broker.url, topic);
      publisher.start();
      await waitForBroker(() => publisher.connected);
      publisher.touch();
      await waitForBroker(() => publisher.publishCount > 0);
      return await received;
    } finally {
      publisher.stop();
    }
  }

  const approvableGateway = fakeGateway({
    sessions: [session('labby-session')],
    onRequest(method, params) {
      if (method === 'sessions.messages.subscribe') {
        return Promise.resolve({
          approvalReplay: {
            approvals: [approval('secret-1', {
              expiresAtMs: approvableBaseExpiresAtMs,
              presentation: {
                kind: 'plugin',
                allowedDecisions: ['allow-once', 'deny'],
                title: 'Approve release window?',
                detail: detailSecret,
                metadata: { reversible: true, note: metadataSecret },
              },
            }), approval('fail-1', {
              expiresAtMs: approvableBaseExpiresAtMs + 1,
            })],
            truncated: false,
          },
        });
      }
      if (method === 'approval.resolve') {
        if (params?.id === 'secret-1') {
          return Promise.resolve({
            applied: true,
            approval: {
              id: 'secret-1',
              status: 'allowed',
              decision: 'allow-once',
              resolvedAtMs: NOW + 500,
              presentation: { kind: 'plugin', allowedDecisions: ['allow-once', 'deny'] },
            },
          });
        }
        if (params?.id === 'fail-1') {
          return Promise.reject(new Error(`transport dropped ${secret}`));
        }
      }
      return undefined;
    },
  });
  const approvableStack = await startStack({
    labbyGateway: approvableGateway,
    omarGateway: fakeGateway({ sessions: [session('omar-session')] }),
    onLog: (line) => httpLogs.push(line),
  });

  try {
    const rawPublished = await publishRawMessage(approvableStack, `${STATE_TOPIC}/approvable`);
    assert.equal(rawPublished.includes(secret), false);
    assert.equal(rawPublished.includes(longLabel), false);

    const payload = approvableStack.latestPayload();
    assert.equal(payload.prompt?.kind, 'approve_reject');
    assert.equal(payload.prompt?.id, 'labby:secret-1');

    const approvableSnapshot = rendererSnapshot(payload);
    const approvableView = promptView({ ...approvableSnapshot, now: NOW, phase: {} });
    const approvableVisibleStrings = [
      approvableSnapshot.label,
      approvableView.line,
      approvableView.message,
      ...approvableView.buttons.flatMap((button) => [button.text, button.ariaLabel]),
      outcomeMessage({ ok: true, code: 'ok' }),
    ].filter((value) => typeof value === 'string' && value.length > 0);
    assert.ok(approvableVisibleStrings.length > 0, 'Approvable renderer view assertion is vacuous if no visible strings were produced.');
    for (const text of approvableVisibleStrings) {
      assert.equal(text.includes(secret), false);
      assert.equal(text.includes(longLabel), false);
    }

    await approvableStack.withHttp(async ({ fetchJson }) => {
      const okRes = await fetchJson('/api/approval', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'labby:secret-1', decision: 'allow-once' }),
      });
      assert.equal(okRes.status, 200);

      const failRes = await fetchJson('/api/approval', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'labby:fail-1', decision: 'deny' }),
      });
      assert.equal(failRes.status, 502);
      assert.equal(failRes.json.code, 'transport_uncertain');
    });
    assert.deepEqual(readQueue(), []);
  } finally {
    await approvableStack.stop();
  }

  const handoffGateway = fakeGateway({
    sessions: [session('labby-session')],
    onRequest(method) {
      if (method !== 'sessions.messages.subscribe') return undefined;
      return Promise.resolve({
        approvalReplay: {
          approvals: [approval('handoff-1', {
            presentation: {
              kind: 'plugin',
              allowedDecisions: ['allow-once', 'deny'],
              title: longLabel,
              detail: `detail ${secret}`,
              metadata: { reversible: true },
            },
          })],
          truncated: false,
        },
      });
    },
  });
  const handoffStack = await startStack({
    labbyGateway: handoffGateway,
    omarGateway: fakeGateway({ sessions: [session('omar-session')] }),
  });

  try {
    const rawPublished = await publishRawMessage(handoffStack, `${STATE_TOPIC}/handoff`);
    assert.equal(rawPublished.includes(secret), false);
    assert.equal(rawPublished.includes(longLabel), false);

    const last = JSON.parse(rawPublished);
    const snapshot = rendererSnapshot(last);
    const view = promptView({ ...snapshot, now: NOW, phase: {} });
    assert.equal(last.prompt?.kind, 'handoff');

    const visibleStrings = [
      snapshot.label,
      view.line,
      view.message,
      ...view.buttons.flatMap((button) => [button.text, button.ariaLabel]),
      outcomeMessage({ ok: false, code: 'transport_uncertain' }),
    ].filter((value) => typeof value === 'string' && value.length > 0);
    assert.ok(visibleStrings.length > 0, 'Handoff renderer view assertion is vacuous if no visible strings were produced.');
    for (const text of visibleStrings) {
      assert.equal(text.includes(secret), false);
      assert.equal(text.includes(longLabel), false);
    }
  } finally {
    await handoffStack.stop();
  }

  assertNoLeak(
    httpLogs,
    [secret, longLabel, detailSecret, metadataSecret],
    'HTTP log capture must be non-empty or the content assertion is vacuous.',
  );
  assertNoLeak(
    publisherLogs,
    [secret, longLabel, detailSecret, metadataSecret],
    'Publisher log capture must be non-empty or the content assertion is vacuous.',
  );
  } finally {
    await broker.close();
    if (priorLocalStorageDescriptor === undefined) delete globalThis.localStorage;
    else Object.defineProperty(globalThis, 'localStorage', priorLocalStorageDescriptor);
  }
});

test('approval integration: expires_at dies by the panel clock and the route refuses it without needing a new message', async () => {
  const baseNow = Date.now();
  const expiresAtMs = baseNow + 500;
  const labbyGateway = fakeGateway({
    sessions: [session('labby-session')],
    onRequest(method) {
      if (method !== 'sessions.messages.subscribe') return undefined;
      return Promise.resolve({
        approvalReplay: {
          approvals: [approval('expires-1', { expiresAtMs })],
          truncated: false,
        },
      });
    },
  });
  const omarGateway = fakeGateway({ sessions: [session('omar-session')] });
  const realNow = Date.now;
  const stack = await startStack({ labbyGateway, omarGateway });

  try {
    const payload = stack.latestPayload(baseNow);
    const expiredView = promptView({ ...rendererSnapshot(payload), now: expiresAtMs, phase: {} });
    assert.equal(expiredView.line, 'Decision expired.');
    assert.equal(canSubmit({ view: expiredView, snapshot: rendererSnapshot(payload), decision: 'deny' }), false);

    Date.now = () => expiresAtMs;
    await stack.withHttp(async ({ fetchJson }) => {
      const res = await fetchJson('/api/approval', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'labby:expires-1', decision: 'deny' }),
      });
      assert.equal(res.status, 409);
      assert.deepEqual(res.json, {
        ok: false,
        code: 'expired',
        error: 'approval expired',
        status: 'expired',
      });
    }, {
      resolveApproval: async (id, decision) => stack.coordinator.resolveApproval(id, decision),
    });
  } finally {
    Date.now = realNow;
    await stack.stop();
  }
});
