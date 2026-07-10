# termux-playwright-harness

A small Playwright setup for driving a webapp through the **system Chromium** on Termux (Android) or a generic Debian/Linux host. Useful for visually verifying changes — screenshots, DOM assertions, console inspection — from a phone or any other host without a desktop browser. The name is historical (it started Termux-only); the harness itself is cross-platform.

Generic infrastructure only. Feature-specific scripts go in the consuming project (or stay as throwaway one-liners in the shell). The goal is reusable pieces for any current or future webapp running on either platform.

```
termux-playwright-harness/
├── browser.mjs       launchBrowser / withPage / waitForServer / findFreePort / bootServer
│                     + startSession / connectSession / withActivePage (multi-turn)
│                     + findChromiumBin / resolveChromiumBin (cross-platform discovery)
├── snap.mjs          generic screenshot CLI (single-shot)
├── session.mjs       multi-turn session CLI (start / stop / status / goto / snap / eval)
├── test/             unit tests for chromium discovery (node --test)
└── package.json      playwright-core only
```

## Growing the harness while debugging

Every debug session is also a chance to make the *next* one cheaper. While you're driving the harness for a specific feature, watch for code with a high probability of being useful across unrelated future debug sessions — and lift it into the harness rather than letting it live in a throwaway script.

Good signals that something belongs here:

- You found yourself **copy-pasting it from a previous session** (mkdtemp + ephemeral roots, REST helper, waiting for a status, killing a subprocess by pid).
- It's **state setup that any feature would need**, not just yours (sandboxing, pre-populating disk fixtures, snapshotting WS traffic, dumping the page console).
- It would be **annoying to rediscover** the next time (CLI flags, env vars, encoding rules, selectors for stable UI landmarks).

Anti-signals — keep these *out* of here:

- Specific to one bug, ticket, or PR (`verify-session-delete.mjs`, `repro-issue-42.mjs`).
- Hard-coded against a particular fixture, project name, scenario, or selector tied to one feature's markup.
- Single-use scripts whose value is the *session*, not the *tool* — those belong in `$TMPDIR/` (or your shell history).

When in doubt, ask: *"Would a teammate debugging a totally different feature next month want this?"* If yes, generalise the API, drop the feature-specific bits, document briefly, and commit it. If no, leave it ephemeral.

## Prereqs

- **Node 22+**.
- A system Chromium/Chrome binary:
  - **Termux**:
    ```bash
    pkg install chromium
    which chromium-browser
    # → /data/data/com.termux/files/usr/bin/chromium-browser
    ```
  - **Debian/generic Linux**:
    ```bash
    apt install chromium
    ```
    (`google-chrome` / `google-chrome-stable` also work if that's what's installed.)

`browser.mjs` finds the binary automatically — no config needed on either platform. Resolution order (see `findChromiumBin`/`resolveChromiumBin` in `browser.mjs`):

1. `PLAYWRIGHT_CHROMIUM_BIN` env var, if set — used as-is; an invalid override fails loudly rather than falling through.
2. A PATH scan of `chromium`, `chromium-browser`, `google-chrome-stable`, `google-chrome`, in that order.
3. The Termux absolute path (`/data/data/com.termux/files/usr/bin/chromium-browser`), as a last-resort fallback for contexts where PATH doesn't carry the usual install location.

If nothing is found, the error lists every candidate that was tried plus the install command for your platform.

