/**
 * The three commands that end a run — `/team`, `/autopilot`, `/split` — each tell
 * the leader to attach the per-model usage and cost table to the completion
 * report, and the line they hand over is one the REAL CLI accepts.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 * `scripts/ledger/usage-cost-table.mjs` can print the table, and
 * `tests/ledger/usage-cost-table-cli.test.js` pins what it prints. Neither makes
 * a leader RUN it: the model that composes a completion report follows the
 * command body, not the repository's scripts. A step that exists only in the CLI
 * is the state the owner complained about ("the table can be seen only when
 * asked"), so the step has to be in the three documents a leader reads at the
 * moment it reports, and it has to survive the next edit of those documents.
 *
 * The step follows the shape that `tests/commands/verify-record-steps.test.js`
 * measured to work for the record step: the script is found through a chain that
 * resolves from any cwd (`$HOME` copy, then `CLAUDE_PLUGIN_ROOT`, then the source
 * tree), the session id is read under BOTH spellings (`CLAUDE_SESSION_ID` is
 * often empty on this host, `CLAUDE_CODE_SESSION_ID` is what the host sets), and
 * a missing script prints a line instead of failing silently.
 *
 * ── WHAT IS PINNED ──────────────────────────────────────────────────────────
 *  - the whole shell line, byte for byte, once per file — in a fenced block in
 *    `team.md` and `autopilot.md`, and INLINE in `split.md`, whose 300-line
 *    ratchet leaves no room for a fence (see the carrier entry);
 *  - that the block lies INSIDE the completion section of its file, not merely
 *    somewhere in it, and inside neither contract fence (`[보고 계약]`,
 *    `[중계 계약]` — their byte parity is `report-contract-parity.test.js`'s);
 *  - that every flag the line names is one the real CLI accepts, and that the
 *    line, with its placeholders filled, runs and exits 0;
 *  - the load-bearing sentences: paste the output as printed, keep the caveat
 *    lines, say why the current session has to be read live (SessionEnd is the
 *    only receipt writer), and print `TABLE OMITTED` rather than invent a table;
 *  - that the block names no raw model id and carries no `prompt="` (which
 *    `report-contract-parity.test.js` counts as a spawn prompt).
 *
 * ── WHAT THIS FILE CANNOT SEE (rules section 9 — written beside the gate) ───
 *  - WHETHER ANY MODEL RUNS THE STEP. This pins wording. A model that skips it
 *    leaves every assertion green.
 *  - THE SHELL LINE IS NEVER EXECUTED AS SHELL HERE. Its flags are fed to the
 *    real CLI through `node`. A quoting mistake, or a wrong `[ -f ]` chain, is
 *    guarded by the byte pin and by a manual probe, not by a run in this suite.
 *    The `${A:-$B}` fallback is POSIX semantics that nothing here exercises.
 *  - THE INSTALLED COPIES. This reads the commands in THIS worktree;
 *    `~/.claude/commands`, the plugin cache and `~/.claude/artibot/scripts` can
 *    lag by releases — until they are updated the chain reports "not found".
 *  - THE REST OF THE PROSE. Only the sentences above are pinned; a reworded
 *    paragraph that keeps them stays green.
 *
 * @module tests/commands/usage-table-steps
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The real-CLI cases spawn a child process; nothing here waits on a timer.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const COMMANDS_DIR = path.join(PLUGIN_ROOT, 'commands');
const CLI = path.join(PLUGIN_ROOT, 'scripts', 'ledger', 'usage-cost-table.mjs');

/** Both spellings blanked in every child: the host session must not reach a table. */
const NO_SESSION_ENV = { CLAUDE_SESSION_ID: '', CLAUDE_CODE_SESSION_ID: '' };

/** The step's heading text — the same words in all three files. */
const HEADING = '모델별 사용량·비용 (자동 — 생략 금지)';

/**
 * The shared front of the line: the session id under both spellings, then the
 * three places the script may live, in the order the chain must try them, then
 * the guard. Spelled out here rather than built from a document, so a wording
 * change in a command is a visible edit of this file.
 */
const CHAIN = 'SID="${CLAUDE_SESSION_ID:-$CLAUDE_CODE_SESSION_ID}";'
  + ' USG="$HOME/.claude/artibot/scripts/ledger/usage-cost-table.mjs";'
  + ' [ -f "$USG" ] || USG="${CLAUDE_PLUGIN_ROOT}/scripts/ledger/usage-cost-table.mjs";'
  + ' [ -f "$USG" ] || USG="plugins/artibot/scripts/ledger/usage-cost-table.mjs";'
  + ' if [ -f "$USG" ]; then node "$USG"';

const TAIL = '; else echo "usage-cost-table not found - 표 생략"; fi';

/** The three places, in the order the chain must try them. */
const CHAIN_ORDER = [
  '$HOME/.claude/artibot/scripts/ledger/usage-cost-table.mjs',
  '${CLAUDE_PLUGIN_ROOT}/scripts/ledger/usage-cost-table.mjs',
  'plugins/artibot/scripts/ledger/usage-cost-table.mjs',
];

