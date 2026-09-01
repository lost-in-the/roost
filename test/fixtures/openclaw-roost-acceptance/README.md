# Roost OpenClaw approval acceptance fixture

This is a temporary, no-secret OpenClaw plugin for reproducing Roost's live
approval paths. It is part of the test suite, not a production dependency.

It registers two parameter-free tools:

- `roost_reversible_probe` returns a static success result and changes nothing.
- `roost_irreversible_probe` increments only a process-local counter, so it can
  exercise the renderer's second confirm without persistent side effects.

The `before_tool_call` hook emits bounded static titles and deliberately ignores
tool parameters. `npm test` checks the manifest, static copy, parameter absence
and tool behavior.

For an operator-authorized live drill, install this directory with the target
Gateway's normal `openclaw plugins install` command, allow the two tools in that
Gateway's tool policy, and restart the Gateway. Configure only the reversible
pair in Roost:

```sh
ROOST_OPENCLAW_REVERSIBLE_TOOLS=roost-acceptance/roost_reversible_probe
```

Run each tool once through an isolated agent session, then restore the previous
Gateway tool policy, uninstall `roost-acceptance`, restart the Gateway, and
remove the temporary Roost setting. Never leave the fixture installed merely
to satisfy an acceptance checkbox.
