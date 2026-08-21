# perch — initial prompt, milestone M1

> **How to use this.** Paste everything below the line into a fresh agent session in an empty repo named `perch`, alongside `desk-agent-presence-plan.md` and `slice1-delivery-plan.md`.
>
> **Design rule for this brief:** the agent may be working unattended. Every question that would otherwise block has either a decision baked in or a stub to build against. Nothing here should cause a stall.

---

## Your task

Build **M1** of `perch`: a small touchscreen on my desk showing what my OpenClaw agents are doing, so I stop opening a laptop just to check on them.

**Ship M1 and stop.** M2 and M3 are planned but out of scope.

## Environment — given, but verify with a shell command before relying on it

| Thing | Detail |
|---|---|
| Machine | Desktop PC, always on. Ryzen 5 3600, RTX 3080 Ti FE (1× HDMI 2.1, 3× DP 1.4a, no USB-C) |
| OS / desktop | Omarchy (Arch-based), **Hyprland** on Wayland |
| Panel | Waveshare 7" 1024×600 IPS capacitive touch LCD (H), HDMI in + USB touch. Already owned. |
| Broker | **EMQX**, already running, shared with Home Assistant and Zigbee2MQTT |
| Agents | **OpenClaw** on this PC. An existing Stream Deck integration already consumes agent state. |

**Do not use DisplayLink or any USB-display device.** Broken on Hyprland — see §3 of the plan. Video comes off the GPU.

## Build order — this order matters

**Step 1. Build against a mock. Do not start with the OpenClaw integration.**

Define a `StateSource` interface and write `MockStateSource` first — it emits scripted state transitions on a timer, including `thinking → stalled`, rapid multi-agent changes, and a daemon-death scenario. The entire renderer, the aggregation logic, and the Hyprland setup get built and verified against the mock.

The real `OpenClawStateSource` is the **last** thing you write, and it's a swap behind the same interface. If you can't determine the right OpenClaw mechanism, ship M1 on the mock and leave the real adapter stubbed with a clear TODO. **A working panel driven by a mock is a successful M1.** A stalled session waiting on an integration question is not.

**Step 2.** Aggregation daemon → MQTT → renderer → Hyprland pinning → laptop-open counter → real adapter.

## Decisions already made — do not re-litigate

These were left open in an earlier draft and caused an unattended agent to guess. They're settled now.

### Renderer: web view
A fullscreen browser window, not GTK. Reason: appearance needs to be swappable later without touching the daemon, and HTML/CSS iterates fastest for that. This supersedes any "GTK or web view" wording elsewhere. Still no retained-mode UI framework — plain HTML/CSS/JS is correct; a build step is not.

### Heartbeat and staleness
- The daemon publishes **at least every 10 seconds**, whether or not state changed. Heartbeat is decoupled from state change — this is what makes staleness detectable at all.
- The renderer marks the display **stale after 30 seconds** without a message.
- 30s is deliberately well above the 10s heartbeat and unrelated to how long agent turns run. A long `thinking` state is *not* stale as long as heartbeats keep arriving.

### Aggregation
When agents disagree, highest wins:

`needs_attention > stalled > thinking > listening > idle`

- `urgency` = the maximum urgency across all non-idle agents.
- `count` = **number of non-idle agents.** Not total agents.
- `label` = the label of the agent that determined the displayed state.
- `primary_run_id` = the run id of that same agent. **Renamed from `run_id`** — the old name implied a single run in a payload that aggregates many. If you see `run_id` in older docs, this supersedes it.

### Label length
Max **64 characters**, truncated **in the daemon**, never in the renderer. The renderer may ellipsize further to fit, but must never receive a long string in the first place.

### Last Will payload
LWT is fixed at connect time, so it **must not contain `ts`** — a timestamp frozen at connection would be arbitrarily stale by the time it fires and would corrupt staleness logic.

```json
{ "v": 1, "state": "offline", "count": 0, "label": null,
  "urgency": "ambient", "primary_run_id": null }
```

The renderer treats a payload with `state: "offline"` and no `ts` as **"offline as of now."** Handle the missing field explicitly rather than defaulting it.

### Secrets
This runs as a **systemd user service on a desktop, not in Kubernetes.** External Secrets Operator does not apply here — that's the cluster pattern and it was wrongly carried over.

Use the **1Password CLI**: the unit invokes the daemon via `op run --env-file`, and the daemon reads plain env vars. Provide a committed `.env.example` listing every variable with placeholder values. **Never commit a real credential; never inline one in a unit file.**

Expected variables: `PERCH_MQTT_HOST`, `PERCH_MQTT_PORT`, `PERCH_MQTT_USER`, `PERCH_MQTT_PASSWORD`, `PERCH_MQTT_TOPIC` (default `perch/agents/state`).

