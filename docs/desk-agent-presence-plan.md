# Desk Agent Presence — Plan

**Scale:** M (leaning L) · **Slices:** 4, sequential · **Planned:** 2026-08-21 · **Participants:** the author and Claude
**Status:** slice 1 approved, M1 ready to start. Slices 2–4 unplanned by design.

## TL;DR — what was decided

- **Build:** a small touchscreen on the desk, driven by the PC over HDMI, showing what the agents are doing. Microphone array and speaker in the same enclosure.
- **Not:** a standalone gadget with its own chip. The PC renders everything; the screen is just glass.
- **Why:** once agent work moves to the always-on PC, there's nothing on the desk to watch it through — so you'd keep opening the laptop just to check.
- **First step (M1):** costs nothing. Uses the 7" Waveshare panel already on hand.
- **How we'll know it worked:** 30 days with zero laptop-opens just to check on an agent.
- **The one thing that must be right:** the shared state message on MQTT (§4). Every screen subscribes to it; get it right and the screens themselves stay disposable.

> **What this document is.** The record of why this got built this way — including the framings and options that lost, and the four places the plan was wrong and got corrected. If you're reading this in three months wondering "why not just X," X is probably in section 2 or 5.

---

## 1. Problem

### North Star

Homelab and personal agent work is moving off the M1 onto the always-on PC, leaving nothing on the desk to observe it through. Once the last dependency migrates, agent activity becomes **invisible and unanswerable unless you open a machine specifically to check** — which is the exact habit the migration was meant to end.

### How it started

A narrow ask: a small desk device to talk to an OpenClaw agent, inspired by Byte-90 and Taby (heytaby.com, Lloyd December). It expanded twice — first to agent monitoring, then to owning a FieldStation42 TV channel — before compressing to the above.

### Framings considered

| Framing | Verdict |
|---|---|
| "An assistant with a face" | **Rejected as North Star.** Most interesting part, survives as slice 3, but doesn't address why the project matters. |
| "Fewer displays" | **Reinterpreted.** The real constraint is desk *footprint* and machines-to-maintain, not screen count. Net −1 object is the win condition. |
| "Ambient surfaces independent of keyboard focus" | **Chosen**, merged with the one below. |
| "Get personal life off the work machine" | **Chosen** — but see correction #1: this was initially built on a false premise. |

### Success — pre-declared

**Primary:** across 30 days, **zero laptop-opens motivated solely by checking on or responding to an agent.**
*Baseline:* non-zero. The Stream Deck already reduced it "somewhat, but not enough."
*Judge:* self. *Review:* 30 days after slice 2 ships.

**Secondary:** stalled or failed agent runs noticed by glance · agent prompts answered without opening a laptop.
**Learning signal:** two distinct assistant appearances prototyped and swapped without touching hardware.
**Anti-metric (the Home Remote test):** still voluntarily in use at week 4. A device that nags or interrupts badly fails here even if everything else passes.

### Scope

**In:** always-visible agent state (idle / listening / thinking / needs-attention, plus count and usage) · voice in and out with barge-in · non-voice binary approve/reject · quick Home Assistant view · swappable appearance as software · ambient media with overlay, notifications, and pause-while-responding · one desk object, minimum cabling.

**Out:**

| Excluded | Why |
|---|---|
| Full content review / complex approvals | Phone and browser own this. Only the binary case is local. |
| Display-KVM switching between machines | *Input* switching wearing a display costume. Belongs to the Corne/ZMK track. A panel that switches away is a panel where the assistant vanishes. |
| Work Mac clamshell transition | Gated on keyboard/trackpad, not on this. Parallel track. |
| The CRT hunt | Unbounded side quest. The CRT *look* is a shader; the CRT *object* is a separate project. |
| Presence detection as a wake trigger | Lights up every time you sit down. May return as a dimming input only. |
| Rendering video from another device | Moot once the PC drives the panel. Curiosity satisfied, requirement dissolved. |

### Constraints

