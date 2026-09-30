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
 *  2. Behaviour: each distinct command is rendered with the token replaced by a real
 *     directory whose name holds a space and a parenthesis, then RUN under bash and
 *     under the platform's default shell (`cmd.exe` on Windows, `sh` elsewhere). A
 *     stub script at that path reports the arguments it received, so the test
 *     proves the script was found AND the arguments (`start`, `teammate-update`)
 *     survived the quoting.
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

  /** Run one rendered command; `viaBash` picks bash, otherwise the platform default shell. */
  const run = (line, viaBash) => {
    const opts = { encoding: 'utf-8', timeout: 20000, cwd: base };
    return viaBash ? spawnSync('bash', ['-c', line], opts) : spawnSync(line, { ...opts, shell: true });
  };

  /** Commands whose run did not exit 0 with exactly their own arguments on stdout. */
  const failures = (commands, viaBash, stripQuotes) => commands.flatMap((command) => {
    const r = run(rendered(command, stripQuotes), viaBash);
    const ok = r.status === 0 && r.stdout === JSON.stringify(parts(command).args);
    return ok ? [] : [`${command} -> exit ${r.status}, stdout ${JSON.stringify(r.stdout)}`];
  });

  // The negative controls run a sample (every command that carries arguments, plus every
  // sixth one) to keep the spawn count down; the positive runs below cover them all.
  const SAMPLE = DISTINCT.filter((command, i) => i % 6 === 0 || parts(command).args.length > 0);

  it('the negative-control sample is a real sample (it includes commands with arguments)', () => {
    expect(SAMPLE.length).toBeGreaterThanOrEqual(5);
    expect(SAMPLE.some((command) => parts(command).args.length > 0)).toBe(true);
    expect(SAMPLE.length).toBeLessThan(DISTINCT.length);
  });

  it.skipIf(!bash.ok)('every distinct command runs under bash', () => {
    expect(failures(DISTINCT, true, false)).toEqual([]);
  });

  it('every distinct command runs under the platform default shell', () => {
    expect(failures(DISTINCT, false, false)).toEqual([]);
  });

  it.skipIf(!bash.ok)('negative control: the same commands WITHOUT quotes all fail under bash', () => {
    expect(failures(SAMPLE, true, true).length).toBe(SAMPLE.length);
  });

  it('negative control: the same commands WITHOUT quotes all fail under the platform default shell', () => {
    expect(failures(SAMPLE, false, true).length).toBe(SAMPLE.length);
  });
});
