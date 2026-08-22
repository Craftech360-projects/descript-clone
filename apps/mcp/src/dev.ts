import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { appLogs, editorStatus, wakeEditor } from './lifecycle.ts';
import * as relay from './relay.ts';

/**
 * The workshop: the tools an agent needs to change Jumpstart's own code.
 *
 * ── why this is a second server, and why it lives outside the repo ──────────
 *
 * Separate from jumpstart-mcp because the two fail differently. The editor tools
 * need the app running; these need it to be safe for the app NOT to be running,
 * because the most common reason to reach for them is that the agent has just
 * broken it. Nothing here touches the app over HTTP except restart_app, which
 * expects it to be down.
 *
 * And the file this runs from should NOT be the copy in the repo. The agent can
 * edit the repo — that is the point — and an agent that edits its own undo
 * mechanism has disarmed itself at exactly the moment it needed it. Install a
 * copy outside the working tree (see the README) and point Hermes at that. This
 * blocks nothing the agent wants to do to Jumpstart; it only keeps the escape
 * hatch out of reach of the thing being changed.
 *
 * ── full autonomy, made recoverable ────────────────────────────────────────
 *
 * There are no approval gates here, deliberately: the user asked for full
 * autonomy on main and that is what this is. What it adds is an undo path.
 * git_checkpoint before an edit session is the commit that saves you; the one
 * taken afterwards is a record of the damage.
 *
 * Note git_revert_last uses `git revert`, not `git reset --hard`. Revert is
 * additive — it never destroys a commit, so a mistaken revert is itself
 * revertable. Reset is exposed separately as git_reset_to so that discarding
 * work takes a deliberate second choice rather than being the easy default.
 *
 * ── what this cannot save you from ─────────────────────────────────────────
 *
 * The projects, transcripts, uploads and renders are all gitignored. Every
 * checkpoint here protects the CODE and none of the WORK. That needs Time
 * Machine or an APFS snapshot, and it is the gap most likely to be misread as
 * covered.
 */

const TIMEOUT_MS = 10 * 60_000;

function repoRoot(): string {
  if (process.env.JUMPSTART_REPO) return process.env.JUMPSTART_REPO;
  // Walk up from this file — correct when running from the checkout, wrong when
  // running from an installed copy, which is why the env var exists and why the
  // README tells you to set it.
  let dir = new URL('.', import.meta.url).pathname;
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'packages'))) return dir;
    dir = join(dir, '..');
  }
  return process.cwd();
}

interface Ran {
  ok: boolean;
  out: string;
}

function run(cmd: string, args: string[], cwd = repoRoot()): Promise<Ran> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: `${stdout}${stderr}`.trim() });
    });
  });
}

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s || '(no output)' }] });

/** Pull the counts out of node --test's TAP tail rather than dumping 500 lines at a model. */
export function summarizeTap(out: string): string {
  const num = (k: string) => Number(new RegExp(`^# ${k} (\\d+)$`, 'm').exec(out)?.[1] ?? -1);
  const pass = num('pass');
  const fail = num('fail');
  if (pass < 0) return out.slice(-4000);

  const failures = [...out.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]);
  const head = `${num('tests')} tests, ${pass} pass, ${fail} fail, ${num('skipped')} skipped.`;
  if (!fail) return `${head} Green.`;

  /**
   * The assertion messages, which are where a fix actually starts.
   *
   * node --test writes them as YAML block scalars — `error: |-` followed by the
   * real text indented beneath. Matching `error: (.+)` therefore captures the
   * literal "|-" and throws the message away, handing the agent a failing test
   * name with no reason. Take the indented block instead.
   */
  const why: string[] = [];
  for (const m of out.matchAll(/^(\s+)error: (\|-?|>-?)?\s*(.*)$/gm)) {
    const [, indent, block, inline] = m;
    if (!block) {
      if (inline) why.push(inline.replace(/^'|'$/g, ''));
      continue;
    }
    // Everything indented deeper than the `error:` key belongs to its value.
    const rest = out.slice(m.index! + m[0].length + 1).split('\n');
    const body: string[] = [];
    for (const line of rest) {
      if (line.trim() && !line.startsWith(indent + ' ')) break;
      if (line.trim()) body.push(line.trim());
    }
    if (body.length) why.push(body.join(' — '));
  }

  return [
    head,
    '',
    'Failing:',
    ...failures.map((f, i) => `  ${f}${why[i] ? `\n      ${why[i]}` : ''}`),
  ].join('\n');
}

