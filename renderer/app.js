import mqtt from '/vendor/mqtt.esm.js';
import { isStale, silentFor } from '/staleness.js';

/**
 * The panel.
 *
 * It is a plain MQTT subscriber, exactly like the Stream Deck and (later) Home
 * Assistant. It NEVER aggregates: whatever arrives on the topic is what gets
 * drawn. Two surfaces that can disagree make both untrustworthy.
 *
 * It protects against two different failures, which is why both mechanisms are
 * needed:
 *   - the daemon dies      -> the broker publishes Last Will, we render offline
 *   - the broker is cut off -> no messages arrive, we render stale ourselves
 */

const el = (id) => document.getElementById(id);
const root = document.documentElement;

const nodes = {
  state: el('state-name'),
  label: el('label'),
  count: el('count'),
  elapsed: el('elapsed'),
  clock: el('clock'),
  laptop: el('laptop'),
  laptopCount: el('laptop-count'),
  toast: el('toast'),
  staleSub: el('stale-sub'),
};

const STATE_WORDS = {
  idle: 'idle',
  listening: 'listening',
  thinking: 'thinking',
  stalled: 'stalled',
  needs_attention: 'needs you',
  offline: 'offline',
};

const KNOWN_STATES = Object.keys(STATE_WORDS);

let config = null;
let last = null;          // last payload rendered
let lastMessageAt = 0;    // wall clock of the last message of any kind
const startedAt = Date.now();  // so a panel that never connects still goes stale
let sinceEpoch = null;    // when the winning agent entered its state

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

function render(payload) {
  // Tolerate unknown future fields, and unknown states, without breaking.
  const state = KNOWN_STATES.includes(payload.state) ? payload.state : 'idle';

  root.dataset.state = state;
  nodes.state.textContent = STATE_WORDS[state];
  nodes.label.textContent = payload.label ?? '';

  const count = Number.isFinite(payload.count) ? payload.count : 0;
  nodes.count.hidden = count < 2;         // "1" adds nothing; 2+ is information
  nodes.count.textContent = String(count);

  // `since` is additive to v1. Fall back to first-seen if a daemon predates it.
  if (payload.since) {
    sinceEpoch = Date.parse(payload.since);
  } else if (!last || last.state !== state) {
    sinceEpoch = Date.now();
  }
  if (state === 'idle' || state === 'offline') sinceEpoch = null;

  last = payload;
  tickElapsed();
}

function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

function tickElapsed() {
  // A counter that keeps climbing while the feed is dead is the exact lie this
  // project exists to avoid. Freeze it the moment we go stale.
  if (root.dataset.stale === 'yes') return;
  if (sinceEpoch == null) { nodes.elapsed.textContent = ''; return; }
  const duration = formatDuration(Date.now() - sinceEpoch);
  // Stalled reads as "stuck for", so even the text stops sounding like progress.
  nodes.elapsed.textContent = root.dataset.state === 'stalled' ? `stuck ${duration}` : duration;
}

