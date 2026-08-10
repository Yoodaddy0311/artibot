import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const {
  COUNTER_FILENAME,
  ZERO_RESULT_MARKERS,
  buildOutput,
  counterPath,
  evaluateZeroResult,
  extractQueryPattern,
  extractResponseText,
  formatScopeReminder,
  handlePostToolUse,
  isIdentifierLike,
  isZeroResult,
} = await import('../../scripts/hooks/zero-result-guard.js');

// ---------------------------------------------------------------------------
// Zero-result strings — MEASURED, not invented.
//
// Captured 2026-08-10 by issuing live Grep/Glob tool calls for the identifier
// `zzz_nonexistent_identifier_probe` / `**/zzzNonexistentProbe.*` against
// plugins/artibot/lib:
//
//   Grep output_mode:'content'            -> 'No matches found'
//   Grep output_mode:'files_with_matches' -> 'No files found'
//   Grep output_mode:'count'              -> 'No matches found\n\nFound 0 total occurrences across 0 files.'
//   Glob                                  -> 'No files found'
//
// The response arrives as a PLAIN STRING, not an object (WP-3 brief: 131/131
// Grep tool_response values measured as strings). The object branch below is
// defensive only — it has never been observed live.
// ---------------------------------------------------------------------------
const MEASURED = {
  grepContent: 'No matches found',
  grepFiles: 'No files found',
  grepCount: 'No matches found\n\nFound 0 total occurrences across 0 files.',
  globNone: 'No files found',
  grepHit: 'C:\\repo\\lib\\core\\model-policy.js:12:export function resolveModel() {',
  // REAL hit whose CONTENT quotes a zero-result marker. Captured by grepping
  // this very repo for `grepContent` on 2026-08-10 — three genuine hits, the
  // first of which contains the literal 'No matches found'. A substring test
  // reads this as "zero results" and injects advice contradicting what the
  // model just saw. Regression fixture for the anchored isZeroResult().
  grepHitQuotingMarker:
    "39:  grepContent: 'No matches found',\n"
    + '53:    expect(extractResponseText({ tool_response: MEASURED.grepContent }))\n'
    + '165:    tool_response: MEASURED.grepContent,',
};

const HOOK = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..', 'scripts', 'hooks', 'zero-result-guard.js',
);

describe('extractResponseText', () => {
  it('reads a plain-string tool_response (the measured live shape)', () => {
    expect(extractResponseText({ tool_response: MEASURED.grepContent }))
      .toBe(MEASURED.grepContent);
  });

  it('reads the object shapes defensively (never observed live)', () => {
    expect(extractResponseText({ tool_response: { content: 'No matches found' } }))
      .toBe('No matches found');
    expect(extractResponseText({ tool_response: { stdout: 'No files found' } }))
      .toBe('No files found');
    expect(extractResponseText({ tool_result: 'No matches found' }))
      .toBe('No matches found');
  });

  it('flattens an anthropic content-block array', () => {
    expect(extractResponseText({ tool_response: [{ text: 'No matches found' }] }))
      .toBe('No matches found');
  });

  it('returns empty string for junk', () => {
    expect(extractResponseText(null)).toBe('');
    expect(extractResponseText({})).toBe('');
    expect(extractResponseText({ tool_response: 42 })).toBe('');
  });
});

describe('extractQueryPattern', () => {
  it('reads tool_input.pattern', () => {
    expect(extractQueryPattern({ tool_input: { pattern: 'resolveModel' } }))
      .toBe('resolveModel');
  });

  it('returns empty string when absent or non-string', () => {
    expect(extractQueryPattern({})).toBe('');
    expect(extractQueryPattern({ tool_input: {} })).toBe('');
    expect(extractQueryPattern({ tool_input: { pattern: 12 } })).toBe('');
    expect(extractQueryPattern(null)).toBe('');
  });
});

