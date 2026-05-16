/**
 * Unit tests for scripts/squash-wip.mjs.
 *
 * The CLI module exports `parseArgs`, `collectWipRun`, `isWorkingTreeClean`,
 * `runSquash`, and `main`, all of which accept an injectable `git` runner.
 * No real git invocation happens in these tests.
 */

import { describe, expect, it } from 'vitest';
import {
  collectWipRun,
  isWorkingTreeClean,
  main,
  parseArgs,
  runSquash,
} from '../../scripts/squash-wip.mjs';

/**
 * Build a stub git runner from a function table keyed on the first argv slot.
 * Each entry can be a string (returned as stdout) or an Error (thrown).
 * The handler can also be a function for per-call inspection.
 *
 * @param {Record<string, string | Error | ((args: string[]) => string)>} table
 * @returns {(args: string[]) => string}
 */
function makeGit(table) {
  return (args) => {
    const key = args[0];
    const v = table[key];
    if (v === undefined) throw new Error(`unexpected git call: ${args.join(' ')}`);
    if (typeof v === 'function') return v(args);
    if (v instanceof Error) throw v;
    return v;
  };
}

describe('parseArgs', () => {
  it('returns defaults for empty argv', () => {
    expect(parseArgs([])).toEqual({ from: null, message: null, dryRun: false, help: false });
  });

  it('parses --from and --message', () => {
    expect(parseArgs(['--from', 'main', '--message', 'final'])).toEqual({
      from: 'main',
      message: 'final',
      dryRun: false,
      help: false,
    });
  });

  it('parses --dry-run flag', () => {
    expect(parseArgs(['--dry-run']).dryRun).toBe(true);
  });

  it('parses --help / -h', () => {
    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs(['-h']).help).toBe(true);
  });

  it('handles --message with short alias -m', () => {
    expect(parseArgs(['-m', 'short']).message).toBe('short');
  });
});

describe('collectWipRun', () => {
  it('collects contiguous WIP tail from HEAD', () => {
    const git = makeGit({
      log: [
        'aaaa\twip: c',
        'bbbb\twip: b',
        'cccc\twip: a',
        'dddd\tfeat: real work',
      ].join('\n'),
    });
    const { commits, sawNonWipBeforeWip } = collectWipRun({ git });
    expect(commits.map((c) => c.sha)).toEqual(['aaaa', 'bbbb', 'cccc']);
    expect(sawNonWipBeforeWip).toBe(false);
  });

  it('flags interleaved non-WIP commits as abort signal', () => {
    const git = makeGit({
      log: [
        'aaaa\twip: c',
        'bbbb\tfeat: sneaky',
        'cccc\twip: a',
      ].join('\n'),
    });
    const { sawNonWipBeforeWip } = collectWipRun({ git });
    expect(sawNonWipBeforeWip).toBe(true);
  });

  it('returns empty commits when HEAD is not a WIP commit', () => {
    const git = makeGit({
      log: 'aaaa\tfeat: real',
    });
    const { commits } = collectWipRun({ git });
    expect(commits).toEqual([]);
  });

  it('returns empty list on git error', () => {
    const git = makeGit({ log: new Error('not a git repo') });
    const { commits } = collectWipRun({ git });
    expect(commits).toEqual([]);
  });
});

describe('isWorkingTreeClean', () => {
  it('returns true on empty porcelain output', () => {
    const git = makeGit({ status: '' });
    expect(isWorkingTreeClean({ git })).toBe(true);
  });

  it('returns false when porcelain has entries', () => {
    const git = makeGit({ status: ' M lib/foo.js\n?? extra.tmp\n' });
    expect(isWorkingTreeClean({ git })).toBe(false);
  });

  it('returns false when git fails', () => {
    const git = makeGit({ status: new Error('fatal') });
    expect(isWorkingTreeClean({ git })).toBe(false);
  });
});

describe('runSquash — abort paths', () => {
  it('aborts on dirty working tree', () => {
    const git = makeGit({ status: ' M lib/foo.js' });
    const result = runSquash({ git });
    expect(result.status).toBe('abort-dirty');
    expect(result.message).toMatch(/uncommitted/i);
  });

  it('aborts when non-WIP commits are interleaved', () => {
    const git = makeGit({
      status: '',
      log: [
        'aaaa\twip: c',
        'bbbb\tfeat: sneaky',
        'cccc\twip: a',
      ].join('\n'),
    });
    const result = runSquash({ git });
    expect(result.status).toBe('abort-mixed');
    expect(result.message).toMatch(/interleaved/i);
  });
});

