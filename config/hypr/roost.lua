-- roost — dedicated Hyprland output for the desk agent panel.
--
-- Installed as ~/.config/hypr/roost.lua and loaded from ~/.config/hypr/hyprland.lua:
--
--     require("hypr.roost")
--
-- VERIFIED ON Hyprland 0.56.2 (Omarchy, Lua config parser). Several directives
-- behave differently from the wiki on this version — config/README.md records
-- each one and how it was tested.

local panel = require("hypr.roost-monitor")

-- Monitor selector. Description-based, so hotplug reordering of connector names
-- (HDMI-A-1, DP-1 …) can never move the panel to the wrong output.
--
-- `panel.output` is an escape hatch for outputs that report NO description —
-- Hyprland headless outputs, which is how this config gets verified when the
-- physical panel is unplugged. Real hardware always has a description.
local MONITOR = panel.output or ("desc:" .. panel.description)

-- The window is matched by TITLE. renderer/index.html sets <title>roost</title>,
-- so this is ours to control. Chromium on Wayland derives its app_id from the
-- --app URL (e.g. "chrome-127.0.0.1__-Default"), which changes with host and
-- port, making it the less stable identifier.
local PANEL_TITLE = "^roost$"

-- 1. The output ------------------------------------------------------------

hl.monitor({
  output = MONITOR,
  mode = panel.mode,
  position = panel.position,
  scale = panel.scale,
})

-- 1b. Touch input ----------------------------------------------------------
--
-- The panel is a touchscreen. Hyprland does NOT route touch to the monitor the
-- glass physically belongs to unless it is told to. Touch.cpp (0.56.2) does:
--
--     PMONITOR     = query().name(boundOutput).run() or focused_monitor
--     TOUCH_COORDS = PMONITOR.position + (pos * PMONITOR.size)
--
-- Touch positions arrive normalized 0.0-1.0, so with no binding they are scaled
-- onto whatever monitor happens to be FOCUSED. Measured here before the fix:
-- a touch near the centre of the glass put the cursor at 2127,613 -- the centre
-- of `sunshine-vd`, not this panel. On a single-monitor machine (the Pi this
-- panel came from) the fallback is accidentally correct, which is why the panel
-- appeared to "work fine" there and dead here.
--
-- WHY PER-DEVICE, not the global `input:touchdevice:output`:
--   * The global defaults to "[[Auto]]", but the autodetect branch in
--     InputManager.cpp is commented out (FIXME upstream), so Auto binds nothing.
--   * A global would also capture Sunshine's virtual `touch-passthrough`
--     device, which must keep targeting sunshine-vd.
--
-- WARN: `output` MUST be a connector name. MonitorQueryCore.cpp matches it with
-- `*m_name != m->name()`, an exact compare against the connector, so the
-- `desc:` selector used for MONITOR above is silently ignored here. The
-- description stays the source of truth and is resolved to a connector below.
--
-- Device name is Hyprland's, from `hyprctl devices` -> Touch.
local TOUCH_DEVICE = "waveshare-ws170120"

-- Used only when the description cannot be resolved: at COLD BOOT the config is
-- parsed before outputs are enumerated, so hl.get_monitors() is empty and there
-- is nothing to match against. Any later `hyprctl reload` re-resolves properly
-- and corrects this if the connector has moved.
local TOUCH_CONNECTOR_FALLBACK = "HDMI-A-1"

local function connector_for(description)
  for _, m in ipairs(hl.get_monitors()) do
    if m.description == description then
      return m.name
    end
  end
end

hl.device({
  name = TOUCH_DEVICE,
  output = panel.output or connector_for(panel.description) or TOUCH_CONNECTOR_FALLBACK,
})

-- 2. A named workspace bound to that output --------------------------------
--
-- `persistent` keeps it alive with no windows on it, so the panel monitor is
-- never left showing an empty numbered workspace instead.
--
-- ⚠ `default = true` does NOT reliably claim the output on 0.56.2: Hyprland
-- assigns the lowest free NUMBERED workspace to a monitor as it connects, and
-- that workspace keeps the output. scripts/launch-panel.sh performs the focus
-- dance that actually puts `roost` on screen. See config/README.md.
hl.workspace_rule({
  workspace = "name:roost",
  monitor = MONITOR,
  default = true,
  persistent = true,
  -- The panel is one window filling the glass. No gaps, no border.
  gaps_in = 0,
  gaps_out = 0,
  border_size = 0,
})

-- 3. Pin the renderer window ------------------------------------------------

hl.window_rule({ match = { title = PANEL_TITLE }, workspace = "name:roost" })
hl.window_rule({ match = { title = PANEL_TITLE }, fullscreen = true })

-- Strip decoration. On 0.56.2 the fields are `border_size` and `decorate`;
-- `no_border` and `no_rounding` do NOT exist and raise config errors.
hl.window_rule({ match = { title = PANEL_TITLE }, border_size = 0 })
hl.window_rule({ match = { title = PANEL_TITLE }, decorate = false })
hl.window_rule({ match = { title = PANEL_TITLE }, no_shadow = true })
hl.window_rule({ match = { title = PANEL_TITLE }, no_blur = true })
hl.window_rule({ match = { title = PANEL_TITLE }, no_dim = true })

-- Ambient by definition: it must never take focus from the main monitors.
hl.window_rule({ match = { title = PANEL_TITLE }, no_initial_focus = true })

-- Omarchy tags every window for default opacity and tags Chromium-based
-- windows again in default/hypr/apps/browser.lua. Opt out of both so the panel
-- renders at full opacity.
hl.window_rule({ match = { title = PANEL_TITLE }, tag = "-default-opacity" })
hl.window_rule({ match = { title = PANEL_TITLE }, opacity = "1.0 1.0" })

-- 4. Keep the panel out of workspace cycling on the main monitors -----------
--
-- ⚠ THIS CHANGES TWO OMARCHY DEFAULT BINDINGS. Delete this section if you would
-- rather keep them; the panel still works, it just becomes reachable by TAB.
--
-- Omarchy binds SUPER+TAB and SUPER+scroll to `e+1`/`e-1`, which cycle every
-- existing workspace ACROSS ALL MONITORS — verified to land on `roost` and drag
-- focus onto the panel output. The monitor-scoped `m+1`/`m-1` cycle only the
-- current monitor's workspaces, so `roost` is unreachable from the main monitor
-- while behaving identically there.
--
-- There is no workspace rule that hides a workspace from cycling on this
-- version; changing the dispatcher is the mechanism that works.
hl.unbind("SUPER + TAB")
hl.unbind("SUPER + SHIFT + TAB")
hl.unbind("SUPER + mouse_down")
hl.unbind("SUPER + mouse_up")

o.bind("SUPER + TAB", "Next workspace (this monitor)", hl.dsp.focus({ workspace = "m+1" }))
o.bind("SUPER + SHIFT + TAB", "Previous workspace (this monitor)", hl.dsp.focus({ workspace = "m-1" }))
o.bind("SUPER + mouse_down", "Scroll workspace forward (this monitor)", hl.dsp.focus({ workspace = "m+1" }))
o.bind("SUPER + mouse_up", "Scroll workspace backward (this monitor)", hl.dsp.focus({ workspace = "m-1" }))
