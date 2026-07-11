// Thin wrapper around playwright-core that launches Chromium. On Termux
// that's the system `chromium-browser` package (Playwright's own Chromium
// builds aren't published for Android/ARM). On Debian/other Linux it's a
// Playwright-managed Chromium download (`playwright-core install chromium`,
// run by install.sh) resolved through `chromium.executablePath()`.
// Use this from ad-hoc debug scripts so they don't all have to repeat the
// executablePath / flags dance.
//
//   import { withPage } from 'code-playwright/browser.mjs';   // or relative path
//   await withPage(async (page) => {
//     await page.goto('http://127.0.0.1:8787');
//     await page.screenshot({ path: 'screenshots/home.png' });
//   });

import { chromium } from 'playwright-core';
import { existsSync, promises as fsp } from 'node:fs';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

// --- Chromium discovery --------------------------------------------------
//
// Resolution order: PLAYWRIGHT_CHROMIUM_BIN env override, then a PATH scan
// of well-known binary names, then (non-Termux only) the path of a
// Playwright-managed Chromium download (`chromium.executablePath()`, see
// install.sh), then the Termux absolute fallback path as a last resort.

// Termux sets PREFIX to something like /data/data/com.termux/files/usr on
// every invocation; generic Linux never does. More robust than
// os.platform() (reports 'linux' on both) or uname sniffing.
export function isTermux() {
  return !!process.env.PREFIX && process.env.PREFIX.includes('com.termux');
}

const TERMUX_ABS_PATH = '/data/data/com.termux/files/usr/bin/chromium-browser';
const CANDIDATE_NAMES = ['chromium', 'chromium-browser', 'google-chrome-stable', 'google-chrome'];
const ABSOLUTE_FALLBACKS = [TERMUX_ABS_PATH];

// Resolve `name` against PATH the way a shell would, without spawning
// `which` — no subprocess, no assumption it's installed, works identically
// on Termux and Debian since both are POSIX.
function resolveOnPath(name, pathEnv) {
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// Pure core: takes every input explicitly and never touches process.env
// itself, so it can be unit-tested with a fake PATH/candidate list. Returns
// { path, tried } where `tried` is the ordered probe list for error text.
export function resolveChromiumBin({
  envOverride,
  pathEnv = '',
  names = CANDIDATE_NAMES,
  absoluteFallbacks = ABSOLUTE_FALLBACKS,
} = {}) {
  const tried = [];
  if (envOverride) {
    tried.push(`${envOverride} (PLAYWRIGHT_CHROMIUM_BIN)`);
    if (existsSync(envOverride)) return { path: envOverride, tried };
    // An explicit override that's missing is almost certainly a typo — fail
    // loud rather than silently falling through to auto-discovery.
    return { path: null, tried, overrideInvalid: true };
  }
  for (const name of names) {
    tried.push(`${name} (on PATH)`);
    const hit = resolveOnPath(name, pathEnv);
    if (hit) return { path: hit, tried };
  }
  for (const abs of absoluteFallbacks) {
    tried.push(abs);
    if (existsSync(abs)) return { path: abs, tried };
  }
  return { path: null, tried };
}

// Where a Playwright-managed Chromium download would live, if install.sh
// (or a manual `playwright-core install chromium`) has put one there.
// Termux never uses this — it always uses the system chromium-browser
// package instead — so callers should skip it there rather than relying on
// this try/catch alone (Playwright's registry has no Android host entry).
function resolvePlaywrightManagedPath() {
  try {
    const p = chromium.executablePath();
    return typeof p === 'string' && p ? p : null;
  } catch {
    return null;
  }
}

export function findChromiumBin() {
  const playwrightManaged = isTermux() ? null : resolvePlaywrightManagedPath();
  const { path: found, tried, overrideInvalid } = resolveChromiumBin({
    envOverride: process.env.PLAYWRIGHT_CHROMIUM_BIN,
    pathEnv: process.env.PATH ?? '',
    absoluteFallbacks: [...(playwrightManaged ? [playwrightManaged] : []), TERMUX_ABS_PATH],
  });
  if (found) return found;

  const installCmd = isTermux()
    ? 'pkg install chromium'
    : 'npx playwright-core install chromium (or bash install.sh)';
  if (overrideInvalid) {
    throw new Error(
      `PLAYWRIGHT_CHROMIUM_BIN is set to '${process.env.PLAYWRIGHT_CHROMIUM_BIN}' but that path doesn't exist.`,
    );
  }
  throw new Error(
    'Could not find a Chromium binary. Tried:\n' +
    tried.map((t) => `  - ${t}`).join('\n') + '\n' +
    `Install one (\`${installCmd}\`) or set PLAYWRIGHT_CHROMIUM_BIN to an explicit path.`,
  );
}

function requireExecutable(bin) {
  if (!existsSync(bin)) {
    const installCmd = isTermux()
      ? 'pkg install chromium'
      : 'npx playwright-core install chromium (or bash install.sh)';
    throw new Error(
      `Chromium binary not found at ${bin}. Install with \`${installCmd}\` or set PLAYWRIGHT_CHROMIUM_BIN.`,
    );
  }
  return bin;
}

// Launch flags: --no-sandbox and --disable-dev-shm-usage are required on
// Termux (no setuid sandbox helper / no /dev/shm mount on Android); the
// rest reduce memory pressure and skip UI that doesn't matter for
// automation. All seven are also safe/recommended for headless automation
// on generic Debian/Linux — see README Troubleshooting for the per-flag
// rationale — so this list stays unconditional on every platform.
const CHROMIUM_ARGS = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--disable-software-rasterizer',
  '--disable-extensions',
  '--no-first-run',
  '--no-default-browser-check',
];

