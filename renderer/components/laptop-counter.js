/**
 * The "had to open the laptop" instrument, as a shared component.
 *
 * Any surface that wants to show or collect the metric imports this module.
 * It owns its own markup, its own styles hook, and its own retry queue, so a
 * new renderer gets correct behaviour by mounting it rather than by
 * reimplementing the rules.
 *
 * Data flow:
 *   count in   <- MQTT, retained, topic roost/instrument/laptop-opens
 *   tap out    -> POST to the daemon's loopback HTTP
 *
 * Reading over MQTT means every screen shows the same number without polling,
 * and a screen that starts late gets the current count immediately because the
 * topic is retained. Writing over HTTP keeps the browser's broker credential
 * subscribe-only: a page that could publish could also forge the metric.
 *
 * Plain ES module, no framework, no build step.
 */

/** Layout variants. Both are spiked so they can be compared on real glass. */
export const VARIANTS = ['corner', 'header'];

const DEFAULT_VARIANT = 'corner';

export function resolveVariant(value) {
  return VARIANTS.includes(value) ? value : DEFAULT_VARIANT;
}

/**
 * Pure: what the control should read, given what we know.
 *
 * @param {{count: number|null, pending: number, phase: 'idle'|'saved'|'failed'}} state
 */
export function counterView({ count, pending = 0, phase = 'idle' }) {
  // Zero is the TARGET of this metric, so it must never be displayed before it
  // is actually known — that would be a lie about the thing being measured.
  const known = Number.isFinite(count);
  const total = (known ? count : 0) + pending;
  const display = known || pending > 0 ? String(total) : '—';

  let hint = '';
  if (phase === 'failed') hint = 'kept locally, will sync';
  else if (pending > 0) hint = `${pending} waiting to sync`;

  return {
    display,
    status: phase,
    hint,
    label: `had to open the laptop: ${display} times. Tap to record another.`,
  };
}

const span = (className) => {
  const el = document.createElement('span');
  el.className = className;
  return el;
};

/**
 * Built with DOM calls rather than innerHTML: no string ever becomes markup.
 *
 * Both variants are icon plus count, no words. What the control means lives in
 * its aria-label instead, because a panel tapped a few times a month should not
 * spend permanent pixels explaining itself.
 */
function buildContents(button) {
  const icon = span('lc-icon');
  icon.setAttribute('aria-hidden', 'true');
  button.appendChild(icon);

  const count = span('lc-count');
  count.textContent = '—';
  button.appendChild(count);
}

/**
 * Mount the control into `root`.
 *
 * @param {Element} root
 * @param {{variant?: string, onRecord: () => Promise<number>}} options
 *        onRecord persists one tap and resolves with the authoritative count.
 * @returns {{setCount: (n: number|null) => void, element: Element}}
 */
export function mount(root, { variant = DEFAULT_VARIANT, onRecord } = {}) {
  const chosen = resolveVariant(variant);

  const button = document.createElement('button');
  button.type = 'button';
  button.className = `laptop-counter lc-${chosen}`;
  buildContents(button);
  root.appendChild(button);

  const countEl = button.querySelector('.lc-count');
  const hintEl = document.createElement('span');
  hintEl.className = 'lc-hint';
  button.appendChild(hintEl);

  const state = { count: null, pending: readQueue().length, phase: 'idle' };

  function paint() {
    const view = counterView(state);
    countEl.textContent = view.display;
    hintEl.textContent = view.hint;
    button.dataset.status = view.status;
    button.setAttribute('aria-label', view.label);
    button.classList.toggle('lc-has-hint', view.hint !== '');
  }

  let resetTimer = null;
  function flash(phase) {
    state.phase = phase;
    paint();
    clearTimeout(resetTimer);
    resetTimer = setTimeout(() => { state.phase = 'idle'; paint(); }, 1600);
  }

  button.addEventListener('click', async () => {
    // Optimistic: the tap is acknowledged instantly, then reconciled against
    // whatever the daemon says. A control that feels laggy gets tapped twice.
    state.count = Number.isFinite(state.count) ? state.count + 1 : state.count;
    paint();
    try {
      const authoritative = await onRecord();
      state.count = authoritative;
      flash('saved');
    } catch {
      // An instrument that silently drops data points measures nothing.
      enqueue(new Date().toISOString());
      state.pending = readQueue().length;
      flash('failed');
    }
  });

  paint();

  return {
    element: button,
    /** Called when a retained counter message arrives. */
    setCount(next) {
      state.count = Number.isFinite(next) ? next : null;
      state.pending = readQueue().length;
      paint();
    },
    /** Called after the retry queue drains. */
    refreshPending() {
      state.pending = readQueue().length;
      paint();
    },
  };
}

// ---- local retry queue ----------------------------------------------------
// Taps made while the daemon is unreachable are held here and replayed.

const QUEUE_KEY = 'roost.pendingLaptopOpens';

export function readQueue() {
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); } catch { return []; }
}

export function writeQueue(list) {
  try { localStorage.setItem(QUEUE_KEY, JSON.stringify(list)); } catch { /* full or blocked */ }
}

function enqueue(stamp) {
  writeQueue([...readQueue(), stamp]);
}

/**
 * Replay queued taps. Stops at the first failure so ordering is preserved and
 * the daemon is not hammered while it is down.
 *
 * @param {() => Promise<number>} onRecord
 */
export async function flushQueue(onRecord) {
  const queued = readQueue();
  if (queued.length === 0) return { flushed: 0, remaining: 0 };
  const remaining = [...queued];
  let flushed = 0;
  while (remaining.length) {
    try { await onRecord(); remaining.shift(); flushed += 1; }
    catch { break; }
  }
  writeQueue(remaining);
  return { flushed, remaining: remaining.length };
}
