# Roost agent contract

Roost is the ambient agent-presence panel described in `README.md`. Work from this repository root and keep
the aggregation daemon, MQTT state contract, renderer, and tests consistent.

Before changing approval behavior, read `docs/M2-touch-approvals.md` and `docs/DECISIONS.md`. For older project
context, use `docs/AGENT_BRIEF.md`; current code and decisions supersede that original milestone brief.

Rules:

- Run `npm test` after code changes. Add or update tests for behavioral changes.
- Keep security and protocol decisions documented in `docs/DECISIONS.md`.
- Never read `.env`, credential caches, device tokens, private keys, or other secret-bearing files.
- Do not change host services, OpenClaw gateways, paired-device scopes, firewall policy, or deployment state
  from this repository task unless the operator explicitly authorizes that exact action.
- Do not commit or push unless the task explicitly requests it.
- Do not weaken the renderer/daemon boundary: the daemon aggregates; renderers consume the published state.
