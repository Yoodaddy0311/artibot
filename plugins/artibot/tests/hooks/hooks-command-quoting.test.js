/**
 * Purpose: every hook command the plugin registers must still run when the
 * plugin root contains a space or a parenthesis (`C:\Users\First Last\...`,
 * `C:\Program Files (x86)\...`).
 *
 * -- What broke ------------------------------------------------------------------
 * hooks.json said `node ${CLAUDE_PLUGIN_ROOT}/scripts/hooks/x.js`. The host puts
 * the plugin directory in place of the token and hands the line to a shell. With a
 * space in that directory an unquoted path is two shell words, so `node` is asked
 * to run `C:/Users/First` and every hook dies before it starts. A parenthesis is
 * worse under bash: it is a syntax error. Quoting the path (`node "..."`) fixes both
 * and is accepted by bash, sh, cmd.exe and PowerShell.
 *
 * -- What this file gates --------------------------------------------------------
 *  1. Spelling: every command in hooks.json, and every `singleHookCommand` in
 *     dispatch-table.json, carries the script path in double quotes. (The regex in
 *     tests/hooks-schema-shape.test.js pins the same shape for hooks.json; this file
 *     adds the dispatch table, whose copies must equal hooks.json's.)
 *  2. Behaviour: a representative set of commands (one per argument shape, one
 *     dispatcher, and the two dispatch-table commands; a guard requires it to cover
 *     every shape that occurs) is rendered with the token replaced by a real
 *     directory whose name holds a space and a parenthesis, then RUN under bash and
 *     under the platform's default shell (`cmd.exe` on Windows, `sh` elsewhere),
 *     chained into one shell each to keep the process count down. A stub script at
 *     that path reports the arguments it received, so the test proves the script was
 *     found AND the arguments (`start`, `teammate-update`) survived the quoting.
 *     Why a set and not all 30: the spelling check in (1) already pins every command
 *     to one shape, and node start-up (~0.5 s loaded) made the exhaustive run time
 *     out in a parallel full run. The exhaustive run against the REAL scripts was a
 *     one-off measurement (30 of 30 fail unquoted, 0 of 30 quoted, 2026-09-30).
 *  3. A negative control: the same commands with the quotes removed FAIL under the
 *     same shells. Without it, "the quoted form runs" would also be true if the
 *     directory name did not exercise the problem at all.
 *
 * -- What this gate cannot see (rules 9) -----------------------------------------
 *  - The real host. It substitutes the token itself and picks its own shell; this
 *    test renders the token by hand and uses the shells available to node. The
 *    substitution was observed by hand once, for command markdown, not for hooks.
 *  - The real hook scripts. The stubs only prove path and argument handling; the
 *    scripts' own behaviour from a foreign working directory is measured separately
 *    (30 of 30 exit 0 on installed 4.70.0, teammate smoke run 2026-09-30).
 *  - PowerShell as the hook shell, and WSL bash. The bash half skips, with a printed
 *    reason, where `bash` cannot open native paths; the default-shell half and the
 *    static half always run.
 *  - A plugin root that contains a double quote or a dollar sign.
 *
 * @module tests/hooks/hooks-command-quoting
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { announceBashSkip, probeBash } from '../../scripts/utils/bash-compat.js';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const readJson = (rel) => JSON.parse(readFileSync(path.join(PLUGIN_ROOT, rel), 'utf-8'));

/** The literal token, written so a linter does not read it as a template placeholder. */
const TOKEN = '$' + '{CLAUDE_PLUGIN_ROOT}';
const QUOTED_COMMAND = /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/hooks\/([A-Za-z0-9_.-]+\.(?:c|m)?js)"((?: \S+)*)$/;

const HOOKS = readJson('hooks/hooks.json');
const TABLE = readJson('hooks/dispatch-table.json');

/** Every command string hooks.json registers, in file order. */
const HOOK_COMMANDS = Object.values(HOOKS.hooks)
  .flat()
  .flatMap((group) => group.hooks ?? [])
  .map((hook) => hook.command);

/** Every `singleHookCommand` the dispatch table pins. */
const SINGLE_COMMANDS = Object.values(TABLE.slots)
  .map((slot) => slot.singleHookCommand)
  .filter((command) => typeof command === 'string');

