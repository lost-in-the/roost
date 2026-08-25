/**
 * Operator scope arithmetic for pairing and scope upgrades.
 *
 * Pure functions, no I/O. The pairing script decides whether to no-op or to
 * raise an upgrade request purely from these, so the decision is unit-testable
 * without a gateway.
 *
 * Satisfaction rules are transcribed from the installed openclaw package,
 * docs/gateway/operator-scopes.md "Scope levels":
 *
 *   operator.admin   "Satisfies every operator.* scope."
 *   operator.write   "Also satisfies operator.read."
 *   operator.talk    "operator.write also satisfies this scope."
 *
 * and the closing rule of that section:
 *
 *   "Unknown future operator.* scopes require an exact match unless the caller
 *    already holds operator.admin."
 *
 * That last line is why this deliberately does NOT invent a hierarchy:
 * `operator.approvals` is NOT implied by `operator.write`. Assuming it were
 * would make roost skip a required upgrade request and then fail at runtime
 * with an authorization error that looks like a bug in the daemon.
 */

export const READ_ONLY_SCOPES = ['operator.read'];

/** Scopes each scope implies, beyond itself. Admin is handled separately. */
const IMPLIES = {
  'operator.write': ['operator.read', 'operator.talk'],
};

/**
 * Parse a scope list from CLI input or config.
 * Accepts an array, or a string separated by commas and/or whitespace.
 * Trims, drops empties, de-duplicates, preserves first-seen order.
 */
export function parseScopes(input) {
  const raw = Array.isArray(input) ? input : String(input ?? '').split(/[,\s]+/);
  const out = [];
  for (const item of raw) {
    const scope = String(item ?? '').trim();
    if (scope && !out.includes(scope)) out.push(scope);
  }
  return out;
}

/** Whether `held` covers `wanted`, applying the documented satisfaction rules. */
export function satisfies(held, wanted) {
  if (held.includes('operator.admin')) return true;
  if (held.includes(wanted)) return true;
  return held.some((h) => (IMPLIES[h] ?? []).includes(wanted));
}

/** The requested scopes that `held` does not already cover. Order preserved. */
export function missingScopes(held, requested) {
  const have = parseScopes(held);
  return parseScopes(requested).filter((scope) => !satisfies(have, scope));
}

/**
 * Read `--scopes a,b` or `--scopes=a,b` out of an argv tail.
 *
 * Returns the default read-only set when the flag is absent, and `null` when
 * the flag is present but carries no value — the caller decides how loudly to
 * fail, so this stays pure and testable without a gateway or a process exit.
 */
export function scopesFromArgv(argv) {
  const flag = (argv ?? []).findIndex((a) => a === '--scopes' || String(a).startsWith('--scopes='));
  if (flag === -1) return READ_ONLY_SCOPES;
  const raw = String(argv[flag]).startsWith('--scopes=')
    ? String(argv[flag]).slice('--scopes='.length)
    : argv[flag + 1];
  const parsed = parseScopes(raw);
  return parsed.length > 0 ? parsed : null;
}

/**
 * The scope set to request when upgrading.
 *
 * Union, existing first. Asking for only the NEW scope would narrow the
 * pairing contract to that one scope: the gateway negotiates exactly what the
 * connect frame requests, so a bare `operator.approvals` upgrade would cost
 * roost the `operator.read` it already relies on.
 */
export function mergeScopes(held, requested) {
  const out = parseScopes(held);
  for (const scope of parseScopes(requested)) if (!out.includes(scope)) out.push(scope);
  return out;
}
