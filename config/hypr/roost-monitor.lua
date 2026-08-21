-- Panel monitor identity. GENERATED — re-derive with scripts/derive-monitor.sh
--
-- Pinned by DESCRIPTION, never by connector name: connector names like
-- "HDMI-A-1" reorder on hotplug and would silently move the panel.
--
-- Re-derive on this or any other machine:
--     hyprctl monitors -j | jq -r '.[] | "\(.name)  \(.width)x\(.height)  \(.description)"'
--
-- ⚠ PLACEHOLDER. At M1 build time the Waveshare panel was NOT plugged in:
--   all three DisplayPorts read "disconnected" and HDMI-A-1 held the Dell
--   ultrawide. Plug the panel in and run scripts/derive-monitor.sh to replace
--   this file with the real description.
return {
  -- The `description` field from `hyprctl monitors -j`, without the "desc:" prefix.
  description = "Waveshare 7inch HDMI LCD H",

  mode = "1024x600@60",
  position = "auto",
  scale = 1,

  -- Escape hatch: a raw connector name, used ONLY for outputs with no
  -- description (Hyprland headless outputs). Leave nil for real hardware so
  -- the description-based selector is used.
  output = nil,

  -- Set true once the real panel is present and verified.
  verified = false,
}