const DISTINCT = [...new Set(HOOK_COMMANDS)];

/** `a.js start` from `node "<token>/scripts/hooks/a.js" start`: script name and trailing args. */
function parts(command) {
  const m = command.match(QUOTED_COMMAND);
  return m === null ? null : { script: m[1], args: m[2].trim() === '' ? [] : m[2].trim().split(/\s+/) };
}

describe('hook commands: the plugin path is quoted', () => {
  it('reads a plausible number of commands (0 violations is not 0 commands)', () => {
    expect(HOOK_COMMANDS.length).toBeGreaterThanOrEqual(30);
    expect(SINGLE_COMMANDS.length).toBeGreaterThanOrEqual(2);
    expect(DISTINCT.length).toBeGreaterThan(20);
  });

  it('every hooks.json command has the quoted spelling', () => {
    const bad = HOOK_COMMANDS.filter((command) => parts(command) === null);
    expect(bad, `not of the form node "${TOKEN}/scripts/hooks/<name>" [args]:\n${bad.join('\n')}`).toEqual([]);
  });

  it('every dispatch-table singleHookCommand has the quoted spelling and equals a hooks.json command', () => {
    for (const command of SINGLE_COMMANDS) {
      expect(parts(command), command).not.toBeNull();
      expect(HOOK_COMMANDS, `singleHookCommand missing from hooks.json: ${command}`).toContain(command);
    }
  });

  it('the pattern itself rejects the spellings that break (self-check)', () => {
    expect(parts(`node "${TOKEN}/scripts/hooks/a.js"`)).toEqual({ script: 'a.js', args: [] });
    expect(parts(`node "${TOKEN}/scripts/hooks/a.js" start now`)).toEqual({ script: 'a.js', args: ['start', 'now'] });
    expect(parts(`node ${TOKEN}/scripts/hooks/a.js`)).toBeNull();
    expect(parts(`node "${TOKEN}/scripts/hooks/a.js start"`)).toBeNull();
    expect(parts(`node "${TOKEN}/scripts/hooks/a.js`)).toBeNull();
  });
});

const bash = probeBash();
if (!bash.ok) announceBashSkip('hooks-command-quoting/bash');

