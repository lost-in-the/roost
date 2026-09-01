export function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

export function timeDisplay({ state, since, expiresAt, now }) {
  if (state === 'needs_attention' && Number.isFinite(expiresAt)) {
    const remaining = expiresAt - now;
    return remaining > 0 ? `expires in ${formatDuration(remaining)}` : 'expired';
  }
  if (!Number.isFinite(since) || state === 'idle' || state === 'offline') return '';
  const duration = formatDuration(now - since);
  return state === 'stalled' ? `stuck ${duration}` : duration;
}
