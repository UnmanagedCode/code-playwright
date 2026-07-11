# Visually verify UX changes

Always test and visually verify UX changes before considering them done — don't rely on automated tests alone for UI, layout, or visual changes.

- If this project already has a local visual-verification harness (wherever its dev/helper scripts live), use it to capture a screenshot and confirm the change renders correctly.
- If not, create one using the shared `code-playwright` utilities as a base — see its README, "Using from a sibling project" section, for how to import and wire it up.
- Drive the actual golden path (and any obviously-affected edge cases) through the harness, not just a single static screenshot, when the change affects interaction or state.
