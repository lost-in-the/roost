import test from 'node:test';
import assert from 'node:assert/strict';
import { rosterView } from '../renderer/components/agent-roster.js';

test('roster displays daemon order and distinguishes same-gateway actors', () => {
  assert.deepEqual(rosterView([
    { gateway: 'Labby', name: 'Labby', state: 'thinking', active: 1, pending: 0, primary: true },
    { gateway: 'Omar', name: 'Claude', state: 'needs_attention', active: 2, pending: 3, primary: false },
  ]), [
    { label: 'Labby', state: 'thinking', active: 1, pending: 0, primary: true },
    { label: 'Omar · Claude', state: 'needs_attention', active: 2, pending: 3, primary: false },
  ]);
});

test('roster ignores malformed entries instead of inventing identity or state', () => {
  assert.deepEqual(rosterView([null, { gateway: 'Labby', name: '', state: 'idle' }, { gateway: 'X', name: 'X', state: 'unknown' }]), []);
});
