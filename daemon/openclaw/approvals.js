import { approvalCorrelation, safeApprovalSummary } from './approval-spike.js';

export const SAFE_DECISIONS = new Set(['allow-once', 'deny']);
export const SAFE_STATUSES = new Set(['pending', 'allowed', 'denied', 'expired', 'cancelled']);
const UNSUPPORTED_PLUGIN_ID = 'openclaw-codex-app-server';
const DEFAULT_MAX_RESOLVED = 256;

function finiteTimestamp(value) {
  return Number.isFinite(value) ? value : null;
}

function cleanText(value) {
  if (typeof value !== 'string') return null;
  const clean = value.trim();
  const unsafe = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
  return clean !== '' && !unsafe.test(clean) ? clean : null;
}

function deriveSummary(presentation) {
  // Only the presentation title crosses Roost's retained/browser boundary.
  // Plugin descriptions and details can contain serialized tool input,
  // commands and paths. They are reviewer-safe inside OpenClaw, but D-015
  // deliberately does not make them persistence-safe for MQTT.
  const title = cleanText(presentation?.title) ?? cleanText(presentation?.label);
  const genericClaudeTitle = title?.startsWith('Claude native tool: ') === true;
  return {
    label: title,
    // A tool class is not enough information to approve an action. Keep it
    // visible as a handoff, but never put Allow beside it.
    sufficient: title !== null && !genericClaudeTitle,
  };
}

function deriveReversible(presentation) {
  const metadata = presentation?.metadata;
  const candidates = [
    presentation?.reversible,
    presentation?.isReversible,
    presentation?.requiresConfirmation === true ? false : undefined,
    metadata?.reversible,
    metadata?.isReversible,
  ];
  for (const value of candidates) {
    if (typeof value === 'boolean') return value;
  }
  return false;
}

function actionableWithPair(allowedDecisions) {
  return allowedDecisions.includes('allow-once') && allowedDecisions.includes('deny');
}

export function isTerminalApprovalStatus(status) {
  return typeof status === 'string' && SAFE_STATUSES.has(status) && status !== 'pending';
}

export function projectApproval(approval, {
  fromTruncatedReplay = false,
  onDrop = () => {},
} = {}) {
  if (approval?.pluginId === UNSUPPORTED_PLUGIN_ID) {
    onDrop(`dropping approval correlation=${approvalCorrelation(approval?.id)} pluginId=${UNSUPPORTED_PLUGIN_ID}`);
    return null;
  }
  if (typeof approval?.id !== 'string' || approval.id === '') return null;
  if (!SAFE_STATUSES.has(approval?.status)) return null;

  const kind = typeof approval?.presentation?.kind === 'string'
    ? approval.presentation.kind
    : null;
  if (!kind) return null;

  const allowedDecisions = Array.isArray(approval?.presentation?.allowedDecisions)
    ? approval.presentation.allowedDecisions.filter((decision) => SAFE_DECISIONS.has(decision))
    : [];
  const summary = deriveSummary(approval?.presentation);

  // Keep the full derived label in memory here. aggregate.js applies the 64-char
  // schema cap and detects truncation there; truncating earlier would make
  // `kind: "handoff"` unreachable for long but otherwise safe labels.
  return {
    id: approval.id,
    gatewayKind: kind,
    reversible: deriveReversible(approval.presentation),
    status: approval.status,
    createdAtMs: finiteTimestamp(approval?.createdAtMs),
    expiresAtMs: finiteTimestamp(approval?.expiresAtMs),
    allowedDecisions,
    label: summary.label,
    actorId: cleanText(approval?.presentation?.agentId),
    actionable: actionableWithPair(allowedDecisions)
      && summary.sufficient
      && !fromTruncatedReplay,
  };
}

function terminalRecord(approval) {
  const summary = safeApprovalSummary(approval);
  return {
    status: summary.status,
    decision: summary.decision ?? null,
    resolvedAtMs: summary.resolvedAtMs ?? null,
    correlation: summary.correlation,
  };
}