describe('runSquash — nothing-to-do paths', () => {
  it('reports nothing-to-do when HEAD is not WIP', () => {
    const git = makeGit({
      status: '',
      log: 'aaaa\tfeat: real',
    });
    expect(runSquash({ git }).status).toBe('nothing-to-do');
  });

  it('reports nothing-to-do when only one WIP commit at HEAD', () => {
    const git = makeGit({
      status: '',
      log: ['aaaa\twip: only one', 'bbbb\tfeat: prior'].join('\n'),
    });
    expect(runSquash({ git }).status).toBe('nothing-to-do');
  });
});

describe('runSquash — dry-run', () => {
  it('emits a plan without mutating', () => {
    const calls = [];
    const git = (args) => {
      calls.push(args[0]);
      if (args[0] === 'status') return '';
      if (args[0] === 'log') {
        return [
          'aaaa\twip: c',
          'bbbb\twip: b',
          'cccc\twip: a',
          'dddd\tfeat: real',
        ].join('\n');
      }
      throw new Error(`unexpected: ${args.join(' ')}`);
    };
    const result = runSquash({ git, dryRun: true });
    expect(result.status).toBe('dry-run');
    expect(result.squashed).toBe(3);
    expect(result.baseRef).toBe('HEAD~3');
    // Critically: reset and commit must NOT have been invoked.
    expect(calls).not.toContain('reset');
    expect(calls).not.toContain('commit');
  });
});

describe('runSquash — success path', () => {
  it('invokes reset --soft and commit -m', () => {
    const calls = [];
    const git = (args) => {
      calls.push(args.slice(0, 2).join(' '));
      if (args[0] === 'status') return '';
      if (args[0] === 'log') {
        return [
          'aaaa\twip: c',
          'bbbb\twip: b',
          'cccc\twip: a',
          'dddd\tfeat: real',
        ].join('\n');
      }
      if (args[0] === 'reset' || args[0] === 'commit') return '';
      throw new Error(`unexpected: ${args.join(' ')}`);
    };
    const result = runSquash({ git });
    expect(result.status).toBe('ok');
    expect(result.squashed).toBe(3);
    expect(calls).toContain('reset --soft');
    expect(calls).toContain('commit -m');
  });

  it('surfaces git errors as status=error', () => {
    let phase = 0;
    const git = (args) => {
      phase += 1;
      if (args[0] === 'status') return '';
      if (args[0] === 'log') {
        return ['aaaa\twip: c', 'bbbb\twip: b'].join('\n');
      }
      if (args[0] === 'reset') throw new Error('boom');
      throw new Error('unexpected');
    };
    const result = runSquash({ git });
    expect(result.status).toBe('error');
    expect(result.message).toMatch(/boom/);
    expect(phase).toBeGreaterThanOrEqual(3);
  });
});

describe('main — exit codes', () => {
  it('returns code 0 for dry-run', () => {
    const git = (args) => {
      if (args[0] === 'status') return '';
      if (args[0] === 'log') {
        return ['aaaa\twip: c', 'bbbb\twip: b'].join('\n');
      }
      throw new Error('unexpected');
    };
    const out = main(['--dry-run'], { git });
    expect(out.code).toBe(0);
    expect(out.status).toBe('dry-run');
  });

  it('returns code 1 for abort-dirty', () => {
    const git = (args) => {
      if (args[0] === 'status') return ' M file.js';
      throw new Error('unexpected');
    };
    const out = main([], { git });
    expect(out.code).toBe(1);
    expect(out.status).toBe('abort-dirty');
  });

  it('returns code 1 for abort-mixed', () => {
    const git = (args) => {
      if (args[0] === 'status') return '';
      if (args[0] === 'log') {
        return ['aaaa\twip: c', 'bbbb\tfeat: x', 'cccc\twip: a'].join('\n');
      }
      throw new Error('unexpected');
    };
    const out = main([], { git });
    expect(out.code).toBe(1);
    expect(out.status).toBe('abort-mixed');
  });

  it('returns code 2 for nothing-to-do', () => {
    const git = (args) => {
      if (args[0] === 'status') return '';
      if (args[0] === 'log') return 'aaaa\tfeat: real';
      throw new Error('unexpected');
    };
    const out = main([], { git });
    expect(out.code).toBe(2);
    expect(out.status).toBe('nothing-to-do');
  });

  it('returns code 0 for --help', () => {
    const out = main(['--help'], { git: () => '' });
    expect(out.code).toBe(0);
    expect(out.status).toBe('help');
  });
});