export async function launchBrowser({
  headless = true,
  executablePath,
  extraArgs = [],
} = {}) {
  const bin = requireExecutable(executablePath ?? findChromiumBin());
  return chromium.launch({
    headless,
    executablePath: bin,
    args: [...CHROMIUM_ARGS, ...extraArgs],
  });
}

// Convenience: spin up a browser + context + page, run `fn`, tear down
// cleanly even on throw. Returns whatever `fn` returns.
export async function withPage(fn, opts = {}) {
  const browser = await launchBrowser(opts);
  try {
    const context = await browser.newContext({
      viewport: opts.viewport ?? { width: 1280, height: 800 },
      deviceScaleFactor: opts.deviceScaleFactor ?? 1,
    });
    // Surface page console / errors to the terminal — most of the value of
    // a visual debug session is catching things you wouldn't see in a
    // headless screenshot otherwise.
    context.on('console', (msg) => {
      if (['error', 'warning'].includes(msg.type())) {
        console.log(`[page ${msg.type()}] ${msg.text()}`);
      }
    });
    context.on('weberror', (e) => console.log(`[page error] ${e.error()}`));
    const page = await context.newPage();
    return await fn(page, { browser, context });
  } finally {
    await browser.close();
  }
}

// For scripts that want to wait until a server is reachable (e.g. you just
// `npm start`ed it in another shell or are about to).
export async function waitForServer(url, { timeoutMs = 10_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { method: 'GET' });
      if (r.ok || r.status < 500) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server at ${url} did not respond within ${timeoutMs}ms`);
}

// --- Multi-turn session support ---------------------------------------
//
// `withPage` is single-shot: each invocation launches a fresh chromium and
// tears it down on exit. For agent-style multi-turn workflows (turn 1
// navigates, turn 2 inspects, turn 3 clicks) we need a long-lived chromium
// that persists across separate node processes.
//
// Design: a daemon process spawns chromium directly with
// --remote-debugging-port=<port>, writes a metadata file, and parks. Each
// per-turn CLI invocation reads the metadata and connects over CDP via
// `chromium.connectOverCDP`. CDP-mode contexts live on the chromium side,
// so page URL / cookies / DOM / scroll state survive disconnects.
//
// (launchServer + connect would seem natural but tears down contexts on
// disconnect, which breaks state-across-turns.)

// Respect XDG_CACHE_HOME if set (generic Linux convention); Termux doesn't
// set this by default, so the fallback below is unchanged there.
const CACHE_ROOT = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
export const SESSION_DIR = path.join(CACHE_ROOT, 'code-playwright');

// Walk up from `startDir` looking for `.git` — a directory for a normal
// repo, a file for a worktree checkout (like this one). Used to anchor the
// auto-derived session name to the workspace a runner owns, not whatever
// subdirectory it happens to be in for a given turn.
function findWorktreeRoot(startDir) {
  let dir = path.resolve(startDir);
  while (true) {
    if (existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function sanitizeForName(s) {
  return s.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 40);
}

// Default session name when neither --session nor PW_SESSION is given.
// Stable across every turn issued from the same runner/worktree (turns can
// `cd` around inside it — we anchor on the worktree root, not raw cwd), but
// distinct across separate runners (separate worktrees/checkouts), so
// concurrent runners no longer collide on a shared literal 'default'.
//
// IMPORTANT: this harness is consumed by other projects via relative import
// (`../../code-playwright/browser.mjs`), so the walk MUST start
// from `process.cwd()` — the invoking runner's directory — and never from
// this file's own location (`import.meta.url` / `__dirname`). Anchoring on
// the harness's own file path would collapse every consumer back onto one
// shared name, reintroducing the exact collision this function exists to
// prevent.
export function defaultSessionName() {
  const root = findWorktreeRoot(process.cwd()) ?? process.cwd();
  const base = sanitizeForName(path.basename(root)) || 'session';
  const hash = crypto.createHash('sha1').update(root).digest('hex').slice(0, 8);
  return `auto-${base}-${hash}`;
}

// Single source of truth for session-name precedence: explicit arg (e.g.
// --session) > PW_SESSION env > auto-derived default. Both the CLI and
// programmatic callers should resolve through this so they can't drift.
export function resolveSessionName(explicit) {
  return explicit ?? process.env.PW_SESSION ?? defaultSessionName();
}

export function sessionMetaPath(name = resolveSessionName()) {
  return path.join(SESSION_DIR, `session-${name}.json`);
}

export function sessionLogPath(name = resolveSessionName()) {
  return path.join(SESSION_DIR, `session-${name}.log`);
}

export async function readSessionMeta(name = resolveSessionName()) {
  try {
    return JSON.parse(await fsp.readFile(sessionMetaPath(name), 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

export function isPidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

// If the metadata file exists but the daemon PID is gone, remove the stale
// file. Returns true if it cleared something.
export async function clearStaleSessionMeta(name = resolveSessionName()) {
  const meta = await readSessionMeta(name);
  if (meta && !isPidAlive(meta.pid)) {
    await fsp.unlink(sessionMetaPath(name)).catch(() => {});
    return true;
  }
  return false;
}

// Spawn chromium with a remote debugging port + a fresh user-data-dir,
// wait for CDP to come up, write the session metadata file. Returns the
// child handle so the caller can wire it to the daemon process lifecycle.
//
// The caller (the daemon) is responsible for keeping the child alive
// (parking) and tearing it down on SIGTERM.
export async function startSession({
  name = resolveSessionName(),
  headless = true,
  executablePath,
  extraArgs = [],
} = {}) {
  const bin = requireExecutable(executablePath ?? findChromiumBin());
  await fsp.mkdir(SESSION_DIR, { recursive: true });

  const cdpPort = await findFreePort();
  const userDataDir = await fsp.mkdtemp(
    path.join(os.tmpdir(), `tpw-session-${name}-`),
  );

  const args = [
    ...CHROMIUM_ARGS,
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${userDataDir}`,
    ...(headless ? ['--headless=new'] : []),
    ...extraArgs,
    'about:blank',
  ];

  const child = spawn(bin, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (b) => process.stdout.write(`[chromium] ${b}`));
  child.stderr.on('data', (b) => process.stderr.write(`[chromium] ${b}`));

  const cdpEndpoint = `http://127.0.0.1:${cdpPort}`;
  // /json/version is the canonical CDP discovery endpoint.
  await waitForServer(`${cdpEndpoint}/json/version`, { timeoutMs: 20_000 });

  const meta = {
    name,
    pid: process.pid,           // daemon node pid (what `stop` SIGTERMs)
    chromiumPid: child.pid,
    cdpEndpoint,
    userDataDir,
    headless,
    startedAt: new Date().toISOString(),
  };
  await fsp.writeFile(sessionMetaPath(name), JSON.stringify(meta, null, 2));

  return { child, meta, userDataDir };
}

