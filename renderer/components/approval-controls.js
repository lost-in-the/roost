/**
 * Approval controls for touch surfaces.
 *
 * The daemon decides what this prompt means. The renderer only draws from the
 * safe prompt contract and never retries or queues answers.
 */

export const CONFIRM_MS = 4_000;

const ACTION_TEXT = {
  deny: 'Deny',
  'allow-once': 'Allow once',
};

const APPLIED_TEXT = {
  deny: 'denied',
  'allow-once': 'allowed once',
};

const NON_ANSWERABLE_CODES = new Set(['expired', 'not_actionable', 'gateway_stale']);
const TERMINAL_STATUS_FOR = new Map([
  ['deny', 'denied'],
  ['allow-once', 'allowed'],
]);

function normalizePrompt(prompt) {
  if (!prompt || typeof prompt !== 'object') return null;
  if (typeof prompt.id !== 'string' || prompt.id.length === 0) return null;
  if (prompt.kind !== 'approve_reject' && prompt.kind !== 'handoff') return null;
  if (typeof prompt.reversible !== 'boolean') return null;

  let expiresAtMs = null;
  if (prompt.expires_at !== undefined && prompt.expires_at !== null) {
    if (typeof prompt.expires_at !== 'string') return null;
    expiresAtMs = Date.parse(prompt.expires_at);
    if (!Number.isFinite(expiresAtMs)) return null;
  }

  return {
    id: prompt.id,
    kind: prompt.kind,
    reversible: prompt.reversible,
    expiresAtMs,
  };
}

function isExpired(prompt, now) {
  return prompt.expiresAtMs != null && now >= prompt.expiresAtMs;
}

function samePrompt(id, prompt) {
  return Boolean(prompt && id === prompt.id);
}

export function reducePhase(previous = {}, event, now = Date.now()) {
  const next = {
    armedPromptId: previous.armedPromptId ?? null,
    armedUntil: previous.armedUntil ?? 0,
    inFlightPromptId: previous.inFlightPromptId ?? null,
    disabledPromptId: previous.disabledPromptId ?? null,
    outcome: previous.outcome ?? null,
  };

  switch (event.type) {
    case 'prompt-changed':
      if (event.promptId !== previous.armedPromptId) {
        next.armedPromptId = null;
        next.armedUntil = 0;
      }
      if (event.promptId !== previous.inFlightPromptId) next.inFlightPromptId = null;
      if (event.promptId !== previous.disabledPromptId) {
        next.disabledPromptId = null;
        next.outcome = null;
      }
      return next;

    case 'tick':
      if (next.armedPromptId && now >= next.armedUntil) {
        next.armedPromptId = null;
        next.armedUntil = 0;
      }
      return next;

    case 'arm-confirm':
      next.armedPromptId = event.promptId;
      next.armedUntil = now + CONFIRM_MS;
      return next;

    case 'submit-start':
      next.inFlightPromptId = event.promptId;
      next.armedPromptId = null;
      next.armedUntil = 0;
      return next;

    case 'submit-result':
      next.inFlightPromptId = null;
      next.disabledPromptId = event.promptId;
      next.outcome = { promptId: event.promptId, ok: event.ok, code: event.code, decision: event.decision };
      return next;

    default:
      return next;
  }
}

export function outcomeMessage(outcome) {
  if (!outcome) return '';
  if (outcome.ok) return `Applied: ${APPLIED_TEXT[outcome.decision] || outcome.decision}.`;
  if (outcome.code === 'already_answered') return 'Already answered.';
  if (NON_ANSWERABLE_CODES.has(outcome.code)) return 'This decision is no longer answerable here.';
  if (outcome.code === 'transport_uncertain') return 'Result unknown. Check on a laptop.';
  return 'Approval failed.';
}

export function promptView({ prompt, state, stale, now, phase = {} }) {
  const normalized = normalizePrompt(prompt);
  if (!normalized) {
    return {
      visible: false,
      promptId: null,
      line: '',
      message: '',
      disabled: true,
      buttons: [],
    };
  }

  const expired = isExpired(normalized, now);
  const deadSurface = stale || state === 'offline';
  const inFlight = samePrompt(phase.inFlightPromptId, normalized);
  const locked = samePrompt(phase.disabledPromptId, normalized);
  const armed = samePrompt(phase.armedPromptId, normalized) && now < (phase.armedUntil || 0);
  const message = locked && phase.outcome ? outcomeMessage(phase.outcome) : '';

  if (normalized.kind === 'handoff') {
    return {
      visible: true,
      promptId: normalized.id,
      line: expired ? 'Decision expired.' : 'A decision is waiting. Answer it elsewhere.',
      message,
      disabled: true,
      buttons: [],
    };
  }

  let line = '';
  if (expired) line = 'Decision expired.';
  else if (deadSurface) line = 'This panel cannot answer right now.';
  else if (inFlight) line = 'Sending decision...';
  else if (locked) line = message || 'This decision is no longer answerable here.';
  else if (!normalized.reversible && armed) line = 'Tap allow once again to confirm.';

  const controlsDisabled = expired || deadSurface || inFlight || locked;
  const buttons = [
    {
      decision: 'deny',
      text: ACTION_TEXT.deny,
      ariaLabel: 'Deny this decision',
      disabled: controlsDisabled,
      confirm: false,
      armed: false,
    },
    {
      decision: 'allow-once',
      text: armed ? 'Confirm allow once' : ACTION_TEXT['allow-once'],
      ariaLabel: normalized.reversible ? 'Allow this decision once' : 'Allow this decision once with confirmation',
      disabled: controlsDisabled,
      confirm: !normalized.reversible,
      armed,
    },
  ];

  return {
    visible: true,
    promptId: normalized.id,
    line,
    message,
    disabled: controlsDisabled,
    buttons,
  };
}

