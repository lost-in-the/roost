import test from 'node:test';
import assert from 'node:assert/strict';
import { timeDisplay } from '../renderer/components/time-display.js';

test('an expiring approval counts down to the same zero boundary as its controls', () => {
  const expiresAt = 100_000;
  assert.equal(timeDisplay({ state: 'needs_attention', since: 0, expiresAt, now: 1_000 }), 'expires in 1m 39s');
  assert.equal(timeDisplay({ state: 'needs_attention', since: 0, expiresAt, now: expiresAt }), 'expired');
  assert.equal(timeDisplay({ state: 'needs_attention', since: 0, expiresAt, now: expiresAt + 1 }), 'expired');
});

test('non-expiring work keeps elapsed semantics and stalled wording', () => {
  assert.equal(timeDisplay({ state: 'thinking', since: 1_000, expiresAt: null, now: 6_000 }), '5s');
  assert.equal(timeDisplay({ state: 'stalled', since: 1_000, expiresAt: null, now: 66_000 }), 'stuck 1m 05s');
});
