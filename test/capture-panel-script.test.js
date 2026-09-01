import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';

const path = new URL('../scripts/capture-panel-states.sh', import.meta.url);
const source = readFileSync(path, 'utf8');

test('panel capture script is executable and restores its temporary override on every exit', () => {
  assert.notEqual(statSync(path).mode & 0o111, 0);
  assert.match(source, /trap restore_live_source EXIT/);
  assert.match(source, /rm -f -- "\$dropin"/);
  assert.match(source, /wait_for_source "\$original_source"/);
  assert.match(source, /trap '' HUP INT TERM/);
  assert.match(source, /stale panel-capture override exists/);
});

test('panel capture script never reads or prints secret-bearing environment files', () => {
  assert.doesNotMatch(source, /credentials\.env|\.env\b/);
  assert.doesNotMatch(source, /systemctl .*show-environment|printenv|\/proc\/.*environ/);
});

test('panel capture script covers every meaningful renderer state', () => {
  for (const name of [
    '01-idle', '02-listening', '03-thinking', '04-multi-agent',
    '05-stalled', '06-approval', '07-handoff', '08-bare-attention',
  ]) assert.match(source, new RegExp(name));
});

test('panel capture script records context alongside its image manifest', () => {
  assert.match(source, /context\.tsv/);
  assert.match(source, /original_source/);
  assert.match(source, /manifest\.tsv/);
});
