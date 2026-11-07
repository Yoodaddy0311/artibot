/**
 * PowerShell reach of the PreToolUse dangerous-command guard (S1, 2026-11-07).
 *
 * The host's PowerShell tool reached no guard at all: hooks.json matched `Bash`
 * only, and `dangerous-command` was registered for `Bash` only, so
 * `executeChain('pre', 'PowerShell', …)` found zero guards and returned
 * approve. Every row here goes through executeChain — the path pre-bash.js
 * takes — from a NON-Artibot cwd, where only `security-critical` guards run.
 *
 * Three things are pinned:
 *   1. the owner-approved PowerShell rules (Remove-Item recurse+force with its
 *      aliases and parameter abbreviations, Format-Volume, Clear-Disk);
 *   2. the PowerShell spellings the bash-shaped normalizer cannot read
 *      (backtick continuation, backtick escapes, `$env:` and `C:\` paths);
 *   3. the bash printer exemption NOT applying to PowerShell — its quoting
 *      rules differ (`\` is not an escape there), so a string bash reads as
 *      one quoted argument can be a separator plus a live command in
 *      PowerShell. Measured 2026-11-07 before this change: the printer row
 *      below was blanked whole and approved.
 *
 * WHAT THIS FILE CANNOT SEE: the live host dispatch on the `Bash|PowerShell`
 * matcher, and L2 (lib/autopilot/safety.js#classifyRisk), which has no
 * PowerShell-native rule — bash-risk-guard.js stays silent on Remove-Item.
 */
import os from 'node:os';
import { beforeEach, describe, expect, it } from 'vitest';
import { BLOCKED_PATTERNS } from '../../lib/core/blocked-patterns.js';
import { executeChain, listGuards, registerBuiltinGuards, resetGuards } from '../../lib/core/guard-registry.js';

const CWD = os.tmpdir();

/** One PreToolUse decision through the real chain. */
function run(tool, command) {
  return executeChain('pre', tool, { tool_name: tool, tool_input: { command } }, { cwd: CWD });
}

beforeEach(() => {
  resetGuards();
  registerBuiltinGuards();
});

describe('guard wiring for the PowerShell tool', () => {
  it('runs dangerous-command only — bash-lint and path-portability stay Bash-only', () => {
    expect(listGuards('pre', 'PowerShell').map((g) => g.name)).toEqual(['dangerous-command']);
    expect(listGuards('pre', 'Bash').map((g) => g.name).sort())
      .toEqual(['bash-lint', 'dangerous-command', 'path-portability']);
  });

  it('does not extend env-var-exposure: no post-phase caller reaches it for a shell tool', () => {
    // quality-gate.js is the only executeChain('post', …) caller and it returns
    // early unless the tool is Edit or Write, so the Bash registration is
    // already unreachable at runtime. Widening it would add a guard that never runs.
    expect(listGuards('post', 'PowerShell')).toEqual([]);
  });

  it('declares each new rule once, in an existing category', () => {
    for (const [label, category] of [
      ['Remove-Item -Recurse -Force (PowerShell)', 'filesystem'],
      ['Format-Volume (PowerShell)', 'disk'],
      ['Clear-Disk (PowerShell)', 'disk'],
    ]) {
      const rows = BLOCKED_PATTERNS.filter((p) => p.label === label);
      expect(rows, label).toHaveLength(1);
      expect(rows[0].category, label).toBe(category);
    }
  });
});

