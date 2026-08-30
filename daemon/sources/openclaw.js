import { GATEWAY_CLIENT_CAPS } from '@openclaw/gateway-protocol/client-info';
import { SESSION_VIEWER_PRESENCE_MAX_KEYS } from '@openclaw/gateway-protocol/schema';
import { StateSource } from './state-source.js';
import { deviceSigningDeps } from '../openclaw/ed25519.js';
import { mapSessionsToAgents } from '../openclaw/map-sessions.js';
import { PendingApprovalStore, projectApproval, SAFE_DECISIONS } from '../openclaw/approvals.js';

/**
 * OpenClawStateSource — agent presence, read from the OpenClaw gateway.
 *
 * Connects as the Labby paired operator device. Its live credential now holds
 * `operator.read` plus `operator.approvals`, but this M1 source implements only
 * read-only presence calls and no approval route. The device token lives beside
 * its keypair in ~/.local/state/roost/openclaw-device.json.
 *
 * PUSH, NOT POLL. The gateway broadcasts session changes, and its own client
 * guide (docs/gateway/clients.md) says to subscribe rather than poll. Nothing
 * is queued for a disconnected client, so every reconnect is treated as a NEW
 * projection: re-subscribe, then re-snapshot. A missed event during a
 * disconnect can never be recovered by waiting for it.
 *
 * The snapshot is a full `sessions.list` rather than an incremental patch.
 * StateSource requires the complete agent set on every emission anyway, so
 * keeping a local projection would add state this daemon has no business
 * holding — and would drift from the gateway on any missed event.
 */

/** Events that mean the session set may have changed. Verified present in the gateway's registry. */
const SESSION_EVENTS = new Set([
  'sessions.changed',
  'session.updated',
  'session.started',
  'session.ended',
  'session.closed',
  'session.replaced',
  'session.error',
  'agent.run.started',
  'agent.run.finished',
  'openclaw.session.state',
]);

const READ_ONLY_SCOPES = ['operator.read'];

/**
 * Capabilities roost advertises in connect.params.caps.
 *
 * `tool-events` is not optional decoration. Measured on a live run: every
 * progress field on a session record is null or frozen while the run is
 * active — `lastActivityAt` is null, `runtimeMs` is 0, `status` is null, and
 * `updatedAt` stays pinned at run start. A five-second run and a ten-minute
 * hang are byte-identical in `sessions.list`.
 *
 * Structured tool events are therefore the ONLY live progress signal, and the
 * gateway registers a connection as a recipient for them only if it advertises
 * this capability. Its docs are explicit that omitting it yields silence with
 * no handshake error — which is exactly how this was missed the first time.
 *
 * Nothing else is claimed. The guidance is to advertise only what the client
 * implements, and roost at M1 has neither the scope nor the UI for approvals.
 */
const CAPS = [GATEWAY_CLIENT_CAPS.TOOL_EVENTS];
const CONNECTION_STATES = new Set(['connected', 'reconciling', 'disconnected']);

