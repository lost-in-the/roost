#!/usr/bin/env node

/**
 * Owner-authorized live protocol spike for D-015.
 *
 * The exact session key is accepted only through ROOST_SPIKE_SESSION_KEY so it
 * does not appear in argv. Raw approval projections remain in memory. Every
 * emitted line passes through the explicit allowlist in approval-spike.js.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { GatewayClient } from '@openclaw/gateway-client';
import { GATEWAY_CLIENT_CAPS } from '@openclaw/gateway-protocol/client-info';
import { deviceSigningDeps } from '../daemon/openclaw/ed25519.js';
import { loadOrCreateDeviceIdentity, readDeviceToken } from '../daemon/openclaw/device-identity.js';
import { gatewayAliasFromArgv, resolveGatewayTarget } from '../daemon/openclaw/gateway-targets.js';
import {
  approvalCorrelation,
  assertSpikeDecision,
  safeApprovalSummary,
  safeReplaySummary,
  safeResolutionSummary,
} from '../daemon/openclaw/approval-spike.js';

const MODES = new Set(['expect-none', 'reconnect-resolve', 'first-answer', 'expire']);

function option(argv, name, fallback = undefined) {
  const values = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === name) { values.push(argv[i + 1]); i += 1; }
    else if (argv[i].startsWith(`${name}=`)) values.push(argv[i].slice(name.length + 1));
  }
  if (values.length > 1) throw new Error(`duplicate ${name}`);
  return values[0] ?? fallback;
}

function emit(event, fields = {}) {
  process.stdout.write(`${JSON.stringify({ event, ...fields })}\n`);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function connectionOptions({ target, stored, identity, caps, onHelloOk, onEvent, onConnectError }) {
  return {
    url: target.url,
    deviceToken: stored.token,
    deviceIdentity: identity,
    role: 'operator',
    scopes: stored.scopes,
    caps,
    clientName: 'gateway-client',
    clientDisplayName: 'roost-approval-spike',
    mode: 'cli',
    hostDeps: deviceSigningDeps,
    onHelloOk,
    onEvent,
    onConnectError,
  };
}

async function connect({ target, stored, identity, sessionKey, caps, onApproval }) {
  const ready = deferred();
  let settled = false;
  let client;
  client = new GatewayClient(connectionOptions({
    target,
    stored,
    identity,
    caps,
    onHelloOk: async () => {
      if (settled) return;
      try {
        const response = await client.request('sessions.messages.subscribe', {
          key: sessionKey,
          includeApprovals: true,
        });
        settled = true;
        ready.resolve({ client, replay: response?.approvalReplay });
      } catch (error) {
        settled = true;
        ready.reject(error);
      }
    },
    onEvent: (evt) => {
      if (evt?.event !== 'session.approval') return;
      // Never emit evt.payload. The callback receives the raw value in memory.
      onApproval?.(evt.payload);
    },
    onConnectError: (error) => {
      if (settled) return;
      settled = true;
      ready.reject(error);
    },
  }));
  client.start();
  return ready.promise;
}

function pendingFrom(payload) {
  return payload?.phase === 'pending' && payload?.approval?.status === 'pending'
    ? payload.approval
    : null;
}

function terminalFrom(payload) {
  return payload?.phase === 'terminal' && payload?.approval?.status !== 'pending'
    ? payload.approval
    : null;
}

async function main() {
  const argv = process.argv.slice(2);
  const alias = gatewayAliasFromArgv(argv);
  const mode = option(argv, '--mode');
  if (!MODES.has(mode)) throw new Error(`--mode must be one of ${[...MODES].join('|')}`);
  const timeoutMs = Number(option(argv, '--timeout-ms', '180000'));
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) {
    throw new Error('--timeout-ms must be an integer from 1000 through 600000');
  }
  const decision = assertSpikeDecision(option(argv, '--decision', 'deny'));
  const advertiseRoute = argv.includes('--advertise-route');
  const caps = advertiseRoute ? [GATEWAY_CLIENT_CAPS.APPROVALS] : [];
  const sessionKey = process.env.ROOST_SPIKE_SESSION_KEY;
  if (!sessionKey) throw new Error('ROOST_SPIKE_SESSION_KEY is required');

  const stateHome = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
  const target = resolveGatewayTarget(alias, stateHome);
  const stored = readDeviceToken(target.deviceFile);
  if (!stored?.token || !stored.scopes?.includes('operator.approvals')) {
    throw new Error('gateway identity is not paired with operator.approvals');
  }
  const identity = loadOrCreateDeviceIdentity(target.deviceFile);
  const clients = new Set();
  const stopAll = () => {
    for (const client of clients) {
      try { client.stop(); } catch { /* best effort */ }
    }
    clients.clear();
  };
  process.once('SIGINT', () => { stopAll(); process.exit(130); });
  process.once('SIGTERM', () => { stopAll(); process.exit(143); });

  try {
    if (mode === 'expect-none') {
      const unexpected = deferred();
      const connected = await connect({
        target, stored, identity, sessionKey, caps,
        onApproval: (payload) => unexpected.resolve(payload),
      });
      clients.add(connected.client);
      emit('ready', { gateway: alias, approvalRoute: advertiseRoute, replay: safeReplaySummary(connected.replay) });
      try {
        const payload = await withTimeout(unexpected.promise, timeoutMs, 'no-approval control');
        emit('unexpected-approval', { gateway: alias, approval: safeApprovalSummary(payload?.approval) });
        process.exitCode = 2;
      } catch (error) {
        if (error?.message !== 'no-approval control timed out') throw error;
        emit('no-approval-observed', { gateway: alias });
      }
      return;
    }

    const pending = deferred();
    const terminal = deferred();
    const first = await connect({
      target, stored, identity, sessionKey, caps,
      onApproval: (payload) => {
        const p = pendingFrom(payload);
        if (p) pending.resolve(p);
        const t = terminalFrom(payload);
        if (t) terminal.resolve(t);
      },
    });
    clients.add(first.client);
    emit('ready', { gateway: alias, approvalRoute: advertiseRoute, replay: safeReplaySummary(first.replay) });
    const replayPending = first.replay?.approvals?.find((approval) => approval?.status === 'pending');
    if (replayPending) pending.resolve(replayPending);

    if (mode === 'expire') {
      const approval = await withTimeout(pending.promise, timeoutMs, 'pending approval');
      emit('pending', { gateway: alias, approval: safeApprovalSummary(approval) });
      const ended = await withTimeout(terminal.promise, timeoutMs, 'terminal approval');
      emit('terminal', { gateway: alias, approval: safeApprovalSummary(ended) });
      if (ended.status !== 'expired') process.exitCode = 3;
      return;
    }

    if (mode === 'first-answer') {
      const secondPending = deferred();
      const second = await connect({
        target, stored, identity, sessionKey, caps,
        onApproval: (payload) => {
          const p = pendingFrom(payload);
          if (p) secondPending.resolve(p);
        },
      });
      clients.add(second.client);
      emit('second-reviewer-ready', { gateway: alias, replay: safeReplaySummary(second.replay) });
      const secondReplayPending = second.replay?.approvals?.find((approval) => approval?.status === 'pending');
      if (secondReplayPending) secondPending.resolve(secondReplayPending);
      const approval = await withTimeout(pending.promise, timeoutMs, 'first reviewer pending approval');
      const seenBySecond = await withTimeout(secondPending.promise, timeoutMs, 'second reviewer pending approval');
      if (seenBySecond.id !== approval.id) throw new Error('reviewers observed different approvals');
      emit('both-reviewers-saw-pending', { gateway: alias, correlation: approvalCorrelation(approval.id) });
      const firstResult = await first.client.request('approval.resolve', {
        id: approval.id, kind: approval.presentation.kind, decision,
      });
      emit('first-resolution', { gateway: alias, result: safeResolutionSummary(firstResult) });
      const losingDecision = decision === 'deny' ? 'allow-once' : 'deny';
      const secondResult = await second.client.request('approval.resolve', {
        id: approval.id, kind: approval.presentation.kind, decision: losingDecision,
      });
      emit('second-resolution', { gateway: alias, result: safeResolutionSummary(secondResult) });
      if (!firstResult?.applied || secondResult?.applied ||
          firstResult?.approval?.decision !== secondResult?.approval?.decision) {
        process.exitCode = 4;
      }
      return;
    }

    const approval = await withTimeout(pending.promise, timeoutMs, 'pending approval');
    emit('pending', { gateway: alias, approval: safeApprovalSummary(approval) });
    first.client.stop();
    clients.delete(first.client);
    emit('disconnected', { gateway: alias, correlation: approvalCorrelation(approval.id) });

    const reconnectedTerminal = deferred();
    const reconnected = await connect({
      target, stored, identity, sessionKey, caps,
      onApproval: (payload) => {
        const t = terminalFrom(payload);
        if (t) reconnectedTerminal.resolve(t);
      },
    });
    clients.add(reconnected.client);
    const replay = reconnected.replay;
    emit('reconnected', { gateway: alias, replay: safeReplaySummary(replay) });
    const replayed = replay?.approvals?.find((item) => item?.id === approval.id);
    if (!replayed) throw new Error('pending approval was absent from reconnect replay');
    const result = await reconnected.client.request('approval.resolve', {
      id: approval.id, kind: approval.presentation.kind, decision,
    });
    emit('resolution', { gateway: alias, result: safeResolutionSummary(result) });
    const ended = await withTimeout(reconnectedTerminal.promise, timeoutMs, 'terminal event');
    emit('terminal', { gateway: alias, approval: safeApprovalSummary(ended) });
    if (!result?.applied || approvalCorrelation(ended.id) !== approvalCorrelation(approval.id)) {
      process.exitCode = 5;
    }
  } finally {
    stopAll();
  }
}

main().catch((error) => {
  // Deliberately omit error details: library errors can echo request params.
  emit('failed', { category: error?.name || 'Error' });
  process.exitCode = 1;
});
