import { StateSource } from './state-source.js';

/**
 * A scripted StateSource. Drives the whole system with no OpenClaw present.
 *
 * Steps are relative: `after` is milliseconds from the start of the loop, and
 * `since` and `prompt.expiresAt` are likewise relative, translated to wall-clock
 * on emission. A hardcoded absolute expiry would be in the past forever, so
 * every prompt in the demo would be dropped as expired the moment it aggregated.
 */

const L = (s) => s; // readability marker for labels

/** The demo loop. Exercises every displayable state, plus the races that matter. */
export const DEMO_SCRIPT = [
  // Quiet. This is ~95% of real runtime, so the panel must be calm here.
  { after: 0, agents: [
    { id: 'ariel', state: 'idle', label: null, runId: null, urgency: 'ambient', since: 0 },
  ]},

  // Woken, listening.
  { after: 6000, agents: [
    { id: 'ariel', state: 'listening', label: L('Listening'), runId: 'run-4f1a', urgency: 'ambient', since: 6000 },
  ]},

  // Working.
  { after: 11000, agents: [
    { id: 'ariel', state: 'thinking', label: L('Deploying photopush to k3s'), runId: 'run-4f1a', urgency: 'ambient', since: 11000 },
  ]},

  // A second agent starts while the first keeps working. count -> 2.
  { after: 19000, agents: [
    { id: 'ariel', state: 'thinking', label: L('Deploying photopush to k3s'), runId: 'run-4f1a', urgency: 'ambient', since: 11000 },
    { id: 'bosun', state: 'thinking', label: L('Reindexing the media library'), runId: 'run-90cc', urgency: 'ambient', since: 19000 },
  ]},

  // bosun goes from thinking to stalled. THE distinction the panel exists for.
  { after: 27000, agents: [
    { id: 'ariel', state: 'thinking', label: L('Deploying photopush to k3s'), runId: 'run-4f1a', urgency: 'ambient', since: 11000 },
    { id: 'bosun', state: 'stalled', label: L('No output for 4m — waiting on a registry lock'), runId: 'run-90cc', urgency: 'notify', since: 27000 },
  ]},

  // A third agent needs a human. Outranks the stall. It carries a prompt, so
  // this is the step where the panel draws buttons: short label, reversible,
  // expiring when cutty moves on to its next question at 51000.
  { after: 35000, agents: [
    { id: 'ariel', state: 'thinking', label: L('Deploying photopush to k3s'), runId: 'run-4f1a', urgency: 'ambient', since: 11000 },
    { id: 'bosun', state: 'stalled', label: L('No output for 4m — waiting on a registry lock'), runId: 'run-90cc', urgency: 'notify', since: 27000 },
    { id: 'cutty', state: 'needs_attention', label: L('Approve deploy photopush to staging?'), runId: 'run-1d7e', urgency: 'blocking', since: 35000,
      prompt: { id: 'prm_8f2a', kind: 'approve_reject', reversible: true, expiresAt: 51000 } },
  ]},

  // The simultaneous-transition race: two agents change in the same instant.
  // cutty is unchanged, still asking, so the prompt must survive the race.
  { after: 43000, agents: [
    { id: 'ariel', state: 'idle', label: null, runId: null, urgency: 'ambient', since: 43000 },
    { id: 'bosun', state: 'idle', label: null, runId: null, urgency: 'ambient', since: 43000 },
    { id: 'cutty', state: 'needs_attention', label: L('Approve deploy photopush to staging?'), runId: 'run-1d7e', urgency: 'blocking', since: 35000,
      prompt: { id: 'prm_8f2a', kind: 'approve_reject', reversible: true, expiresAt: 51000 } },
  ]},

  // The SAME run asks a second question — which is why answering names the
  // prompt id and not the run id. The label is deliberately longer than the
  // 64-character contract maximum, so it exercises truncation AND the §2
  // handoff rule at once: the source asks for approve_reject, and the daemon
  // downgrades it to a handoff because the question cannot be read in full on
  // the glass. The panel says a decision is waiting and draws no buttons.
  { after: 51000, agents: [
    { id: 'cutty', state: 'needs_attention', label: L('Approve destructive migration on the production photopush database before continuing?'), runId: 'run-1d7e', urgency: 'blocking', since: 51000,
      prompt: { id: 'prm_c410', kind: 'approve_reject', reversible: false, expiresAt: 59000 } },
  ]},

  // A third question, carrying no prompt at all. This is what EVERY surface
  // that predates the field renders — the Stream Deck included, and it must
  // keep working untouched — and it is what the live OpenClaw source produces
  // today, since nothing upstream emits prompts yet. Three renderings, three
  // steps: buttons, handoff, and bare.
  { after: 59000, agents: [
    { id: 'cutty', state: 'needs_attention', label: L('Waiting on you'), runId: 'run-1d7e', urgency: 'blocking', since: 59000 },
  ]},

  // Answered. Back to listening, then quiet.
  { after: 67000, agents: [
    { id: 'cutty', state: 'listening', label: L('Listening'), runId: 'run-1d7e', urgency: 'ambient', since: 67000 },
  ]},
  { after: 72000, agents: [
    { id: 'cutty', state: 'idle', label: null, runId: null, urgency: 'ambient', since: 72000 },
  ]},
];