/**
 * The three carriers. `flags` is what differs between them: `/team` runs in one
 * session, so it scopes to that session; `/autopilot` scopes to the session AND
 * to the run's start; `/split` has worker windows that are OTHER sessions, so it
 * scopes by start time alone and reads only the parent window live.
 *
 * `start`/`stop` bound the completion section the step must sit inside;
 * `ends` is where the step's own block stops (the next sibling item).
 */
const CARRIERS = [
  {
    file: 'team.md',
    start: '### Phase 5: REPORT (Leader only)',
    stop: '\n### Phase 5.5: FOLLOW-UP',
    ends: /\n### /,
    line: `${CHAIN} --session "$SID" --live-session "$SID" --cwd "<project root>"${TAIL}`,
  },
  {
    file: 'autopilot.md',
    start: '### Step 5 — Completion',
    stop: '\n## Fable-mode',
    ends: /\n(?:- |## |### )/,
    line: `${CHAIN} --since "<작업 시작 ISO>" --session "$SID" --live-session "$SID" --cwd "<project root>"${TAIL}`,
  },
  {
    file: 'split.md',
    start: '### run (메인 세션 전용 · 원샷)',
    stop: '\n### integrate',
    // INLINE, on purpose: split.md is ratcheted at 300 lines
    // (`tests/firewall/split-window-contract.test.js`, "넘으면 엔진 승격이 규약이다")
    // and was AT 300 when this step was added, so a fenced block (three new lines)
    // would turn that gate red and the honest alternative — loosening the ratchet —
    // is not this step's to take. The step is appended to the end of the `run`
    // completion paragraph instead, so its block is the rest of that one line.
    inline: true,
    ends: /\n/,
    line: `${CHAIN} --since "<작업 시작 ISO>" --live-session "$SID" --cwd "<parentRoot>"${TAIL}`,
  },
];

/** A command file, newline-normalized (the repo checks out CRLF on this host). */
function read(file) {
  return readFileSync(path.join(COMMANDS_DIR, file), 'utf-8').replace(/\r\n/g, '\n');
}

/** How many times `needle` occurs in `haystack`. */
function countOf(haystack, needle) {
  return haystack.split(needle).length - 1;
}

/** The completion section, or null when either bound is missing or misordered. */
function section(doc, carrier) {
  const start = doc.indexOf(carrier.start);
  if (start === -1) return null;
  const stop = doc.indexOf(carrier.stop, start);
  return stop === -1 ? null : doc.slice(start, stop);
}

/** The step's own block: from its heading to the next sibling item, or null. */
function stepBlock(doc, carrier) {
  const body = section(doc, carrier);
  if (body === null) return null;
  const at = body.indexOf(HEADING);
  if (at === -1) return null;
  const rest = body.slice(at + HEADING.length);
  const end = carrier.ends.exec(rest);
  return body.slice(at, at + HEADING.length + (end === null ? rest.length : end.index));
}

/** The lines of `doc` that hold the invocation. */
const callLines = (doc) => doc.split('\n').filter((line) => line.includes('node "$USG"'));

/** The byte span of every contract fence in `doc`. */
function contractSpans(doc) {
  return ['보고 계약', '중계 계약'].map((label) => {
    const m = new RegExp('```\\n\\[' + label + '\\][\\s\\S]*?\\n```').exec(doc);
    return m === null ? null : [m.index, m.index + m[0].length];
  });
}

const docs = Object.fromEntries(CARRIERS.map((c) => [c.file, read(c.file)]));

describe.each(CARRIERS)('$file: the usage-table step', (carrier) => {
  const doc = docs[carrier.file];

  it('exists once, inside the completion section', () => {
    expect(section(doc, carrier), `${carrier.file} lost its completion section`).not.toBeNull();
    expect(countOf(doc, HEADING)).toBe(1);
    expect(stepBlock(doc, carrier), 'step heading is not inside the completion section').not.toBeNull();
  });

  it('hands over the whole shell line, byte for byte, once', () => {
    const block = stepBlock(doc, carrier);
    const at = block.indexOf(carrier.line);
    expect(at).toBeGreaterThan(-1);
    expect(countOf(doc, carrier.line)).toBe(1);
    // Exactly one line of the file invokes the script.
    expect(callLines(doc)).toHaveLength(1);

    if (carrier.inline === true) {
      // Inline code: the line is wrapped in single backticks and nothing else.
      expect(block[at - 1]).toBe('`');
      expect(block[at + carrier.line.length]).toBe('`');
      return;
    }
    // Fenced: the line may be indented under a bullet, so compare on trimmed text.
    expect(callLines(doc).map((l) => l.trim())).toEqual([carrier.line]);
    // An odd number of fences before the line means it is inside an open fence,
    // and a fence must follow it to close.
    expect(countOf(block.slice(0, at), '```') % 2).toBe(1);
    expect(block.slice(at + carrier.line.length)).toContain('```');
  });

  it('tries the three locations in order, so it resolves from any cwd', () => {
    const positions = CHAIN_ORDER.map((p) => carrier.line.indexOf(p));
    expect(positions.every((p) => p > -1)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(carrier.line).toContain('${CLAUDE_SESSION_ID:-$CLAUDE_CODE_SESSION_ID}');
  });

  it('says what a leader must do with the output, and what it must not', () => {
    const block = stepBlock(doc, carrier);
    expect(block).toContain('출력 전문을 그대로');
    // The caveat lines are part of the number: the reader of a pasted table
    // has no CLI to ask.
    for (const token of ['영수증 0행', '가격 미검증', '한계:']) expect(block).toContain(token);
    // Why the live flag exists: without it the running session is not in the table.
    expect(block).toContain('SessionEnd');
    expect(block).toContain('--live-session');
    // No table is invented when the script cannot run.
    expect(block).toContain('TABLE OMITTED');
  });

  it('sits inside neither contract fence', () => {
    const at = doc.indexOf(HEADING);
    for (const span of contractSpans(doc)) {
      expect(span, `${carrier.file} lost a contract fence`).not.toBeNull();
      expect(at < span[0] || at >= span[1]).toBe(true);
    }
  });

  it('names no raw model id and carries no spawn prompt', () => {
    const block = stepBlock(doc, carrier);
    expect(block).not.toMatch(/claude-(?:opus|sonnet|haiku|fable)-[\w.-]+/i);
    expect(block).not.toMatch(/model="/);
    // report-contract-parity.test.js counts `prompt="` as a spawn prompt.
    expect(block).not.toContain('prompt="');
    // verify-record-steps.test.js counts `node "$REC"` lines once per file.
    expect(block).not.toContain('node "$REC"');
  });
});

describe('the documented line runs against the real CLI', () => {
  /** @type {string} */
  let tmp;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'artibot-usg-doc-')));
  });
  afterEach(() => {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  });

  /** A project root the CLI can read; it has no ledger, which is a finding, not an error. */
  function makeRoot() {
    const root = path.join(tmp, 'root');
    mkdirSync(path.join(root, '.git'), { recursive: true });
    writeFileSync(path.join(root, 'artibot.config.json'), '{}\n', 'utf-8');
    mkdirSync(path.join(tmp, 'projects'), { recursive: true });
    return root;
  }

  /** The argument list the line passes to node, placeholders filled. */
  function argvOf(line, root) {
    const args = /node "\$USG"(.*?); else/.exec(line)[1];
    return args.match(/"[^"]*"|--[\w-]+/g).map((token) => token.replace(/^"|"$/g, '')
      .replace('$SID', 'sessDocPin01')
      .replace('<작업 시작 ISO>', '2026-09-30T00:00:00.000Z')
      .replace('<project root>', root)
      .replace('<parentRoot>', root));
  }

  function runCli(args, root) {
    const res = spawnSync(process.execPath, [CLI, ...args], {
      encoding: 'utf-8', windowsHide: true, cwd: root, env: { ...process.env, ...NO_SESSION_ENV },
    });
    return { status: res.status, stdout: String(res.stdout || ''), stderr: String(res.stderr || '') };
  }

  it('is a script that exists where the last fallback says it does', () => {
    expect(existsSync(CLI)).toBe(true);
    expect(existsSync(path.resolve(PLUGIN_ROOT, '..', '..', 'plugins/artibot/scripts/ledger/usage-cost-table.mjs'))).toBe(true);
  });

  it.each(CARRIERS)('$file: every flag on the line is one the CLI accepts, and the line runs', (carrier) => {
    const root = makeRoot();
    const argv = argvOf(carrier.line, root);
    const flags = argv.filter((a) => a.startsWith('--'));
    expect(flags.length).toBeGreaterThanOrEqual(3);

    // The CLI's own usage line lists every flag it accepts.
    const usage = runCli(['--no-such-flag'], root).stderr;
    for (const flag of flags) expect(usage, flag).toContain(flag);

    // Isolated from the real home: --projects-dir points at an empty directory.
    const out = runCli([...argv, '--projects-dir', path.join(tmp, 'projects')], root);
    expect(out.stderr).toBe('');
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('영수증 0행');
    expect(out.stdout).toContain('sessDocP');
  });

  it('an empty session id is REFUSED by the line, not turned into a whole-ledger table', () => {
    // `${CLAUDE_SESSION_ID:-$CLAUDE_CODE_SESSION_ID}` expands to "" when both are
    // unset; /team and /autopilot pass it to --session, which must fail closed.
    const root = makeRoot();
    const out = runCli(['--session', '', '--live-session', '', '--cwd', root], root);
    expect(out.status).toBe(2);
    expect(out.stdout).toBe('');
    expect(out.stderr).toContain('--session is blank');
  });
});