- **No external deadline.** Sequencing is driven by dependency and by what unblocks the M1.
- **Footprint:** must not increase net desk objects. Target net −1.
- **Self-contained enclosure**, even if tethered. A first-class filter, not a preference.
- **⚠ Load-bearing assumption:** the PC is effectively never off. Omarchy experimentation is what would invalidate it.
- **AEC is mandatory** — mic and speaker co-located, always-on, or barge-in dies.
- **Latency reality:** agent turns run seconds to tens of seconds. The thinking state must not read as broken.
- **Idle is ~95% of runtime.** Idle behavior *is* the product.
- **No GUI-toolkit learning on the critical path.** Orchestration and window rules fine; retained-mode framework ramp-up not.
- **Upstream dependency:** the cluster agent's browser access must land on the PC before the M1 can leave. In flight, owned elsewhere. Doesn't block design; does block validation.
- **Implementation partner:** the PC OpenClaw instance. Options must be expressible as versioned config an agent can execute — not click-through setup.
- **GitOps:** config in Git, secrets via External Secrets Operator + 1Password.

---

## 2. Options considered

Judged against: *agent activity visible without sitting at a machine.*

### ✅ Option A — Tethered Panel — **chosen**

Panel driven by the PC as a dedicated Hyprland output, pinned to its own workspace, never switched. XVF3800 USB array for mic, AEC, speaker, and status LEDs. All in one enclosure, harness to the PC.

**Why it won:** every remaining gap — readable short text, a face, media on one surface, touch approvals — is a panel capability. None argued for a satellite. And the face on a panel is a web view: no toolkit to learn, swappable in an afternoon, which serves the slice 3 learning goal *better* than firmware would.

### ❌ Option B — Stream Deck as the surface (the 80/20 cut)

No new glass; the existing Stream Deck renders state and takes approvals.

**Why it lost:** it wasn't a spike — it was already running. OpenClaw already pushes state to a Stream Deck on the M1. It had therefore already returned its result: **"somewhat, but not enough."** The mechanism works; fifteen backlit icons run out of room. That answer validated the direction and retired the project's riskiest assumption for free.

### ❌ Option C — Network Satellite

ESP32 or Pi with its own brain, talking to OpenClaw over WiFi. One cable: power.

**Why it lost:** it's the only architecture where cable count genuinely reaches one, and that's a real win — but it puts firmware and a toolkit ramp on the critical path, contradicting a named constraint, and it makes the media path unreachable. Kept alive in reduced form as slice 3.

### ❌ Option D — Hybrid (panel + satellite)

**Why it lost:** it was the right answer for about one message. Once "own ears" and "media on the same surface" came in, everything moved into one enclosure and the satellite lost its job. Two devices when one suffices fails the footprint constraint.

**⚠ The satellite isn't dead — it just isn't architecture.** It moved to slice 3 as a standalone experiment that nothing depends on. See §4. If it never gets built, slices 1, 2, and 4 are unaffected.

---

## 3. Research findings that shaped the design

### 🚨 USB-only single-cable display is a landmine on this stack

**Bottom line: don't drive this panel over USB. Use HDMI or DisplayPort straight from the graphics card.**

The obvious "self-contained, one cable" answer is a USB-C portable monitor. On Hyprland that means **DisplayLink** — a chip that squeezes video over USB instead of a real display cable — driven by a Linux kernel module called **evdi**. That combination is actively broken in ways that track this exact setup. A **May 2026** report covers <cite index="12-1">Omarchy 3.8.0, Hyprland 0.54.3, DisplayLink 6.2-1, evdi 1.14.16 — output works after reboot, but hotplug stops entirely</cite>. Historically also <cite index="13-1">devices loading with evdi present and the service healthy, yet no output appearing in Hyprland at all</cite> and <cite index="14-1">corrupted output when a Wayland greeter hands off to the user session, because evdi keeps stale DRM state</cite>. A patch is <cite index="17-1">merged into Aquamarine</cite>, but the community answer is telling: <cite index="24-1">the maintainer of the DisplayLink patch gist switched to a DP-Alt-Mode screen and stopped needing it</cite>.