/** Short script that kills the daemon mid-run, to exercise Last Will end to end. */
export const DEATH_SCRIPT = [
  { after: 0, agents: [
    { id: 'ariel', state: 'thinking', label: L('Long-running build, about to be killed'), runId: 'run-dead', urgency: 'ambient', since: 0 },
  ]},
  { after: 8000, die: true, agents: [
    { id: 'ariel', state: 'thinking', label: L('Long-running build, about to be killed'), runId: 'run-dead', urgency: 'ambient', since: 0 },
  ]},
];

export const SCRIPTS = { demo: DEMO_SCRIPT, death: DEATH_SCRIPT };

/** Total loop length: the last step's offset plus its dwell time. */
export function scriptDuration(script) {
  const last = script[script.length - 1];
  const penultimate = script.length > 1 ? script[script.length - 2] : { after: 0 };
  const typicalDwell = last.after - penultimate.after || 1;
  return last.after + typicalDwell;
}

function stepIndexAt(script, elapsedMs) {
  const period = scriptDuration(script);
  const t = ((elapsedMs % period) + period) % period;
  let index = 0;
  for (let i = 0; i < script.length; i++) {
    if (t >= script[i].after) index = i;
  }
  return index;
}

/** A scripted prompt's relative expiry as wall-clock. Null expiry stays null. */
export function absoluteExpiry(prompt, cycleOrigin) {
  const relative = prompt?.expiresAt ?? null;
  return relative === null ? null : cycleOrigin + relative;
}

/** Pure: the agent set a script yields at a given elapsed time. Loops forever. */
export function scriptedAgentsAt(script, elapsedMs) {
  return script[stepIndexAt(script, elapsedMs)].agents;
}

export class MockStateSource extends StateSource {
  constructor({ script = DEMO_SCRIPT, intervalMs = 250 } = {}) {
    super();
    this.script = script;
    this.intervalMs = intervalMs;
    this.originEpoch = Date.now();
    this.stopped = false;
    this.lastCycle = null;
    this.lastIndex = null;
    this.timer = null;
  }

  /** Evaluate the script at `elapsedMs` and emit if the step changed. */
  sample(elapsedMs) {
    if (this.stopped) return;
    const period = scriptDuration(this.script);
    const cycle = Math.floor(elapsedMs / period);
    const index = stepIndexAt(this.script, elapsedMs);
    if (cycle === this.lastCycle && index === this.lastIndex) return;
    this.lastCycle = cycle;
    this.lastIndex = index;

    const step = this.script[index];
    const cycleOrigin = this.originEpoch + cycle * period;
    this.emit('agents', step.agents.map((a) => ({
      ...a,
      since: cycleOrigin + (a.since ?? 0),
      // Same relative-to-wall-clock translation as `since`, and for the same
      // reason. Spread conditionally so an agent with no prompt stays without
      // one rather than gaining an explicit undefined.
      ...(a.prompt ? { prompt: { ...a.prompt, expiresAt: absoluteExpiry(a.prompt, cycleOrigin) } } : {}),
    })));
    if (step.die) this.emit('die');
  }

  start() {
    this.stopped = false;
    this.originEpoch = Date.now();
    this.sample(0);
    this.timer = setInterval(() => this.sample(Date.now() - this.originEpoch), this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
