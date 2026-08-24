# Hyprland and systemd configuration

Everything here was verified by hand on the machine it was written for. Where a
directive does not behave as the wiki documents, the **actual** behaviour is
recorded below with how it was tested — version drift in this area is common and
the wiki is generally ahead of, or behind, whatever you have installed.

**Verified on:** Hyprland `0.56.2` (commit `efb5099`, tag v0.56.2), Omarchy,
Wayland, Lua config parser. Chromium 151.

---

## Files

| File | What it does | Installed as |
|---|---|---|
| `hypr/roost.lua` | Monitor, named workspace, window rules, cycling fix | `~/.config/hypr/roost.lua` (symlink) |
| `hypr/roost-monitor.lua` | The panel's monitor description. **Generated.** | `~/.config/hypr/roost-monitor.lua` (copy) |
| `systemd/roost-daemon.service` | The aggregation daemon | `~/.config/systemd/user/` (symlink) |
| `systemd/roost-panel.service` | Launches and places the browser | `~/.config/systemd/user/` (symlink) |

`roost.lua` is symlinked so `git pull` updates it. `roost-monitor.lua` is
**copied**, because it describes this machine's hardware and should not be
overwritten by a checkout made on different hardware.

Loaded from `~/.config/hypr/hyprland.lua` with:

```lua
require("hypr.roost")
```

It must come **after** `require("default.hypr.omarchy")` so its window rules win
over Omarchy's defaults (notably the browser opacity tag).

---

## Re-deriving the monitor description

The panel is pinned by **description**, never by connector name, because
connector names (`HDMI-A-1`, `DP-2`) reorder on hotplug.

```sh
./scripts/derive-monitor.sh            # auto-detect the 1024x600 output
./scripts/derive-monitor.sh --list     # show every connected output
./scripts/derive-monitor.sh DP-2       # pick a connector explicitly
```

Or read it straight off Hyprland:

```sh
hyprctl monitors -j | jq -r '.[] | "\(.name)  \(.width)x\(.height)  \(.description)"'
```

Then `cp config/hypr/roost-monitor.lua ~/.config/hypr/` and `hyprctl reload`.

### ⚠ The panel was not connected when this was built

At M1 build time all three DisplayPorts read `disconnected` and `HDMI-A-1` held
the Dell ultrawide:

```
$ for c in /sys/class/drm/card*-*/status; do echo "$(basename $(dirname $c)) $(cat $c)"; done
card1-DP-1      disconnected
card1-DP-2      disconnected
card1-DP-3      disconnected
card1-HDMI-A-1  connected
```

**That is no longer the situation.** As of 2026-08-23 the panel is connected on
`HDMI-A-1` and everything below is verified on the real glass: the output is
pinned by description, the `roost` workspace is bound to it, and the renderer
sits fullscreen at 1024x600. `roost-monitor.lua` carries the real description
and `verified = true`.

The panel still reports a **cloned EDID** — `Lenovo Group Limited LEN L1950wD
B3432845`, serial `0x01010101` (a placeholder), max image size 15cm x 10cm. The
name is fiction; the size and the 1024x600 preferred timing are the panel's own.
Pinning uses that string because it is what Hyprland sees and it is stable.

It also advertises 1920x1080, 1440x900 and 1280x720. **The hardware refuses to
sync any of them.** All three were set on the live output and it stayed at
1024x600 every time. Do not build a fallback around those modes.

⚠ **There is no touch input.** `/proc/bus/input/devices` shows no touch
controller and the USB tree has none. The only touch device on the machine is
`Touch passthrough` (`Vendor=beef Product=dead`, `/devices/virtual/input/`),
which is Sunshine's virtual input for Moonlight. These panels carry video on
HDMI and touch on a separate USB lead; that lead has never enumerated. A missing
driver would still show a device, so this is a cable problem.

---

## ⚠ Known defect: the panel silently loses fullscreen

Observed twice on 2026-08-24. The panel drops from **1024x600 to 1024x574**,
handing 26px back to the bar's reserved area. Nothing errors; the panel just
gets slightly smaller, which on a wall display is easy to miss for days.

Re-running `./scripts/launch-panel.sh` fixes it. It is idempotent and re-places
an existing window, so it is safe to run at any time.

**What has been ruled out:**

- **`hyprctl reload` is NOT the trigger.** Tested directly: fullscreen survives
  a reload (`1024x600 fullscreen=2` before and after).
