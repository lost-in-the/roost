import { codedError } from './openclaw.js';
import { StateSource } from './state-source.js';

function qualifyAgent(alias, agent) {
  // Preserve the full record so prompt and future fields survive qualification.
  return {
    ...agent,
    gateway: alias,
    id: `${alias}:${agent.id}`,
    runId: agent.runId == null ? null : `${alias}:${agent.runId}`,
    ...(agent.prompt ? { prompt: { ...agent.prompt, id: `${alias}:${agent.prompt.id}` } } : {}),
  };
}

export class MultiGatewaySource extends StateSource {
  constructor(children = []) {
    super();
    this.children = [...children];
    this.snapshots = new Map(children.map(({ alias }) => [alias, []]));
    this.stale = new Set();
    this.handlers = new Map();
    this.stopped = true;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    for (const child of this.children) {
      this.attach(child);
      child.source.start();
    }
  }

  attach({ alias, source }) {
    const onAgents = (agents) => {
      this.stale.delete(alias);
      this.snapshots.set(alias, agents.map((agent) => qualifyAgent(alias, agent)));
      this.emitMerged();
    };
    const onWarning = (warning) => this.emit('warning', `[${alias}] ${warning}`);
    const onDie = (...args) => this.emit('die', ...args);
    const onConnection = (info) => {
      if (info?.state !== 'disconnected' && info?.state !== 'reconciling') return;
      const wasStale = this.stale.has(alias);
      this.stale.add(alias);
      this.snapshots.set(alias, []);
      this.emitMerged();
      if (!wasStale) this.emit('warning', `[${alias}] source ${info.state}; clearing snapshot`);
    };

    source.on('agents', onAgents);
    source.on('warning', onWarning);
    source.on('die', onDie);
    source.on('connection', onConnection);
    this.handlers.set(alias, { source, onAgents, onWarning, onDie, onConnection });
  }

  emitMerged() {
    if (this.stopped) return;
    const merged = [];
    for (const { alias } of this.children) merged.push(...(this.snapshots.get(alias) ?? []));
    this.emit('agents', merged);
  }

  staleAliases() {
    return this.children
      .map(({ alias }) => alias)
      .filter((alias) => this.stale.has(alias));
  }

  async resolveApproval(qualifiedPromptId, decision) {
    if (typeof qualifiedPromptId !== 'string' || !qualifiedPromptId.includes(':')) {
      throw codedError('unknown_prompt', 'qualified prompt id must include a gateway alias');
    }
    const [alias, ...rest] = qualifiedPromptId.split(':');
    const id = rest.join(':');
    const child = this.children.find((entry) => entry.alias === alias);
    if (!child) throw codedError('unknown_prompt', `unknown gateway alias ${JSON.stringify(alias)}`);
    if (this.stale.has(alias)) throw codedError('gateway_stale', `gateway ${alias} is stale or reconciling`);
    return child.source.resolveApproval({ id, decision });
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    for (const { alias } of this.children) {
      const entry = this.handlers.get(alias);
      if (entry) {
        entry.source.off('agents', entry.onAgents);
        entry.source.off('warning', entry.onWarning);
        entry.source.off('die', entry.onDie);
        entry.source.off('connection', entry.onConnection);
      }
      try { entry?.source.stop(); } catch { /* best-effort */ }
    }
    this.handlers.clear();
    this.snapshots.clear();
    this.stale.clear();
  }
}
