/**
 * Tests for the wiring-gap triage classifier (scripts/ci/triage-wiring-gaps.mjs).
 *
 * Exercises the exported pure functions (extractSymbols, extractModule,
 * classifyGap, classifyConfigFlag) with fully in-memory fixtures — no live
 * filesystem or real-repo dependency. The script's stdout entry point is left
 * untouched; only the pure comparison core is unit-tested, mirroring the
 * findModelPolicyDrift testing pattern from validate-model-policy.
 *
 * @module tests/ci/triage-wiring-gaps
 */

import { describe, expect, it } from 'vitest';
import {
  classifyConfigFlag,
  classifyGap,
  extractModule,
  extractSymbols,
} from '../../scripts/ci/triage-wiring-gaps.mjs';

/**
 * Build a single in-memory lib-index entry (shape consumed by classifyGap).
 *
 * @param {string} relPath - Repo-relative POSIX path (e.g. 'lib/a/b.js').
 * @param {string} content - File source text.
 * @returns {{ relPath: string, base: string, content: string, isBarrel: boolean }}
 */
function mkFile(relPath, content) {
  const base = relPath.split('/').pop();
  return { relPath, base, content, isBarrel: base === 'index.js' };
}

describe('extractSymbols', () => {
  it('keeps camelCase API symbols and drops generic prose words', () => {
    const syms = extractSymbols('createWorkingStore without episodicStore (retriever)');
    expect(syms).toContain('createWorkingStore');
    expect(syms).toContain('episodicStore');
    // "without" / "retriever" are lowercase non-factory words -> dropped.
    expect(syms).not.toContain('without');
    expect(syms).not.toContain('retriever');
  });

  it('takes the trailing segment of a dotted access (episodic.appendEpisode)', () => {
    const syms = extractSymbols('episodic.appendEpisode (session-time write path)');
    expect(syms).toContain('appendEpisode');
    expect(syms).not.toContain('episodic.appendEpisode');
  });

  it('filters STOPWORDS even if they look identifier-ish', () => {
    const syms = extractSymbols('config flag enabled session store data');
    expect(syms).toEqual([]);
  });
});

describe('extractModule', () => {
  it('derives defPath + module basename from a path:line file field', () => {
    expect(extractModule('lib/core/event-bus.js:159')).toEqual({
      defPath: 'lib/core/event-bus.js',
      moduleName: 'event-bus',
    });
  });

  it('returns nulls for a non-js file reference', () => {
    expect(extractModule('.mcp.json:3-23')).toEqual({ defPath: null, moduleName: null });
  });
});

describe('classifyGap — caller detection', () => {
  const gap = { subsystem: 's', capability: 'doThing factory', file: 'lib/x/thing.js:10' };

  it('classifies a symbol with zero callers as dead', () => {
    const libIndex = [
      mkFile('lib/x/thing.js', 'export function doThing() { return 1; }\n'),
    ];
    const res = classifyGap(gap, libIndex);
    expect(res.verdict).toBe('dead');
    expect(res.callers).toEqual([]);
  });

  it('classifies a symbol with a real use-site caller as wired-suspect', () => {
    const libIndex = [
      mkFile('lib/x/thing.js', 'export function doThing() { return 1; }\n'),
      // caller file that nothing else imports would be an orphan; give it an
      // inbound reference so depth-2 keeps it as a real caller.
      mkFile('lib/x/caller.js', "import { doThing } from './thing.js';\nexport function run() { return doThing(); }\n"),
      mkFile('lib/x/entry.js', "import { run } from './caller.js';\nrun();\n"),
    ];
    const res = classifyGap(gap, libIndex);
    expect(res.verdict).toBe('wired-suspect');
    expect(res.callers).toContain('lib/x/caller.js');
  });
});

