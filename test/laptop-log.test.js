import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LaptopLog } from '../daemon/laptop-log.js';

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'roost-test-'));
  return { dir, path: join(dir, 'nested', 'laptop-opens.log'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('a fresh log counts zero without the file existing', () => {
  const s = scratch();
  try {
    assert.equal(new LaptopLog({ path: s.path }).count(), 0);
  } finally { s.cleanup(); }
});

test('recording an open increments the count', () => {
  const s = scratch();
  try {
    const log = new LaptopLog({ path: s.path });
    assert.equal(log.record(Date.parse('2026-08-21T18:00:00Z')), 1);
    assert.equal(log.record(Date.parse('2026-08-21T19:00:00Z')), 2);
    assert.equal(log.count(), 2);
  } finally { s.cleanup(); }
});

test('the count survives the process going away entirely', () => {
  const s = scratch();
  try {
    new LaptopLog({ path: s.path }).record(Date.parse('2026-08-21T18:00:00Z'));
    // A completely separate instance, as after a reboot.
    assert.equal(new LaptopLog({ path: s.path }).count(), 1);
  } finally { s.cleanup(); }
});

test('each entry is written as one timestamped line', () => {
  const s = scratch();
  try {
    const log = new LaptopLog({ path: s.path });
    log.record(Date.parse('2026-08-21T18:00:00Z'));
    log.record(Date.parse('2026-08-21T19:30:15Z'));
    assert.equal(readFileSync(s.path, 'utf8'), '2026-08-21T18:00:00Z\n2026-08-21T19:30:15Z\n');
  } finally { s.cleanup(); }
});

test('the log directory is created when it does not exist', () => {
  const s = scratch();
  try {
    new LaptopLog({ path: s.path }).record(Date.now());
    assert.ok(readFileSync(s.path, 'utf8').length > 0);
  } finally { s.cleanup(); }
});

test('blank and malformed lines do not inflate the count', () => {
  const s = scratch();
  try {
    const log = new LaptopLog({ path: s.path });
    log.record(Date.parse('2026-08-21T18:00:00Z'));
    writeFileSync(s.path, '2026-08-21T18:00:00Z\n\n   \nnot-a-timestamp\n');
    assert.equal(log.count(), 1);
  } finally { s.cleanup(); }
});

test('entries are returned newest first for the renderer to show recency', () => {
  const s = scratch();
  try {
    const log = new LaptopLog({ path: s.path });
    log.record(Date.parse('2026-08-21T18:00:00Z'));
    log.record(Date.parse('2026-08-21T19:00:00Z'));
    assert.deepEqual(log.entries(), ['2026-08-21T19:00:00Z', '2026-08-21T18:00:00Z']);
  } finally { s.cleanup(); }
});

test('a file with no trailing newline still appends cleanly', () => {
  const s = scratch();
  try {
    const log = new LaptopLog({ path: s.path });
    log.record(Date.parse('2026-08-21T18:00:00Z'));
    writeFileSync(s.path, '2026-08-21T18:00:00Z');  // truncated write, no newline
    log.record(Date.parse('2026-08-21T19:00:00Z'));
    assert.equal(log.count(), 2, 'a partial last line must not swallow the next entry');
  } finally { s.cleanup(); }
});