// Read the session metadata and open a CDP connection to the running
// chromium. Returns a Playwright Browser handle and the metadata.
export async function connectSession({ name = resolveSessionName() } = {}) {
  const meta = await readSessionMeta(name);
  if (!meta) {
    throw new Error(
      `no active session for '${name}' — run \`node session.mjs start\` first`,
    );
  }
  if (!isPidAlive(meta.pid)) {
    throw new Error(
      `session '${name}' is dead (daemon pid ${meta.pid} gone) — run ` +
      `\`node session.mjs start\` to restart`,
    );
  }
  const browser = await chromium.connectOverCDP(meta.cdpEndpoint);
  return { browser, meta };
}

// Per-turn primitive: connect, pick the active context+page (the first
// of each — create if absent), run `fn`, then disconnect (which on CDP
// just detaches the client — chromium and its pages stay alive).
export async function withActivePage(fn, { name = resolveSessionName() } = {}) {
  const { browser, meta } = await connectSession({ name });
  try {
    let context = browser.contexts()[0];
    if (!context) context = await browser.newContext();
    // Surface page console errors/warnings for the duration of this turn.
    // These listeners only fire while we're connected.
    context.on('console', (msg) => {
      if (['error', 'warning'].includes(msg.type())) {
        console.error(`[page ${msg.type()}] ${msg.text()}`);
      }
    });
    context.on('weberror', (e) => console.error(`[page error] ${e.error()}`));
    let page = context.pages()[0];
    if (!page) page = await context.newPage();
    return await fn(page, { browser, context, meta });
  } finally {
    // On a CDP-connected browser this disconnects the client without
    // closing chromium — exactly what we want for multi-turn.
    await browser.close();
  }
}

