import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// derive-monitor.sh writes into ${REPO_DIR}/config/hypr/, where REPO_DIR is
// derived from the script's own location. So the script is copied into a
// throwaway tree and run from there: the real repo file is never touched.
const REAL_SCRIPT = fileURLToPath(new URL('../scripts/derive-monitor.sh', import.meta.url));

function runDerive(monitors, args = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-derive-'));
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'config', 'hypr'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });

  const script = path.join(dir, 'scripts', 'derive-monitor.sh');
  fs.copyFileSync(REAL_SCRIPT, script);
  fs.chmodSync(script, 0o755);

  // Stub hyprctl. Only `hyprctl monitors -j` is consulted by the script.
  const stub = path.join(dir, 'bin', 'hyprctl');
  fs.writeFileSync(stub, [
    '#!/usr/bin/env bash',
    'if [ "$1" = "monitors" ]; then',
    "  cat <<'JSON'",
    JSON.stringify(monitors),
    'JSON',
    'fi',
    '',
  ].join('\n'));
  fs.chmodSync(stub, 0o755);

  execFileSync('bash', [script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${path.join(dir, 'bin')}:${process.env.PATH}` },
  });

  return fs.readFileSync(path.join(dir, 'config', 'hypr', 'roost-monitor.lua'), 'utf8');
}

const panel = (refreshRate) => ([{
  name: 'HDMI-A-1',
  description: 'Lenovo Group Limited LEN L1950wD B3432845',
  width: 1024,
  height: 600,
  refreshRate,
}]);

test('a 59.821 Hz panel is recorded as 60, because flooring it names a mode the hardware does not advertise', () => {
  assert.match(runDerive(panel(59.821)), /mode = "1024x600@60"/);
});

test('a 59.4 Hz panel rounds down to 59, so rounding is used rather than always rounding up', () => {
  assert.match(runDerive(panel(59.4)), /mode = "1024x600@59"/);
});

test('the generated file never claims verification, because finding the output proves presence and not that pinning works', () => {
  assert.match(runDerive(panel(59.821)), /verified = false/);
});
