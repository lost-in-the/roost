# Slice 1: Ambient Agent Presence — Delivery Plan

**Chosen approach:** Option A — tethered panel driven by the PC, one enclosure, audio inside. Chosen at the Develop gate, 2026-08-21.

**Unlocked at the gate:** the Waveshare 7" 1024×600 capacitive touch LCD (H) with case is already on hand. M1 costs $0 and can start immediately. Its job is not to be the final panel — it's to answer the layout, legibility, and behavior questions *empirically* so the eventual purchase is informed rather than guessed. If short labels genuinely don't read well on it at the sizes you'd actually use, that's a real finding and it sets the floor for the real panel.

---

## Flows

### User flow — ambient (the 95%)

| State | What the panel does | Notes |
|---|---|---|
| **Idle, nothing running** | Resting face / ambient view, dimmed. No motion that catches peripheral vision. | This is the demand-avoidance surface. Home Remote rules apply. |
| **Agent starts** | State → *thinking*, count increments. Silent, no popup, no animation spike. | A peripheral change you can ignore. |
| **Agent working** | *Thinking* persists, with elapsed time visible. | Elapsed time is what makes seconds-to-tens-of-seconds legible instead of alarming. |
| **Agent finishes** | Brief confirmation, then back to idle. | Non-intrusive. You'll notice it if you look. |
| **Agent needs you** | Distinct, persistent state. Survives until acknowledged. | **The only state permitted to be visually loud.** |
| **Agent stalled / failed** | Visually distinct from *thinking*. | ⚠ Critical: if stuck and thinking look alike, the whole slice fails its success signal. |
| **Needs real review** | Shows "sent to your phone," then returns to idle. | The handoff principle, made visible. Not a failure state. |

**Empty state:** nothing has run all day → ambient view (clock, or the face at rest). Must not read as broken.
**Loading state:** on boot → "connecting," never blank.
**Error state:** see below — this one has a trap in it.

### ⚠ The staleness trap

A panel showing a frozen last-known-good state is **worse than one showing an error**, because you'll trust it and stop checking. If the daemon dies mid-run, the panel says "thinking, 4 minutes" forever and you believe it.

Solution, and it's cheap: **MQTT Last Will and Testament.** The daemon registers an LWT on connect; if it drops, the broker publishes `offline` to the state topic automatically, and every subscriber — panel, Stream Deck, HA — shows disconnected without any of them implementing timeout logic. Payloads also carry their own timestamp so a subscriber can independently detect staleness.

### Data flow

```
OpenClaw (hooks / webhook plugin)
        ↓
  state daemon  ── owns aggregation across all running agents
        ↓
  MQTT (EMQX)   topic: agents/state   [retained] + LWT
        ↓
  ├── panel renderer   (new — this slice)
  ├── Stream Deck      (existing — unchanged, keeps running)
  └── Home Assistant   (later)
```

**State contract** — the keystone. Everything else is a subscriber; get this right and renderers stay disposable.

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

- **Retained** so a subscriber that starts late gets current state immediately, not on next change.
- **Versioned** (`v`) so renderers can be updated independently of the daemon.
- **`label` is short by contract** — a line, not a paragraph. Enforcing brevity in the schema is what stops the panel growing into a third monitor.

**Race condition:** two agents change state in the same instant. **The daemon owns aggregation and publishes one reconciled state.** Renderers must never aggregate — if they do, two surfaces will disagree and you'll stop trusting both.

### Flow tests to run before building

1. **Paper-walk the stalled-vs-thinking distinction.** Sketch both. If you can't tell them apart at a glance from three feet away, redesign before writing code.
2. **Legibility check on the panel you own.** Render your actual longest realistic label at your intended size, sit at normal desk distance. This is the finding that sets the real panel's floor.
3. **Kill the daemon while a run is in flight.** Confirm the panel says disconnected within seconds. If it doesn't, LWT isn't wired right, and everything downstream inherits a lie.

---

## Edge case decisions

| Case | Decision | Note |
|---|---|---|
| PC reboots, panel dark | **Absorb** | PC is effectively never off. Boot splash is a later nicety. |
| HDMI hotplug reorders outputs | **Reshape** | Pin the Hyprland monitor rule by description, never `HDMI-A-1`. |
| Daemon dies mid-run | **Handle** | MQTT LWT → `offline`. Non-negotiable; it's the difference between a tool and a liar. |
| Two agents change state at once | **Handle** | Daemon aggregates; renderers never do. |
| Accidental touch approves something | **Reshape** | Only reversible actions get one-tap. Destructive ones require a second confirm. Deferred to M2. |
| Notification storm | **Defer** | Needs real-world data on how often it happens. Revisit after 30 days. |
| Label too long for the panel | **Reshape** | Truncate at the schema level, not the renderer. Long content is a handoff, by design. |
| Omarchy update breaks Hyprland config | **Absorb** | Mitigated by config-in-Git. |

---

## Increments

### M1: Panel shows live agent state — *retires the riskiest remaining assumption*

The open question is no longer "does ambient status work" (the Stream Deck answered: yes, partially). It's **"does a larger surface close the gap the Stream Deck left."**

**Ships/demos:** the panel you already own, on a spare DP/HDMI output, pinned to its own Hyprland workspace, showing state + count + label + elapsed time, driven by the new MQTT topic. Stream Deck keeps running unchanged alongside it.
**Size:** S. State daemon plus a fullscreen web view. No enclosure, no audio, no touch actions.
**Dependencies:** spare display output; OpenClaw hook already proven.

### M2: Touch approvals + HA view

