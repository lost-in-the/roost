import { GATEWAY_CLIENT_CAPS } from '@openclaw/gateway-protocol/client-info';
import { StateSource } from './state-source.js';
import { deviceSigningDeps } from '../openclaw/ed25519.js';
import { mapSessionsToAgents } from '../openclaw/map-sessions.js';

/**
 * OpenClawStateSource — agent presence, read from the OpenClaw gateway.
 *
 * Connects as a paired operator device scoped `operator.read` and nothing more.
 * Pair once with scripts/pair-openclaw.mjs; the device token it mints lives
 * beside its keypair in ~/.local/state/roost/openclaw-device.json.
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
  } = {}) {
    super();
    Object.assign(this, { createClient, url, deviceToken, deviceIdentity, scopes, debounceMs });
    this.client = null;
    this.stopped = true;
    this.timer = null;
    this.inFlight = false;
    /** sessionKey -> latest session.observer digest. Push-only: it cannot be
     *  re-read from sessions.list, so it has to be held here. Pruned to the
     *  live session set on every snapshot so it cannot grow without bound. */
    this.digests = new Map();
    /** id -> { state, since }. `since` means "entered this state", which no
     *  gateway field expresses; see daemon/openclaw/map-sessions.js. */
    this.previous = new Map();
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
        if (SESSION_EVENTS.has(evt?.event)) this.schedule();
      },
      onConnectError: (err) => this.emit('warning', `openclaw connect: ${err?.message ?? err}`),
    });
    this.client.start();
  }

  /** Re-establish the subscription, then replace the projection. */
  async resync() {
    if (this.stopped) return;
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
    } catch (err) {
      this.emit('warning', `openclaw resync: ${err?.message ?? err}`);
    }
  }

  async snapshot() {
    if (this.stopped || this.inFlight) return;
    this.inFlight = true;
    try {
      const res = await this.client.request('sessions.list', {});
      if (this.stopped) return;
      const sessions = res?.sessions ?? [];

      // Drop digests for sessions the gateway no longer lists.
      const live = new Set(sessions.map((s) => s?.key));
      for (const key of this.digests.keys()) if (!live.has(key)) this.digests.delete(key);

      // Join the per-session observer audience. `sessions.observer.visibility`
      // is a global opt-in; the broadcast targets
      // audience.recipients(sessionKey, agentId), so the gateway also has to be
      // told WHICH sessions this connection is viewing. Declaring only the
      // global flag produced silence across a real run.
      const keys = sessions.map((s) => s?.key).filter(Boolean);
      try { await this.client.request('sessions.viewers.set', { sessionKeys: keys }); }
      catch (err) { this.emit('warning', `openclaw viewers.set: ${err?.message ?? err}`); }

      const agents = mapSessionsToAgents(sessions, this.digests, this.previous);
      this.previous = new Map(agents.map((a) => [a.id, { state: a.state, since: a.since }]));
      this.emit('agents', agents);
    } catch (err) {
      this.emit('warning', `openclaw sessions.list: ${err?.message ?? err}`);
    } finally {
      this.inFlight = false;
    }
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

  schedule() {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.snapshot(); }, this.debounceMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.stopped) return;   // idempotent: stop() may be called twice
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = null;
    this.digests.clear();
    this.previous.clear();
    try { this.client?.stop(); } catch { /* stopping is best-effort */ }
  }
}