- **The window is not being recreated.** Both occurrences kept the same window
  address (`0x564494d87e00`), so this is one window losing state, not Chromium
  relaunching.

**What is suspected but unproven:** both occurrences were around a daemon
restart. The renderer takes its state from MQTT over WebSocket, not from the
daemon's HTTP server, so a restart should not disturb a loaded page — which
makes the correlation suspicious rather than explanatory. Do not fix this until
the trigger is actually identified.

**Why it cannot self-heal today:** the `fullscreen = true` window rule does not
apply on 0.56.2 (see below), so nothing restores it declaratively. Omarchy's
Lua layer exposes only `hyprland.start`, `layer.opened` and `layer.closed` —
there is no window event to hook a re-dispatch onto.

**The likely home for the fix** is `ExecStartPost=` on `roost-panel.service`,
re-running the placement after any restart. That is blocked on the same broker
question as the rest of the systemd work.

---

## Version drift — what does not work as documented on 0.56.2

### 1. `hyprctl keyword` is rejected outright

Omarchy configures Hyprland in **Lua**, and the Lua parser refuses the legacy
keyword path:

```
$ hyprctl keyword monitor "HEADLESS-1,1024x600@60,auto,1"
keyword can't work with non-legacy parsers. Use eval.
```

Use `hyprctl eval` with a Lua call instead:

```sh
hyprctl eval 'hl.monitor({ output = "HEADLESS-1", mode = "1024x600@60", position = "auto", scale = 1 })'
```

### 2. `hyprctl dispatch` takes Lua, not bare words

```
$ hyprctl dispatch moveworkspacetomonitor "name:roost HEADLESS-1"
error: ')' expected near 'name'
```

Dispatchers live under `hl.dsp.<group>`, and `hyprctl dispatch` wraps its
argument in `hl.dispatch(...)`:

```sh
hyprctl dispatch 'hl.dsp.focus({ workspace = "name:roost" })'
hyprctl dispatch 'hl.dsp.focus({ monitor  = "HDMI-A-1" })'
hyprctl dispatch 'hl.dsp.window.fullscreen()'
```

Note `hl.dsp.focus` is a **function**, while `hl.dsp.workspace` and
`hl.dsp.window` are **tables** of functions.

### 3. Window-rule fields that do not exist

`no_border` and `no_rounding` are not fields on this version and raise config
errors:

```
hl.window_rule: unknown field 'no_border'
hl.window_rule: unknown field 'no_rounding'
```

The accepted set (from `/usr/share/omarchy/default/hypr/apps/*.lua`) includes:
`border_size` · `center` · `decorate` · `float` · `fullscreen` · `idle_inhibit`
· `keep_aspect_ratio` · `move` · `no_blur` · `no_dim` · `no_initial_focus` ·
`no_screen_share` · `no_shadow` · `opacity` · `pin` · `size` · `stay_focused` ·
`tag`. Use `border_size = 0` and `decorate = false`.

Likewise `rounding` is **not** a valid *workspace* rule field here, though
`gaps_in`, `gaps_out` and `border_size` are.

### 4. Layer rules cannot match on a monitor

```
$ hyprctl eval 'hl.layer_rule({ match = { namespace = "^omarchy-bar$", monitor = "HEADLESS-2" } , ... })'
hl.layer_rule: unknown match property 'monitor'
```

So the Omarchy bar cannot be hidden on the panel output by a layer rule. It does
not need to be: a genuinely **fullscreen** window renders above the bar's layer
and covers it. Confirmed by sampling the top row of a screenshot — it is
`#06080b`, the renderer's own background, not the bar.

### 5. ⚠ `fullscreen = true` as a window rule does not apply

The rule is accepted without error, but the window still maps inset by the bar's
reserved area:

```
ws=roost size=1024x574 fs=0        # with the rule set
```

Dispatching fullscreen after the window maps **does** work and persists:

```
ws=roost size=1024x600 fs=2
```

`scripts/launch-panel.sh` does this. The rule is left in place because it is
harmless and may start working on a later version.

### 6. ⚠ `default = true` does not claim the output

Hyprland assigns the lowest free **numbered** workspace to a monitor as it
connects, and that workspace keeps the output. A `default = true` named
workspace rule does not displace it — verified by removing and recreating the
output with the rule already loaded, which still produced:

```
HEADLESS-2 1024x600 activeWs=2      # not "roost"
```

