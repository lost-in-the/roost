import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import {
  acceptancePayload,
  acceptancePrompt,
  parseArgs,
} from '../scripts/run-m2-physical-acceptance.mjs';

const scriptPath = new URL('../scripts/run-m2-physical-acceptance.mjs', import.meta.url);

test('physical acceptance runner is executable and exposes safe synthetic fixtures', async () => {
  await access(scriptPath, constants.X_OK);
  const prompt = acceptancePrompt('labby:test', { reversible: false, actor: 'Labby' });
  const payload = acceptancePayload({ prompt });
  assert.equal(payload.prompt.reversible, false);
  assert.deepEqual(payload.prompt.actor, { gateway: 'labby', name: 'Labby' });
  assert.equal(payload.prompt.summary, 'Approve harmless physical acceptance check?');
  assert.doesNotMatch(JSON.stringify(payload), /command|argument|path|secret/i);
});

test('physical acceptance runner rejects missing option values without consuming another flag', () => {
  assert.throws(() => parseArgs(['--output']), /--output needs a value/);
  assert.throws(() => parseArgs(['--output', '--skip-stale']), /--output needs a value/);
  assert.throws(() => parseArgs(['--destination', '--skip-stale']), /--destination needs a value/);
  assert.equal(parseArgs(['--output', 'HDMI-A-1', '--skip-stale']).output, 'HDMI-A-1');
});

test('physical acceptance runner is isolated and restores only the kiosk unit', async () => {
  const source = await readFile(scriptPath, 'utf8');
  assert.match(source, /startBrowserBroker/);
  assert.match(source, /127\.0\.0\.1/);
  assert.match(source, /production_daemon_untouched: true/);
  assert.doesNotMatch(source, /['"`](?:[^'"`]*\/)?\.env['"`]/);
  assert.doesNotMatch(source, /credentials\.env|device-token|gateway-token/);
  assert.doesNotMatch(source, /roost-daemon\.service/);
  assert.match(source, /roost-m2-physical-acceptance\.lock/);
  assert.match(source, /physical acceptance is already running as PID/);
  assert.match(source, /stop', 'roost-panel\.service/);
  assert.match(source, /restart', 'roost-panel\.service/);
  assert.match(source, /await attempt\(\(\) => rm\(profileDir/);
  assert.match(source, /await attempt\(\(\) => command\('systemctl', \['--user', 'restart'/);
  assert.doesNotMatch(source, /restart', 'roost-panel\.service'\]\)\.catch/);
  const finalization = source.indexOf('let cleanupError;');
  const cleanup = source.indexOf('await cleanup();', finalization);
  const restorationCheck = source.indexOf("isUserUnitActive('roost-panel.service')", cleanup);
  const passedEvidence = source.indexOf("evidence.status = finalError ? 'failed' : 'passed'", restorationCheck);
  assert.ok(finalization > 0 && finalization < cleanup);
  assert.ok(cleanup < restorationCheck && restorationCheck < passedEvidence);
});

test('physical acceptance runner covers all four isolated physical renderer cases', async () => {
  const source = await readFile(scriptPath, 'utf8');
  for (const marker of [
    'irreversible_second_confirm',
    'outside_answer_removal',
    'canonical_terminal_winner',
    'stale_controls_dead',
  ]) {
    assert.match(source, new RegExp(marker));
  }
  assert.match(source, /first irreversible tap must not reach the HTTP resolver/);
  assert.match(source, /removalMs < 5_000/);
  assert.match(source, /Already answered: denied\./);
  assert.match(source, /pointerEvents: 'none'/);
});

test('physical acceptance evidence is exact-output and excludes the temporary browser profile', async () => {
  const source = await readFile(scriptPath, 'utf8');
  assert.match(source, /\[1024, 600\]/);
  assert.match(source, /command\('grim', \['-o', output/);
  assert.match(source, /mkdtemp\(join\(tmpdir\(\), 'roost-physical-browser-'/);
  assert.match(source, /rm\(profileDir, \{ recursive: true, force: true \}\)/);
  assert.doesNotMatch(source, /profileDir.*evidence/);
});
