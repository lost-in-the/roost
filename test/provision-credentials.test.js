import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/provision-credentials.sh', import.meta.url));
const DAEMON_PATH = 'op://Homelab/Mosquitto - roost daemon/password';
const PANEL_PATH = 'op://Homelab/Mosquitto - roost panel/password';
const SENTINEL = 'ROOST_MQTT_PASSWORD=old-daemon\nROOST_MQTT_RENDERER_PASSWORD=old-panel\n';
const NONCHAR_UFFFF = Buffer.from([0xef, 0xbf, 0xbf, 0x0a]);
const NONCHAR_UFDD0 = Buffer.from([0xef, 0xb7, 0x90, 0x0a]);
const NONCHAR_U1FFFE = Buffer.from([0xf0, 0x9f, 0xbf, 0xbe, 0x0a]);
const LEGIT_MULTIBYTE = Buffer.from([
  0x6b, 0x65, 0x79, 0x3a, 0xf0, 0x9f, 0x94, 0x91, 0x2d, 0xe6, 0xbc, 0xa2,
  0x2d, 0xc3, 0xa9, 0x2d, 0xef, 0xb7, 0x8f, 0x2d, 0xef, 0xb7, 0xb0, 0x2d,
  0xef, 0xbf, 0xbd,
]);

function sha256(file) {
  if (!fs.existsSync(file)) return null;
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function mode(file) {
  if (!fs.existsSync(file)) return null;
  return fs.statSync(file).mode & 0o777;
}

function tempNames(home) {
  const dir = path.join(home, '.config', 'roost');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name !== 'credentials.env');
}

function makeHome(content = SENTINEL, fileMode = 0o600) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-provision-home-'));
  const dir = path.join(home, '.config', 'roost');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const cache = path.join(dir, 'credentials.env');
  if (content !== null) {
    fs.writeFileSync(cache, content);
    fs.chmodSync(cache, fileMode);
  }
  return { home, cache, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}

function makeToolsDir(home) {
  const tools = path.join(home, 'tools');
  fs.mkdirSync(tools, { recursive: true });
  for (const name of ['bash', 'install', 'mktemp', 'chmod', 'mv', 'rm', 'wc', 'tr', 'cat', 'tail', 'iconv', 'grep']) {
    fs.symlinkSync(`/usr/bin/${name}`, path.join(tools, name));
  }
  return tools;
}