export function canSubmit({ view, snapshot, decision }) {
  if (!view?.visible || !Array.isArray(view.buttons)) return false;
  if (snapshot?.stale || snapshot?.state === 'offline') return false;
  const chosen = view.buttons.find((entry) => entry.decision === decision);
  return Boolean(chosen && !chosen.disabled);
}

export function readDecisionResponse({ ok, status, body }) {
  if (ok) {
    const expected = typeof body?.decision === 'string'
      ? TERMINAL_STATUS_FOR.get(body.decision)
      : undefined;
    if (body?.ok === true && expected !== undefined && body.status === expected) {
      return { ok: true, decision: body.decision, code: null };
    }
    return { ok: false, decision: null, code: 'transport_uncertain' };
  }

  if (typeof body?.code === 'string' && body.code.length > 0) {
    return { ok: false, decision: null, code: body.code };
  }

  return { ok: false, decision: null, code: `http_${status}` };
}

async function postDecision(promptId, decision) {
  const res = await fetch('/api/approval', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: promptId, decision }),
  });

  let body = null;
  try { body = await res.json(); } catch { /* plain failure path below */ }
  return readDecisionResponse({ ok: res.ok, status: res.status, body });
}

export function mount(root, { getSnapshot, onToast, now = () => Date.now() } = {}) {
  const wrap = document.createElement('section');
  wrap.className = 'approval-controls';
  wrap.hidden = true;

  const line = document.createElement('p');
  line.className = 'approval-line';
  wrap.appendChild(line);

  const row = document.createElement('div');
  row.className = 'approval-buttons';
  wrap.appendChild(row);

  const buttons = new Map();
  for (const decision of ['deny', 'allow-once']) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.decision = decision;
    button.className = `approval-button approval-${decision}`;
    row.appendChild(button);
    buttons.set(decision, button);
  }

  root.appendChild(wrap);

  let currentPromptId = null;
  let timer = null;
  let phase = reducePhase({}, { type: 'prompt-changed', promptId: null }, now());

  function schedule() {
    clearTimeout(timer);
    if (phase.armedPromptId && phase.armedUntil > now()) {
      timer = setTimeout(() => {
        phase = reducePhase(phase, { type: 'tick' }, now());
        paint();
      }, Math.max(0, phase.armedUntil - now()));
    }
  }

  function paint() {
    const snapshot = getSnapshot();
    if (snapshot.prompt?.id !== currentPromptId) {
      currentPromptId = snapshot.prompt?.id ?? null;
      phase = reducePhase(phase, { type: 'prompt-changed', promptId: currentPromptId }, now());
    } else {
      phase = reducePhase(phase, { type: 'tick' }, now());
    }

    const view = promptView({ ...snapshot, now: now(), phase });
    wrap.hidden = !view.visible;
    if (!view.visible) {
      wrap.dataset.disabled = 'yes';
      line.textContent = '';
      schedule();
      return;
    }

    wrap.dataset.disabled = view.disabled ? 'yes' : 'no';
    line.textContent = view.message || view.line;

    for (const button of buttons.values()) button.hidden = true;
    for (const spec of view.buttons) {
      const button = buttons.get(spec.decision);
      button.hidden = false;
      button.disabled = spec.disabled;
      button.textContent = spec.text;
      button.setAttribute('aria-label', `${spec.ariaLabel}: ${snapshot.label || 'decision pending'}`);
      button.dataset.armed = spec.armed ? 'yes' : 'no';
    }

    schedule();
  }

  row.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-decision]');
    if (!button) return;

    const snapshot = getSnapshot();
    const view = promptView({ ...snapshot, now: now(), phase });
    if (!canSubmit({ view, snapshot, decision: button.dataset.decision })) return;
    const chosen = view.buttons.find((entry) => entry.decision === button.dataset.decision);

    if (chosen.decision === 'allow-once' && chosen.confirm && !chosen.armed) {
      phase = reducePhase(phase, { type: 'arm-confirm', promptId: view.promptId }, now());
      paint();
      return;
    }

    phase = reducePhase(phase, { type: 'submit-start', promptId: view.promptId }, now());
    paint();

    let result;
    try { result = await postDecision(view.promptId, chosen.decision); }
    catch { result = { ok: false, code: 'network_failure' }; }

    phase = reducePhase(phase, {
      type: 'submit-result',
      promptId: view.promptId,
      ok: result.ok,
      code: result.code || null,
      decision: result.decision || chosen.decision,
    }, now());
    paint();
    if (phase.outcome) onToast?.(outcomeMessage(phase.outcome));
  });

  paint();

  return {
    element: wrap,
    refresh() { paint(); },
  };
}
