# Scaffold a visual-verification harness wrapper

Build a small, project-local wrapper around the shared `code-playwright` so future UX changes in this project are easy to verify visually. This is a one-time bootstrap — after this, the `visual-verification` convention tells future agents to reach for the wrapper you're about to create.

Keep it thin: the generic browser-driving logic (launching chromium, waiting for a server, taking screenshots, multi-turn sessions) already lives in the shared harness repo. This wrapper should contain **only** project-specific glue — the entry file, the port, and the key routes/selectors worth snapping.

## What to build

Adapt all of the following to whatever project you're actually running in (its server entry point, port convention, and key screens) — don't copy these verbatim:

1. The shared `code-playwright` harness is already installed as a conductor plugin and present as a sibling project — there's nothing to clone. It's available at `../../code-playwright/browser.mjs` relative to a script in this project's `debug/` dir (the relative path may differ if the plugin lives elsewhere).
2. Add a small script under this project's `debug/` directory (create the directory if it doesn't exist) that:
   - Imports `withPage`, `bootServer`, and/or `withActivePage` from `../../code-playwright/browser.mjs` (adjust the relative path if the sibling repo lives elsewhere).
   - Boots this project's server via `bootServer({ cwd, entry, ... })`, honoring `process.env.PORT` in the project's own entry point if it doesn't already.
   - Navigates to the project's key screen(s) — whatever the most representative "does this app render" route is — and saves a screenshot.
   - Tears the server down cleanly on exit (`bootServer`'s `close()` handles this).
3. Follow the shared harness README's "Writing your own debug script" section for the exact shape of a minimal script.

## What NOT to do

- Don't reimplement anything the shared harness already provides (chromium discovery, launch flags, port allocation, sandboxing) — import it instead.
- Don't hard-code assumptions from a different project; read this project's actual `package.json`/server entry to find the real entry file and port.
- Don't grow this into a full test suite — it's a visual-verification convenience script, not a replacement for the project's existing tests.