function approvalPrompt(prompt) {
  // Gateway approval presentation kinds (for example `plugin`) are distinct
  // from roost prompt kinds (`approve_reject` / `handoff`). Only the gateway
  // vocabulary goes back out over approval.resolve; aggregate.js must see only
  // roost's vocabulary.
  return {
    id: prompt.id,
    kind: prompt.actionable ? 'approve_reject' : 'handoff',
    reversible: prompt.reversible,
    expiresAt: prompt.expiresAtMs,
  };
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function relevanceTimestamp(s) {
  return Math.max(
    finiteNumber(s?.lastActivityAt),
    finiteNumber(s?.lastInteractionAt),
    finiteNumber(s?.updatedAt),
    finiteNumber(s?.pinnedAt),
    finiteNumber(s?.createdAt),
  );
}

function compareViewerCandidates(a, b) {
  return Number(Boolean(b.session?.hasActiveRun)) - Number(Boolean(a.session?.hasActiveRun))
    || Number(b.hasDigest) - Number(a.hasDigest)
    || Number(Boolean(b.session?.pinned)) - Number(Boolean(a.session?.pinned))
    || Number(Boolean(b.session?.unread)) - Number(Boolean(a.session?.unread))
    || relevanceTimestamp(b.session) - relevanceTimestamp(a.session)
    || a.key.localeCompare(b.key);
}

function sinceForFinalState(previous, id, state, now) {
  const prior = previous?.get(id);
  return prior && prior.state === state ? prior.since : now;
}

export function selectViewerSessionKeys(sessions = [], digests, limit = SESSION_VIEWER_PRESENCE_MAX_KEYS) {
  const boundedLimit = Math.max(0, Math.floor(finiteNumber(limit)));
  const seen = new Set();
  const candidates = [];
  for (const session of sessions) {
    const key = typeof session?.key === 'string' ? session.key.trim() : '';
    if (!key || seen.has(key) || session?.archived) continue;
    seen.add(key);
    candidates.push({ key, session, hasDigest: Boolean(digests?.has(key)) });
  }
  return candidates
    .toSorted(compareViewerCandidates)
    .slice(0, boundedLimit)
    .map((candidate) => candidate.key);
}

export class OpenClawStateSource extends StateSource {
  constructor({
    createClient,
    url = 'ws://127.0.0.1:19789',
    deviceToken,
    deviceIdentity,
    scopes = READ_ONLY_SCOPES,
    // Bursts of events (a run starting fires several) collapse into one
    // snapshot instead of one request each.
    debounceMs = 150,
    trailingSnapshotMs = 2000,
    reconcileMs = 60000,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
  } = {}) {
    super();
    Object.assign(this, {
      createClient, url, deviceToken, deviceIdentity, scopes, debounceMs,
      trailingSnapshotMs, reconcileMs, setTimeoutFn, clearTimeoutFn,
    });
    this.client = null;
    this.stopped = true;
    this.timer = null;
    this.trailingTimer = null;
    this.reconcileTimer = null;
    this.inFlight = false;
    this.pendingSnapshot = false;
    /** sessionKey -> latest session.observer digest. Push-only: it cannot be
     *  re-read from sessions.list, so it has to be held here. Pruned to the
     *  live session set on every snapshot so it cannot grow without bound. */
    this.digests = new Map();
    /** id -> { state, since }. `since` means "entered this state", which no
     *  gateway field expresses; see daemon/openclaw/map-sessions.js. */
    this.previous = new Map();
    this.approvals = new PendingApprovalStore();
    this.connectionState = 'disconnected';
    this.subscribedApprovalKeys = new Set();
  }

  start() {
    this.stopped = false;
    this.client = this.createClient({
      url: this.url,
      deviceToken: this.deviceToken,
      deviceIdentity: this.deviceIdentity,
      role: 'operator',
      scopes: this.scopes,
      caps: CAPS,
      // Closed registries; see daemon/openclaw/pairing.js for why not "roost"
      // and why the mode is not "backend".
      clientName: 'gateway-client',
      clientDisplayName: 'roost',
      mode: 'cli',
      hostDeps: deviceSigningDeps,

      onHelloOk: () => { void this.resync(); },
      onEvent: (evt) => {
        if (evt?.event === 'session.observer') { this.absorbDigest(evt.payload); return; }
        if (evt?.event === 'session.approval') { this.absorbApprovalEvent(evt.payload); return; }
        if (SESSION_EVENTS.has(evt?.event)) this.schedule();
      },
      onConnectError: (err) => this.emit('warning', `openclaw connect: ${err?.message ?? err}`),
      onReconnectPaused: () => this.setConnectionState('reconciling'),
      onClose: () => this.setConnectionState('disconnected'),
    });
    this.client.start();
  }

  /** Re-establish the subscription, then replace the projection. */
  async resync() {
    if (this.stopped) return;
    this.setConnectionState('reconciling');
    this.subscribedApprovalKeys.clear();
    try {
      // Subscribe BEFORE snapshotting: the reverse order leaves a window where
      // a change lands after the read and before the subscription exists.
      await this.client.request('sessions.subscribe', {});
      // Join the session.observer audience. The gateway broadcasts digests only
      // to connections that opt in, and says nothing if you never ask — which is
      // exactly how roost spent its first day blind to them. Audience membership
      // is per CONNECTION, so this must be redone on every reconnect.
      await this.client.request('sessions.observer.visibility', { visible: true });
      await this.snapshot();
      if (!this.stopped) this.setConnectionState('connected');
    } catch (err) {
      this.emit('warning', `openclaw resync: ${err?.message ?? err}`);
    }
  }

  setConnectionState(state) {
    if (!CONNECTION_STATES.has(state)) return;
    this.connectionState = state;
    if (state !== 'connected') this.subscribedApprovalKeys.clear();
    this.emit('connection', { state });
  }

  async subscribeApprovals(sessionKeys) {
    for (const key of sessionKeys) {
      if (this.subscribedApprovalKeys.has(key)) continue;
      try {
        const response = await this.client.request('sessions.messages.subscribe', {
          key,
          includeApprovals: true,
        });
        this.subscribedApprovalKeys.add(key);
        this.absorbApprovalReplay(key, response?.approvalReplay);
      } catch (err) {
        this.emit('warning', `openclaw approvals.subscribe ${JSON.stringify(key)}: ${err?.message ?? err}`);
      }
    }
  }

  async currentSessions() {
    const res = await this.client.request('sessions.list', {});
    return res?.sessions ?? [];
  }

  async snapshot() {
    if (this.stopped) return;
    if (this.inFlight) {
      this.pendingSnapshot = true;
      return;
    }
    this.inFlight = true;
    try {
      do {
        this.pendingSnapshot = false;
        await this.runSnapshotOnce();
      } while (!this.stopped && this.pendingSnapshot);
    } catch (err) {
      this.emit('warning', `openclaw sessions.list: ${err?.message ?? err}`);
    } finally {
      this.inFlight = false;
      this.pendingSnapshot = false;
    }
  }

  async runSnapshotOnce() {
    const sessions = await this.currentSessions();
    if (this.stopped) return;

    // Drop digests for sessions the gateway no longer lists.
    const live = new Set(sessions.map((s) => s?.key));
    for (const key of this.digests.keys()) if (!live.has(key)) this.digests.delete(key);
    this.approvals.pruneSessions(live);
    for (const key of this.subscribedApprovalKeys) if (!live.has(key)) this.subscribedApprovalKeys.delete(key);

    // Join the per-session observer audience. `sessions.observer.visibility`
    // is a global opt-in; the broadcast targets
    // audience.recipients(sessionKey, agentId), so the gateway also has to be
    // told WHICH sessions this connection is viewing. Declaring only the
    // global flag produced silence across a real run.
    const keys = selectViewerSessionKeys(sessions, this.digests);
    try { await this.client.request('sessions.viewers.set', { sessionKeys: keys }); }
    catch (err) { this.emit('warning', `openclaw viewers.set: ${err?.message ?? err}`); }
    await this.subscribeApprovals(keys);

    const snapshotNow = Date.now();
    const agents = mapSessionsToAgents(sessions, this.digests, this.previous, snapshotNow).map((agent) => {
      const prompt = this.approvals.getPrompt(agent.id, {
        actionable: this.connectionState === 'connected',
      });
      if (!prompt) return agent;
      return {
        ...agent,
        label: prompt.label,
        state: 'needs_attention',
        urgency: 'blocking',
        since: sinceForFinalState(this.previous, agent.id, 'needs_attention', snapshotNow),
        prompt: approvalPrompt(prompt),
      };
    });
    this.previous = new Map(agents.map((a) => [a.id, { state: a.state, since: a.since }]));
    this.emit('agents', agents);
    this.afterSnapshot(agents);
  }

  afterSnapshot(agents) {
    const working = agents.some((agent) => agent?.state && agent.state !== 'idle');
    if (!working) {
      this.clearTrailingTimer();
      this.clearReconcileTimer();
      return;
    }
    this.ensureReconcileTimer();
    if (!this.snapshotReasonIs('trailing')) this.scheduleTrailingSnapshot();
  }

  /** A session.observer digest: the observer's read of how a run is going. */
  absorbDigest(payload) {
    const key = payload?.sessionKey;
    if (!key || this.stopped) return;
    // A real digest has never been captured; the mapping is built from the
    // gateway's ModelDigestSchema. ROOST_OPENCLAW_DEBUG=1 dumps the first ones
    // so the shape can be confirmed against a live run rather than assumed.
    if (process.env.ROOST_OPENCLAW_DEBUG) {
      console.error('[roost] session.observer digest: ' + JSON.stringify(payload));
    }
    this.digests.set(key, payload);
    // Re-emit promptly: the gateway sends these with dropIfSlow, and this is
    // the only signal that distinguishes a grinding run from a stuck one.
    this.schedule();
  }

  absorbApprovalReplay(sessionKey, replay) {
    const approvals = Array.isArray(replay?.approvals) ? replay.approvals : [];
    const projected = approvals
      .map((approval) => projectApproval(approval, {
        fromTruncatedReplay: replay?.truncated === true,
        onDrop: (msg) => this.emit('warning', msg),
      }))
      .filter(Boolean);
    this.approvals.replaceReplay(sessionKey, projected, { truncated: replay?.truncated === true });
  }

  absorbApprovalEvent(payload) {
    const sessionKey = typeof payload?.sessionKey === 'string' ? payload.sessionKey : null;
    if (!sessionKey) return;
    if (payload?.phase === 'pending' && payload?.approval?.status === 'pending') {
      const projected = projectApproval(payload.approval, { onDrop: (msg) => this.emit('warning', msg) });
      if (!projected) return;
      this.approvals.upsertPending(sessionKey, {
        ...projected,
        actionable: this.connectionState === 'connected' && projected.actionable,
      });
      this.schedule();
      return;
    }
    if (payload?.phase === 'terminal' && payload?.approval?.status !== 'pending') {
      this.approvals.resolve(sessionKey, payload.approval);
      this.schedule();
    }
  }

  async resolveApproval({ id, decision }) {
    if (!SAFE_DECISIONS.has(decision)) throw new Error('approval decision must be allow-once or deny');
    this.approvals.expire();
    for (const [sessionKey, entries] of this.approvals.pendingBySession) {
      const approval = entries.get(id);
      if (!approval) continue;
      if (this.connectionState !== 'connected') throw new Error('approval source is not answerable while stale or reconciling');
      if (!approval.actionable) throw new Error('approval is not actionable');
      if (approval.expiresAtMs !== null && approval.expiresAtMs <= this.approvals.now()) {
        entries.delete(id);
        throw new Error('approval already expired');
      }
      try {
        const result = await this.client.request('approval.resolve', { id, kind: approval.gatewayKind, decision });
        const canonical = result?.approval;
        if (canonical?.status && canonical.status !== 'pending') this.approvals.resolve(sessionKey, canonical);
        this.schedule();
        return result;
      } catch (err) {
        entries.set(id, { ...approval, actionable: false });
        this.schedule();
        throw err;
      }
    }
    if (this.approvals.getResolved(id)) throw new Error('approval already answered');
    throw new Error(`unknown approval ${JSON.stringify(id)}`);
  }

  schedule() {
    if (this.stopped) return;
    this.clearTrailingTimer();
    this.clearDebounceTimer();
    this.timer = this.armTimer('event', this.debounceMs);
    this.timer.unref?.();
  }

  snapshotReasonIs(reason) {
    return this.currentSnapshotReason === reason;
  }

  armTimer(reason, delayMs) {
    const timer = this.setTimeoutFn(() => {
      if (reason === 'event' && this.timer === timer) this.timer = null;
      if (reason === 'trailing' && this.trailingTimer === timer) this.trailingTimer = null;
      if (reason === 'reconcile' && this.reconcileTimer === timer) this.reconcileTimer = null;
      void this.runSnapshotFrom(reason);
    }, delayMs);
    timer?.unref?.();
    return timer;
  }

  async runSnapshotFrom(reason) {
    this.currentSnapshotReason = reason;
    try {
      await this.snapshot();
    } finally {
      this.currentSnapshotReason = null;
    }
  }

  scheduleTrailingSnapshot() {
    this.clearTrailingTimer();
    this.trailingTimer = this.armTimer('trailing', this.trailingSnapshotMs);
  }

  ensureReconcileTimer() {
    if (this.reconcileTimer) return;
    this.reconcileTimer = this.armTimer('reconcile', this.reconcileMs);
  }

  clearDebounceTimer() {
    this.clearTimeoutFn(this.timer);
    this.timer = null;
  }

  clearTrailingTimer() {
    this.clearTimeoutFn(this.trailingTimer);
    this.trailingTimer = null;
  }

  clearReconcileTimer() {
    this.clearTimeoutFn(this.reconcileTimer);
    this.reconcileTimer = null;
  }

  stop() {
    if (this.stopped) return;   // idempotent: stop() may be called twice
    this.stopped = true;
    this.clearDebounceTimer();
    this.clearTrailingTimer();
    this.clearReconcileTimer();
    this.pendingSnapshot = false;
    this.digests.clear();
    this.previous.clear();
    try { this.client?.stop(); } catch { /* stopping is best-effort */ }
  }
}
