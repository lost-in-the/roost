import { EventEmitter } from 'node:events';

/**
 * StateSource — the seam between "where agent state comes from" and everything else.
 *
 * The renderer, the aggregation logic and the Hyprland setup are all built and
 * verified against MockStateSource. Swapping in OpenClawStateSource is a change
 * behind this interface and nothing downstream should notice.
 *
 * Contract:
 *   start()                 begin producing state
 *   stop()                  stop producing state; must be idempotent
 *   emit('agents', agents)  the CURRENT FULL SET of known agents, every time
 *   emit('die')             the source has determined the daemon should die
 *                           abruptly (used to exercise MQTT Last Will)
 *
 * `agents` is always the complete set, never a delta. Aggregation is a pure
 * function of the whole set, so a source that emits deltas would force the
 * daemon to keep state it has no business keeping.
 *
 * Each agent record:
 *   { id: string,           stable identity across emissions
 *     state: string,        idle | listening | thinking | stalled | needs_attention
 *     label: string|null,   human-readable; truncated later, at the schema boundary
 *     runId: string|null,   the source's own run identifier
 *     urgency: string,      ambient | notify | blocking
 *     since: number }       epoch ms when this agent entered `state`
 *
 * Note `offline` is not a valid agent state. Offline describes the daemon, not
 * an agent, and is published by the broker via Last Will.
 */
export class StateSource extends EventEmitter {
  start() { throw new Error('StateSource.start() not implemented'); }
  stop() { throw new Error('StateSource.stop() not implemented'); }
}