describe('owner-approved PowerShell rules', () => {
  it.each([
    ['Remove-Item -Recurse -Force C:\\proj\\build', 'Remove-Item -Recurse -Force (PowerShell)'],
    ['Remove-Item C:\\proj\\build -Force -Recurse', 'Remove-Item -Recurse -Force (PowerShell)'],
    ['REMOVE-ITEM -RECURSE -FORCE build', 'Remove-Item -Recurse -Force (PowerShell)'],
    ['ri -r -fo .\\build', 'Remove-Item -Recurse -Force (PowerShell)'],
    ['rd -Recurse -Force build', 'Remove-Item -Recurse -Force (PowerShell)'],
    ['rmdir -rec -force build', 'Remove-Item -Recurse -Force (PowerShell)'],
    ['del -Recurse -Force build', 'Remove-Item -Recurse -Force (PowerShell)'],
    ['erase -recur -forc build', 'Remove-Item -Recurse -Force (PowerShell)'],
    // Pipeline input: no positional target, which the bash `rm` rules require.
    ['Get-ChildItem .\\build | Remove-Item -Recurse -Force', 'Remove-Item -Recurse -Force (PowerShell)'],
    ['Get-ChildItem .\\build | rm -r -fo', 'Remove-Item -Recurse -Force (PowerShell)'],
    ['Remove-Item -Recurse:$true -Force:$true build', 'Remove-Item -Recurse -Force (PowerShell)'],
    ['Microsoft.PowerShell.Management\\Remove-Item -Recurse -Force build', 'Remove-Item -Recurse -Force (PowerShell)'],
    // PowerShell accepts en dash, em dash and horizontal bar as a parameter dash.
    ['Remove-Item \u2013Recurse \u2014Force build', 'Remove-Item -Recurse -Force (PowerShell)'],
    ['Remove-Item \u2015r \u2013fo build', 'Remove-Item -Recurse -Force (PowerShell)'],
    ['Format-Volume -DriveLetter D', 'Format-Volume (PowerShell)'],
    ['Format-Volume -DriveLetter D -FileSystem NTFS -Confirm:$false', 'Format-Volume (PowerShell)'],
    ['Clear-Disk -Number 1 -RemoveData', 'Clear-Disk (PowerShell)'],
    ['Get-Disk 1 | Clear-Disk -RemoveData -Confirm:$false', 'Clear-Disk (PowerShell)'],
  ])('blocks: %s', (command, label) => {
    const r = run('PowerShell', command);
    expect(r.decision, command).toBe('block');
    expect(r.reason).toContain(`"${label}"`);
  });

  it.each([
    ['Remove-Item .\\a.txt'],
    // Outside the approved pattern on purpose: recurse alone or force alone.
    // Widening to these is an owner decision, so the current edge is pinned.
    ['Remove-Item -Recurse .\\build'],
    ['Remove-Item -Force .\\a.txt'],
    ['Get-ChildItem -Recurse'],
    ['Get-ChildItem -Recurse -Force'],
    ['Copy-Item -Recurse -Force .\\a .\\b'],
    // The two flags belong to two different commands.
    ['Remove-Item -Recurse .\\a; Remove-Item -Force .\\b'],
    // `-f` alone is ambiguous in Remove-Item (Filter, Force) and errors out.
    ['Remove-Item -Recurse -f .\\a'],
    ['Remove-ItemProperty -Path HKCU:\\Software\\x -Name y -Force'],
    ['Get-Volume'],
    ['Get-Disk'],
    ['Get-Content $env:TEMP\\log.txt'],
    ['git status'],
  ])('passes: %s', (command) => {
    expect(run('PowerShell', command).decision, command).toBe('approve');
  });

  it('the shared catalogue also blocks the PowerShell spelling under Bash (pwsh -c)', () => {
    expect(run('Bash', 'pwsh -c "Remove-Item -Recurse -Force build"').decision).toBe('block');
  });
});

describe('PowerShell spellings the bash normalizer cannot read', () => {
  it.each([
    ['backtick line continuation (LF)', 'Remove-Item C:\\proj\\build `\n  -Recurse -Force'],
    ['backtick line continuation (CRLF)', 'Remove-Item C:\\proj\\build `\r\n  -Recurse `\r\n  -Force'],
    ['backtick continuation on a bash rule', 'rm `\n  -r -fo C:\\proj\\build'],
    ['backtick escape inside the command name', 'Re`move-Item -Recurse -Force build'],
    ['backtick escapes inside the parameters', 'Remove-Item -Re`curse -Fo`rce build'],
    ['$env: target', 'Remove-Item -Recurse -Force $env:TEMP\\artibot'],
    ['quoted $env: target', 'Remove-Item -Recurse -Force "$env:USERPROFILE\\proj"'],
    ['C:\\ literal path', 'Remove-Item -LiteralPath C:\\Users\\me\\proj -Recurse -Force'],
  ])('blocks: %s', (_label, command) => {
    expect(run('PowerShell', command).decision, JSON.stringify(command)).toBe('block');
  });

  it('keeps Bash semantics for Bash: a backtick continuation is not a bash continuation', () => {
    // In bash a lone backtick opens a command substitution; the PowerShell
    // un-escape variant is scoped to the PowerShell tool and must not move Bash.
    expect(run('Bash', 'Remove-Item C:\\proj\\build `\n  -Recurse -Force').decision).toBe('approve');
  });
});

