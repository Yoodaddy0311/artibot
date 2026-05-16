/**
 * Tests for scripts/build-pr-description.mjs
 *
 * Strategy:
 *   - parseArgs and usage are pure — tested directly.
 *   - main() is tested with an injected `build` function that captures
 *     the args passed to the builder, plus injected stdout/stderr writers
 *     that buffer output. No real git or filesystem calls.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  main,
  parseArgs,
  SCRIPT_DIR,
  usage,
} from '../../scripts/build-pr-description.mjs';

// ---------------------------------------------------------------------------
// Helpers — buffered I/O writers
// ---------------------------------------------------------------------------

function makeStream() {
  const chunks = [];
  return {
    write: (chunk) => chunks.push(String(chunk)),
    text: () => chunks.join(''),
  };
}

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

describe('parseArgs', () => {
  it('returns defaults when no flags passed', () => {
    expect(parseArgs([])).toEqual({
      base: 'master',
      head: 'HEAD',
      sessionNotes: null,
      stats: false,
      help: false,
    });
  });

  it('parses --base and --head with values', () => {
    const args = parseArgs(['--base', 'main', '--head', 'feature/x']);
    expect(args.base).toBe('main');
    expect(args.head).toBe('feature/x');
  });

  it('parses --session-notes with a value', () => {
    const args = parseArgs(['--session-notes', '.artibot/SESSION-NOTES.md']);
    expect(args.sessionNotes).toBe('.artibot/SESSION-NOTES.md');
  });

  it('flips --stats to true', () => {
    expect(parseArgs(['--stats']).stats).toBe(true);
  });

  it('flips --help / -h to true', () => {
    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs(['-h']).help).toBe(true);
  });

  it('silently ignores unknown flags', () => {
    const args = parseArgs(['--unknown', 'value', '--base', 'master']);
    expect(args.base).toBe('master');
  });

  it('handles mixed flag ordering', () => {
    const args = parseArgs([
      '--stats',
      '--base', 'develop',
      '--session-notes', 'notes.md',
      '--head', 'HEAD~1',
    ]);
    expect(args).toEqual({
      base: 'develop',
      head: 'HEAD~1',
      sessionNotes: 'notes.md',
      stats: true,
      help: false,
    });
  });
});

// ---------------------------------------------------------------------------
// usage
// ---------------------------------------------------------------------------

describe('usage', () => {
  it('includes all documented flags', () => {
    const txt = usage();
    expect(txt).toContain('--base');
    expect(txt).toContain('--head');
    expect(txt).toContain('--session-notes');
    expect(txt).toContain('--stats');
    expect(txt).toContain('--help');
  });
});

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

describe('main', () => {
  it('emits usage to stdout on --help and returns 0', async () => {
    const stdout = makeStream();
    const stderr = makeStream();
    const build = vi.fn();
    const code = await main(['--help'], { stdout, stderr, build });
    expect(code).toBe(0);
    expect(stdout.text()).toContain('Usage:');
    expect(build).not.toHaveBeenCalled();
  });

  it('forwards parsed args to the builder', async () => {
    const stdout = makeStream();
    const stderr = makeStream();
    const build = vi.fn().mockResolvedValue('## Summary\n\n- ok\n');
    const code = await main(
      ['--base', 'main', '--head', 'HEAD', '--session-notes', 'notes.md', '--stats'],
      { stdout, stderr, build },
    );
    expect(code).toBe(0);
    expect(build).toHaveBeenCalledWith({
      baseBranch: 'main',
      headBranch: 'HEAD',
      sessionNotesPath: 'notes.md',
      includeStats: true,
    });
    expect(stdout.text()).toContain('## Summary');
  });

  it('appends a trailing newline when builder output lacks one', async () => {
    const stdout = makeStream();
    const stderr = makeStream();
    const build = vi.fn().mockResolvedValue('no newline at end');
    await main([], { stdout, stderr, build });
    expect(stdout.text().endsWith('\n')).toBe(true);
  });

  it('does not duplicate trailing newline when builder already ends with one', async () => {
    const stdout = makeStream();
    const stderr = makeStream();
    const build = vi.fn().mockResolvedValue('ends with newline\n');
    await main([], { stdout, stderr, build });
    expect(stdout.text()).toBe('ends with newline\n');
  });

  it('returns exit code 1 and logs to stderr on builder failure', async () => {
    const stdout = makeStream();
    const stderr = makeStream();
    const build = vi.fn().mockRejectedValue(new Error('git not found'));
    const code = await main(['--base', 'master'], { stdout, stderr, build });
    expect(code).toBe(1);
    expect(stderr.text()).toContain('git not found');
    expect(stdout.text()).toBe('');
  });

  it('uses defaults when no flags are passed', async () => {
    const stdout = makeStream();
    const stderr = makeStream();
    const build = vi.fn().mockResolvedValue('ok');
    await main([], { stdout, stderr, build });
    expect(build).toHaveBeenCalledWith({
      baseBranch: 'master',
      headBranch: 'HEAD',
      sessionNotesPath: null,
      includeStats: false,
    });
  });
});

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

describe('module exports', () => {
  it('exports SCRIPT_DIR as a non-empty string', () => {
    expect(typeof SCRIPT_DIR).toBe('string');
    expect(SCRIPT_DIR.length).toBeGreaterThan(0);
  });
});