### Service dependencies
**Do not order the units against the broker.** EMQX isn't managed by this machine's systemd, so ordering can't work. Instead: the daemon connects with **exponential backoff and reconnects indefinitely**, and publishes nothing until connected. `After=network-online.target` is fine; broker readiness is handled in code.

### Monitor identification
Rule: pin the Hyprland monitor rule by **description**, never by connector name like `HDMI-A-1`, because connector names reorder on hotplug.

You can determine the description yourself — **run `hyprctl monitors -j`** and read the `description` field for the 1024×600 output. Write the discovered value into `config/`, and put the command in the README so it can be re-derived on other hardware.

### Hyprland workspace pinning
This is fiddly and under-specified in most examples. Requirements:

- A **named** workspace (e.g. `name:perch`) bound to the panel's monitor.
- The renderer window assigned to it by window rule.
- The workspace must **not appear in workspace cycling** on the main monitors.
- It must survive a Hyprland reload without the window escaping to another output.

Verify all four by hand before calling it done. If a directive doesn't behave as documented on the installed Hyprland version, note the actual behavior in `config/README.md` — version drift here is common.

## The state contract

Topic `perch/agents/state`, **retained**, with the LWT above.

```json
{
  "v": 1,
  "ts": "2026-08-21T17:46:43Z",
  "state": "idle|thinking|listening|needs_attention|stalled|offline",
  "count": 2,
  "label": "Deploying photopush to k3s",
  "urgency": "ambient|notify|blocking",
  "primary_run_id": "abc123"
}
```

Version it in `schema/` with a changelog. Renderers must tolerate unknown future fields.

## Non-negotiable rules

1. **The daemon aggregates. The renderer never does.** Two surfaces that can disagree make both untrustworthy.
2. **`stalled` must be visually distinct from `thinking`.** Turns legitimately run tens of seconds. If working and stuck look alike, the project fails its purpose.
3. **A frozen panel is worse than an error panel.** Never show last-known-good indefinitely. LWT and the 30s staleness rule are both required — they cover different failures.
4. **Truncate `label` in the daemon**, at the schema boundary.
5. **Pin by monitor description**, never connector name.
6. **No UI framework.** Plain HTML/CSS/JS in a fullscreen browser.
7. **Everything in Git**, reproducible from a fresh checkout.

## Also build

A **"had to open the laptop" button** in the renderer. One tap increments a counter and appends a timestamped line to a persistent log. This is the measurement instrument for the project's success metric — build it as a real feature, with durable storage, not a debug affordance.

## Out of scope for M1

Touch approvals · Home Assistant views · microphone, speaker, or audio · enclosure or CAD · media playback · the animated face · the ESP32 satellite.

The existing Stream Deck setup keeps running unchanged. Do not modify or migrate it.

## Definition of done

Each item is verifiable by a command or a stated observation.

- [ ] `hyprctl monitors -j` shows the panel; the renderer occupies its named workspace on that output
- [ ] Workspace does not appear when cycling workspaces on the main monitors
- [ ] Mock source drives all six states end to end
- [ ] `thinking` and `stalled` distinguishable at a glance from three feet — **you must state in the PR how they differ visually**, not merely that they do
- [ ] `kill -9` on the daemon mid-run → panel shows offline within 5 seconds
- [ ] Blocking the broker (drop the connection) → panel shows stale within 35 seconds
- [ ] Scripted simultaneous multi-agent transitions produce one coherent displayed state, verified against the documented priority order
- [ ] Laptop-open counter survives a reboot
- [ ] Fresh checkout + documented setup steps reproduces a working system
- [ ] `README.md` covers running it, changing the schema, and re-deriving the monitor description

## Flag and proceed — don't stall on these

If any of the following is unclear, **pick the reasonable option, proceed, and record the choice in `docs/DECISIONS.md`** with what you assumed and what would change if wrong:

1. Which OpenClaw mechanism supplies state — hooks, webhook plugin, or gateway. Build on the mock and stub this.
2. Whether `perch/agents/state` collides with an existing topic namespace on the shared broker.
3. Language and runtime for the daemon. I'm a Rails engineer by trade — **that does not mean Ruby is right here.** Pick for operational simplicity as a long-lived user service.

**Stop and ask only if** something would make this depend on my laptop being open, or require modifying the existing Stream Deck integration. Both defeat the purpose.

## Context worth reading

`desk-agent-presence-plan.md` — start with the TL;DR, then §5 (what the plan got wrong and why), then §3 (research findings that constrain the design). `slice1-delivery-plan.md` has full flows and edge-case decisions.
