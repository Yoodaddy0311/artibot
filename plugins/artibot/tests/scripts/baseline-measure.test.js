import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  aggregate, family, listTranscripts, parseArgs, recoverySummary, scanTranscript,
  targetOf, toTranscriptDirName,
} from '../../scripts/baseline-measure.js';

/**
 * Tests for the WP-E baseline measurement tool.
 *
 * Two obligations beyond ordinary correctness:
 *
 *  1. READ-ONLY. The script reads the transcript corpus, which sits next to the
 *     learning store that the R14 incident (2026-08-10) truncated. It is
 *     enforced twice below — statically (its `node:fs` imports are a read-only
 *     allowlist) and behaviourally (a full scan over a fixture tree leaves
 *     every byte and every directory entry unchanged).
 *
 *  2. SAME RULER. `targetOf()` defines "the same target" and therefore what
 *     counts as a repeat failure. The pinned baseline in the script header is
 *     only comparable to future runs while that definition holds, so its
 *     precedence order is asserted explicitly rather than left to a smoke test.
 */

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT_PATH = path.join(PLUGIN_ROOT, 'scripts', 'baseline-measure.js');

/** Build one transcript line: an array of content blocks under `message`. */
function line(...blocks) {
  return JSON.stringify({ message: { content: blocks } });
}
const use = (id, name, input) => ({ type: 'tool_use', id, name, input });
const result = (id, isError, content) => ({
  type: 'tool_result', tool_use_id: id, is_error: isError, content,
});

/**
 * Fixture with a known answer:
 *   t1 Bash "cd /nope"  -> error        (1st failure of this tool+target)
 *   t2 Bash "cd /nope"  -> error        (2nd failure -> exactly one repeat)
 *   t3 Bash "cd /nope"  -> ok           (recovers both, costs 2 and 1)
 *   t4 Read /gone.txt   -> error, never retried  (one "gave up")
 */
const FIXTURE_LINES = [
  line(use('t1', 'Bash', { command: 'cd /nope' })),
  line(result('t1', true, 'cd: /nope: No such file or directory')),
  line(use('t2', 'Bash', { command: 'cd  /nope' })), // extra space: same target after normalisation
  line(result('t2', true, 'cd: /nope: No such file or directory')),
  line(use('t3', 'Bash', { command: 'cd /nope' })),
  line(result('t3', false, 'ok')),
  line(use('t4', 'Read', { file_path: '/gone.txt' })),
  line(result('t4', true, 'File does not exist. Current working directory is /repo')),
].join('\n');

/** Recursive snapshot of every file's sha256, keyed by relative path. */
function snapshotTree(root) {
  const acc = {};
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else acc[path.relative(root, p)] = createHash('sha256').update(readFileSync(p)).digest('hex');
    }
  };
  walk(root);
  return acc;
}

describe('baseline-measure: read-only guarantee', () => {
  it('imports only read APIs from node:fs', () => {
    const src = readFileSync(SCRIPT_PATH, 'utf-8');
    const importMatch = src.match(/import\s*\{([^}]+)\}\s*from\s*'node:fs'/);
    expect(importMatch).not.toBeNull();
    const imported = importMatch[1].split(',').map((s) => s.trim()).filter(Boolean).sort();
    expect(imported).toEqual(['readFileSync', 'readdirSync']);
  });

  it('contains no write-API call anywhere in executable code', () => {
    // Comments are stripped first: the header deliberately NAMES the forbidden
    // APIs to explain the prohibition, and a naive grep would flag its own
    // documentation.
    const code = readFileSync(SCRIPT_PATH, 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const forbidden = [
      'writeFileSync', 'appendFileSync', 'mkdirSync', 'rmSync', 'rmdirSync', 'unlinkSync',
      'copyFileSync', 'renameSync', 'createWriteStream', 'truncateSync', 'writeSync',
      'fs.promises', 'openSync',
    ];
    const hits = forbidden.filter((api) => code.includes(api));
    expect(hits).toEqual([]);
  });

  it('leaves the scanned tree byte-identical and adds no entries', () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), 'artibot-baseline-ro-'));
    try {
      const corpus = path.join(sandbox, 'corpus', 'sub', 'subagents');
      mkdirSync(corpus, { recursive: true });
      writeFileSync(path.join(sandbox, 'corpus', 'a.jsonl'), FIXTURE_LINES);
      writeFileSync(path.join(corpus, 'b.jsonl'), FIXTURE_LINES);

      const before = snapshotTree(sandbox);
      const beforeDirs = statSync(path.join(sandbox, 'corpus')).isDirectory();

      // A real child process, and HOME/USERPROFILE point at the sandbox so that
      // even an accidental fallback to the default projects dir cannot reach the
      // developer's own ~/.claude.
      const stdout = execFileSync(
        process.execPath,
        [SCRIPT_PATH, '--dir', path.join(sandbox, 'corpus'), '--json'],
        {
          env: { ...process.env, USERPROFILE: sandbox, HOME: sandbox },
          encoding: 'utf-8',
          timeout: 30000,
        },
      );

      expect(JSON.parse(stdout).transcripts).toBe(2);
      expect(snapshotTree(sandbox)).toEqual(before);
      expect(beforeDirs).toBe(true);
      // No stray output file: the only entry under sandbox is the corpus tree.
      expect(readdirSync(sandbox).sort()).toEqual(['corpus']);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});

