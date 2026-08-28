import crypto from 'node:crypto';

const SAFE_DECISIONS = new Set(['allow-once', 'deny']);
const SAFE_STATUSES = new Set(['pending', 'allowed', 'denied', 'expired', 'cancelled']);

export function approvalCorrelation(id) {
  if (typeof id !== 'string' || id.length === 0) throw new Error('approval has no id');
  return crypto.createHash('sha256').update(id).digest('hex').slice(0, 12);
}

export function assertSpikeDecision(decision) {
  if (!SAFE_DECISIONS.has(decision)) {
    throw new Error('spike decision must be allow-once or deny');
  }
  return decision;
}

/**
 * The live projection may contain commands, paths, patches, and prompts inside
 * `presentation`. This is the complete allowlist for anything the spike may
 * print or persist. Keep the raw approval in memory only.
 */
export function safeApprovalSummary(approval) {
  const status = SAFE_STATUSES.has(approval?.status) ? approval.status : 'unknown';
  const kind = typeof approval?.presentation?.kind === 'string'
    ? approval.presentation.kind
    : 'unknown';
  const allowedDecisions = Array.isArray(approval?.presentation?.allowedDecisions)
    ? approval.presentation.allowedDecisions.filter((decision) => SAFE_DECISIONS.has(decision))
    : [];

  return {
    correlation: approvalCorrelation(approval?.id),
    kind,
    status,
    allowedDecisions,
    createdAtMs: Number.isFinite(approval?.createdAtMs) ? approval.createdAtMs : null,
    expiresAtMs: Number.isFinite(approval?.expiresAtMs) ? approval.expiresAtMs : null,
    ...(Number.isFinite(approval?.resolvedAtMs) ? { resolvedAtMs: approval.resolvedAtMs } : {}),
    ...(SAFE_DECISIONS.has(approval?.decision) ? { decision: approval.decision } : {}),
  };
}

export function safeReplaySummary(replay) {
  const approvals = Array.isArray(replay?.approvals) ? replay.approvals : [];
  return {
    count: approvals.length,
    truncated: replay?.truncated === true,
    correlations: approvals.map((approval) => approvalCorrelation(approval?.id)),
  };
}

export function safeResolutionSummary(result) {
  return {
    applied: result?.applied === true,
    approval: safeApprovalSummary(result?.approval),
  };
}

