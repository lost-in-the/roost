import test from 'node:test';
import assert from 'node:assert/strict';
import { isStale } from '../renderer/staleness.js';

const STALE_MS = 30_000;
const LOADED = 1_000_000;

test('a message that arrived just now is not stale', () => {
  assert.equal(
    isStale({ now: LOADED + 5_000, lastMessageAt: LOADED + 4_000, startedAt: LOADED, staleMs: STALE_MS }),
    false,
  );
});

test('a long thinking turn is not stale while heartbeats keep arriving', () => {
  // The agent has been thinking for ten minutes; the last heartbeat was 3s ago.
  assert.equal(
    isStale({ now: LOADED + 600_000, lastMessageAt: LOADED + 597_000, startedAt: LOADED, staleMs: STALE_MS }),
    false,
  );
});

test('silence for longer than the threshold is stale', () => {
  assert.equal(
    isStale({ now: LOADED + 40_000, lastMessageAt: LOADED + 5_000, startedAt: LOADED, staleMs: STALE_MS }),
    true,
  );
});

test('one dropped heartbeat is tolerated', () => {
  // Heartbeat is 10s, threshold 30s: a single miss must not raise an alarm.
  assert.equal(
    isStale({ now: LOADED + 21_000, lastMessageAt: LOADED + 1_000, startedAt: LOADED, staleMs: STALE_MS }),
    false,
  );
});

test('a panel that has just started is not stale while it connects', () => {
  assert.equal(
    isStale({ now: LOADED + 3_000, lastMessageAt: 0, startedAt: LOADED, staleMs: STALE_MS }),
    false,
    'a brief connecting state is normal on boot',
  );
});

test('a panel that never receives anything goes stale on its own', () => {
  // The failure this exists for: the panel starts while the broker is
  // unreachable, so no message ever arrives. Without this it shows "connecting"
  // forever, which is a frozen panel wearing a friendly word.
  assert.equal(
    isStale({ now: LOADED + 40_000, lastMessageAt: 0, startedAt: LOADED, staleMs: STALE_MS }),
    true,
  );
});

test('staleness is measured from arrival time, never from the payload timestamp', () => {
  // A retained payload can be arbitrarily old and still be the current truth;
  // what matters is that the daemon is still talking to us.
  assert.equal(
    isStale({ now: LOADED + 2_000, lastMessageAt: LOADED + 1_000, startedAt: LOADED, staleMs: STALE_MS }),
    false,
  );
});

test('the silence duration is reported so the panel can say how long', () => {
  assert.equal(
    silentFor({ now: LOADED + 40_000, lastMessageAt: LOADED + 5_000, startedAt: LOADED }),
    35_000,
  );
});

test('silence with no message ever is measured from page load', () => {
  assert.equal(
    silentFor({ now: LOADED + 40_000, lastMessageAt: 0, startedAt: LOADED }),
    40_000,
  );
});

import { silentFor } from '../renderer/staleness.js';