describe('isZeroResult', () => {
  it.each([
    ['Grep content mode', MEASURED.grepContent],
    ['Grep files_with_matches mode', MEASURED.grepFiles],
    ['Grep count mode', MEASURED.grepCount],
    ['Glob', MEASURED.globNone],
  ])('detects the measured zero-result string for %s', (_label, text) => {
    expect(isZeroResult(text)).toBe(true);
  });

  it('does not fire on a real hit', () => {
    expect(isZeroResult(MEASURED.grepHit)).toBe(false);
  });

  // Regression, cross-review finding 1. `text.includes(marker)` passed every
  // other test in this file and still called a 3-hit result "zero results".
  // The marker must be matched at the START of the response: hits begin with a
  // file path, zero-results begin with the marker.
  it('does not fire on a real hit whose content quotes a marker string', () => {
    expect(isZeroResult(MEASURED.grepHitQuotingMarker)).toBe(false);
  });

  it('still fires when the marker is merely indented', () => {
    expect(isZeroResult('  No matches found')).toBe(true);
  });

  it('does not fire on a non-zero count', () => {
    expect(isZeroResult('Found 12 total occurrences across 3 files.')).toBe(false);
  });

  it('does not fire on empty / junk', () => {
    expect(isZeroResult('')).toBe(false);
    expect(isZeroResult(null)).toBe(false);
    expect(isZeroResult(undefined)).toBe(false);
  });

  it('exposes the marker allowlist so a phrasing change is visible in one place', () => {
    expect(ZERO_RESULT_MARKERS).toEqual(
      expect.arrayContaining(['No matches found', 'No files found', 'Found 0 total occurrences']),
    );
  });
});

describe('isIdentifierLike', () => {
  it.each([
    'resolveModel',
    'atomicWriteSync',
    'zero_result_guard',
    'ADVICE_RULES',
    'buildWorkflowPlan',
    't1_official',
    // Boundary: exactly MIN_IDENTIFIER_LENGTH. Without this, raising the
    // minimum from 3 to 4 passes the whole suite (cross-review finding 4).
    // Paired with the 'aB' reject case below, this pins the cutoff at 3.
    'aBc',
  ])('accepts the identifier %s', (p) => {
    expect(isIdentifierLike(p)).toBe(true);
  });

  it.each([
    ['a regex with metacharacters', 'export function \\w+'],
    ['a glob', '**/*.js'],
    ['an alternation', 'foo|bar'],
    ['a phrase', 'no matches found'],
    ['an anchored regex', '^resolveModel$'],
    ['a dotted path', 'lib.core.policy'],
    ['a plain lowercase word (no hump, no underscore)', 'resolve'],
    ['a kebab word (deliberately excluded)', 'zero-result-guard'],
    ['a too-short token', 'aB'],
    ['empty', ''],
  ])('rejects %s', (_label, p) => {
    expect(isIdentifierLike(p)).toBe(false);
  });

  it('rejects non-strings', () => {
    expect(isIdentifierLike(null)).toBe(false);
    expect(isIdentifierLike(12)).toBe(false);
    expect(isIdentifierLike({})).toBe(false);
  });

  it('tolerates surrounding whitespace', () => {
    expect(isIdentifierLike('  resolveModel  ')).toBe(true);
  });
});