function writeOpStub(bin, marker, {
  interruptOnCreate = false,
  interruptOnTemp = false,
  interruptOnRename = false,
  interruptSignal = 'TERM',
  interruptDuringCleanup = false,
  cleanupInterruptSignal = 'INT',
  cleanupInterruptTarget = 'ppid',
  grepMode = null,
} = {}) {
  fs.mkdirSync(bin, { recursive: true });
  const stub = path.join(bin, 'op');
  fs.writeFileSync(stub, [
    '#!/usr/bin/env bash',
    'printf touched > "$ROOST_OP_MARKER"',
    'if [ "$1" != read ]; then exit 64; fi',
    `daemon_path=${JSON.stringify(DAEMON_PATH)}`,
    `panel_path=${JSON.stringify(PANEL_PATH)}`,
    'case "$2" in',
    '  "$daemon_path") field=daemon ;;',
    '  "$panel_path") field=panel ;;',
    '  *) exit 65 ;;',
    'esac',
    'bytes="$ROOST_OP_BYTES_DIR/$field.bin"',
    'emit_env() { printf "%s\\n" "$1" > "$bytes"; cat "$bytes"; }',
    'emit_hex() { printf "$1" > "$bytes"; cat "$bytes"; }',
    'case "${ROOST_OP_SCENARIO}:${field}" in',
    '  success:daemon|permission:daemon) emit_env "$ROOST_DAEMON_VALUE" ;;',
    '  success:panel|permission:panel) emit_env "$ROOST_PANEL_VALUE" ;;',
    '  empty:daemon) exit 0 ;;',
    '  empty:panel) emit_env "$ROOST_PANEL_VALUE" ;;',
    '  fail:daemon) exit 23 ;;',
    '  fail:panel) exit 24 ;;',
    '  second-fail:daemon) emit_env "$ROOST_DAEMON_VALUE" ;;',
    '  second-fail:panel) exit 25 ;;',
    '  second-empty:daemon) emit_env "$ROOST_DAEMON_VALUE" ;;',
    '  second-empty:panel) exit 0 ;;',
    '  lf:daemon) emit_env "$ROOST_DAEMON_VALUE" ;;',
    '  lf:panel) emit_env "$ROOST_PANEL_VALUE" ;;',
    '  cr:daemon) emit_env "$ROOST_DAEMON_VALUE" ;;',
    '  cr:panel) emit_env "$ROOST_PANEL_VALUE" ;;',
    '  nul:daemon) emit_hex "a\\0b\\n" ;;',
    '  nul:panel) emit_env "$ROOST_PANEL_VALUE" ;;',
    '  second-nul:daemon) emit_env "$ROOST_DAEMON_VALUE" ;;',
    '  second-nul:panel) emit_hex "a\\0b\\n" ;;',
    '  invalid-utf8:daemon) emit_hex "\\xff\\xfe\\n" ;;',
    '  invalid-utf8:panel) emit_env "$ROOST_PANEL_VALUE" ;;',
    '  bom:daemon) emit_hex "\\357\\273\\277secret\\n" ;;',
    '  bom:panel) emit_env "$ROOST_PANEL_VALUE" ;;',
    '  grep-quote-plus-invalid:daemon) emit_hex "bad\\047\\357\\273\\277\\357\\277\\277\\n" ;;',
    '  grep-quote-plus-invalid:panel) emit_env "$ROOST_PANEL_VALUE" ;;',
    '  grep-bom-plus-nonchar:daemon) emit_hex "\\357\\273\\277\\357\\277\\277\\n" ;;',
    '  grep-bom-plus-nonchar:panel) emit_env "$ROOST_PANEL_VALUE" ;;',
    '  nonchar-daemon:daemon) emit_hex "\\357\\277\\277\\n" ;;',
    '  nonchar-daemon:panel) emit_env "$ROOST_PANEL_VALUE" ;;',
    '  nonchar-panel:daemon) emit_env "$ROOST_DAEMON_VALUE" ;;',
    '  nonchar-panel:panel) emit_hex "\\357\\267\\220\\n" ;;',
    '  nonchar-supplementary:daemon) emit_hex "\\360\\237\\277\\276\\n" ;;',
    '  nonchar-supplementary:panel) emit_env "$ROOST_PANEL_VALUE" ;;',
    '  legit-multibyte:daemon) emit_hex "key:\\360\\237\\224\\221-\\346\\274\\242-\\303\\251-\\357\\267\\217-\\357\\267\\260-\\357\\277\\275\\n" ;;',
    '  legit-multibyte:panel) emit_env "$ROOST_PANEL_VALUE" ;;',
    '  panel-single-quote:daemon) emit_env "$ROOST_DAEMON_VALUE" ;;',
    '  panel-single-quote:panel) emit_env "$ROOST_PANEL_VALUE" ;;',
    '  *) exit 66 ;;',
    'esac',
    '',
  ].join('\n'));
  fs.chmodSync(stub, 0o755);

  if (interruptOnCreate) {
    const mktemp = path.join(bin, 'mktemp');
    fs.writeFileSync(mktemp, [
      '#!/usr/bin/env bash',
      'created=$("$ROOST_REAL_MKTEMP" "$@") || exit $?',
      'printf "%s\\n" "$created"',
      'count=0',
      'if [ -e "$ROOST_MKTEMP_COUNT" ]; then read -r count < "$ROOST_MKTEMP_COUNT"; fi',
      'count=$((count + 1))',
      'printf "%s\\n" "$count" > "$ROOST_MKTEMP_COUNT"',
      'if [ "$count" -eq "$ROOST_MKTEMP_INTERRUPT_CALL" ]; then',
      '  printf touched > "$ROOST_MKTEMP_MARKER"',
      `  kill -${interruptSignal} 0`,
      'fi',
      '',
    ].join('\n'));
    fs.chmodSync(mktemp, 0o755);
  }

  if (interruptOnTemp) {
    const chmod = path.join(bin, 'chmod');
    fs.writeFileSync(chmod, [
      '#!/usr/bin/env bash',
      'case "$2" in',
      '  *credentials.env.*)',
      '    if [ ! -e "$ROOST_CHMOD_MARKER" ]; then',
      '      printf touched > "$ROOST_CHMOD_MARKER"',
      '      "$ROOST_REAL_CHMOD" "$@"',
      `      kill -${interruptSignal} "$PPID"`,
      '      exit 143',
      '    fi',
      '    ;;',
      'esac',
      'exec "$ROOST_REAL_CHMOD" "$@"',
      '',
    ].join('\n'));
    fs.chmodSync(chmod, 0o755);
  }

  if (interruptOnRename) {
    const mv = path.join(bin, 'mv');
    fs.writeFileSync(mv, [
      '#!/usr/bin/env bash',
      '"$ROOST_REAL_MV" "$@"',
      `kill -${interruptSignal} "$PPID"`,
      '',
    ].join('\n'));
    fs.chmodSync(mv, 0o755);
  }

  if (interruptDuringCleanup) {
    const rm = path.join(bin, 'rm');
    fs.rmSync(rm, { force: true });
    const target = cleanupInterruptTarget === 'process-group' ? '0' : '"$PPID"';
    fs.writeFileSync(rm, [
      '#!/usr/bin/env bash',
      'printf "%s\\n" "$*" >> "$ROOST_RM_LOG"',
      'if [ ! -e "$ROOST_RM_MARKER" ]; then',
      '  printf touched > "$ROOST_RM_MARKER"',
      `  kill -${cleanupInterruptSignal} ${target}`,
      'fi',
      'exec "$ROOST_REAL_RM" "$@"',
      '',
    ].join('\n'));
    fs.chmodSync(rm, 0o755);
  }

  if (grepMode) {
    const grep = path.join(bin, 'grep');
    const body = [
      '#!/usr/bin/env bash',
      'kind=unknown',
      'pattern=',
      'file=',
      'if [ "$1" = -qaE ]; then',
      '  kind=nonchar',
      '  pattern=$2',
      '  file=$3',
      'else',
      '  pattern=$2',
      '  file=$3',
      '  if [ "$pattern" = "\'" ]; then',
      '    kind=quote',
      '  elif [ "$pattern" = "$(printf \'\\357\\273\\277\')" ]; then',
      '    kind=bom',
      '  fi',
      'fi',
      'outcome=delegate',
      'case "${ROOST_GREP_FAIL_ON:-}" in',
      '  quote|bom|nonchar)',
      '    if [ "$kind" = "$ROOST_GREP_FAIL_ON" ]; then outcome=fail; fi ;;',
      'esac',
      'case "${ROOST_GREP_FAIL_FIELD:-}" in',
      '  daemon|panel)',
      '    case "$file" in',
      '      *"roost-$ROOST_GREP_FAIL_FIELD".*) ;;',
      '      *) outcome=delegate ;;',
      '    esac ;;',
      'esac',
      'printf "%s %s %s\\n" "$kind" "$outcome" "$file" >> "$ROOST_GREP_LOG"',
      'if [ "$outcome" = fail ]; then exit 2; fi',
      'exec "$ROOST_REAL_GREP" "$@"',
      '',
    ];
    fs.writeFileSync(grep, body.join('\n'));
    fs.chmodSync(grep, 0o755);
  }
}