> **Debian/Linux support is implemented and unit-tested** (`test/browser.test.mjs` exercises `resolveChromiumBin`'s probe order and fallbacks), **but has not been exercised on real Debian hardware** from this repo — only Termux. Please report issues if something doesn't work there.

> `playwright-core` is intentionally used instead of `playwright`. The full `playwright` package downloads its own Chromium build on install, and those builds aren't published for Android ARM. `playwright-core` exposes the same API minus the auto-download — we point `executablePath` at the system Chromium on whichever platform you're on.

## Install

```bash
cd ~/project/termux-playwright-harness
npm install
```

## Using from a sibling project

This package is consumed via direct relative import — no submodule, no npm publish. Clone it as a sibling of your project:

```bash
git clone git@github.com:UnmanagedCode/termux-playwright-harness.git ~/project/termux-playwright-harness
```

```
~/project/
├── termux-playwright-harness/    # this repo
├── my-webapp/                    # your project
│   └── debug/
│       ├── boot-myapp.mjs        # optional thin wrapper for app-specific defaults
│       └── snap.mjs              # optional app-specific CLI
└── ...
```

Then import directly:

```js
import { withPage, bootServer } from '../../termux-playwright-harness/browser.mjs';
```

Because `playwright-core` is installed under `~/project/termux-playwright-harness/node_modules/`, Node's module resolution finds it relative to `browser.mjs` regardless of where the importer lives.

## Quick smoke test

Snap an already-running URL:

```bash
node snap.mjs http://127.0.0.1:8787 ./home.png
```

Open `home.png` to confirm the page rendered. If you see a blank or chrome-error image, see [Troubleshooting](#troubleshooting).

## Building blocks

### `browser.mjs`

Wraps `playwright-core`'s `chromium.launch()` with an auto-discovered executable path (see [Prereqs](#prereqs)) and a set of launch flags (`--no-sandbox`, `--disable-dev-shm-usage`, etc.) that are safe on both Termux and Debian — see [Troubleshooting](#troubleshooting) for the per-flag rationale.

```js
import { withPage, waitForServer } from '../../termux-playwright-harness/browser.mjs';

await waitForServer('http://127.0.0.1:8787');
await withPage(async (page) => {
  await page.goto('http://127.0.0.1:8787');
  await page.screenshot({ path: 'whatever.png' });
}, { headless: true, viewport: { width: 1440, height: 900 } });
```

- `launchBrowser(opts)` — lower-level: returns the `Browser` directly if you need multi-context / multi-page setups.
- `withPage(fn, opts)` — boots browser + context + page, pipes page console errors/warnings to the terminal, runs `fn(page, { browser, context })`, tears down on return or throw.
- `waitForServer(url, { timeoutMs })` — polls until the URL responds (any non-5xx).
- `findFreePort()` — asks the kernel for an unused TCP port on the loopback. Useful if you're booting your own child process.
- `bootServer({ cwd, entry, port?, env?, sandbox?, silent? })` — spawns an arbitrary node server as a child process on a free ephemeral port (override with `port`), waits for it to bind, and returns `{ url, port, child, sandbox?, close() }`. Cleanup is wired to parent `exit` / `SIGINT` / `SIGTERM` so a Ctrl+C'd script never leaks a server.

```js
import { bootServer, withPage } from '../../termux-playwright-harness/browser.mjs';

const srv = await bootServer({
  cwd: '/path/to/my-app',
  entry: 'server.js',
});
try {
  await withPage(async (page) => {
    await page.goto(srv.url);
    await page.screenshot({ path: 'home.png' });
  });
} finally {
  await srv.close();
}
```

**Sandbox helper.** Most debug sessions want isolated on-disk state, not the real working dirs. Pass a `sandbox` to have `bootServer` create a tmpdir, populate it with named subdirs, and expose each as an env var:

```js
const srv = await bootServer({
  cwd: '/path/to/my-app',
  entry: 'server.js',
  sandbox: {
    dirs: { DATA_ROOT: 'data', LOG_ROOT: 'logs' },
    env:  { NODE_ENV: 'test' },
  },
});
// srv.sandbox.tmpHome              → /tmp/termux-pw-XXXXXX/
// srv.sandbox.dirs.DATA_ROOT       → /tmp/termux-pw-XXXXXX/data
// srv.sandbox.dirs.LOG_ROOT        → /tmp/termux-pw-XXXXXX/logs
// child process sees DATA_ROOT, LOG_ROOT, NODE_ENV in its env
```

`srv.close()` wipes the tmpdir. Multiple concurrent `bootServer({ sandbox: … })` calls each get their own port + tmpdir, so several agents debugging in parallel from their own worktrees stay isolated.

The child receives `PORT=<chosen-port>` in its env — your `entry` script should honour `process.env.PORT`.

Override the chromium path with `PLAYWRIGHT_CHROMIUM_BIN=/some/path` if auto-discovery picks the wrong binary or your install lives somewhere nonstandard.

### `snap.mjs`

CLI: load a URL, save a PNG.

```bash
node snap.mjs <url> [outputPath]
```

- Default output: `screenshots/<ISO-timestamp>-<random>.png` (the directory is gitignored; the random suffix keeps concurrent invocations from colliding).
- Waits up to 5 s for the URL to be reachable before navigating.
- Useful env vars:
  | Var | Effect | Example |
  |---|---|---|
  | `SNAP_VIEWPORT` | Override viewport | `SNAP_VIEWPORT=375x812` (iPhone-ish) |
  | `SNAP_WAIT` | CSS selector to wait for before snapping | `SNAP_WAIT='.sidebar .session-row'` |
  | `SNAP_FULL_PAGE` | `1` → capture full scroll height | `SNAP_FULL_PAGE=1` |
  | `PLAYWRIGHT_CHROMIUM_BIN` | Override chromium binary path (default: platform auto-discovery, see [Prereqs](#prereqs)) | `…/chrome` |

For "boot + snap + tear down" in a single command, write a small consumer CLI in your own project — `bootServer` + `withPage` is two imports and ~15 lines.

## Multi-turn sessions

`withPage` and `snap.mjs` are single-shot — every call launches chromium and tears it down on exit. For agent-style multi-turn workflows (turn 1 navigates, turn 2 inspects, turn 3 acts) page state would be lost between turns. The `session.mjs` CLI fixes that by keeping a long-lived chromium running in a daemon process; each per-turn CLI invocation attaches via CDP, acts on the first context's first page, and detaches without killing the browser. URL, cookies, DOM, scroll position, focused element, and form input all persist between turns.

### CLI

```
node session.mjs start    [--session NAME] [--headless 0|1] [--force]
node session.mjs status   [--session NAME]
node session.mjs goto     <url> [--session NAME] [--wait load|domcontentloaded|networkidle|commit]
node session.mjs snap     [outPath] [--session NAME] [--full-page]
node session.mjs eval     <node-snippet> [--session NAME]
node session.mjs stop     [--session NAME]
```

Session name resolution, in precedence order: `--session <name>` > `PW_SESSION=<name>` env var > an **auto-derived default**. The auto-derived default is `auto-<worktree-basename>-<hash>`, computed from the nearest enclosing git worktree/repo root (falling back to the current directory outside a repo) — stable across every turn issued from the same runner/worktree (turns can `cd` around; the worktree root doesn't move), but distinct across separate runners in separate worktrees or checkouts. This means two runners that never pass `--session` no longer collide the way they would on a shared literal `default`. Multiple named sessions (explicit or auto) run side-by-side with their own chromium / port / user-data-dir.

Behaviour worth knowing:

- `start` **refuses** if a session of that name is already running (exit 1). Pass `--force` to stop-then-start (drops all page state). Stale metadata (PID gone) is cleaned up silently.
- Per-turn commands (`goto`/`snap`/`eval`) **never auto-start** a daemon — they fail with a clear error if none exists.
- `eval` runs a JS snippet in the **daemon's Node process** with `page`, `context`, and `browser` Playwright handles in scope. Use it to batch multiple Playwright actions in one turn. Use `page.evaluate("…")` *from inside* the snippet when you need browser-side JS — that's why there's no separate in-page-eval command. The return value is JSON-printed to stdout.

### Parallel usage

Two runners working in separate worktrees or checkouts get isolated sessions automatically — no flags needed. A runner that wants a human-chosen or explicitly shared name (e.g. two turns of a CI job that don't share a worktree, or deliberately attaching a second process to the same browser) should still pass `--session NAME` or set `PW_SESSION=NAME`; explicit names always win over the auto-derived one, and `start` still refuses a second `start` under the same explicit name unless `--force` is given. Two runners sharing a single directory (not just a worktree) without an explicit `--session` will still resolve to the same auto-derived name and collide — pass distinct explicit names in that case.

### Example: navigate → inspect → act

```bash
node session.mjs start
node session.mjs goto https://example.com
node session.mjs eval 'return page.evaluate("document.title")'    # "Example Domain"
node session.mjs snap /tmp/t1.png
node session.mjs eval 'await page.click("text=Learn more"); await page.waitForLoadState("load"); return page.url()'
node session.mjs eval 'return page.url()'                          # iana.org — state persists across processes
node session.mjs snap /tmp/t2.png
node session.mjs stop
```

### Where things live

- Session metadata: `$XDG_CACHE_HOME/termux-playwright-harness/session-<name>.json` if `XDG_CACHE_HOME` is set, else `~/.cache/termux-playwright-harness/session-<name>.json` (cdpEndpoint, daemon pid, chromium pid, user-data-dir, startedAt). Created by `start`, removed on graceful `stop`. `<name>` is whatever `--session`/`PW_SESSION`/the auto-derived default resolved to.
- Daemon log: same directory, `session-<name>.log` — chromium stdout/stderr + daemon-side messages. Check here if `start` reports the daemon failed to come up.
- Chromium user-data-dir: a fresh `mkdtemp` per `start`, wiped on `stop`.
- `session.mjs snap`'s default output path is `screenshots/<name>-<timestamp>.png` — the session name prefix keeps concurrent sessions' screenshots from colliding even if they share a `screenshots/` dir.

### Programmatic API

```js
import { withActivePage } from '../../termux-playwright-harness/browser.mjs';

await withActivePage(async (page, { context, browser }) => {
  await page.goto('https://example.com');
  return page.title();
}, { name: 'default' });
```

Lower-level helpers: `startSession`, `connectSession`, `readSessionMeta`, `isPidAlive`, `clearStaleSessionMeta`, `defaultSessionName`, `resolveSessionName`.

## Writing your own debug script

```js
// /tmp/check-foo.mjs
import { withPage, waitForServer } from '../../termux-playwright-harness/browser.mjs';

await waitForServer('http://127.0.0.1:8787');
await withPage(async (page) => {
  await page.goto('http://127.0.0.1:8787');
  await page.click('text=Login');
  // assert, screenshot, dump page.content(), etc.
});
```

Useful Playwright APIs for visual debugging:

- `page.waitForSelector('.some-row')` — wait for an element.
- `page.locator('header .mode-select')` — query a specific element.
- `page.on('websocket', ws => ws.on('framereceived', f => console.log(f.payload)))` — eavesdrop on WebSocket traffic.
- `await page.evaluate(() => window.someGlobal)` — peek at the frontend state.

## Troubleshooting

**Snap produces a blank/black image.** Chromium can fail silently without `--no-sandbox`; `browser.mjs` already passes it. If you ever override `extraArgs` from a custom script, keep the defaults in.

**`Could not find a Chromium binary. Tried: ...`.** Nothing was found on PATH or at the known fallback paths. The error lists every candidate that was probed. Install Chromium (`pkg install chromium` on Termux, `apt install chromium` on Debian) or set `PLAYWRIGHT_CHROMIUM_BIN` to an explicit path.

**`PLAYWRIGHT_CHROMIUM_BIN is set to '...' but that path doesn't exist`.** The env override itself points at a missing file — fix the path or unset the var to fall back to auto-discovery.

**`Target page, context or browser has been closed`.** Usually a page-side JS error crashed the renderer. Page errors are already piped to the terminal via the `console` / `weberror` listeners in `withPage` — scroll up.

**Why does every launch pass `--no-sandbox` and friends unconditionally, even on Debian?** All seven flags in `CHROMIUM_ARGS` (`browser.mjs`) are either required on Termux or harmless/standard for headless automation everywhere, so there's no platform branching:

| Flag | Why it's always on |
|---|---|
| `--no-sandbox` | Required on Termux (no setuid sandbox helper on Android); on Debian it's the standard workaround for CI/root/container hosts lacking the sandbox setuid bit — acceptable since this harness only drives local/trusted debug targets, not untrusted web content. |
| `--disable-dev-shm-usage` | Required on Termux (no `/dev/shm` mount); on Debian it just redirects shared-memory IPC to `/tmp`, which is harmless. |
| `--disable-gpu` | Avoids GPU-process crashes/blank renders on Termux's software-only GPU stack; also the standard recommendation for consistent headless screenshots regardless of the host's GPU/driver situation. |
| `--disable-software-rasterizer` | Companion to `--disable-gpu`; a no-op if that fallback path is never hit. |
| `--disable-extensions` | No extensions are ever installed in this automated context on either platform. |
| `--no-first-run` | Skips first-run setup dialogs that would otherwise block automation the first time a fresh profile/user-data-dir is used. |
| `--no-default-browser-check` | Skips the "set as default browser" prompt; irrelevant but harmless if it ever fired. |

**Manually sanity-check chromium discovery** without needing a real install — `resolveChromiumBin` is pure and takes its inputs explicitly:

```bash
node -e "
import('./browser.mjs').then(({ resolveChromiumBin }) => {
  console.log(resolveChromiumBin({ pathEnv: '/nonexistent', absoluteFallbacks: [] }));
});"
```

## Why no Playwright test runner?

This harness exists for *visual* verification — eyes on a screenshot, or interactive scripting — which a headless test runner doesn't help with. If a Playwright assertion is ever worth committing, fold it into your project's existing test setup rather than growing a second runner here. The `test/` directory is a narrow exception: it unit-tests the pure chromium-discovery logic (`resolveChromiumBin`) with `node --test`, not browser behavior — that stance is unchanged.