**Confirmed hardware:** RTX 3080 Ti FE has one HDMI 2.1 and three DP 1.4a, no USB-C. Ryzen 5 3600 has no iGPU. DP Alt Mode is impossible here. **Video comes off the GPU. Self-containment is won through the enclosure, not the cable count.**

### 🚨 AEC dictates where the speaker physically lives

*AEC = acoustic echo cancellation — the processing that stops a device from hearing its own voice through its own speaker. Without it, the device goes deaf while it's talking, so you can't interrupt it mid-sentence.*

**Bottom line: the speaker plugs into the microphone array, not into the screen.**

The XVF3800 <cite index="35-1">takes its AEC reference from the left channel of its I2S or USB input, ignores the right, and configures its DAC to play that left channel on both outputs so what enters the room matches what the canceller expects</cite>. It also <cite index="35-1">calibrates to the loudspeaker-to-microphone acoustic path at startup, which needs some far-end audio present</cite>.

**Therefore:** the speaker is driven **by the array** — its speaker connector or 3.5mm jack — never by the panel's HDMI audio. Array and speaker must be rigidly co-located. Get this wrong and AEC silently does nothing, barge-in dies, and it presents as a software bug.

**Won for free:** the array's <cite index="45-1">DoA-driven LED ring and host-side `xvf_host` CLI</cite> plus <cite index="40-1">5 GPO pins usable as digital, PWM, or LED-flasher outputs, host-controllable over the control interface</cite> — the status-LED nice-to-have, on a part already in the BOM, scriptable by an agent.

### The Stream Deck is fine on Linux — Elgato's software was the problem

`streamdeck-linux-gui` <cite index="68-1">runs as a systemd --user service with per-button icons, animated GIFs, pages, auto-dim, and config import/export</cite>, and `streamdeck-yaml` is <cite index="66-1">configured entirely from a YAML file with Home Assistant integration</cite>. Config-as-code plus HA — exactly the required filter.
⚠ Keystroke emulation leans on X11-era libs (<cite index="56-1">pynput and python-xlib</cite>); under Wayland, use **Command** actions.

### A PC has no GPIO — which settles sensors permanently

mmWave, ambient light, and I2C/UART sensors have nowhere to land on a desktop. Cameras are USB and fine; everything else wants a microcontroller. So sensor expansion means **a small ESPHome puck reporting to Home Assistant** — and crucially, that puck can hide anywhere in the room. It never has to be the thing you look at, so it doesn't constrain the display decision at all.

### "Two devices means two codebases" is avoidable — the Taby property

What made Taby appealing: **the agent's presentation is a client, not a device.** Build it that way and one state daemon publishes to MQTT (EMQX, already running), and every surface is a thin subscriber of a few hundred lines. Renderers stay disposable; the contract is the asset.

---

## 4. The plan

### Slice sequence

| Slice | North Star | Success |
|---|---|---|
| **1 — Ambient agent presence** | Agent activity visible without sitting at a machine | Runs observed and answered from the panel |
| **2 — Voice loop** | Assistant reachable without a keyboard | Full conversation including mid-response interruption |
| **3 — Face, personality, arbitration** | Assistant has presence and knows when not to interrupt | Two swappable appearances; week-4 anti-metric holds |
| **4 — Media** | Ambient media the assistant can politely interrupt | FieldStation running, overlay and pause-on-response correct |

Sequential, not parallel. Each slice's lived experience is discovery input for the next — slice 3's interruption rules in particular should not be designed before slice 2 teaches how the latency feels.

### ⚠ The sequencing risk, named

**Slice 1 buys the hardware; slice 4 exercises it.** Panel size and capability get chosen months before media needs them. Mitigated by starting M1 on the Waveshare 7" 1024×600 (H) already on hand — its job is to answer layout and legibility questions empirically so the real purchase is informed rather than guessed.

### Slice 1 — Delivery Plan

Full detail in `slice1-delivery-plan.md`. Summary:

**M1 — Panel shows live agent state.** Existing panel, spare display output, pinned Hyprland workspace, state + count + label + elapsed time from the new MQTT topic. Stream Deck keeps running alongside. **Size S.**
**M2 — Touch approvals + HA view.** Answer a prompt without a laptop. **Size S–M.**
**M3 — Enclosure + audio mounting.** Final panel, XVF3800 and speaker mounted with acoustic geometry fixed, single harness. **Size M.** Deliberately last: M1 and M2 tell you the size and angle you need, and it's the only irreversible spend.

**State contract** — the keystone; everything else subscribes.

```json
{ "v": 1, "ts": "…", "state": "idle|thinking|listening|needs_attention|stalled|offline",
  "count": 2, "label": "short, by contract", "urgency": "ambient|notify|blocking", "primary_run_id": "…" }
```

**Retained** (a screen that starts late gets the current state immediately, instead of sitting blank until something changes), **versioned** (`v`, so screens can be updated independently of the daemon), and using **MQTT Last Will and Testament (LWT)** — a message the broker sends on your behalf if your connection drops — so a dead daemon publishes `offline` automatically and no screen has to implement its own timeout logic. `label` is short *by contract* — enforcing brevity in the schema is what stops the panel growing into a third monitor.

**Three design rules that carry weight:**

1. **Stalled must not look like thinking.** With turns running seconds to tens of seconds, this distinction is the whole difference between a tool and an anxiety object.
2. **A frozen panel is worse than an error panel** — you'd trust it and stop checking. LWT solves this centrally so no renderer implements timeout logic.
3. **The daemon aggregates; renderers never do.** Two surfaces disagreeing means you trust neither.

**Handoff principle:** the panel's job includes knowing when to send you elsewhere. "Needs review → pushed to your phone" is designed behavior, not a limitation. This is what keeps the panel permanently simple.

**Instrumentation:** a "had to open the laptop" button on the panel itself. The instrument lives on the thing being measured, and tapping beats remembering.

**Rollout:** additive — new MQTT topic, nothing currently subscribes, Stream Deck untouched. Kill switch is `systemctl --user stop` or unplug. Nothing irreversible except M3's enclosure.

**Home:** a self-contained repository — state contract, daemon, renderer, Hyprland rules, systemd units, enclosure CAD, and these docs in `docs/`. **Not Linear** (work only). Devlog for narrative if wanted, not the plan of record.

### Slice 3 note — the satellite, as an optional experiment

**Read this against §2:** Option D (panel *plus* satellite) was rejected. The panel does the work. What survives here is a separate, optional build with **no dependents** — a second face in a different medium, subscribing to the same MQTT state message. Skipping it changes nothing else.

Framed as *motion graphics on microcontrollers*, which is a different goal than "render a face" and changes the library question.

**Good news from the gate:** the HiLetgo 2.42" SSD1309 128×64 module already in use on the pedal is **jumper-selectable between I2C (4-pin) and SPI (7-pin)**. That collapses most of the spike — the bottleneck for animation is the bus, not U8G2, and this panel can simply be moved to SPI. A 128×64 monochrome framebuffer is 1KB; over SPI that's about a millisecond per frame, so the transfer stops being the limit and rendering becomes the limit. **U8G2 is very likely sufficient**, and no library change is needed.

LovyanGFX with DMA sprite buffers only becomes the answer if slice 3 moves to a colour panel at higher resolution. Either path dodges LVGL, keeping the no-toolkit constraint intact.

Bonus: 2.42" at 128×64 gives chunky, large pixels — good for a bold monochrome face, since each pixel is doing real visual work rather than disappearing into density.

---

## 5. Corrections — where the plan was wrong

Kept deliberately. These are the reasoning errors, not just the outcomes.