describe('evaluateZeroResult', () => {
  const grepPayload = (over = {}) => ({
    tool_name: 'Grep',
    tool_input: { pattern: 'resolveModel', path: 'src/', ...over.tool_input },
    tool_response: MEASURED.grepContent,
    ...over,
  });

  it('fires on an identifier-shaped Grep that returned nothing', () => {
    const ev = evaluateZeroResult(grepPayload());
    expect(ev.fired).toBe(true);
    expect(ev.pattern).toBe('resolveModel');
    expect(ev.tool).toBe('Grep');
  });

  it('fires on a Glob whose pattern is a bare identifier', () => {
    const ev = evaluateZeroResult({
      tool_name: 'Glob',
      tool_input: { pattern: 'resolveModel' },
      tool_response: MEASURED.globNone,
    });
    expect(ev.fired).toBe(true);
  });

  it('stays silent when the query matched something', () => {
    expect(evaluateZeroResult(grepPayload({ tool_response: MEASURED.grepHit })).fired)
      .toBe(false);
  });

  it('stays silent for a regex query — the guard is about scope, not syntax', () => {
    expect(evaluateZeroResult(grepPayload({ tool_input: { pattern: 'export\\s+function' } })).fired)
      .toBe(false);
  });

  it('stays silent for an ordinary glob pattern', () => {
    expect(evaluateZeroResult({
      tool_name: 'Glob',
      tool_input: { pattern: '**/*.test.js' },
      tool_response: MEASURED.globNone,
    }).fired).toBe(false);
  });

  it('collects the scope filters that were applied', () => {
    const ev = evaluateZeroResult(grepPayload({
      tool_input: { pattern: 'resolveModel', path: 'src/', glob: '*.js', type: 'js' },
    }));
    expect(ev.filters).toEqual({ path: 'src/', glob: '*.js', type: 'js' });
  });

  it('reports no filters when the sweep was already repo-wide', () => {
    const ev = evaluateZeroResult({
      tool_name: 'Grep',
      tool_input: { pattern: 'resolveModel' },
      tool_response: MEASURED.grepContent,
    });
    expect(ev.fired).toBe(true);
    expect(ev.filters).toEqual({});
  });

  it('stays silent on empty / malformed payloads', () => {
    expect(evaluateZeroResult(null).fired).toBe(false);
    expect(evaluateZeroResult({}).fired).toBe(false);
    expect(evaluateZeroResult({ tool_name: 'Grep' }).fired).toBe(false);
  });
});

describe('formatScopeReminder', () => {
  const ev = {
    fired: true,
    tool: 'Grep',
    pattern: 'resolveModel',
    filters: { path: 'src/', type: 'js' },
  };

  it('names the pattern and the tool that produced zero results', () => {
    const msg = formatScopeReminder(ev);
    expect(msg).toContain('resolveModel');
    expect(msg).toContain('Grep');
  });

  it('carries the artibot hook prefix', () => {
    expect(formatScopeReminder(ev)).toContain('[artibot:zero-result-guard]');
  });

  it('echoes the scope filters back so the narrowing is visible', () => {
    const msg = formatScopeReminder(ev);
    expect(msg).toContain('path=src/');
    expect(msg).toContain('type=js');
  });

  it('directs the model at SCOPE, not at query syntax', () => {
    // The failures this guard was built from were wrong about WHERE they
    // looked, never about HOW they spelled the regex. If this assertion is
    // ever relaxed, the guard has drifted into being a regex tutor.
    const msg = formatScopeReminder(ev);
    expect(msg.toLowerCase()).toContain('scope');
    expect(msg).toMatch(/미확인/);
  });
});

