import mqtt from 'mqtt';

/**
 * Publishes the aggregated state to MQTT.
 *
 * Three properties carry the design:
 *   retained   a panel that starts late gets current state at once, not a blank
 *              screen until something happens.
 *   Last Will  if this process dies, the BROKER publishes `offline` for us, so
 *              no subscriber has to implement its own timeout logic.
 *   heartbeat  we republish on a timer whether or not state changed. Without
 *              this, staleness is undetectable: a silent topic and a genuinely
 *              idle system look identical.
 */

export const HEARTBEAT_MS = 10_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 60_000;

/**
 * The Last Will payload. Deliberately has NO `ts`.
 *
 * The will is fixed at connect time. A timestamp baked in then would be
 * arbitrarily old by the time the broker actually sends it, and a renderer
 * doing staleness maths on it would draw the wrong conclusion. Subscribers
 * read a payload with `state: "offline"` and no `ts` as "offline as of now".
 */
export function lwtPayload() {
  return { v: 1, state: 'offline', count: 0, label: null, urgency: 'ambient', primary_run_id: null };
}

/** Exponential backoff, capped so reconnection continues indefinitely. */
export function backoffDelay(attempt) {
  return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1));
}

export class StatePublisher {
  /**
   * @param {object}   o
   * @param {string}   o.url            mqtt://host:port
   * @param {string}   o.topic
   * @param {Function} o.buildPayload   called at publish time, so `ts` is always fresh
   */
  constructor({ url, topic, buildPayload, username, password, heartbeatMs = HEARTBEAT_MS, reconnectPeriodMs = null, clientId }) {
    this.url = url;
    this.topic = topic;
    this.buildPayload = buildPayload;
    this.username = username;
    this.password = password;
    this.heartbeatMs = heartbeatMs;
    this.reconnectPeriodMs = reconnectPeriodMs;
    this.clientId = clientId || `roost-daemon-${process.pid}`;
    this.client = null;
    this.timer = null;
    this.connected = false;
    this.publishCount = 0;
    this.reconnectAttempts = 0;
    this.onLog = () => {};
    // Called after every (re)connect, so retained side-channels can be
    // republished once the broker is actually reachable.
    this.onConnected = () => {};
  }

  start() {
    this.client = mqtt.connect(this.url, {
      clientId: this.clientId,
      username: this.username,
      password: this.password,
      clean: true,
      reconnectPeriod: this.reconnectPeriodMs ?? BACKOFF_BASE_MS,
      connectTimeout: 10_000,
      // Registered at connect time; the broker sends it if we drop.
      will: { topic: this.topic, payload: JSON.stringify(lwtPayload()), qos: 1, retain: true },
    });

    this.client.on('connect', () => {
      this.connected = true;
      this.reconnectAttempts = 0;
      if (this.reconnectPeriodMs == null) this.client.options.reconnectPeriod = BACKOFF_BASE_MS;
      this.onLog('connected to broker');
      this.publishNow();
      this.onConnected();
    });

    this.client.on('reconnect', () => {
      this.reconnectAttempts += 1;
      if (this.reconnectPeriodMs == null) {
        // Walk the delay up ourselves; mqtt.js otherwise retries at a fixed rate.
        this.client.options.reconnectPeriod = backoffDelay(this.reconnectAttempts);
      }
      this.onLog(`reconnecting (attempt ${this.reconnectAttempts})`);
    });

    this.client.on('close', () => { this.connected = false; });
    this.client.on('offline', () => { this.connected = false; });
    this.client.on('error', (err) => this.onLog(`broker error: ${err.message}`));

    this.timer = setInterval(() => this.publishNow(), this.heartbeatMs);
    this.timer.unref?.();
  }

  /** Publish immediately, because something changed. */
  touch() { this.publishNow(); }

  publishNow() {
    // Publishing while disconnected only queues a payload whose `ts` will be
    // wrong by the time it is sent. Stay silent until genuinely connected.
    if (!this.connected || !this.client) return;
    const payload = this.buildPayload();
    this.client.publish(this.topic, JSON.stringify(payload), { qos: 1, retain: true });
    this.publishCount += 1;
  }

  /**
   * Publish a retained payload to any topic on the daemon's existing
   * connection. Used for the laptop-open instrument, which shares this client
   * rather than opening a second one for a single number.
   *
   * @returns {boolean} whether it actually went out
   */
  publishRetained(topic, payload) {
    if (!this.connected || !this.client) return false;
    this.client.publish(topic, JSON.stringify(payload), { qos: 1, retain: true });
    return true;
  }

  /** Drop the socket with no DISCONNECT, so the broker fires our will. */
  simulateHardDeath() {
    this.connected = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.client?.stream?.destroy();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.connected = false;
    this.client?.end(true);
    this.client = null;
  }
}