function tickClock() {
  nodes.clock.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * Staleness is measured from the last message ARRIVAL, not from the payload's
 * `ts`. A long `thinking` turn is not stale while heartbeats keep coming.
 */
function tickStaleness() {
  if (!config) return;
  const now = Date.now();
  const args = { now, lastMessageAt, startedAt, staleMs: config.staleMs };
  const stale = isStale(args);
  root.dataset.stale = stale ? 'yes' : 'no';
  if (stale) {
    nodes.staleSub.textContent = lastMessageAt
      ? `last update ${formatDuration(silentFor(args))} ago`
      : `no message since this panel started ${formatDuration(silentFor(args))} ago`;
  }
}

// ---------------------------------------------------------------------------
// laptop-open counter
// ---------------------------------------------------------------------------

const PENDING_KEY = 'roost.pendingLaptopOpens';

const readPending = () => {
  try { return JSON.parse(localStorage.getItem(PENDING_KEY) || '[]'); } catch { return []; }
};
const writePending = (list) => {
  try { localStorage.setItem(PENDING_KEY, JSON.stringify(list)); } catch { /* full or blocked */ }
};

function toast(message) {
  nodes.toast.textContent = message;
  nodes.toast.classList.add('show');
  setTimeout(() => nodes.toast.classList.remove('show'), 1900);
}

async function postLaptopOpen() {
  const res = await fetch('/api/laptop-open', { method: 'POST' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()).count;
}

/** Retry anything recorded while the daemon was down. Taps must not be lost. */
async function flushPending() {
  const pending = readPending();
  if (pending.length === 0) return;
  const remaining = [...pending];
  while (remaining.length) {
    try { await postLaptopOpen(); remaining.shift(); }
    catch { break; }
  }
  writePending(remaining);
  if (remaining.length < pending.length) refreshLaptopCount();
}

async function refreshLaptopCount() {
  try {
    const { count } = await (await fetch('/api/laptop-open')).json();
    nodes.laptopCount.textContent = String(count + readPending().length);
  } catch {
    nodes.laptopCount.textContent = String(readPending().length || '—');
  }
}

nodes.laptop.addEventListener('click', async () => {
  nodes.laptop.classList.remove('saved', 'failed');
  // Optimistic: the tap is acknowledged instantly, then reconciled.
  const optimistic = Number.parseInt(nodes.laptopCount.textContent, 10);
  if (Number.isFinite(optimistic)) nodes.laptopCount.textContent = String(optimistic + 1);
  try {
    const count = await postLaptopOpen();
    nodes.laptopCount.textContent = String(count + readPending().length);
    nodes.laptop.classList.add('saved');
    toast('logged');
  } catch {
    // Queue locally so a dead daemon does not cost us a data point.
    writePending([...readPending(), new Date().toISOString()]);
    nodes.laptop.classList.add('failed');
    toast('logged locally, will sync');
  }
  setTimeout(() => nodes.laptop.classList.remove('saved', 'failed'), 1600);
});

// ---------------------------------------------------------------------------
// startup
// ---------------------------------------------------------------------------

async function connect() {
  config = await (await fetch('/api/config')).json();

  const client = mqtt.connect(config.wsUrl, {
    username: config.username || undefined,
    password: config.password || undefined,
    clientId: `roost-panel-${Math.random().toString(16).slice(2, 10)}`,
    clean: true,
    reconnectPeriod: 2000,
    connectTimeout: 8000,
  });

  client.on('connect', () => {
    root.dataset.link = 'up';
    client.subscribe(config.topic, { qos: 1 });
  });
  client.on('close', () => { root.dataset.link = 'down'; });
  client.on('error', () => { root.dataset.link = 'down'; });

  client.on('message', (_topic, raw) => {
    let payload;
    try { payload = JSON.parse(raw.toString()); }
    catch { return; }                       // a malformed message is not state

    lastMessageAt = Date.now();
    root.dataset.stale = 'no';

    // Last Will arrives with state "offline" and deliberately NO `ts`, because
    // a timestamp frozen at connect time would be arbitrarily stale. Treat it
    // explicitly as "offline as of now" rather than defaulting the field.
    if (payload.state === 'offline' && payload.ts === undefined) {
      render({ ...payload, label: 'state daemon is not running', count: 0, since: null });
      return;
    }
    render(payload);
  });
}

setInterval(tickElapsed, 1000);
setInterval(tickClock, 10_000);
setInterval(tickStaleness, 1000);
setInterval(flushPending, 15_000);

tickClock();
refreshLaptopCount();
flushPending();
connect().catch((err) => {
  root.dataset.state = 'offline';
  root.dataset.link = 'down';
  nodes.state.textContent = 'offline';
  nodes.label.textContent = `cannot reach the roost daemon (${err.message})`;
});
