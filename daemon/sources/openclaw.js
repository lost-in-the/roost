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
  }

  start() {
    this.stopped = false;
    this.client = this.createClient({
      url: this.url,
      deviceToken: this.deviceToken,
      deviceIdentity: this.deviceIdentity,
      role: 'operator',
      scopes: this.scopes,
      // Closed registries; see daemon/openclaw/pairing.js for why not "roost"
      // and why the mode is not "backend".
      clientName: 'gateway-client',
      clientDisplayName: 'roost',
      mode: 'cli',
      hostDeps: deviceSigningDeps,

      onHelloOk: () => { void this.resync(); },
      onEvent: (evt) => { if (SESSION_EVENTS.has(evt?.event)) this.schedule(); },
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
      this.emit('agents', mapSessionsToAgents(res?.sessions ?? []));
    } catch (err) {
      this.emit('warning', `openclaw sessions.list: ${err?.message ?? err}`);
    } finally {
      this.inFlight = false;
    }
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
    try { this.client?.stop(); } catch { /* stopping is best-effort */ }
  }
}
