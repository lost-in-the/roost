#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  access,
  mkdir,
  mkdtemp,
  readlink,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { StatePublisher } from '../daemon/publisher.js';
import { startHttpServer } from '../daemon/http.js';
import { startBrowserBroker } from '../test/helpers/browser-broker.js';
import { waitFor } from '../test/helpers/broker.js';

const execFileAsync = promisify(execFile);
const repoDir = resolve(fileURLToPath(new URL('..', import.meta.url)));
const STALE_MS = 30_000;
const TOPIC = `roost/physical-acceptance/${process.pid}/${Date.now()}`;

function timestampSlug(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

export function parseArgs(argv) {
  const options = {
    output: null,
    destination: join(repoDir, 'tmp', 'physical-acceptance', timestampSlug()),
    skipStale: false,
  };
  const valueAfter = (index, option) => {
    const value = argv[index + 1];
    if (!value || value.startsWith('-')) throw new Error(`${option} needs a value`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--output') options.output = valueAfter(index++, '--output');
    else if (arg === '--destination') options.destination = resolve(valueAfter(index++, '--destination'));
    else if (arg === '--skip-stale') options.skipStale = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function usage() {
  return [
    'Usage: npm run accept:m2:physical -- [--output OUTPUT] [--destination DIR] [--skip-stale]',
    '',
    'Runs isolated M2 browser/HTTP/MQTT acceptance on the real 1024x600 panel.',
    'Only roost-panel.service is stopped temporarily; restoration is verified before success.',
  ].join('\n');
}

async function acquireRunLock() {
  const runtimeDir = process.env.XDG_RUNTIME_DIR;
  assert.ok(runtimeDir, 'XDG_RUNTIME_DIR is required to lock the physical panel runner');
  const lockPath = join(runtimeDir, 'roost-m2-physical-acceptance.lock');
  const owner = String(process.pid);

  for (;;) {
    try {
      await symlink(owner, lockPath);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let existingOwner;
      try {
        existingOwner = await readlink(lockPath);
      } catch (readError) {
        if (readError.code === 'ENOENT') continue;
        throw new Error(`physical panel lock is unreadable: ${lockPath}`, { cause: readError });
      }
      if (!/^\d+$/.test(existingOwner)) {
        throw new Error(`physical panel lock has an invalid owner: ${lockPath}`);
      }
      try {
        process.kill(Number(existingOwner), 0);
        throw new Error(`physical acceptance is already running as PID ${existingOwner}`);
      } catch (ownerError) {
        if (ownerError.code !== 'ESRCH') throw ownerError;
      }
      const stalePath = `${lockPath}.stale-${owner}-${Date.now()}`;
      try {
        await rename(lockPath, stalePath);
        await unlink(stalePath);
      } catch (staleError) {
        if (staleError.code !== 'ENOENT') throw staleError;
      }
    }
  }

  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      if (await readlink(lockPath) === owner) await unlink(lockPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  };
}

function chromiumPath() {
  if (process.env.ROOST_CHROMIUM_BIN) return [process.env.ROOST_CHROMIUM_BIN];
  return ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'];
}

async function findChromium() {
  for (const candidate of chromiumPath()) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  throw new Error('Chromium not found; set ROOST_CHROMIUM_BIN');
}

async function command(file, args, options = {}) {
  return execFileAsync(file, args, { maxBuffer: 4 * 1024 * 1024, ...options });
}

async function hyprJson(subject) {
  const { stdout } = await command('hyprctl', [subject, '-j']);
  return JSON.parse(stdout);
}

async function isUserUnitActive(unit) {
  try {
    const { stdout } = await command('systemctl', ['--user', 'is-active', unit]);
    return stdout.trim() === 'active';
  } catch {
    return false;
  }
}

export function acceptancePayload({
  state = 'needs_attention',
  label = 'Approve harmless physical acceptance check?',
  prompt = null,
} = {}) {
  const now = new Date().toISOString();
  return {
    v: 1,
    ts: now,
    state,
    count: state === 'idle' ? 0 : 1,
    label,
    urgency: prompt ? 'blocking' : 'ambient',
    primary_run_id: state === 'idle' ? null : 'physical-acceptance:run',
    since: now,
    prompt,
    roster: [],
  };
}

export function acceptancePrompt(id, { reversible = true, actor = 'Claude' } = {}) {
  const gateway = id.split(':', 1)[0];
  return {
    id,
    kind: 'approve_reject',
    reversible,
    expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
    actor: { gateway, name: actor },
    summary: 'Approve harmless physical acceptance check?',
    queue: { position: 1, total: 1 },
  };
}

async function discoverOutput(requested) {
  const monitors = await hyprJson('monitors');
  let output = requested;
  if (!output) {
    const clients = await hyprJson('clients');
    const panel = clients.find((client) => client.title === 'roost');
    output = monitors.find((monitor) => monitor.id === panel?.monitor)?.name ?? null;
  }
  const monitor = monitors.find((candidate) => candidate.name === output);
  assert.ok(monitor, 'could not identify the output holding the production Roost panel');
  assert.deepEqual(
    [monitor.width, monitor.height],
    [1024, 600],
    `output ${output} is not the expected 1024x600 panel`,
  );
  return {
    output,
    monitorId: monitor.id,
    focusedOutput: monitors.find((candidate) => candidate.focused)?.name ?? null,
  };
}

async function waitForWindow() {
  try {
    return await waitFor(async () => {
      const clients = await hyprJson('clients');
      return clients.find((client) => /^roost(?: - Chromium)?$/.test(client.title)) ?? null;
    }, { timeout: 15_000, interval: 100 });
  } catch {
    const clients = await hyprJson('clients');
    const chromiumWindows = clients
      .filter((client) => /chrom/i.test(`${client.class} ${client.initialClass}`))
      .map((client) => `${client.class}:${client.title}`);
    throw new Error(`acceptance browser window not found; chromium windows=${JSON.stringify(chromiumWindows)}`);
  }
}

async function placeWindow(output, expectedMonitorId) {
  let panel = await waitForWindow();
  const address = panel.address;
  await command('hyprctl', ['dispatch', 'hl.dsp.focus({ workspace = "name:roost" })']);
  await command('hyprctl', ['dispatch', `hl.dsp.focus({ window = "address:${address}" })`]);
  await waitFor(async () => (await hyprJson('activewindow')).address === address, {
    timeout: 3_000,
    interval: 50,
  });
  panel = (await hyprJson('clients')).find((client) => client.address === address);
  if (panel.workspace?.name !== 'roost') {
    await command('hyprctl', ['dispatch', 'hl.dsp.window.move({ workspace = "name:roost", follow = true })']);
    await waitFor(async () => {
      const candidate = (await hyprJson('clients')).find((client) => client.address === address);
      return candidate?.workspace?.name === 'roost' ? candidate : null;
    }, { timeout: 3_000, interval: 50 });
    await command('hyprctl', ['dispatch', `hl.dsp.focus({ window = "address:${address}" })`]);
    await waitFor(async () => (await hyprJson('activewindow')).address === address, {
      timeout: 3_000,
      interval: 50,
    });
    panel = (await hyprJson('clients')).find((client) => client.address === address);
  }
  if (panel.fullscreen === 0) {
    await command('hyprctl', ['dispatch', 'hl.dsp.window.fullscreen()']);
  }
  panel = await waitFor(async () => {
    const candidate = (await hyprJson('clients')).find((client) => client.address === address);
    return candidate?.fullscreen !== 0 ? candidate : null;
  }, { timeout: 3_000, interval: 50 });
  assert.equal(panel.monitor, expectedMonitorId, `acceptance window did not land on ${output}`);
  assert.deepEqual(panel.size, [1024, 600], 'acceptance window is not exact-output fullscreen');
  return panel;
}

async function startStack() {
  const broker = await startBrowserBroker();
  let current = acceptancePayload({ state: 'idle', label: null });
  let resolveHandler = async () => {
    throw new Error('physical acceptance resolver was not configured');
  };
  const calls = [];
  const publisher = new StatePublisher({
    url: broker.tcpUrl,
    topic: TOPIC,
    heartbeatMs: 1_000,
    reconnectPeriodMs: 0,
    buildPayload: () => ({ ...current, ts: new Date().toISOString() }),
    clientId: `roost-physical-acceptance-${process.pid}`,
  });
  let http;
  try {
    publisher.start();
    await waitFor(() => publisher.connected);

    http = await startHttpServer({
      host: '127.0.0.1',
      port: 0,
      laptopLog: { record: () => 0, count: () => 0, entries: () => [] },
      rendererConfig: {
        wsUrl: broker.wsUrl,
        topic: TOPIC,
        staleMs: STALE_MS,
        instrumentVariant: 'corner',
      },
      resolveApproval: async (id, decision) => {
        calls.push({ id, decision });
        return resolveHandler(id, decision);
      },
    });
  } catch (error) {
    await http?.close().catch(() => {});
    publisher.stop();
    await broker.close().catch(() => {});
    throw error;
  }

  return {
    broker,
    calls,
    http,
    publisher,
    setPayload(next) {
      current = next;
      publisher.touch();
    },
    setResolver(handler) { resolveHandler = handler; },
  };
}

async function showPrompt(stack, page, id, options) {
  stack.setPayload(acceptancePayload({ prompt: acceptancePrompt(id, options) }));
  await page.waitForFunction(
    (promptId) => document.querySelector('.approval-controls')?.dataset.disabled === 'no'
      && document.querySelector('.approval-button[data-decision="allow-once"]')?.disabled === false
      && document.querySelector('.approval-controls')?.hidden === false
      && document.body.textContent.toLocaleLowerCase().includes(promptId.split(':')[0]),
    id,
  );
}

async function clickAllow(page) {
  await page.locator('.approval-button[data-decision="allow-once"]').click();
}

async function capture(output, destination, name, evidence, page) {
  const file = `${name}.png`;
  await page.waitForTimeout(250);
  await command('grim', ['-o', output, join(destination, file)]);
  evidence.captures.push(file);
  return file;
}

async function runAcceptance(options, releaseLock) {
  for (const required of ['grim', 'hyprctl', 'systemctl']) {
    await command('sh', ['-c', `command -v ${required}`]);
  }
  const browserPath = await findChromium();
  const { output, monitorId, focusedOutput } = await discoverOutput(options.output);
  const panelWasActive = await isUserUnitActive('roost-panel.service');
  assert.equal(panelWasActive, true, 'roost-panel.service is not active; refusing to invent deployment state');

  await mkdir(options.destination, { recursive: true });
  const profileDir = await mkdtemp(join(tmpdir(), 'roost-physical-browser-'));
  const evidence = {
    version: 1,
    status: 'running',
    started_at: new Date().toISOString(),
    output,
    output_size: [1024, 600],
    isolated: true,
    production_daemon_untouched: true,
    cases: {},
    captures: [],
  };

  let stack;
  let context;
  let panelMayNeedRestore = false;
  let cleanupPromise;
  const stage = (name) => {
    evidence.stage = name;
    process.stderr.write(`[roost-physical-acceptance] ${name}\n`);
  };
  const cleanup = () => {
    cleanupPromise ??= (async () => {
      let firstError;
      const attempt = async (operation) => {
        try {
          await operation();
        } catch (error) {
          firstError ??= error;
        }
      };
      await attempt(() => context?.close());
      if (stack) {
        await attempt(() => stack.http.close());
        await attempt(() => stack.publisher.stop());
        await attempt(() => stack.broker.close());
      }
      await attempt(() => rm(profileDir, { recursive: true, force: true }));
      if (panelWasActive && panelMayNeedRestore) {
        await attempt(() => command('systemctl', ['--user', 'restart', 'roost-panel.service']));
      }
      if (firstError) throw firstError;
    })();
    return cleanupPromise;
  };

  for (const [signal, code] of [['SIGHUP', 129], ['SIGINT', 130], ['SIGTERM', 143]]) {
    process.once(signal, () => {
      (async () => {
        let cleanupError;
        try {
          await cleanup();
        } catch (error) {
          cleanupError = error;
        }
        evidence.status = 'interrupted';
        evidence.completed_at = new Date().toISOString();
        evidence.error = cleanupError
          ? `${signal}; cleanup failed: ${cleanupError.message}`
          : signal;
        evidence.production_panel_restored = await isUserUnitActive('roost-panel.service');
        await writeFile(
          join(options.destination, 'evidence.json'),
          `${JSON.stringify(evidence, null, 2)}\n`,
          'utf8',
        ).catch(() => {});
        await releaseLock().catch(() => {});
        process.exit(code);
      })();
    });
  }

  let acceptanceError;
  try {
    stage('starting isolated HTTP/MQTT stack');
    stack = await startStack();
    stage('stopping production kiosk');
    // Treat a stop attempt as needing restoration even if systemctl reports a
    // failure after partially changing the unit state.
    panelMayNeedRestore = true;
    await command('systemctl', ['--user', 'stop', 'roost-panel.service']);
    stage('launching temporary Chromium');
    context = await chromium.launchPersistentContext(profileDir, {
      executablePath: browserPath,
      headless: false,
      viewport: null,
      ignoreDefaultArgs: ['--no-sandbox'],
      args: [
        `--app=http://127.0.0.1:${stack.http.port}/`,
        '--window-size=1024,600',
        '--ozone-platform=wayland',
        '--no-first-run',
        '--noerrdialogs',
        '--disable-infobars',
        '--disable-session-crashed-bubble',
        '--hide-crash-restore-bubble',
      ],
    });
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(`http://127.0.0.1:${stack.http.port}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.documentElement.dataset.link === 'up');
    stage('placing temporary Chromium on physical panel');
    const placed = await placeWindow(output, monitorId);
    evidence.window = { size: placed.size, fullscreen: placed.fullscreen, workspace: placed.workspace.name };
    if (focusedOutput) {
      await command('hyprctl', ['dispatch', `hl.dsp.focus({ monitor = "${focusedOutput}" })`]);
    }
    evidence.operator_focus_restored_to = focusedOutput;
    // Hyprland draws a transient fullscreen hint. Returning focus to the
    // operator monitor and settling keeps it out of exact-output evidence.
    await page.waitForTimeout(5_000);

    const irreversibleId = 'labby:physical-irreversible';
    stage('testing irreversible second confirm');
    stack.calls.length = 0;
    stack.setResolver(async () => {
      stack.setPayload(acceptancePayload({ state: 'thinking', label: 'Labby continued', prompt: null }));
      return { approval: { id: 'physical-irreversible', status: 'allowed', decision: 'allow-once' } };
    });
    await showPrompt(stack, page, irreversibleId, { reversible: false, actor: 'Labby' });
    await capture(output, options.destination, '01-irreversible-pending', evidence, page);
    await clickAllow(page);
    await page.waitForFunction(
      () => document.querySelector('.approval-button[data-decision="allow-once"]')?.textContent === 'Confirm allow once',
    );
    await page.waitForTimeout(250);
    assert.equal(
      await page.locator('.approval-button[data-decision="allow-once"]').textContent(),
      'Confirm allow once',
      'armed state must remain visible long enough to capture',
    );
    assert.equal(stack.calls.length, 0, 'first irreversible tap must not reach the HTTP resolver');
    await capture(output, options.destination, '02-irreversible-armed', evidence, page);
    await clickAllow(page);
    await waitFor(() => stack.calls.length === 1);
    await page.waitForFunction(() => document.querySelector('.approval-controls')?.hidden === true);
    assert.deepEqual(stack.calls, [{ id: irreversibleId, decision: 'allow-once' }]);
    await capture(output, options.destination, '03-irreversible-complete', evidence, page);
    evidence.cases.irreversible_second_confirm = {
      pass: true,
      first_tap_http_requests: 0,
      total_http_requests: 1,
    };

    const outsideId = 'omar:physical-outside-answer';
    stage('testing outside-answer removal');
    stack.calls.length = 0;
    await showPrompt(stack, page, outsideId, { actor: 'Omar' });
    await capture(output, options.destination, '04-outside-answer-pending', evidence, page);
    const outsideStarted = performance.now();
    stack.setPayload(acceptancePayload({ state: 'thinking', label: 'Answered outside Roost', prompt: null }));
    await page.waitForFunction(() => document.querySelector('.approval-controls')?.hidden === true);
    const removalMs = Math.round(performance.now() - outsideStarted);
    assert.ok(removalMs < 5_000, `outside answer removal took ${removalMs}ms`);
    assert.equal(stack.calls.length, 0);
    await capture(output, options.destination, '05-outside-answer-removed', evidence, page);
    evidence.cases.outside_answer_removal = { pass: true, removal_ms: removalMs, limit_ms: 5_000 };

    const raceId = 'labby:physical-canonical-race';
    stage('testing canonical terminal winner');
    stack.calls.length = 0;
    stack.setResolver(async () => {
      const error = new Error('approval already answered');
      error.code = 'already_answered';
      error.status = 'denied';
      error.decision = 'deny';
      throw error;
    });
    await showPrompt(stack, page, raceId, { actor: 'Labby' });
    const responsePromise = page.waitForResponse((response) => response.url().endsWith('/api/approval'));
    await clickAllow(page);
    const response = await responsePromise;
    const responseBody = await response.json();
    assert.equal(response.status(), 409);
    assert.equal(responseBody.status, 'denied');
    assert.equal(responseBody.decision, 'deny');
    await page.waitForFunction(
      () => document.querySelector('.approval-line')?.textContent === 'Already answered: denied.',
    );
    await capture(output, options.destination, '06-canonical-winner', evidence, page);
    evidence.cases.canonical_terminal_winner = {
      pass: true,
      attempted: 'allow-once',
      canonical_status: responseBody.status,
      canonical_decision: responseBody.decision,
    };

    if (!options.skipStale) {
      stage('testing stale controls');
      stack.calls.length = 0;
      await showPrompt(stack, page, 'omar:physical-stale', { actor: 'Omar' });
      await capture(output, options.destination, '07-stale-pending', evidence, page);
      const staleStarted = performance.now();
      await stack.broker.cutOffPanelPath();
      await page.waitForFunction(() => document.documentElement.dataset.stale === 'yes', null, {
        timeout: STALE_MS + 10_000,
      });
      const staleMs = Math.round(performance.now() - staleStarted);
      const deadState = await page.evaluate(() => {
        const button = document.querySelector('.approval-button[data-decision="allow-once"]');
        const stale = document.querySelector('#stale');
        button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return {
          disabled: button.disabled,
          pointerEvents: getComputedStyle(button).pointerEvents,
          staleVisible: getComputedStyle(stale).visibility !== 'hidden',
        };
      });
      assert.deepEqual(deadState, { disabled: true, pointerEvents: 'none', staleVisible: true });
      await page.waitForTimeout(200);
      assert.equal(stack.calls.length, 0);
      await capture(output, options.destination, '08-stale-controls-dead', evidence, page);
      evidence.cases.stale_controls_dead = { pass: true, stale_after_ms: staleMs, ...deadState };
    }

  } catch (error) {
    acceptanceError = error;
  }

  let cleanupError;
  try {
    await cleanup();
  } catch (error) {
    cleanupError = error;
  }

  const restored = await isUserUnitActive('roost-panel.service');
  evidence.production_panel_restored = restored;
  const finalError = acceptanceError
    ?? cleanupError
    ?? (restored ? null : new Error('production roost-panel.service was not restored'));
  evidence.status = finalError ? 'failed' : 'passed';
  evidence.stage = finalError ? evidence.stage : 'complete';
  evidence.completed_at = new Date().toISOString();
  if (finalError) evidence.error = finalError instanceof Error ? finalError.message : String(finalError);
  await writeFile(join(options.destination, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  if (finalError) throw finalError;
  process.stdout.write(`${options.destination}\n`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const releaseLock = await acquireRunLock();
  try {
    await runAcceptance(options, releaseLock);
  } finally {
    await releaseLock();
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`[roost-physical-acceptance] ${error.message}\n`);
    process.exitCode = 1;
  });
}
