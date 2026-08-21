import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveVariant, counterView, VARIANTS } from '../renderer/components/laptop-counter.js';

// ---- variant selection ----------------------------------------------------

test('both spiked variants are offered', () => {
  assert.deepEqual(VARIANTS, ['corner', 'header']);
});

test('an explicit variant is honoured', () => {
  assert.equal(resolveVariant('header'), 'header');
  assert.equal(resolveVariant('corner'), 'corner');
});

test('an unknown or missing variant falls back rather than rendering nothing', () => {
  assert.equal(resolveVariant('sidebar'), 'corner');
  assert.equal(resolveVariant(null), 'corner');
  assert.equal(resolveVariant(undefined), 'corner');
  assert.equal(resolveVariant(''), 'corner');
});

// ---- what the number reads ------------------------------------------------

test('a known count is shown plainly', () => {
  assert.equal(counterView({ count: 3, pending: 0, phase: 'idle' }).display, '3');
});

test('queued taps are included, so the number never appears to go backwards', () => {
  // Two taps were made while the daemon was down. The instrument must not look
  // like it lost them.
  assert.equal(counterView({ count: 3, pending: 2, phase: 'idle' }).display, '5');
});

test('an unknown count reads as unknown, not as zero', () => {
  // Zero is a meaningful value for this metric — it is the target. Showing it
  // before we actually know would be a lie about the thing being measured.
  assert.equal(counterView({ count: null, pending: 0, phase: 'idle' }).display, '—');
});

test('a genuine zero is shown as zero', () => {
  assert.equal(counterView({ count: 0, pending: 0, phase: 'idle' }).display, '0');
});

test('queued taps show even before the count is known', () => {
  assert.equal(counterView({ count: null, pending: 2, phase: 'idle' }).display, '2');
});

// ---- feedback -------------------------------------------------------------

test('a saved tap is acknowledged', () => {
  assert.equal(counterView({ count: 4, pending: 0, phase: 'saved' }).status, 'saved');
});

test('a tap that could not reach the daemon says it was kept locally', () => {
  const view = counterView({ count: 3, pending: 1, phase: 'failed' });
  assert.equal(view.status, 'failed');
  assert.match(view.hint, /local/i, 'the human must know the tap was not lost');
});

test('the resting state offers no status noise', () => {
  const view = counterView({ count: 3, pending: 0, phase: 'idle' });
  assert.equal(view.status, 'idle');
  assert.equal(view.hint, '');
});

test('pending taps are surfaced while they wait, so the queue is never silent', () => {
  const view = counterView({ count: 3, pending: 2, phase: 'idle' });
  assert.match(view.hint, /2/, 'the number waiting to sync should be visible');
});

// ---- accessible label -----------------------------------------------------

test('the control describes itself for a screen reader in both variants', () => {
  // The corner variant shows an icon and a number only, so the words have to
  // live in the label rather than on screen.
  const label = counterView({ count: 3, pending: 0, phase: 'idle' }).label;
  assert.match(label, /laptop/i);
  assert.match(label, /3/);
});
