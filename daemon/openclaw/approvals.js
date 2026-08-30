import { approvalCorrelation, safeApprovalSummary } from './approval-spike.js';

export const SAFE_DECISIONS = new Set(['allow-once', 'deny']);
export const SAFE_STATUSES = new Set(['pending', 'allowed', 'denied', 'expired', 'cancelled']);
const UNSUPPORTED_PLUGIN_ID = 'openclaw-codex-app-server';
const DEFAULT_MAX_RESOLVED = 256;

function finiteTimestamp(value) {
  return Number.isFinite(value) ? value : null;
}

function deriveLabel(presentation) {
  const candidates = [presentation?.title, presentation?.label, presentation?.description, presentation?.detail];
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
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
  const label = deriveLabel(approval?.presentation);

  // Keep the full derived label in memory here. aggregate.js applies the 64-char
  // schema cap and detects truncation there; truncating earlier would make
  // `kind: "handoff"` unreachable for long but otherwise safe labels.
  return {
    id: approval.id,
    gatewayKind: kind,
    reversible: deriveReversible(approval.presentation),
    status: approval.status,
    expiresAtMs: finiteTimestamp(approval?.expiresAtMs),
    allowedDecisions,
    label,
    actionable: actionableWithPair(allowedDecisions) && !fromTruncatedReplay,
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

function choosePrompt(entries) {
  return entries
    .slice()
    .sort((a, b) =>
      (finiteTimestamp(a?.expiresAtMs) ?? Number.POSITIVE_INFINITY)
      - (finiteTimestamp(b?.expiresAtMs) ?? Number.POSITIVE_INFINITY)
      || String(a?.id).localeCompare(String(b?.id))
    )[0] ?? null;
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
        if (approval.expiresAtMs !== null && approval.expiresAtMs <= now) entries.delete(id);
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
    this.expire();
    const current = this.pendingBySession.get(sessionKey);
    if (!current) return null;
    const prompt = choosePrompt([...current.values()]);
    if (!prompt) return null;
    return actionable ? prompt : { ...prompt, actionable: false };
  }
}