function runProvision({
  scenario = 'success',
  daemonValue = 'daemon-secret-value',
  panelValue = 'panel-secret-value',
  existing = SENTINEL,
  existingMode = 0o600,
  interruptOnCreate = false,
  interruptCreateCall = 1,
  interruptOnTemp = false,
  interruptOnRename = false,
  interruptSignal = 'TERM',
  interruptDuringCleanup = false,
  cleanupInterruptSignal = 'INT',
  cleanupInterruptTarget = 'ppid',
  grepMode = null,
} = {}) {
  const { home, cache, cleanup } = makeHome(existing, existingMode);
  const bin = path.join(home, 'bin');
  const tools = makeToolsDir(home);
  const marker = path.join(home, 'op.marker');
  const bytesDir = path.join(home, 'op-bytes');
  const chmodMarker = path.join(home, 'chmod.marker');
  const mktempMarker = path.join(home, 'mktemp.marker');
  const mktempCount = path.join(home, 'mktemp.count');
  const rmMarker = path.join(home, 'rm.marker');
  const rmLog = path.join(home, 'rm.log');
  const grepLog = path.join(home, 'grep.log');
  fs.mkdirSync(bytesDir, { recursive: true });
  writeOpStub(bin, marker, {
    interruptOnCreate,
    interruptOnTemp,
    interruptOnRename,
    interruptSignal,
    interruptDuringCleanup,
    cleanupInterruptSignal,
    cleanupInterruptTarget,
    grepMode,
  });
  const beforeHash = sha256(cache);
  const beforeMode = mode(cache);
  const beforeBytes = fs.existsSync(cache) ? fs.readFileSync(cache) : null;
  const useProcessGroup = interruptOnCreate || cleanupInterruptTarget === 'process-group';
  const command = useProcessGroup ? '/usr/bin/setsid' : 'bash';
  const args = useProcessGroup ? ['-w', 'bash', SCRIPT] : [SCRIPT];
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: {
      HOME: home,
      PATH: `${bin}:${tools}`,
      ROOST_OP_MARKER: marker,
      ROOST_OP_BYTES_DIR: bytesDir,
      ROOST_CHMOD_MARKER: chmodMarker,
      ROOST_MKTEMP_MARKER: mktempMarker,
      ROOST_MKTEMP_COUNT: mktempCount,
      ROOST_MKTEMP_INTERRUPT_CALL: String(interruptCreateCall),
      ROOST_RM_MARKER: rmMarker,
      ROOST_RM_LOG: rmLog,
      ROOST_OP_SCENARIO: scenario,
      ROOST_DAEMON_VALUE: daemonValue,
      ROOST_PANEL_VALUE: panelValue,
      ROOST_REAL_CHMOD: '/usr/bin/chmod',
      ROOST_REAL_MKTEMP: '/usr/bin/mktemp',
      ROOST_REAL_MV: path.join(tools, 'mv'),
      ROOST_REAL_RM: path.join(tools, 'rm'),
      ROOST_REAL_GREP: path.join(tools, 'grep'),
      ROOST_GREP_LOG: grepLog,
      ROOST_GREP_FAIL_ON: grepMode?.replace('panel-', '').replace('-error', '') ?? '',
      ROOST_GREP_FAIL_FIELD: grepMode === 'panel-quote-error' ? 'panel' : '',
    },
  });
  return {
    ...result,
    home,
    cache,
    marker,
    bytesDir,
    chmodMarker,
    mktempMarker,
    mktempCount,
    rmMarker,
    rmLog,
    grepLog,
    beforeHash,
    beforeMode,
    beforeBytes,
    afterHash: sha256(cache),
    afterMode: mode(cache),
    cacheText: fs.existsSync(cache) ? fs.readFileSync(cache, 'utf8') : null,
    cacheBytes: fs.existsSync(cache) ? fs.readFileSync(cache) : null,
    temps: tempNames(home),
    secrets: [daemonValue, panelValue].filter(Boolean),
    cleanup,
  };
}