describe('the bash printer exemption does not apply to PowerShell', () => {
  // `\"` closes nothing in PowerShell: the string ends at `a\`, then `;` runs
  // the delete. Bash reads the whole thing as one echo argument.
  const QUOTE_SPLIT = 'echo "a\\"; ri -r -fo C:\\x; \\""';
  // `\;` is an escaped separator in bash and a literal `\` plus a real
  // separator in PowerShell.
  const ESCAPED_SEPARATOR = 'echo a\\; ri -r -fo C:\\x';

  it.each([
    ['quote split', QUOTE_SPLIT],
    ['escaped separator', ESCAPED_SEPARATOR],
  ])('PowerShell blocks: %s', (_label, command) => {
    expect(run('PowerShell', command).decision).toBe('block');
  });

  it('Bash keeps its exemption for the quote-split row (bash really prints it)', () => {
    expect(run('Bash', QUOTE_SPLIT).decision).toBe('approve');
  });

  it('a mention through a printer blocks under PowerShell (fail-closed; double quotes expand $(…) there)', () => {
    expect(run('PowerShell', 'Write-Host "Remove-Item -Recurse -Force"').decision).toBe('block');
    expect(run('PowerShell', "Write-Host 'Remove-Item -Recurse -Force'").decision).toBe('block');
    expect(run('PowerShell', 'echo "Remove-Item -Recurse -Force"').decision).toBe('block');
    // Bash keeps the printer exemption for the same text.
    expect(run('Bash', 'echo "Remove-Item -Recurse -Force"').decision).toBe('approve');
  });
});

describe('separators inside PowerShell quotes do not end a rule window', () => {
  // Cross-check finding, 2026-11-07 20:1x: the `[^\n;|&]` windows stopped at a
  // separator that sat inside a quoted path, so a path placed before the flags
  // walked the delete through.
  it.each([
    ['ampersand in a double-quoted path', 'Remove-Item "C:/R&D" -Recurse -Force'],
    ['semicolon in a double-quoted path', 'Remove-Item "C:/a;b" -Recurse -Force'],
    ['pipe in a single-quoted path', "Remove-Item 'C:/a|b' -Recurse -Force"],
    ['backtick-escaped quote before the separator', 'Remove-Item "C:/a`"b;c" -Recurse -Force'],
    ['doubled single quote before the separator', "Remove-Item 'it''s;x' -Recurse -Force"],
    ['typographic quotes', 'Remove-Item \u201CC:/R&D\u201D -Recurse -Force'],
  ])('blocks: %s', (_label, command) => {
    expect(run('PowerShell', command).decision, command).toBe('block');
  });

  it.each([
    ['a real separator after a quoted one', 'Remove-Item -Recurse "C:/a;b"; Remove-Item -Force .\\c'],
    ['a quoted separator in an unrelated command', 'Write-Output "a;b"; Remove-Item -Recurse .\\x'],
    ['a pipe after a quoted path', 'Get-ChildItem "C:/R&D" | Remove-Item -Force'],
  ])('passes: %s', (_label, command) => {
    expect(run('PowerShell', command).decision, command).toBe('approve');
  });
});

describe('cmd.exe recursive deletes: rd and erase', () => {
  it.each([
    ['cmd /c rd /s /q C:\\proj\\build'],
    ['cmd /c rd /s C:\\proj\\build'],
    ['cmd /c erase /s /q C:\\proj\\build\\*'],
    ['cmd /c erase /s C:\\proj\\build\\*'],
  ])('blocks under both shells: %s', (command) => {
    expect(run('PowerShell', command).decision, command).toBe('block');
    expect(run('Bash', command).decision, command).toBe('block');
  });

  it.each([
    ['rd at the end of a word', 'Write-Output forward /s'],
    ['rd at the end of a path segment', 'Get-ChildItem C:\\standard /s'],
    ['rd without /s', 'cmd /c rd C:\\proj\\empty'],
  ])('passes: %s', (_label, command) => {
    expect(run('PowerShell', command).decision, command).toBe('approve');
  });
});