| # | Error | Correction |
|---|---|---|
| 1 | **Invented a deadline.** Assumed the work Mac hosted TV and that clamshelling would strand it, so media went first. | The work Mac is for work; clamshell is gated on the keyboard situation. The displaced machine is the **M1**. Media lost its date and moved last. |
| 2 | **Carried stale context as fact.** Treated FieldStation42 as running on a Pi 3B with a burn-in timer. | It isn't installed anywhere. Greenfield, more work than assumed, and entirely optional to the North Star. |
| 3 | **Wrote a confounded metric.** "M1 stays closed 30 days" — but the M1's last job is browser access, migrating independently. | The laptop would close whether or not this gets built. Replaced with zero laptop-opens *motivated by agent checking*, which only the panel can deliver. |
| 4 | **Recommended D, then reversed to A.** Argued for panel + satellite on the strength of a U8G2/LVGL split. | Once every named gap turned out to be a panel capability and the device needed its own ears, the satellite lost its job. |
| 5 | **Inflated a requirement.** Turned "legible short text" into an explicit legibility requirement and raised the panel resolution floor. | Short strings only — approval prompts, HA labels. 1024×600 at 7" is ~170 PPI and fine. **Resolution is not a differentiator**; choose on footprint, glass, case, and mounting angle. |

---

## 6. Validation results

*To be appended after the 30-day review.*

**Signal:** zero laptop-opens motivated solely by checking on or responding to an agent, across 30 days.
**Baseline:** non-zero; Stream Deck reduced it "somewhat, but not enough."
**Review date:** 30 days after slice 2 ships. **Owner:** self.

**If missed:**
- **Iterate** — count is low and causes are specific (one recurring interaction the panel can't do yet).
- **Expand** — causes point at a capability gap clearly inside slice 2 or 3.
- **Kill** — you're opening the laptop for reasons the panel structurally cannot address. That means the ambient-surface premise is wrong; stop building and keep the Stream Deck. *Saying this now is what makes it sayable then.*

---

## Appendix — Discovery Notes

Full notes in `desk-display-discovery-notes.md`. The parts still worth carrying:

- **Three roles, incompatible display appetites.** TV wants colour and video and size; monitoring wants text density; a face wants small and characterful and reads fine in monochrome. One surface serving all three needs arbitration rules — and arbitration is a compositor's job, which is cheap on Linux and expensive on an MCU. This is the observation the entire architecture rests on.
- **No usage data exists.** Personal system, preference-driven. Hence the harsh, falsifiable primary metric — there was nothing else honest available.
- **Prior art in-house.** Home Remote already encodes ADHD-first, demand-avoidance-conscious interaction rules. Reuse them; don't re-derive.
- **The skills asymmetry that drove early analysis.** Fluent in U8G2, not LVGL, not GUI toolkits. This looked decisive for weeks of the conversation and ultimately dissolved — the Linux path needs orchestration, not toolkit knowledge, and the satellite path can stay in U8G2. Worth remembering that the constraint shaped the search even though it didn't decide the answer.

---

## Findability — other names for the things in this document

*Added so this surfaces when the exact word won't come.*

**This project:** desk agent display · agent status screen · little screen on the desk · the thing that shows what the agents are doing · ambient agent presence · desk companion · assistant panel

**The state message (§4):** state contract · MQTT topic · the JSON blob every screen reads · agent status payload · `agents/state`

**AEC:** acoustic echo cancellation · echo canceller · the reason the mic can hear you while the speaker is talking · barge-in support · the thing that makes interrupting work

**LWT:** Last Will and Testament · MQTT dead-man's switch · the "it went offline" message · staleness protection

**DisplayLink / evdi:** USB video · USB-to-HDMI chip · the thing that doesn't work on Hyprland · why the panel uses a real display cable

**DP++ / DP Alt Mode:** DisplayPort dual-mode · passive vs active adapter · whether a cheap DisplayPort-to-HDMI dongle works

**XVF3800:** ReSpeaker · the microphone array · the round mic with the LED ring · XMOS voice chip

**U8G2 / LovyanGFX:** the OLED drawing libraries · monochrome display code · how the little screen draws · the animation library question

**Hyprland output pinning:** dedicated monitor · monitor rule · the workspace that never switches · keeping the panel out of the tiling