// Ask the kernel for an unused TCP port on the loopback. Concurrent
// debug sessions each get their own — no shared fixed port to collide on.
// There's a tiny TOCTOU between releasing here and the caller binding,
// but in practice the kernel doesn't recycle that fast.
export async function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// Boot an arbitrary node server as a child process on a free ephemeral
// port and wait for it to start serving. Returns `{ url, port, child,
// sandbox?, close() }`. Cleanup is wired to parent exit / SIGINT so a
// Ctrl+C'd debug script doesn't leave a stray server running.
//
// Required:
//   cwd    — directory to spawn from (typically your app's repo root)
//   entry  — script path relative to `cwd` (e.g. 'server.js')
//
// Optional:
//   port    — fixed port; default is an ephemeral free port
//   env     — extra env vars; explicit env wins over sandbox-derived env
//   silent  — if true, suppress piping the child's stdout/stderr
//   sandbox — generic mkdtemp helper. Shape:
//             { dirs: { ENV_NAME: 'relative/subpath', ... },
//               env:  { OTHER_VAR: 'value', ... } }
//             Each `dirs` entry is created under a unique tmp root; the
//             env var is set to its absolute path. Any `env` entries are
//             merged in. The tmp root is wiped on `close()`.
//
// Example:
//   const srv = await bootServer({
//     cwd: '/path/to/my-app',
//     entry: 'server.js',
//     sandbox: {
//       dirs: { DATA_ROOT: 'data', LOG_ROOT: 'logs' },
//       env:  { NODE_ENV: 'test' },
//     },
//   });
//   try { /* ... */ } finally { await srv.close(); }
//
// The orchestrator passes PORT to the child; entrypoint scripts should
// read process.env.PORT to honour the chosen port.
export async function bootServer({
  cwd,
  entry,
  port,
  env = {},
  sandbox,
  silent = false,
} = {}) {
  if (!cwd) throw new Error('bootServer: `cwd` is required');
  if (!entry) throw new Error('bootServer: `entry` is required');

  let sandboxState = null;
  if (sandbox) {
    const tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'termux-pw-'));
    const dirs = {};
    const sandboxEnv = {};
    for (const [varName, subPath] of Object.entries(sandbox.dirs ?? {})) {
      const abs = path.join(tmpHome, subPath);
      await fsp.mkdir(abs, { recursive: true });
      dirs[varName] = abs;
      sandboxEnv[varName] = abs;
    }
    Object.assign(sandboxEnv, sandbox.env ?? {});
    sandboxState = { tmpHome, dirs };
    // Explicit caller env wins over sandbox-derived env (current contract).
    env = { ...sandboxEnv, ...env };
  }

  const chosenPort = port ?? await findFreePort();
  const child = spawn(process.execPath, [entry], {
    cwd,
    env: { ...process.env, ...env, PORT: String(chosenPort) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (!silent) {
    child.stdout.on('data', (b) => process.stdout.write(`[server] ${b}`));
    child.stderr.on('data', (b) => process.stderr.write(`[server] ${b}`));
  }
  const url = `http://127.0.0.1:${chosenPort}`;

  let exitedEarly = null;
  child.once('exit', (code, signal) => {
    exitedEarly = { code, signal };
  });

  try {
    await waitForServer(url, { timeoutMs: 15_000 });
  } catch (e) {
    if (exitedEarly) {
      throw new Error(
        `child server exited before binding (code=${exitedEarly.code} signal=${exitedEarly.signal})`,
      );
    }
    child.kill('SIGTERM');
    if (sandboxState) {
      await fsp.rm(sandboxState.tmpHome, { recursive: true, force: true });
    }
    throw e;
  }

  const cleanup = () => { if (!child.killed) child.kill('SIGTERM'); };
  process.once('exit', cleanup);
  process.once('SIGINT', () => { cleanup(); process.exit(130); });
  process.once('SIGTERM', () => { cleanup(); process.exit(143); });

  return {
    url,
    port: chosenPort,
    child,
    sandbox: sandboxState ?? undefined,
    async close() {
      if (!child.killed && child.exitCode === null) {
        child.kill('SIGTERM');
        await new Promise((resolve) => {
          const t = setTimeout(() => {
            if (child.exitCode === null) child.kill('SIGKILL');
            resolve();
          }, 3000);
          child.once('exit', () => { clearTimeout(t); resolve(); });
        });
      }
      if (sandboxState) {
        await fsp.rm(sandboxState.tmpHome, { recursive: true, force: true });
      }
    },
  };
}