function grepLog(run) {
  return fs.existsSync(run.grepLog) ? fs.readFileSync(run.grepLog, 'utf8').trim().split('\n') : [];
}

function emittedBytes(run, field) {
  return fs.readFileSync(path.join(run.bytesDir, `${field}.bin`));
}

function withProvision(options, fn) {
  const run = runProvision(options);
  try {
    fn(run);
  } finally {
    run.cleanup();
  }
}

function assertNoSecretOutput(run) {
  for (const secret of run.secrets) {
    assert.doesNotMatch(run.stdout, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(run.stderr, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
}

function assertFailedUntouched(run) {
  assert.notEqual(run.status, 0);
  assert.equal(run.afterHash, run.beforeHash);
  assert.equal(run.afterMode, run.beforeMode);
  assert.deepEqual(run.temps, []);
  assert.equal(fs.readFileSync(run.marker, 'utf8'), 'touched');
  assertNoSecretOutput(run);
}

test('success writes single-quoted credentials with mode 600 through the op stub', () => {
  withProvision({ existing: null }, (run) => {
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.cacheText, "ROOST_MQTT_PASSWORD='daemon-secret-value'\nROOST_MQTT_RENDERER_PASSWORD='panel-secret-value'\n");
    assert.equal(run.afterMode, 0o600);
    assert.deepEqual(run.temps, []);
    assert.equal(fs.readFileSync(run.marker, 'utf8'), 'touched');
    assertNoSecretOutput(run);
  });
});

test('a backslash in a value survives in single-quoted EnvironmentFile output', () => {
  withProvision({
    existing: null,
    daemonValue: 'corr\\ect horse',
    panelValue: 'panel-secret-value',
  }, (run) => {
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.cacheText, "ROOST_MQTT_PASSWORD='corr\\ect horse'\nROOST_MQTT_RENDERER_PASSWORD='panel-secret-value'\n");
    assert.match(run.cacheText, /corr\\ect horse/);
    assert.deepEqual(run.temps, []);
    assert.equal(fs.readFileSync(run.marker, 'utf8'), 'touched');
    assertNoSecretOutput(run);
  });
});

test('leading and trailing spaces survive inside single-quoted EnvironmentFile output', () => {
  withProvision({
    existing: null,
    daemonValue: '  daemon secret  ',
    panelValue: '  panel secret  ',
  }, (run) => {
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.cacheText, "ROOST_MQTT_PASSWORD='  daemon secret  '\nROOST_MQTT_RENDERER_PASSWORD='  panel secret  '\n");
    assert.deepEqual(run.temps, []);
    assert.equal(fs.readFileSync(run.marker, 'utf8'), 'touched');
    assertNoSecretOutput(run);
  });
});