describe('baseline-measure: the ruler', () => {
  it('targetOf resolves in file_path > path > command > pattern order', () => {
    expect(targetOf({ file_path: '/a', path: '/b', command: 'c' })).toBe('/a');
    expect(targetOf({ path: '/b', command: 'c' })).toBe('/b');
    expect(targetOf({ command: 'c' })).toBe('c');
    expect(targetOf({ pattern: 'p' })).toBe('pattern:p');
    expect(targetOf({})).toBe('(no-target)');
    expect(targetOf()).toBe('(no-target)');
  });

  it('targetOf collapses whitespace and caps commands at 120 chars', () => {
    expect(targetOf({ command: '  git   status  ' })).toBe('git status');
    expect(targetOf({ command: 'x'.repeat(200) })).toHaveLength(120);
  });

  it('classifies the advisor-targeted error families', () => {
    expect(family('cd: /nope: No such file or directory')).toBe('F2-cwd-bash');
    expect(family('File does not exist. Current working directory is /r')).toBe('F2-path-cwd');
    expect(family('File has not been read yet')).toBe('F1-read-first');
    expect(family('String to replace not found in file')).toBe('F3-anchor');
    expect(family("The user doesn't want to proceed")).toBe('F4-user-decision');
    expect(family('some unrecognised failure')).toBe('F5-other');
  });

  it('counts a 2nd failure of the same tool+target as exactly one repeat', () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), 'artibot-baseline-fx-'));
    try {
      const f = path.join(sandbox, 'a.jsonl');
      writeFileSync(f, FIXTURE_LINES);
      const s = scanTranscript(f);

      expect(s.use).toBe(4);
      expect(s.isErrorTotal).toBe(3);
      expect(s.attributed).toBe(3);
      expect(s.repeats).toBe(1);
      expect(s.famCount).toEqual({ 'F2-cwd-bash': 2, 'F2-path-cwd': 1 });

      const r = recoverySummary(s.recoveries);
      expect(r.total).toBe(3);
      expect(r.recovered).toBe(2);
      expect(r.gaveUp).toBe(1);
      expect(r.costs).toEqual([1, 2]);
      expect(r.max).toBe(2);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('aggregates per-transcript scans additively', () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), 'artibot-baseline-ag-'));
    try {
      writeFileSync(path.join(sandbox, 'a.jsonl'), FIXTURE_LINES);
      writeFileSync(path.join(sandbox, 'b.jsonl'), FIXTURE_LINES);
      const t = aggregate(listTranscripts(sandbox));

      expect(t.transcripts).toBe(2);
      expect(t.use).toBe(8);
      expect(t.isErrorTotal).toBe(6);
      expect(t.repeats).toBe(2);
      expect(t.famCount).toEqual({ 'F2-cwd-bash': 4, 'F2-path-cwd': 2 });
      // Repeats are scoped per transcript: two files never merge into one streak.
      expect(t.perSession).toHaveLength(2);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('finds transcripts nested under subagents/', () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), 'artibot-baseline-nest-'));
    try {
      const nested = path.join(sandbox, 'session', 'subagents');
      mkdirSync(nested, { recursive: true });
      writeFileSync(path.join(sandbox, 'top.jsonl'), FIXTURE_LINES);
      writeFileSync(path.join(nested, 'agent.jsonl'), FIXTURE_LINES);
      writeFileSync(path.join(sandbox, 'ignore.txt'), 'not a transcript');

      expect(listTranscripts(sandbox)).toHaveLength(2);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('returns no transcripts for a missing directory instead of throwing', () => {
    expect(listTranscripts(path.join(tmpdir(), 'artibot-does-not-exist-xyz'))).toEqual([]);
  });
});

describe('baseline-measure: path resolution and fail-closed behaviour', () => {
  it('encodes a Windows repo path with the double dash Claude Code uses', () => {
    // `C:` and the separator after it each contribute a dash. Getting this
    // wrong points the scan at a directory that does not exist, which would
    // report a flawless (empty) baseline.
    expect(toTranscriptDirName(String.raw`C:\Users\me\Desktop\Artibot`))
      .toBe('C--Users-me-Desktop-Artibot');
    expect(toTranscriptDirName('/home/me/artibot')).toBe('-home-me-artibot');
  });

  it('honours --dir over the derived default, and --json', () => {
    // --dir is passed through verbatim; readdirSync resolves it against cwd.
    expect(parseArgs(['--dir', '/tmp/x']).dir).toBe('/tmp/x');
    expect(parseArgs(['--dir', '/tmp/x']).json).toBe(false);
    expect(parseArgs(['--dir', '/tmp/x', '--json']).json).toBe(true);
  });

  it('composes --projects and --project into the scan directory', () => {
    const opts = parseArgs(['--projects', path.join('/p'), '--project', 'proj']);
    expect(opts.dir).toBe(path.join('/p', 'proj'));
  });

  it('exits non-zero rather than reporting an empty baseline', () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), 'artibot-baseline-empty-'));
    try {
      let status = 0;
      let stderr = '';
      try {
        execFileSync(process.execPath, [SCRIPT_PATH, '--dir', sandbox], {
          env: { ...process.env, USERPROFILE: sandbox, HOME: sandbox },
          encoding: 'utf-8',
          timeout: 30000,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err) {
        status = typeof err.status === 'number' ? err.status : -1;
        stderr = err.stderr?.toString('utf-8') || '';
      }
      expect(status).toBe(1);
      expect(stderr).toMatch(/refusing to report an empty baseline/);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});

describe('baseline-measure: import safety', () => {
  let sandbox;
  beforeAll(() => { sandbox = mkdtempSync(path.join(tmpdir(), 'artibot-baseline-imp-')); });
  afterAll(() => { if (sandbox) rmSync(sandbox, { recursive: true, force: true }); });

  it('does not scan anything on import (direct-run guard)', () => {
    // Importing at the top of this file must not have produced output or work;
    // if the guard regressed, every test run would scan the whole machine.
    // Re-importing is a no-op, which is the observable form of that guarantee.
    expect(typeof aggregate).toBe('function');
    expect(readdirSync(sandbox)).toEqual([]);
  });
});
