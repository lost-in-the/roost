import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';

const SCRIPT = new URL('../scripts/launch-panel.sh', import.meta.url);

test('panel launcher is executable', async () => {
  await access(SCRIPT, constants.X_OK);
});

test('panel launcher waits for focus and fullscreen before restoring human focus', async () => {
  const source = await readFile(SCRIPT, 'utf8');
  const placement = source.indexOf('# 7. Fullscreen the panel');
  const focusWait = source.indexOf('hyprctl activewindow -j', placement);
  const fullscreenDispatch = source.indexOf("hyprctl dispatch 'hl.dsp.window.fullscreen()'", placement);
  const fullscreenWait = source.indexOf('panel did not enter fullscreen');
  const restoreFocus = source.indexOf('# 8. Give the desk back to the human.');

  assert.ok(focusWait > 0, 'must observe the panel as active before using a focused-window dispatcher');
  assert.ok(fullscreenDispatch > focusWait, 'fullscreen dispatch must follow the focus observation');
  assert.ok(fullscreenWait > fullscreenDispatch, 'must observe fullscreen before moving focus away');
  assert.ok(restoreFocus > fullscreenWait, 'human focus must be restored only after placement settles');
  assert.equal(
    source.match(/for _ in \$\(seq 1 20\); do/g)?.length,
    2,
    'both waits must be bounded',
  );
});