describe('hook commands: they run from a plugin root with a space and a parenthesis', () => {
  let base = '';
  let root = '';

  beforeAll(() => {
    base = mkdtempSync(path.join(os.tmpdir(), 'artibot-hookquote-'));
    root = path.join(base, 'plugin root (x86)');
    const stub = 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n';
    const dir = path.join(root, 'scripts', 'hooks');
    mkdirSync(dir, { recursive: true });
    for (const command of DISTINCT) writeFileSync(path.join(dir, parts(command).script), stub);
  });
  afterAll(() => {
    if (base !== '') rmSync(base, { recursive: true, force: true });
  });

  /** The form the host produces on Windows and elsewhere: forward slashes. */
  const rendered = (command, stripQuotes = false) => {
    const line = command.replace(TOKEN, root.replaceAll('\\', '/'));
    return stripQuotes ? line.replaceAll('"', '') : line;
  };

  /** Run one rendered line; `viaBash` picks bash, otherwise the platform default shell. */
  const run = (line, viaBash, timeout = 30000) => {
    const opts = { encoding: 'utf-8', timeout, cwd: base };
    return viaBash ? spawnSync('bash', ['-c', line], opts) : spawnSync(line, { ...opts, shell: true });
  };

  // Spawn budget. Starting a shell and a node per command for all 26 distinct commands made ~70
  // process trees in series; on a loaded Windows machine node start-up alone is ~0.5 s, and both
  // exhaustive cases timed out (37-62 s) in a parallel full run while passing alone. The runtime
  // proof only has to cover each SHAPE of command, because the static checks above already pin
  // that all 30 commands share one spelling. So the commands that RUN are a representative set,
  // chained with `&&` into ONE shell per shell type (the chain only reaches the end if every
  // command found its script and exited 0, and stdout is the concatenation of each stub's own
  // arguments). The exhaustive proof against the real scripts was a one-off measurement, not
  // this test. The timeouts are sized for a loaded Windows runner, not for one machine.
  const CHAIN_TIMEOUT_MS = 120000;
  const CASE_TIMEOUT_MS = 150000;

  const shapeOf = (command) => parts(command).args.length;
  const REPRESENTATIVE = [...new Set([
    DISTINCT.find((command) => shapeOf(command) === 0),
    DISTINCT.find((command) => shapeOf(command) > 0),
    DISTINCT.find((command) => /^node "[^"]*\/_[a-z]+-dispatcher\.js"$/.test(command)),
    ...SINGLE_COMMANDS,
  ])];

  const chain = (commands) => commands.map((command) => rendered(command)).join(' && ');
  const expectedStdout = (commands) => commands.map((command) => JSON.stringify(parts(command).args)).join('');

  /** Run a chain in one shell; when it falls short, name the first command that did not report. */
  function runChain(commands, viaBash) {
    const r = run(chain(commands), viaBash, CHAIN_TIMEOUT_MS);
    const stdout = String(r.stdout ?? '');
    let consumed = 0;
    let reported = 0;
    for (const command of commands) {
      const next = JSON.stringify(parts(command).args);
      if (!stdout.startsWith(next, consumed)) break;
      consumed += next.length;
      reported += 1;
    }
    return {
      status: r.status,
      ok: r.status === 0 && stdout === expectedStdout(commands),
      stoppedBefore: reported < commands.length ? commands[reported] : null,
    };
  }

  /** The unquoted spelling of a command run on its own: did it fail, as it must? */
  const failsUnquoted = (command, viaBash) => {
    const r = run(rendered(command, true), viaBash);
    return r.status !== 0 || String(r.stdout ?? '') !== JSON.stringify(parts(command).args);
  };

  // The negative controls run the first three representatives, one command at a time.
  const SAMPLE = REPRESENTATIVE.slice(0, 3);

  it('the representative set covers every argument shape of every hook command, and is far smaller', () => {
    const shapes = (commands) => [...new Set(commands.map(shapeOf))].sort();
    expect(shapes(REPRESENTATIVE)).toEqual(shapes(DISTINCT));
    expect(shapes(REPRESENTATIVE).length).toBeGreaterThanOrEqual(2);
    expect(REPRESENTATIVE.every((command) => DISTINCT.includes(command))).toBe(true);
    expect(REPRESENTATIVE.length).toBeLessThan(DISTINCT.length / 2);
    expect(SAMPLE.some((command) => shapeOf(command) === 0) && SAMPLE.some((command) => shapeOf(command) > 0)).toBe(true);
  });

  it('the chain check reports where it stopped (self-check on a chain that breaks on purpose)', () => {
    const broken = [DISTINCT[0], `node "${TOKEN}/scripts/hooks/not-there.js"`, DISTINCT[1]];
    const r = runChain(broken, false);
    expect(r.ok).toBe(false);
    expect(r.stoppedBefore).toBe(broken[1]);
  }, CASE_TIMEOUT_MS);

  it.skipIf(!bash.ok)('the representative commands run under bash (one shell, chained with &&)', () => {
    const r = runChain(REPRESENTATIVE, true);
    expect(r.ok, `chain stopped before: ${r.stoppedBefore} (exit ${r.status})`).toBe(true);
  }, CASE_TIMEOUT_MS);

  it('the representative commands run under the platform default shell (one shell, chained with &&)', () => {
    const r = runChain(REPRESENTATIVE, false);
    expect(r.ok, `chain stopped before: ${r.stoppedBefore} (exit ${r.status})`).toBe(true);
  }, CASE_TIMEOUT_MS);

  it.skipIf(!bash.ok)('negative control: the sampled commands WITHOUT quotes all fail under bash', () => {
    expect(SAMPLE.filter((command) => !failsUnquoted(command, true))).toEqual([]);
  }, CASE_TIMEOUT_MS);

  it('negative control: the sampled commands WITHOUT quotes all fail under the platform default shell', () => {
    expect(SAMPLE.filter((command) => !failsUnquoted(command, false))).toEqual([]);
  }, CASE_TIMEOUT_MS);
});
