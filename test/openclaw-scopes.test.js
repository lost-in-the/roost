import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  READ_ONLY_SCOPES,
  mergeScopes,
  missingScopes,
  parseScopes,
  satisfies,
  scopesFromArgv,
} from '../daemon/openclaw/scopes.js';

test('parseScopes accepts commas, whitespace, or an array', () => {
  assert.deepEqual(parseScopes('operator.read,operator.approvals'), ['operator.read', 'operator.approvals']);
  assert.deepEqual(parseScopes('operator.read operator.approvals'), ['operator.read', 'operator.approvals']);
  assert.deepEqual(parseScopes(['operator.read', 'operator.approvals']), ['operator.read', 'operator.approvals']);
});

test('parseScopes trims, drops empties, and de-duplicates in first-seen order', () => {
  assert.deepEqual(parseScopes(' operator.read , , operator.read,operator.approvals '), [
    'operator.read',
    'operator.approvals',
  ]);
  assert.deepEqual(parseScopes(''), []);
  assert.deepEqual(parseScopes(null), []);
  assert.deepEqual(parseScopes(undefined), []);
});

test('operator.admin satisfies every operator scope', () => {
  // docs/gateway/operator-scopes.md: "Satisfies every operator.* scope."
  assert.equal(satisfies(['operator.admin'], 'operator.read'), true);
  assert.equal(satisfies(['operator.admin'], 'operator.approvals'), true);
  assert.equal(satisfies(['operator.admin'], 'operator.some.future.scope'), true);
});

test('operator.write satisfies read and talk, but NOT approvals', () => {
  // The negative case is the one that matters: assuming write implied
  // approvals would make roost skip a required upgrade and fail at runtime.
  assert.equal(satisfies(['operator.write'], 'operator.read'), true);
  assert.equal(satisfies(['operator.write'], 'operator.talk'), true);
  assert.equal(satisfies(['operator.write'], 'operator.approvals'), false);
});

test('an unknown scope requires an exact match', () => {
  assert.equal(satisfies(['operator.read'], 'operator.questions'), false);
  assert.equal(satisfies(['operator.questions'], 'operator.questions'), true);
});

test('missingScopes reports only what is not already covered', () => {
  assert.deepEqual(missingScopes(['operator.read'], ['operator.read', 'operator.approvals']), [
    'operator.approvals',
  ]);
  assert.deepEqual(missingScopes(['operator.read'], ['operator.read']), []);
  assert.deepEqual(missingScopes(['operator.admin'], ['operator.approvals']), []);
});

test('a read-only roost asking for M2 scopes needs exactly the approvals upgrade', () => {
  const missing = missingScopes(READ_ONLY_SCOPES, ['operator.read', 'operator.approvals']);
  assert.deepEqual(missing, ['operator.approvals']);
});

test('mergeScopes unions, keeping the held scopes first', () => {
  // Requesting only the NEW scope would narrow the pairing contract and cost
  // roost the operator.read it already runs on.
  assert.deepEqual(mergeScopes(['operator.read'], ['operator.approvals']), [
    'operator.read',
    'operator.approvals',
  ]);
  assert.deepEqual(mergeScopes(['operator.read'], ['operator.read']), ['operator.read']);
  assert.deepEqual(mergeScopes([], ['operator.read']), ['operator.read']);
});

test('scopesFromArgv defaults to read-only when the flag is absent', () => {
  assert.deepEqual(scopesFromArgv([]), READ_ONLY_SCOPES);
  assert.deepEqual(scopesFromArgv(['--other', 'x']), READ_ONLY_SCOPES);
});

test('scopesFromArgv accepts both --scopes a,b and --scopes=a,b', () => {
  assert.deepEqual(scopesFromArgv(['--scopes', 'operator.read,operator.approvals']), [
    'operator.read',
    'operator.approvals',
  ]);
  assert.deepEqual(scopesFromArgv(['--scopes=operator.read,operator.approvals']), [
    'operator.read',
    'operator.approvals',
  ]);
});

test('scopesFromArgv returns null when the flag carries no value', () => {
  // Never silently fall back to the read-only default here: someone who typed
  // --scopes meant to widen the request, and a silent default would pair with
  // the wrong scopes and look like it worked.
  assert.equal(scopesFromArgv(['--scopes']), null);
  assert.equal(scopesFromArgv(['--scopes', '']), null);
  assert.equal(scopesFromArgv(['--scopes=']), null);
});

test('mergeScopes does not drop a held scope that the request omits', () => {
  assert.deepEqual(mergeScopes(['operator.read', 'operator.talk'], ['operator.approvals']), [
    'operator.read',
    'operator.talk',
    'operator.approvals',
  ]);
});