describe('buildOutput / handlePostToolUse', () => {
  it('returns null when the guard does not fire — silence is the default', () => {
    expect(buildOutput({ fired: false })).toBeNull();
    expect(handlePostToolUse({
      tool_name: 'Grep',
      tool_input: { pattern: 'resolveModel' },
      tool_response: MEASURED.grepHit,
    })).toBeNull();
  });

  it('emits additionalContext under the PostToolUse event name', () => {
    const out = handlePostToolUse({
      tool_name: 'Grep',
      tool_input: { pattern: 'resolveModel', path: 'src/' },
      tool_response: MEASURED.grepContent,
    });
    expect(out).not.toBeNull();
    expect(out.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    expect(out.hookSpecificOutput.additionalContext).toContain('resolveModel');
  });

  it('never blocks — advisory only', () => {
    const out = handlePostToolUse({
      tool_name: 'Grep',
      tool_input: { pattern: 'resolveModel' },
      tool_response: MEASURED.grepContent,
    });
    expect(out.decision).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain('block');
  });
});

describe('counter file contract (WP-4 consumes this)', () => {
  it('is named zero-result-guard-counter.json under ~/.claude/artibot/', () => {
    expect(COUNTER_FILENAME).toBe('zero-result-guard-counter.json');
    const p = counterPath();
    expect(p.endsWith(path.join('.claude', 'artibot', COUNTER_FILENAME))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Subprocess E2E.
//
// HOME/USERPROFILE are redirected to a throwaway dir for every spawn so the
// counter lands in a sandbox rather than the developer's real learning store
// — same mechanism and same reason as tests/dispatcher/posttooluse-dispatcher
// .test.js:36,55-58.
// ---------------------------------------------------------------------------
describe('zero-result-guard hook (subprocess)', () => {
  let sandboxHome;

  beforeAll(() => {
    sandboxHome = mkdtempSync(path.join(tmpdir(), 'artibot-zrg-'));
  });

  afterAll(() => {
    if (sandboxHome) rmSync(sandboxHome, { recursive: true, force: true });
  });

  beforeEach(() => {
    const p = path.join(sandboxHome, '.claude', 'artibot', COUNTER_FILENAME);
    if (existsSync(p)) rmSync(p, { force: true });
  });

  function runHook(payload) {
    const input = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const res = spawnSync(process.execPath, [HOOK], {
      input,
      encoding: 'utf-8',
      env: { ...process.env, USERPROFILE: sandboxHome, HOME: sandboxHome },
    });
    return { stdout: res.stdout ?? '', status: res.status };
  }

  function readCounter() {
    const p = path.join(sandboxHome, '.claude', 'artibot', COUNTER_FILENAME);
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) : null;
  }

  it('emits the scope reminder for a real zero-result Grep payload', () => {
    const { stdout, status } = runHook({
      session_id: 'x',
      hook_event_name: 'PostToolUse',
      tool_name: 'Grep',
      tool_input: { pattern: 'resolveModel', path: 'src/', output_mode: 'content' },
      tool_response: MEASURED.grepContent,
      cwd: process.cwd(),
    });
    expect(status).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    expect(out.hookSpecificOutput.additionalContext).toContain('[artibot:zero-result-guard]');
    expect(out.hookSpecificOutput.additionalContext).toContain('resolveModel');
  });

  it('increments the counter under byChannel.b1 when it fires', () => {
    runHook({
      tool_name: 'Grep',
      tool_input: { pattern: 'resolveModel' },
      tool_response: MEASURED.grepContent,
    });
    const c = readCounter();
    expect(c).not.toBeNull();
    expect(c.fired).toBe(1);
    expect(c.byChannel.b1).toBe(1);
    expect(c.byChannel.b2).toBe(0);
    expect(typeof c.lastFiredAt).toBe('string');
    expect(Number.isNaN(Date.parse(c.lastFiredAt))).toBe(false);
  });

  it('accumulates across fires rather than resetting', () => {
    const payload = {
      tool_name: 'Grep',
      tool_input: { pattern: 'atomicWriteSync' },
      tool_response: MEASURED.grepContent,
    };
    runHook(payload);
    runHook(payload);
    const c = readCounter();
    expect(c.fired).toBe(2);
    expect(c.byChannel.b1).toBe(2);
  });

  it('writes nothing and touches no counter when the query matched', () => {
    const { stdout, status } = runHook({
      tool_name: 'Grep',
      tool_input: { pattern: 'resolveModel' },
      tool_response: MEASURED.grepHit,
    });
    expect(stdout.trim()).toBe('');
    expect(status).toBe(0);
    expect(readCounter()).toBeNull();
  });

  it('survives malformed stdin without throwing', () => {
    const { stdout, status } = runHook('not json {{{');
    expect(stdout.trim()).toBe('');
    expect(status).toBe(0);
  });

  it('direct-run guard: importing the module does NOT execute main()', async () => {
    // Without this guard an import blocks on stdin and hangs the whole suite —
    // the failure mode fixed in 67adb5e. The import at the top of this file has
    // already happened; if the guard were missing, the suite would never have
    // reached this line.
    const mod = await import('../../scripts/hooks/zero-result-guard.js');
    expect(typeof mod.handlePostToolUse).toBe('function');
  });
});