The fix, also in `launch-panel.sh`: focus the named workspace once, then focus
back to where the human was. The panel workspace **stays** on its output
afterwards, and focus returns correctly:

```
HDMI-A-1   activeWs=1     focused=true
HEADLESS-2 activeWs=roost focused=false
```

---

## The four pinning requirements, and how each was verified

| Requirement | Verified |
|---|---|
| A **named** workspace bound to the panel's monitor | `hyprctl workspaces -j` → `roost -> HEADLESS-2`; id is negative (`-1337`), which is how Hyprland represents named workspaces |
| The renderer window assigned to it by window rule | `hyprctl clients -j` → panel window `workspace=roost`, `size=1024x600`, `fullscreen=2` |
| Must **not** appear in workspace cycling on the main monitors | See below — this one failed at first and needed a fix |
| Must survive a Hyprland reload without escaping | `hyprctl reload`, then re-checked: same workspace, same 1024x600 fullscreen geometry, focus still on the Dell, `hyprctl configerrors` empty |

### ⚠ Cycling: this required changing two Omarchy keybindings

Omarchy binds workspace cycling to `e+1`/`e-1`, which walk **every existing
workspace across all monitors**. Measured from the Dell:

```
cycle e+1 -> roost (monitor HEADLESS-2)     <- wrong: focus jumps to the panel
cycle e+1 -> 1     (monitor HDMI-A-1)
cycle e+1 -> roost (monitor HEADLESS-2)
```

There is **no workspace rule on this version that hides a workspace from
cycling**. The mechanism that works is the monitor-scoped dispatcher `m+1`/`m-1`,
which only walks the current monitor's workspaces:

```
cycle m+1 -> 1 (monitor HDMI-A-1)
cycle m+1 -> 1 (monitor HDMI-A-1)     <- roost is never reachable
```

So `roost.lua` rebinds four Omarchy defaults:

| Key | Was | Now |
|---|---|---|
| `SUPER + TAB` | `workspace e+1` (all monitors) | `workspace m+1` (this monitor) |
| `SUPER + SHIFT + TAB` | `workspace e-1` | `workspace m-1` |
| `SUPER + scroll down` | `workspace e+1` | `workspace m+1` |
| `SUPER + scroll up` | `workspace e-1` | `workspace m-1` |

**On the main monitor the behaviour is identical** — it only stops cycling from
wandering onto other outputs. Delete that section of `roost.lua` if you would
rather keep the Omarchy defaults; the panel still works, it just becomes
reachable with TAB.

---

## Validating a change

```sh
hyprctl reload
hyprctl configerrors          # must print nothing

hyprctl monitors -j   | jq -r '.[] | "\(.name) \(.width)x\(.height) activeWs=\(.activeWorkspace.name)"'
hyprctl workspaces -j | jq -r '.[] | "\(.name) -> \(.monitor)"'
hyprctl clients -j    | jq -r '.[] | select(.title=="roost") | "ws=\(.workspace.name) size=\(.size|join("x")) fs=\(.fullscreen)"'
```

Expect the panel window on `ws=roost`, `size=1024x600`, `fs=2`.

## Testing without the panel hardware

A headless output stands in for the panel:

```sh
hyprctl output create headless
hyprctl monitors -j | jq -r '.[] | .name'     # note the new HEADLESS-N
```

Point `~/.config/hypr/roost-monitor.lua` at it using the `output` escape hatch
(headless outputs report an **empty** description, so they cannot be matched by
one):

```lua
return { description = "HEADLESS TEST", output = "HEADLESS-2",
         mode = "1024x600@60", position = "3440x0", scale = 1, verified = false }
```

Then `hyprctl reload` and `./scripts/launch-panel.sh`. Screenshot it with
`grim -o HEADLESS-2 shot.png`. Remove it with `hyprctl output remove HEADLESS-2`.

## systemd

```sh
systemctl --user daemon-reload
systemctl --user enable --now roost-daemon roost-panel
systemctl --user status roost-daemon
journalctl --user -u roost-daemon -f
```

Kill switch, leaving the Stream Deck and everything else untouched:

```sh
systemctl --user stop roost-panel roost-daemon
```

The units are deliberately **not** ordered against the broker. EMQX is not
managed by this machine's systemd, so ordering could never work; the daemon
reconnects with exponential backoff instead and publishes nothing until it is
genuinely connected.
