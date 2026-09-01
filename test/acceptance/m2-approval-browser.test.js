import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { StatePublisher } from '../../daemon/publisher.js';
import { startHttpServer } from '../../daemon/http.js';
import { startBrowserBroker } from '../helpers/browser-broker.js';
import { waitFor } from '../helpers/broker.js';

const TOPIC = `roost/acceptance/${process.pid}/${Date.now()}`;
const STALE_MS = 30_000;

function chromiumPath() {
  if (process.env.ROOST_CHROMIUM_BIN) return process.env.ROOST_CHROMIUM_BIN;
  for (const candidate of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('Chromium not found; set ROOST_CHROMIUM_BIN to its executable');
}

function payload({
  state = 'needs_attention',
  label = 'Approve harmless acceptance check?',
  prompt = null,
} = {}) {
  return {
    v: 1,
    ts: new Date().toISOString(),
    state,
    count: state === 'idle' ? 0 : 1,
    label,
    urgency: prompt ? 'blocking' : 'ambient',
    primary_run_id: state === 'idle' ? null : 'acceptance:run',
    since: new Date().toISOString(),
    prompt,
    roster: [],
  };
}

function approvalPrompt(id, { reversible = true, actor = 'Claude' } = {}) {
  const gateway = id.split(':', 1)[0];
  return {
    id,
    kind: 'approve_reject',
    reversible,
    expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
    actor: { gateway, name: actor },
    summary: 'Approve harmless acceptance check?',
    queue: { position: 1, total: 1 },
  };
}

async function startStack() {
  const broker = await startBrowserBroker();
  let current = payload({ state: 'idle', label: null });
  let resolveHandler = async () => {
    throw new Error('acceptance resolver was not configured');
  };
  const calls = [];

  const publisher = new StatePublisher({
    url: broker.tcpUrl,
    topic: TOPIC,
    heartbeatMs: 1_000,
    reconnectPeriodMs: 0,
    buildPayload: () => ({ ...current, ts: new Date().toISOString() }),
    clientId: `roost-acceptance-daemon-${process.pid}`,
  });
  publisher.start();
  await waitFor(() => publisher.connected);

  const http = await startHttpServer({
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

  const browser = await chromium.launch({
    executablePath: chromiumPath(),
    headless: true,
    args: ['--disable-gpu'],
  });

  return {
    broker,
    browser,
    calls,
    http,
    publisher,
    setPayload(next) {
      current = next;
      publisher.touch();
    },
    setResolver(handler) { resolveHandler = handler; },
    async openPage() {
      const page = await browser.newPage({ viewport: { width: 800, height: 480 } });
      await page.goto(`http://127.0.0.1:${http.port}/`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => document.documentElement.dataset.link === 'up');
      return page;
    },
    async close() {
      await browser.close();
      await http.close();
      publisher.stop();
      await broker.close();
    },
  };
}

async function showPrompt(stack, page, id, options) {
  stack.setPayload(payload({ prompt: approvalPrompt(id, options) }));
  await page.waitForFunction(
    (promptId) => document.querySelector('.approval-controls')?.dataset.disabled === 'no'
      && document.querySelector('.approval-button[data-decision="allow-once"]')?.disabled === false
      && document.querySelector('.approval-controls')?.hidden === false
      && document.querySelector('.approval-button')?.getAttribute('aria-label')?.length > 0
      && document.body.textContent.toLocaleLowerCase().includes(promptId.split(':')[0]),
    id,
  );
}

async function clickAllow(page) {
  await page.locator('.approval-button[data-decision="allow-once"]').click();
}

async function assertEventuallyText(page, text) {
  await page.waitForFunction(
    (expected) => document.querySelector('.approval-button[data-decision="allow-once"]')?.textContent === expected,
    text,
  );
}

test('M2 browser acceptance: real renderer, HTTP route, MQTT transport, and browser controls', { timeout: 120_000 }, async (t) => {
  const stack = await startStack();
  t.after(() => stack.close());

  await t.test('reversible approvals route by qualified Gateway id and the continued run is rendered', async () => {
    for (const gateway of ['labby', 'omar']) {
      stack.calls.length = 0;
      const page = await stack.openPage();
      try {
        const id = `${gateway}:browser-${gateway}`;
        stack.setResolver(async (seenId, decision) => {
          assert.equal(seenId, id);
          assert.equal(decision, 'allow-once');
          stack.setPayload(payload({ state: 'thinking', label: `${gateway} continued`, prompt: null }));
          return { approval: { id: id.split(':')[1], status: 'allowed', decision: 'allow-once' } };
        });
        await showPrompt(stack, page, id);
        await clickAllow(page);
        await page.waitForFunction(
          (continuedLabel) => document.documentElement.dataset.state === 'thinking'
            && document.querySelector('.approval-controls')?.hidden === true
            && document.querySelector('#label')?.textContent === continuedLabel,
          `${gateway} continued`,
        );
        assert.deepEqual(stack.calls, [{ id, decision: 'allow-once' }]);
      } finally {
        await page.close();
      }
    }
  });

  await t.test('irreversible approval needs a fresh second tap inside the confirm window', async () => {
    stack.calls.length = 0;
    const page = await stack.openPage();
    try {
      const id = 'labby:browser-destructive';
      stack.setResolver(async () => ({
        approval: { id: 'browser-destructive', status: 'allowed', decision: 'allow-once' },
      }));
      await showPrompt(stack, page, id, { reversible: false });

      await clickAllow(page);
      assert.equal(stack.calls.length, 0);
      await assertEventuallyText(page, 'Confirm allow once');

      await page.waitForTimeout(4_200);
      await assertEventuallyText(page, 'Allow once');
      assert.equal(stack.calls.length, 0);

      await clickAllow(page);
      await clickAllow(page);
      await waitFor(() => stack.calls.length === 1);
      assert.deepEqual(stack.calls, [{ id, decision: 'allow-once' }]);
    } finally {
      await page.close();
    }
  });

  await t.test('an answer on another surface removes browser controls in under five seconds', async () => {
    stack.calls.length = 0;
    const page = await stack.openPage();
    try {
      await showPrompt(stack, page, 'omar:browser-laptop');
      const started = performance.now();
      stack.setPayload(payload({ state: 'thinking', label: 'answered on laptop', prompt: null }));
      await page.waitForFunction(() => document.querySelector('.approval-controls')?.hidden === true);
      assert.ok(performance.now() - started < 5_000, 'approval controls should disappear in under five seconds');
      assert.equal(stack.calls.length, 0);
    } finally {
      await page.close();
    }
  });

  await t.test('a losing panel race displays the canonical terminal result', async () => {
    stack.calls.length = 0;
    const page = await stack.openPage();
    try {
      const id = 'labby:browser-race';
      stack.setResolver(async () => {
        const error = new Error('approval already answered');
        error.code = 'already_answered';
        error.status = 'denied';
        error.decision = 'deny';
        throw error;
      });
      await showPrompt(stack, page, id);
      const responsePromise = page.waitForResponse((response) => response.url().endsWith('/api/approval'));
      await clickAllow(page);
      const response = await responsePromise;
      assert.equal(response.status(), 409);
      assert.deepEqual(await response.json(), {
        ok: false,
        code: 'already_answered',
        error: 'approval already answered',
        status: 'denied',
        decision: 'deny',
      });
      await page.waitForFunction(
        () => document.querySelector('.approval-line')?.textContent === 'Already answered: denied.',
      );
      assert.deepEqual(stack.calls, [{ id, decision: 'allow-once' }]);
    } finally {
      await page.close();
    }
  });

  await t.test('35 seconds without the panel broker path makes controls actually dead', async () => {
    stack.calls.length = 0;
    const page = await stack.openPage();
    try {
      await showPrompt(stack, page, 'omar:browser-stale');
      await stack.broker.cutOffPanelPath();
      await page.waitForTimeout(35_000);
      assert.equal(await page.evaluate(() => document.documentElement.dataset.stale), 'yes');
      const state = await page.evaluate(() => {
        const button = document.querySelector('.approval-button[data-decision="allow-once"]');
        const stale = document.querySelector('#stale');
        button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return {
          disabled: button.disabled,
          pointerEvents: getComputedStyle(button).pointerEvents,
          staleVisible: getComputedStyle(stale).visibility !== 'hidden',
        };
      });
      assert.deepEqual(state, { disabled: true, pointerEvents: 'none', staleVisible: true });
      await page.waitForTimeout(200);
      assert.equal(stack.calls.length, 0);
    } finally {
      await page.close();
    }
  });
});