test('double quote and dollar values survive inside single-quoted EnvironmentFile output', () => {
  withProvision({
    existing: null,
    daemonValue: 'a"b$c',
    panelValue: 'panel-secret-value',
  }, (run) => {
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.cacheText, "ROOST_MQTT_PASSWORD='a\"b$c'\nROOST_MQTT_RENDERER_PASSWORD='panel-secret-value'\n");
    assert.deepEqual(run.temps, []);
    assert.equal(fs.readFileSync(run.marker, 'utf8'), 'touched');
    assertNoSecretOutput(run);
  });
});

test('an empty op result fails before touching the existing cache', () => {
  withProvision({ scenario: 'empty' }, assertFailedUntouched);
});

test('a failed first op read fails before touching the existing cache', () => {
  withProvision({ scenario: 'fail' }, assertFailedUntouched);
});

test('a failed second op read preserves the existing cache', () => {
  withProvision({ scenario: 'second-fail' }, assertFailedUntouched);
});

test('an empty second op read preserves the existing cache', () => {
  withProvision({ scenario: 'second-empty' }, assertFailedUntouched);
});

test('an LF inside a value fails before touching the existing cache', () => {
  withProvision({
    scenario: 'lf',
    daemonValue: 'first\nINJECTED=1',
  }, assertFailedUntouched);
});

test('a trailing LF in a value fails before touching the existing cache', () => {
  withProvision({
    scenario: 'lf',
    daemonValue: 'daemon-secret-value\n',
  }, assertFailedUntouched);
});

test('a CR inside a value fails before touching the existing cache', () => {
  withProvision({
    scenario: 'cr',
    panelValue: 'panel\rINJECTED=1',
  }, assertFailedUntouched);
});

test('a trailing CR in a value fails before touching the existing cache', () => {
  withProvision({
    scenario: 'cr',
    panelValue: 'panel-secret-value\r',
  }, assertFailedUntouched);
});

test('a NUL in the first op read fails before touching the existing cache', () => {
  withProvision({
    scenario: 'nul',
  }, assertFailedUntouched);
});

test('a NUL in the second op read preserves the existing cache', () => {
  withProvision({
    scenario: 'second-nul',
  }, assertFailedUntouched);
});

test('a single quote in a value fails before touching the existing cache', () => {
  withProvision({
    daemonValue: "daemon's-secret",
  }, (run) => {
    assertFailedUntouched(run);
    assert.match(run.stderr, /ROOST_MQTT_PASSWORD/);
    assert.match(run.stderr, /cannot be represented in a systemd EnvironmentFile/);
    assert.match(run.stderr, /without a single quote/);
  });
});

test('a grep error while checking a daemon single quote preserves the existing cache', () => {
  withProvision({
    scenario: 'grep-quote-plus-invalid',
    grepMode: 'quote-error',
  }, (run) => {
    assertFailedUntouched(run);
    assert.match(run.stderr, /ROOST_MQTT_PASSWORD/);
    assert.match(run.stderr, /grep exited 2/);
    assert.doesNotMatch(run.stderr, /byte order mark/);
    assert.doesNotMatch(run.stderr, /Unicode noncharacter/);
    assert.deepEqual(grepLog(run).map((line) => line.split(' ').slice(0, 2).join(' ')), ['quote fail']);
  });
});

test('invalid UTF-8 bytes fail before touching the existing cache', () => {
  withProvision({
    scenario: 'invalid-utf8',
  }, (run) => {
    assertFailedUntouched(run);
    assert.match(run.stderr, /ROOST_MQTT_PASSWORD/);
    assert.match(run.stderr, /not valid UTF-8/);
  });
});