export function buildDevServer(): McpServer {
  const mcp = new McpServer({ name: 'jumpstart-dev', version: '0.1.0' });

  mcp.registerTool(
    'run_tests',
    {
      description:
        "Run Jumpstart's test suite. Takes about half a second, so run it after every edit — not just before you finish.",
      inputSchema: {},
    },
    async () => {
      const r = await run('npm', ['test']);
      return text(summarizeTap(r.out));
    },
  );

  mcp.registerTool(
    'git_status_diff',
    {
      description: 'What has changed in the working tree: branch, status, diffstat, and the patch.',
      inputSchema: { patch: z.boolean().optional().describe('Include the full diff. Default true.') },
    },
    async (args: { patch?: boolean }) => {
      const status = await run('git', ['status', '--porcelain=v1', '-b']);
      const stat = await run('git', ['diff', '--stat', 'HEAD']);
      const parts = [status.out, stat.out || '(no unstaged changes)'];
      if (args.patch !== false) {
        const d = await run('git', ['diff', 'HEAD']);
        parts.push(d.out.length > 60_000 ? `${d.out.slice(0, 60_000)}\n… truncated` : d.out);
      }
      return text(parts.filter(Boolean).join('\n\n'));
    },
  );

  mcp.registerTool(
    'git_checkpoint',
    {
      description:
        'Commit everything and push to the backup mirrors. Do this BEFORE you start editing — the checkpoint that saves you is the one taken first.',
      inputSchema: { message: z.string().describe('What this checkpoint is for.') },
    },
    async (args: { message: string }) => {
      await run('git', ['add', '-A']);
      const commit = await run('git', ['commit', '-m', args.message]);
      if (!commit.ok && /nothing to commit/i.test(commit.out)) {
        return text('Nothing to commit — the tree is already clean.');
      }
      if (!commit.ok) return text(`Commit failed:\n${commit.out}`);

      const sha = (await run('git', ['rev-parse', '--short', 'HEAD'])).out;
      const lines = [`Checkpointed ${sha}: ${args.message}`];

      // Best effort, and reported honestly. A checkpoint that only exists on this
      // disk is most of the value; saying so when the mirror is missing is the
      // rest, because the user needs to know which one they have.
      const mirror = await run('git', ['push', 'mirror', '+refs/heads/*:refs/heads/*']);
      lines.push(mirror.ok ? 'Pushed to the local mirror.' : 'No local mirror (see the README to set one up).');
      return text(lines.join('\n'));
    },
  );

  mcp.registerTool(
    'git_revert_last',
    {
      description:
        'Undo the last commit by making a new one that reverses it. Additive and safe — it destroys nothing, so a mistaken revert can itself be reverted. Use this when tests go red.',
      inputSchema: {},
    },
    async () => {
      /**
       * Uncommitted work is the common case, and reverting HEAD would be wrong.
       *
       * The loop is: checkpoint, edit, test, and if red go back. At the "if red"
       * moment the bad edit is usually still in the WORKING TREE — so `git revert
       * HEAD` would undo the checkpoint that was taken before the edit, leaving
       * the broken change in place and destroying the good commit. It would look
       * like it worked, and the next test run would still be red.
       *
       * Say so, and name the tool that actually helps.
       */
      const dirty = (await run('git', ['status', '--porcelain'])).out;
      if (dirty) {
        return text(
          [
            'The broken change is not committed yet, so there is no commit to revert.',
            'Reverting HEAD here would undo your checkpoint and keep the bad edit.',
            '',
            'To throw the working changes away and go back to the last commit:',
            '  git_reset_to with sha "HEAD"',
            '',
            'Uncommitted files:',
            dirty,
          ].join('\n'),
        );
      }

      // A dangling commit git fsck can find, in case anything is disturbed.
      const stash = await run('git', ['stash', 'create']);
      const head = (await run('git', ['log', '-1', '--oneline'])).out;
      const r = await run('git', ['revert', '--no-edit', 'HEAD']);
      if (!r.ok) {
        return text(
          `Revert failed — probably a conflict or a dirty tree:\n${r.out}\n\n` +
            (stash.out ? `Your uncommitted work is recoverable at ${stash.out}.` : ''),
        );
      }
      return text(`Reverted ${head}.\nRun run_tests to confirm that fixed it.`);
    },
  );

  mcp.registerTool(
    'git_reset_to',
    {
      description:
        'DISCARD commits and working changes back to a given sha. Destructive — prefer git_revert_last. Only use when you mean to throw work away.',
      inputSchema: { sha: z.string().describe('The commit to reset to, from git_status_diff or the mirror.') },
    },
    async (args: { sha: string }) => {
      const stash = await run('git', ['stash', 'create']);
      const r = await run('git', ['reset', '--hard', args.sha]);
      if (!r.ok) return text(`Reset failed:\n${r.out}`);
      return text(
        `Reset to ${args.sha}. ${r.out}\n` +
          (stash.out
            ? `What was in the tree beforehand is recoverable at ${stash.out} (git fsck finds it).`
            : ''),
      );
    },
  );

  mcp.registerTool(
    'restart_app',
    {
      description:
        'Restart Jumpstart so your code changes take effect, then wait until it is answering again. Reports whether it actually came back.',
      inputSchema: {},
    },
    async () => {
      const before = await relay.bridge();
      if (before?.pid) {
        try {
          process.kill(before.pid, 'SIGTERM');
        } catch {
          /* already gone — that is the state we wanted anyway */
        }
      }
      // Give it a moment to release the port before trying to start it again.
      await new Promise((r) => setTimeout(r, 1500));

      const woke = await wakeEditor();
      /**
       * Always say which happened.
       *
       * An agent that cannot tell whether its restart worked retries forever. The
       * two failure modes need different responses — "did not start" means read
       * the log, "started but no window" means the bridge is off — so they get
       * different sentences.
       */
      return text(`${woke}\n\nIf that did not work, read app_logs.`);
    },
  );

  mcp.registerTool(
    'app_logs',
    {
      description: "The tail of Jumpstart's server log. Works when the app is down, which is when you need it.",
      inputSchema: { lines: z.number().optional().describe('How many trailing lines. Default 80.') },
    },
    async (args: { lines?: number }) => text(await appLogs(Math.round(args.lines ?? 80))),
  );

  mcp.registerTool(
    'editor_status',
    {
      description: 'Is Jumpstart running, is the bridge on, and are any editor windows attached.',
      inputSchema: {},
    },
    async () => text(await editorStatus()),
  );

  return mcp;
}
