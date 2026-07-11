# Scaffold a visual-verification harness

Build a project-local visual-verification harness, using the shared `code-playwright` utilities (`browser.mjs`) as its base, so future UX changes in this project are easy to verify visually. This is a one-time bootstrap — after this, the `visual-verification` convention tells future agents to reach for the harness you're about to create.

It can be as simple or as elaborate as this project's verification needs call for — a single screenshot script is fine to start, and it's fine to grow it further as needed. Reuse the shared browser-driving primitives (chromium launch, server boot, screenshots, sessions) rather than reimplementing them; only the project-specific glue — the entry file, the port, and the key routes/selectors worth snapping — needs to live here.

## What to build

Adapt all of the following to whatever project you're actually running in (its server entry point, port convention, and key screens) — don't copy these verbatim:

1. The shared `code-playwright` harness is already available as a sibling project — import its browser-driving helpers directly (the next step gives the path).
2. Add the harness wherever this project already keeps dev/verification/helper scripts. If it has no such place, create a sensibly-named directory for it (use your judgment based on this project's conventions — don't default to `debug/` or any other fixed name). The harness should:
   - Import `withPage`, `bootServer`, and/or `withActivePage` from `../../code-playwright/browser.mjs` (adjust the relative path if the sibling repo lives elsewhere).
   - Boot this project's server via `bootServer({ cwd, entry, ... })`, honoring `process.env.PORT` in the project's own entry point if it doesn't already.
   - Navigate to the project's key screen(s) — whatever the most representative "does this app render" route is — and save a screenshot.
   - Tear the server down cleanly on exit (`bootServer`'s `close()` handles this).
3. Follow the shared harness README's "Writing your own debug script" section for the exact shape of a minimal script.

## What NOT to do

- Don't reimplement anything the shared harness already provides (chromium discovery, launch flags, port allocation, sandboxing) — import it instead.
- Don't hard-code assumptions from a different project; read this project's actual `package.json`/server entry to find the real entry file and port.
- This is for visual verification, not a replacement for the project's existing automated test suite — but it can be built up as much as visual verification warrants.