test('a byte order mark fails before touching the existing cache', () => {
  withProvision({
    scenario: 'bom',
  }, (run) => {
    assertFailedUntouched(run);
    assert.match(run.stderr, /ROOST_MQTT_PASSWORD/);
    assert.match(run.stderr, /byte order mark/);
  });
});

test('a grep error while checking a byte order mark preserves the existing cache', () => {
  withProvision({
    scenario: 'grep-bom-plus-nonchar',
    grepMode: 'bom-error',
  }, (run) => {
    assertFailedUntouched(run);
    assert.match(run.stderr, /ROOST_MQTT_PASSWORD/);
    assert.match(run.stderr, /grep exited 2/);
    assert.doesNotMatch(run.stderr, /Unicode noncharacter/);
    assert.deepEqual(grepLog(run).map((line) => line.split(' ').slice(0, 2).join(' ')), [
      'quote delegate',
      'bom fail',
    ]);
  });
});

test('a Unicode noncharacter in the daemon value fails before touching the existing cache', () => {
  withProvision({
    scenario: 'nonchar-daemon',
  }, (run) => {
    assertFailedUntouched(run);
    assert.deepEqual(emittedBytes(run, 'daemon'), NONCHAR_UFFFF);
    assert.match(run.stderr, /ROOST_MQTT_PASSWORD/);
    assert.match(run.stderr, /Unicode noncharacter/);
  });
});

test('a Unicode noncharacter in the panel value preserves the existing cache', () => {
  withProvision({
    scenario: 'nonchar-panel',
  }, (run) => {
    assertFailedUntouched(run);
    assert.deepEqual(emittedBytes(run, 'panel'), NONCHAR_UFDD0);
    assert.match(run.stderr, /ROOST_MQTT_RENDERER_PASSWORD/);
    assert.match(run.stderr, /Unicode noncharacter/);
  });
});

test('a supplementary-plane Unicode noncharacter fails before touching the existing cache', () => {
  withProvision({
    scenario: 'nonchar-supplementary',
  }, (run) => {
    assertFailedUntouched(run);
    assert.deepEqual(emittedBytes(run, 'daemon'), NONCHAR_U1FFFE);
    assert.match(run.stderr, /ROOST_MQTT_PASSWORD/);
    assert.match(run.stderr, /Unicode noncharacter/);
  });
});

test('a grep error while checking Unicode noncharacters preserves the existing cache', () => {
  withProvision({
    scenario: 'nonchar-daemon',
    grepMode: 'nonchar-error',
  }, (run) => {
    assertFailedUntouched(run);
    assert.match(run.stderr, /ROOST_MQTT_PASSWORD/);
    assert.match(run.stderr, /grep exited 2/);
    assert.deepEqual(emittedBytes(run, 'daemon'), NONCHAR_UFFFF);
    assert.deepEqual(grepLog(run).map((line) => line.split(' ').slice(0, 2).join(' ')), [
      'quote delegate',
      'bom delegate',
      'nonchar fail',
    ]);
  });
});

test('legitimate multibyte values and noncharacter neighbours provision successfully', () => {
  withProvision({
    scenario: 'legit-multibyte',
    existing: null,
  }, (run) => {
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(emittedBytes(run, 'daemon'), Buffer.concat([LEGIT_MULTIBYTE, Buffer.from('\n')]));
    assert.deepEqual(run.cacheBytes, Buffer.concat([
      Buffer.from("ROOST_MQTT_PASSWORD='"),
      LEGIT_MULTIBYTE,
      Buffer.from("'\nROOST_MQTT_RENDERER_PASSWORD='panel-secret-value'\n"),
    ]));
    assert.deepEqual(run.temps, []);
    assert.equal(fs.readFileSync(run.marker, 'utf8'), 'touched');
    assertNoSecretOutput(run);
  });
});

test('a panel-side single quote failure preserves the existing cache', () => {
  withProvision({
    scenario: 'panel-single-quote',
    daemonValue: 'daemon-secret-value',
    panelValue: "panel's-secret",
  }, (run) => {
    assertFailedUntouched(run);
    assert.match(run.stderr, /ROOST_MQTT_RENDERER_PASSWORD/);
    assert.match(run.stderr, /cannot be represented in a systemd EnvironmentFile/);
  });
});