describe('classifyGap — exclusion rules', () => {
  const gap = { subsystem: 's', capability: 'doThing factory', file: 'lib/x/thing.js:10' };

  it('(a) does not count the definition file itself as a caller', () => {
    const libIndex = [
      // thing.js both defines and internally references doThing — still not a caller.
      mkFile('lib/x/thing.js', 'export function doThing() { return doThing.name; }\n'),
    ];
    expect(classifyGap(gap, libIndex).verdict).toBe('dead');
  });

  it('(a2) excludes a different file that DEFINES the symbol (export function)', () => {
    // audit file points at thing.js, but another file re-defines doThing and
    // never calls it — it must not be treated as a caller.
    const libIndex = [
      mkFile('lib/x/thing.js', '// stub\n'),
      mkFile('lib/y/other.js', 'export function doThing() { return 2; }\n'),
    ];
    expect(classifyGap(gap, libIndex).verdict).toBe('dead');
  });

  it('(c) ignores an index.js barrel re-export line', () => {
    const libIndex = [
      mkFile('lib/x/thing.js', 'export function doThing() {}\n'),
      mkFile('lib/x/index.js', "export { doThing } from './thing.js';\n"),
    ];
    expect(classifyGap(gap, libIndex).verdict).toBe('dead');
  });

  it('(d) ignores comment-line mentions (JSDoc * and //)', () => {
    const libIndex = [
      mkFile('lib/x/thing.js', 'export function doThing() {}\n'),
      mkFile(
        'lib/x/docs.js',
        '/**\n * Example: doThing() is great.\n */\n// call doThing() later\nexport const z = 1;\n'
      ),
    ];
    expect(classifyGap(gap, libIndex).verdict).toBe('dead');
  });
});

describe('classifyGap — orphan / mutually-dead chains', () => {
  const gap = { subsystem: 's', capability: 'doThing factory', file: 'lib/x/thing.js:10' };

  it('drops an orphan caller (caller file nobody imports)', () => {
    const libIndex = [
      mkFile('lib/x/thing.js', 'export function doThing() {}\n'),
      // caller.js calls doThing but nothing imports caller.js -> orphan.
      mkFile('lib/x/caller.js', "import { doThing } from './thing.js';\ndoThing();\n"),
    ];
    const res = classifyGap(gap, libIndex);
    expect(res.verdict).toBe('dead');
    expect(res.orphanCallers).toContain('lib/x/caller.js');
  });

  it('drops a caller that is itself another unverified gap def file (mutually-dead)', () => {
    const libIndex = [
      mkFile('lib/x/thing.js', 'export function doThing() {}\n'),
      mkFile('lib/x/caller.js', "import { doThing } from './thing.js';\ndoThing();\n"),
      // caller.js is imported elsewhere (would normally count as a real caller)...
      mkFile('lib/x/entry.js', "import { run } from './caller.js';\nrun();\n"),
    ];
    // ...but caller.js is itself flagged as a gap def file -> must not count.
    const gapDefFiles = new Set(['lib/x/thing.js', 'lib/x/caller.js']);
    const res = classifyGap(gap, libIndex, gapDefFiles);
    expect(res.verdict).toBe('dead');
    expect(res.orphanCallers).toContain('lib/x/caller.js');
  });
});

describe('classifyConfigFlag', () => {
  const config = {
    context: { importCacheTTL: 1000 },
    cognitive: { router: { adaptRate: 0.1 } },
  };

  it('inConfig + hasConsumer => config-only (not a gap)', () => {
    const libIndex = [
      mkFile('lib/core/cache.js', 'const ttl = cfg.importCacheTTL ?? 0;\n'),
    ];
    const res = classifyConfigFlag('context.importCacheTTL', config, libIndex);
    expect(res.inConfig).toBe(true);
    expect(res.hasConsumer).toBe(true);
    expect(res.consumers).toContain('lib/core/cache.js');
  });

  it('inConfig + NO consumer => flagged as unconsumed (separate count signal)', () => {
    const libIndex = [mkFile('lib/core/unrelated.js', 'export const z = 1;\n')];
    const res = classifyConfigFlag('cognitive.router.adaptRate', config, libIndex);
    expect(res.inConfig).toBe(true);
    expect(res.hasConsumer).toBe(false);
    expect(res.consumers).toEqual([]);
  });

  it('absent key => inConfig false', () => {
    const res = classifyConfigFlag('automation.intentDetection', config, []);
    expect(res.inConfig).toBe(false);
  });
});
