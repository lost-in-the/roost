const STATES = new Set(['idle', 'listening', 'thinking', 'stalled', 'needs_attention']);

function clean(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

export function rosterView(roster) {
  if (!Array.isArray(roster)) return [];
  return roster.flatMap((entry) => {
    const gateway = clean(entry?.gateway);
    const name = clean(entry?.name);
    if (!gateway || !name || !STATES.has(entry?.state)) return [];
    const label = gateway.toLocaleLowerCase() === name.toLocaleLowerCase()
      ? name
      : `${gateway} · ${name}`;
    return [{
      label,
      state: entry.state,
      active: Number.isInteger(entry.active) && entry.active >= 0 ? entry.active : 0,
      pending: Number.isInteger(entry.pending) && entry.pending >= 0 ? entry.pending : 0,
      primary: entry.primary === true,
    }];
  });
}

export function mount(root) {
  function render(roster) {
    const entries = rosterView(roster);
    root.replaceChildren();
    root.hidden = entries.length === 0;
    for (const entry of entries) {
      const chip = document.createElement('div');
      chip.className = 'agent-chip';
      chip.dataset.state = entry.state;
      chip.dataset.primary = entry.primary ? 'yes' : 'no';

      const dot = document.createElement('span');
      dot.className = 'agent-dot';
      dot.setAttribute('aria-hidden', 'true');
      chip.appendChild(dot);

      const name = document.createElement('span');
      name.className = 'agent-name';
      name.textContent = entry.label;
      chip.appendChild(name);

      const state = document.createElement('span');
      state.className = 'agent-state';
      state.textContent = entry.pending > 0
        ? `${entry.pending} waiting`
        : entry.active > 1 ? `${entry.active} ${entry.state}` : entry.state.replace('_', ' ');
      chip.appendChild(state);
      root.appendChild(chip);
    }
  }

  render([]);
  return { render };
}