test('a grep error while checking the panel read preserves the existing cache', () => {
  withProvision({
    scenario: 'panel-single-quote',
    daemonValue: 'daemon-secret-value',
    panelValue: "bad'password",
    grepMode: 'panel-quote-error',
  }, (run) => {
    assertFailedUntouched(run);
    assert.match(run.stderr, /ROOST_MQTT_RENDERER_PASSWORD/);
    assert.match(run.stderr, /grep exited 2/);
    assert.deepEqual(grepLog(run).map((line) => line.split(' ').slice(0, 2).join(' ')), [
      'quote delegate',
      'bom delegate',
      'nonchar delegate',
      'quote fail',
    ]);
  });
});

test('a successful run repairs an existing over-permissive cache', () => {
  withProvision({ scenario: 'permission', existingMode: 0o644 }, (run) => {
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.cacheText, "ROOST_MQTT_PASSWORD='daemon-secret-value'\nROOST_MQTT_RENDERER_PASSWORD='panel-secret-value'\n");
    assert.equal(run.afterMode, 0o600);
    assert.deepEqual(run.temps, []);
    assert.equal(fs.readFileSync(run.marker, 'utf8'), 'touched');
    assertNoSecretOutput(run);
  });
});

for (const [interruptCreateCall, stage] of [[1, 'daemon read'], [2, 'panel read'], [3, 'cache']]) {
  for (const interruptSignal of ['HUP', 'INT', 'TERM']) {
    test(`a process-group ${interruptSignal} after ${stage} temp creation leaves no unnamed temp`, () => {
      withProvision({ interruptOnCreate: true, interruptCreateCall, interruptSignal }, (run) => {
        assert.equal(run.signal, `SIG${interruptSignal}`);
        assert.equal(run.status, null);
        assert.equal(run.afterHash, run.beforeHash);
        assert.equal(run.afterMode, run.beforeMode);
        assert.equal(fs.readFileSync(run.mktempMarker, 'utf8'), 'touched');
        assert.equal(fs.readFileSync(run.mktempCount, 'utf8').trim(), String(interruptCreateCall));
        assert.deepEqual(run.temps, []);
        assertNoSecretOutput(run);
      });
    });
  }
}

test('signal handler keeps unrelated termination signals ignored until the original is re-raised', () => {
  const source = fs.readFileSync(SCRIPT, 'utf8');
  const handler = source.match(/on_signal\(\) \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(handler);
  assert.match(handler, /trap '' HUP INT TERM\n  cleanup\n  trap - EXIT\n[\s\S]*?trap - "\$signal"\n  kill -s "\$signal" "\$\$"/);
  assert.doesNotMatch(handler, /trap - EXIT HUP INT TERM/);
});

test('an interruption after the temp file exists still cleans up and preserves the cache', () => {
  withProvision({ interruptOnTemp: true }, (run) => {
    assert.equal(run.signal, 'SIGTERM');
    assert.equal(run.status, null);
    assert.equal(run.afterHash, run.beforeHash);
    assert.equal(run.afterMode, run.beforeMode);
    assert.deepEqual(run.temps, []);
    assert.equal(fs.readFileSync(run.marker, 'utf8'), 'touched');
    assert.equal(fs.readFileSync(run.chmodMarker, 'utf8'), 'touched');
    assertNoSecretOutput(run);
  });
});

test('an INT after the temp file exists re-raises SIGINT after cleanup', () => {
  withProvision({ interruptOnTemp: true, interruptSignal: 'INT' }, (run) => {
    assert.equal(run.signal, 'SIGINT');
    assert.equal(run.status, null);
    assert.equal(run.afterHash, run.beforeHash);
    assert.equal(run.afterMode, run.beforeMode);
    assert.deepEqual(run.temps, []);
    assert.equal(fs.readFileSync(run.marker, 'utf8'), 'touched');
    assert.equal(fs.readFileSync(run.chmodMarker, 'utf8'), 'touched');
    assertNoSecretOutput(run);
  });
});

test('a HUP after the temp file exists re-raises SIGHUP after cleanup', () => {
  withProvision({ interruptOnTemp: true, interruptSignal: 'HUP' }, (run) => {
    assert.equal(run.signal, 'SIGHUP');
    assert.equal(run.status, null);
    assert.equal(run.afterHash, run.beforeHash);
    assert.equal(run.afterMode, run.beforeMode);
    assert.deepEqual(run.temps, []);
    assert.equal(fs.readFileSync(run.marker, 'utf8'), 'touched');
    assert.equal(fs.readFileSync(run.chmodMarker, 'utf8'), 'touched');
    assertNoSecretOutput(run);
  });
});

test('a TERM during rename still commits the completed cache and exits cleanly', () => {
  withProvision({ interruptOnRename: true }, (run) => {
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.signal, null);
    assert.equal(run.cacheText, "ROOST_MQTT_PASSWORD='daemon-secret-value'\nROOST_MQTT_RENDERER_PASSWORD='panel-secret-value'\n");
    assert.equal(run.afterMode, 0o600);
    assert.deepEqual(run.temps, []);
    assertNoSecretOutput(run);
  });
});