export function expiredTerminalRecord(id, resolvedAtMs = Date.now()) {
  return {
    status: 'expired',
    decision: null,
    resolvedAtMs,
    correlation: safeApprovalSummary({ id }).correlation,
  };
}

export class PendingApprovalStore {
  constructor({ now = () => Date.now(), maxResolved = DEFAULT_MAX_RESOLVED } = {}) {
    this.now = now;
    this.maxResolved = Math.max(1, Math.floor(maxResolved));
    this.pendingBySession = new Map();
    this.resolved = new Map();
  }

  pruneResolved() {
    while (this.resolved.size > this.maxResolved) {
      const oldestId = this.resolved.keys().next().value;
      this.resolved.delete(oldestId);
    }
  }

  pruneSessions(liveSessionKeys = []) {
    const live = new Set(liveSessionKeys);
    for (const key of this.pendingBySession.keys()) {
      if (!live.has(key)) this.pendingBySession.delete(key);
    }
  }

  expire() {
    const now = this.now();
    for (const entries of this.pendingBySession.values()) {
      for (const [id, approval] of entries) {
        if (approval.expiresAtMs !== null && approval.expiresAtMs <= now) {
          this.rememberResolved(id, expiredTerminalRecord(id, now));
          entries.delete(id);
        }
      }
    }
    for (const [sessionKey, entries] of this.pendingBySession) {
      if (entries.size === 0) this.pendingBySession.delete(sessionKey);
    }
  }

  replaceReplay(sessionKey, projectedApprovals, { truncated = false } = {}) {
    this.expire();
    const next = new Map(projectedApprovals.map((approval) => [approval.id, {
      ...approval,
      actionable: truncated ? false : approval.actionable,
    }]));
    if (!truncated) {
      this.pendingBySession.set(sessionKey, next);
      return;
    }
    const current = this.pendingBySession.get(sessionKey) ?? new Map();
    const merged = new Map(next);
    for (const [id, approval] of current) {
      if (!next.has(id)) merged.set(id, { ...approval, actionable: false });
    }
    this.pendingBySession.set(sessionKey, merged);
  }

  upsertPending(sessionKey, approval) {
    this.expire();
    const current = this.pendingBySession.get(sessionKey) ?? new Map();
    current.set(approval.id, approval);
    this.pendingBySession.set(sessionKey, current);
  }

  resolve(sessionKey, approval) {
    const current = this.pendingBySession.get(sessionKey);
    current?.delete(approval.id);
    if (current && current.size === 0) this.pendingBySession.delete(sessionKey);
    this.rememberResolved(approval.id, terminalRecord(approval));
  }

  rememberResolved(id, record) {
    this.resolved.delete(id);
    this.resolved.set(id, record);
    // This cache exists only to distinguish "already answered" from "unknown
    // approval", so a capped FIFO is enough and cannot grow without bound.
    this.pruneResolved();
  }

  getResolved(id) {
    return this.resolved.get(id) ?? null;
  }

  findPending(id) {
    this.expire();
    for (const [sessionKey, entries] of this.pendingBySession) {
      const approval = entries.get(id);
      if (approval) return { sessionKey, entries, approval };
    }
    return null;
  }

  getPrompt(sessionKey, { actionable = true } = {}) {
    return this.getPrompts(sessionKey, { actionable })[0] ?? null;
  }

  getPrompts(sessionKey, { actionable = true } = {}) {
    this.expire();
    const current = this.pendingBySession.get(sessionKey);
    if (!current) return [];
    const prompts = [...current.values()]
      .slice()
      .sort((a, b) =>
        (finiteTimestamp(a?.expiresAtMs) ?? Number.POSITIVE_INFINITY)
        - (finiteTimestamp(b?.expiresAtMs) ?? Number.POSITIVE_INFINITY)
        || (finiteTimestamp(a?.createdAtMs) ?? Number.POSITIVE_INFINITY)
        - (finiteTimestamp(b?.createdAtMs) ?? Number.POSITIVE_INFINITY)
        || String(a?.id).localeCompare(String(b?.id))
      );
    return actionable ? prompts : prompts.map((prompt) => ({ ...prompt, actionable: false }));
  }
}
