import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';

import { looksAlive } from './discovery.ts';
import * as relay from './relay.ts';

/**
 * Opening and inspecting the app, from a process that survives it.
 *
 * These live in the MCP server rather than behind the bridge, and that is the
 * whole point of the two-process split. If the app is down, every tool that goes
 * through /api/bridge/call is unavailable — including, obviously, any tool that
 * would start the app. So the ones that diagnose and revive it must not need it.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function run(cmd: string, args: string[]): Promise<{ ok: boolean; err: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 10_000 }, (err, _out, stderr) => {
      resolve({ ok: !err, err: err ? String(stderr || err.message) : '' });
    });
  });
}

/**
 * What is running, in the order someone debugging would want it.
 *
 * Works with the app down — that is when it is most useful — so every failure
 * mode has to produce a sentence rather than an exception.
 */
export async function editorStatus(): Promise<string> {
  const b = await relay.bridge();

  if (!b) {
    return [
      'Jumpstart does not appear to have run on this machine — there is no bridge file.',
      'Start it once (open the app, or `npm run app` in the repo) so it can publish where it is listening.',
    ].join('\n');
  }

  const alive = looksAlive(b) && (await relay.reachable());
  if (!alive) {
    return [
      'Jumpstart is NOT running.',
      b.port ? `Last seen on port ${b.port} (pid ${b.pid || 'unknown'}), started ${b.startedAt}.` : 'It exited cleanly.',
      b.logPath ? `Log: ${b.logPath}` : '',
      'Call wake_editor to start it.',
    ]
      .filter(Boolean)
      .join('\n');
  }

  let s: relay.Status;
  try {
    s = await relay.status();
  } catch (e) {
    return `Jumpstart is listening on ${b.port}, but the bridge did not answer: ${
      e instanceof Error ? e.message : String(e)
    }`;
  }

  const lines = [
    `Jumpstart is running at ${s.url} (${s.mode}, pid ${s.pid}), started ${s.startedAt}.`,
    `Hermes bridge: ${s.enabled ? 'ON' : 'OFF — turn it on in Settings → Connect Hermes'}.`,
  ];

  if (s.windows === 0) {
    lines.push(
      'No editor window is attached. Tools that edit the live document cannot run — call wake_editor.',
    );
  } else {
    lines.push(`${s.windows} window${s.windows === 1 ? '' : 's'} attached:`);
    for (const w of s.sessions) {
      lines.push(
        `  ${w.id}  ${w.projectName ?? '(no project open)'}${w.busy ? '  [working]' : ''}  since ${w.since}`,
      );
    }
  }

  if (s.watch) {
    // Worth saying unprompted: the agent is about to edit server code, and this
    // decides whether doing so kills a render that is running.
    lines.push('Started under --watch: editing a server file will restart it and kill in-flight jobs.');
  }
  if (s.logPath) lines.push(`Log: ${s.logPath}`);

  return lines.join('\n');
}

/**
 * Make sure there is a window to work in, starting the app if there is not.
 *
 * The polling mirrors waitForServer() in desktop/mac/main.cjs — same 250ms, same
 * shape — so the two agree about how long a cold start is allowed to take.
 *
 * `open -a` deliberately: it returns immediately and the app is NOT our child, so
 * it outlives the Hermes process. Spawning it as a child would mean the editor
 * dies whenever the agent's host restarts, which is the opposite of what is
 * wanted.
 */
export async function wakeEditor(): Promise<string> {
  const b = await relay.bridge();

  if (!(await relay.reachable())) {
    if (process.platform !== 'darwin') {
      return 'The app is not running, and this tool only knows how to start it on macOS. Start it by hand, or run `npm run app` in the repo.';
    }

    const app = b?.appPath || (await defaultAppPath());
    if (!app) {
      return [
        'Jumpstart is not running and I could not find the app to start.',
        'Open it yourself, or run `npm run app` in the repo checkout.',
        'If it is installed somewhere unusual, set JUMPSTART_APP_PATH.',
      ].join('\n');
    }

    const { ok, err } = await run('open', ['-a', app]);
    if (!ok) return `Could not start ${app}: ${err}`;

    const started = await waitFor(() => relay.reachable(), 30_000);
    if (!started) return `Started ${app}, but it did not answer within 30s. Check the log.`;
  }

  // Listening is not the same as ready: the window has to attach before a
  // document tool can run, and these are different failures with different fixes.
  const attached = await waitFor(async () => {
    try {
      return (await relay.status()).windows > 0;
    } catch {
      return false;
    }
  }, 20_000);

  if (!attached) {
    return 'Jumpstart is running, but no editor window attached within 20s. If the app is open, the bridge may be switched off in Settings → Connect Hermes.';
  }

  const s = await relay.status();
  const where = s.sessions[0]?.projectName;
  return `Jumpstart is ready — ${s.windows} window${s.windows === 1 ? '' : 's'} attached${
    where ? `, showing "${where}"` : ', no project open'
  }.`;
}

async function waitFor(check: () => Promise<boolean>, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await sleep(250);
  }
  return false;
}

async function defaultAppPath(): Promise<string | null> {
  if (process.env.JUMPSTART_APP_PATH) return process.env.JUMPSTART_APP_PATH;
  for (const p of ['/Applications/Jumpstart.app', '/Applications/Transcript Editor.app']) {
    try {
      await stat(p);
      return p;
    } catch {
      /* not there */
    }
  }
  return null;
}

/** The tail of the server log, so an agent can read the crash it just caused. */
export async function appLogs(lines: number): Promise<string> {
  const b = await relay.bridge();
  const path = process.env.JUMPSTART_LOG_PATH || b?.logPath;
  if (!path) {
    return 'No log file is configured. The desktop app writes one; a server started in a terminal prints to that terminal instead.';
  }
  try {
    const text = await readFile(path, 'utf8');
    const all = text.split('\n');
    const tail = all.slice(Math.max(0, all.length - Math.max(1, lines)));
    return tail.join('\n') || '(the log is empty)';
  } catch (e) {
    return `Could not read ${path}: ${e instanceof Error ? e.message : String(e)}`;
  }
}