test('an INT during rename still commits the completed cache and exits cleanly', () => {
  withProvision({ interruptOnRename: true, interruptSignal: 'INT' }, (run) => {
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.signal, null);
    assert.equal(run.cacheText, "ROOST_MQTT_PASSWORD='daemon-secret-value'\nROOST_MQTT_RENDERER_PASSWORD='panel-secret-value'\n");
    assert.equal(run.afterMode, 0o600);
    assert.deepEqual(run.temps, []);
    assertNoSecretOutput(run);
  });
});

test('a HUP during rename still commits the completed cache and exits cleanly', () => {
  withProvision({ interruptOnRename: true, interruptSignal: 'HUP' }, (run) => {
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.signal, null);
    assert.equal(run.cacheText, "ROOST_MQTT_PASSWORD='daemon-secret-value'\nROOST_MQTT_RENDERER_PASSWORD='panel-secret-value'\n");
    assert.equal(run.afterMode, 0o600);
    assert.deepEqual(run.temps, []);
    assertNoSecretOutput(run);
  });
});

test('cleanup ignores signals before disarming traps and re-raising the original signal', () => {
  withProvision({ interruptOnTemp: true, interruptDuringCleanup: true }, (run) => {
    assert.equal(run.signal, 'SIGTERM');
    assert.equal(run.status, null);
    assert.equal(fs.readFileSync(run.rmLog, 'utf8').trim().split('\n').length, 1);
    assert.equal(fs.readFileSync(run.rmMarker, 'utf8'), 'touched');
    assert.equal(run.afterHash, run.beforeHash);
    assert.equal(run.afterMode, run.beforeMode);
    assert.deepEqual(run.temps, []);
    assertNoSecretOutput(run);
  });
});

test('cleanup preserves the original TERM when a second HUP targets the parent shell', () => {
  withProvision({
    interruptOnTemp: true,
    interruptDuringCleanup: true,
    cleanupInterruptSignal: 'HUP',
  }, (run) => {
    assert.equal(run.signal, 'SIGTERM');
    assert.equal(run.status, null);
    assert.equal(fs.readFileSync(run.rmLog, 'utf8').trim().split('\n').length, 1);
    assert.equal(fs.readFileSync(run.rmMarker, 'utf8'), 'touched');
    assert.equal(run.afterHash, run.beforeHash);
    assert.equal(run.afterMode, run.beforeMode);
    assert.deepEqual(run.temps, []);
    assertNoSecretOutput(run);
  });
});

for (const cleanupInterruptSignal of ['HUP', 'INT', 'TERM']) {
  test(`cleanup removes temp files when a second ${cleanupInterruptSignal} targets the process group`, () => {
    withProvision({
      interruptOnTemp: true,
      interruptDuringCleanup: true,
      cleanupInterruptSignal,
      cleanupInterruptTarget: 'process-group',
    }, (run) => {
      assert.equal(run.signal, 'SIGTERM');
      assert.equal(run.status, null);
      assert.deepEqual(run.cacheBytes, run.beforeBytes);
      assert.equal(run.afterMode, run.beforeMode);
      assert.equal(fs.readFileSync(run.rmMarker, 'utf8'), 'touched');
      assert.deepEqual(run.temps, []);
      assertNoSecretOutput(run);
    });
  });
}

test('sentinel credentials survive empty, failed, and multiline reads byte-for-byte', () => {
  for (const scenario of ['empty', 'second-empty', 'fail', 'lf', 'cr']) {
    withProvision({
      scenario,
      daemonValue: scenario === 'lf' ? 'first\nINJECTED=1' : 'daemon-secret-value',
      panelValue: scenario === 'cr' ? 'panel\rINJECTED=1' : 'panel-secret-value',
    }, (run) => {
      assertFailedUntouched(run);
      assert.equal(run.cacheText, SENTINEL);
    });
  }
});