**Ships/demos:** answer an approve/reject prompt from the panel without opening a laptop; swipe to a Home Assistant view for monitoring and automation shortcuts.
**Size:** S–M. Depends on M1's state contract being stable.

### M3: Enclosure + audio mounting

**Ships/demos:** the finished desk object — final panel selected, XVF3800 and speaker mounted with acoustic geometry fixed, single harness to the PC.
**Size:** M. CAD and print time; low risk given the Qidi and your pedal-build experience.
**Deliberately last** — M1 and M2 tell you the size, angle, and layout you actually need. And the AEC constraint (speaker driven by the array, array and speaker rigidly co-located, panel audio unused) is structural, so it must be designed in here rather than discovered in slice 2.

**Rollout strategy:** *progressive detail per release.* Each milestone is independently useful — no accumulate-behind-a-flag needed, because nothing existing depends on any of it.

---

## Rollout

**The "flag" equivalent:** the new MQTT topic is additive. Nothing currently subscribes to it. The Stream Deck keeps consuming what it consumes today. The panel is a new subscriber, so the blast radius is one systemd unit and one Hyprland monitor rule.

**Kill switch:** `systemctl --user stop` the daemon, or unplug the panel. Both leave the existing setup untouched.

**Rollback:** everything reverts cheaply. Nothing here is a data migration; nothing is irreversible. The only non-reversible spend is M3's enclosure — which is why it's last.

**Config discipline:** Hyprland rules, systemd units, daemon config, and renderer all in Git. Any broker credentials via External Secrets Operator + 1Password references — no inline secrets, consistent with the rest of your stack.

**Instrumentation before the ramp:** the success signal needs a counter, and at n=1 the honest answer is a manual tally with near-zero friction. Concrete suggestion: **put a "had to open the laptop" button on the panel itself.** One tap increments a counter. The instrument lives on the thing being measured, and tapping it is faster than remembering.

---

## Validation — the Done gate

**Pre-declared signal:** across 30 days, **zero laptop-opens motivated solely by checking on or responding to an agent.**
**Baseline:** currently non-zero — the Stream Deck reduced it "somewhat, but not enough."
**Review:** 30 days after **slice 2** ships. Owner: self.

**If missed:**
- **Iterate** if the count is low and the causes are specific (one recurring interaction the panel can't do yet).
- **Expand** if the causes point at a capability gap that's clearly in slice 2 or 3 — voice, or the face carrying more state.
- **Kill** if you're opening the laptop for reasons the panel structurally cannot address. That would mean the ambient-surface premise is wrong, and the right response is to stop building and keep the Stream Deck. Saying this now is what makes it sayable then.

---

## Handoff

**Epics to cut:** three, matching M1–M3. Don't pre-write subtasks past M1 — M1's findings will rewrite them.
**Owner:** self, with the PC OpenClaw instance as implementation partner.
**Where this lives:** ⚠ **not Linear** — Linear is work content only. This gets a **self-contained repository**, which suits it better than the the personal notes vault anyway: the state contract, daemon, renderer, Hyprland rules, systemd units, and eventually the enclosure CAD all belong in one versioned place. Milestones as repo issues; the planning docs in `docs/`. Devlog gets narrative entries if you want them, not the plan of record.
**Revisit cadence:** after M1, and again at the 30-day review.

---

## Resolved at the Deliver gate

### 1. Display connection — ✅ no longer blocking

HDMI currently carries PC interaction; all three DisplayPorts are free, and the display can move either way.

**Cleanest path: move a monitor to DP and give the panel the native HDMI port.** Zero purchase, zero adapter risk, and the Waveshare (H) is HDMI-in anyway.

If you'd rather not re-cable, a **passive** DP→HDMI adapter is very likely fine — <cite index="95-1">30-series cards are reported to support DP++, needing no active adapter for DP-out to HDMI-in</cite>, and <cite index="108-1">an RTX 3060 user with three DP and one HDMI confirmed a passive adapter worked</cite>. At 1024×600 you're far inside passive limits, since <cite index="92-1">passive adapters handle 1080p and below at 60Hz</cite>. The one caveat worth knowing: <cite index="94-1">some cards can't run their maximum monitor count while using DP++, which is more likely when the machine has several DisplayPort connections</cite> — so if a third display misbehaves, that's the first suspect, and an active adapter is the fix.

### 2. Satellite — stays on the board as a slice 3 experiment

Framed as **motion graphics on microcontrollers**, which is a different goal than "render a face" and changes the library question.

⚠ **U8G2 may not be the right tool for this specific job**, and it's worth a spike before committing:

- **U8G2 is immediate-mode and monochrome** — excellent for glyphs, text, and simple state drawing. That's why it fits Home Remote.
- **The bottleneck is usually the bus, not the library.** SSD1306 over I2C means pushing the whole framebuffer every frame at I2C speeds; that ceiling is low. The *same panel over SPI* is dramatically faster and is the cheapest fix if you stay monochrome.
- **For real motion work** — easing, sprites, tweening, compositing — the ESP32 idiom is **LovyanGFX** (or TFT_eSPI) with DMA and sprite buffers on a colour panel. Purpose-built for hand-authored animation in a way LVGL isn't; LVGL's animation engine is widget-oriented and would fight you here.

So the actual fork for slice 3 is **monochrome + SPI + U8G2** versus **colour + LovyanGFX + DMA sprites**. Both dodge LVGL entirely, which keeps the waist brief's constraint intact either way. Cheap spike: animate one easing curve at 30fps on each and compare.

---

## Still open

Nothing blocking. M1 can start.
