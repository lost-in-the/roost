import { StateSource } from './state-source.js';

/**
 * OpenClawStateSource — NOT IMPLEMENTED. This is the M1 stub.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * TODO: implement against a real OpenClaw instance.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * WHY THIS IS STILL A STUB
 * OpenClaw is not installed on this machine yet. As of the M1 build there was
 * no `openclaw` binary on PATH, no `~/.openclaw` or `~/.config/openclaw`, no
 * matching pacman or npm package, and no Stream Deck integration running that
 * could be inspected for the state mechanism it already consumes. Choosing a
 * mechanism now would be guessing, and a wrong guess is more expensive than an
 * honest stub, because everything downstream would be built against a fiction.
 *
 * THE THREE CANDIDATE MECHANISMS (see docs/DECISIONS.md, D-001)
 *
 *   1. Hooks — OpenClaw runs a command on lifecycle events. Cheapest to adopt:
 *      the hook POSTs an agent record to this daemon and nothing needs polling.
 *      Preferred, because it matches how the Stream Deck integration is
 *      described as already working ("OpenClaw already pushes state").
 *
 *   2. Webhook plugin — OpenClaw POSTs to an HTTP endpoint we expose. Same
 *      shape as (1) but configured in OpenClaw rather than as a shell hook.
 *
 *   3. Gateway / API polling — we ask OpenClaw for the current run list on a
 *      timer. Most robust to missed events, worst latency, and the only option
 *      that needs credentials.
 *
 * HOW TO FINISH IT
 *   - Inspect the existing Stream Deck integration to see which mechanism it
 *     consumes. DO NOT MODIFY IT — read only. It is the ground truth.
 *   - Emit `agents` with the COMPLETE current agent set on every change, never
 *     a delta. See state-source.js for the record shape.
 *   - Map OpenClaw's own vocabulary onto the five source states. `stalled` is
 *     the one that will not map directly: it is most likely derived here, from
 *     "no output for N seconds while a run is active", not reported upstream.
 *   - Nothing else needs to change. Aggregation, publishing, staleness, Last
 *     Will and the whole renderer are already built and tested against
 *     MockStateSource behind this same interface.
 */
export class OpenClawStateSource extends StateSource {
  constructor(options = {}) {
    super();
    this.options = options;
    this.started = false;
  }

  start() {
    this.started = true;
    // Deliberately emits nothing. The panel will sit at idle, which is honest:
    // this daemon genuinely has no idea what any agent is doing.
    this.emit('warning',
      'OpenClawStateSource is a stub and reports no agents. ' +
      'Run with ROOST_SOURCE=mock for a working panel. See daemon/sources/openclaw.js.');
  }

  stop() { this.started = false; }
}
