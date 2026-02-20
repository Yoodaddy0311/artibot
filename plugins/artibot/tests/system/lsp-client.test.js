import { describe, it, expect, beforeEach } from 'vitest';
import {
  parseTscOutput,
  parseEslintOutput,
  addDiagnosticContext,
  parseDiagnostic,
  getLastDiagnostics,
  resetDiagnostics,
  collectDiagnostics,
  SEVERITY,
  SEVERITY_LABEL,
  MAX_DIAGNOSTICS_PER_SOURCE,
} from '../../lib/system/lsp-client.js';

beforeEach(() => {
  resetDiagnostics();
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
describe('SEVERITY constants', () => {
  it('defines 4 severity levels', () => {
    expect(SEVERITY.ERROR).toBe(1);
    expect(SEVERITY.WARNING).toBe(2);
    expect(SEVERITY.INFORMATION).toBe(3);
    expect(SEVERITY.HINT).toBe(4);
  });

  it('defines reverse labels', () => {
    expect(SEVERITY_LABEL[1]).toBe('error');
    expect(SEVERITY_LABEL[2]).toBe('warning');
    expect(SEVERITY_LABEL[3]).toBe('information');
    expect(SEVERITY_LABEL[4]).toBe('hint');
  });

  it('has a sane max per source', () => {
    expect(MAX_DIAGNOSTICS_PER_SOURCE).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// parseTscOutput()
// ---------------------------------------------------------------------------
describe('parseTscOutput()', () => {
  it('parses standard tsc error output', () => {
    const output = [
      'src/index.ts(10,5): error TS2345: Argument of type \'string\' is not assignable.',
      'src/utils.ts(22,10): error TS2304: Cannot find name \'foo\'.',
    ].join('\n');

    const result = parseTscOutput(output, '/project');
    expect(result).toHaveLength(2);

    expect(result[0]).toEqual({
      file: 'src/index.ts',
      line: 10,
      column: 5,
      severity: 'error',
      message: 'Argument of type \'string\' is not assignable.',
      code: 'TS2345',
      source: 'tsc',
    });

    expect(result[1].file).toBe('src/utils.ts');
    expect(result[1].line).toBe(22);
    expect(result[1].code).toBe('TS2304');
  });

  it('parses warning severity', () => {
    const output = 'src/app.ts(5,1): warning TS6133: declared but never used.';
    const result = parseTscOutput(output, '/project');
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe('warning');
  });

  it('returns empty array for empty input', () => {
    expect(parseTscOutput('', '/project')).toEqual([]);
    expect(parseTscOutput(null, '/project')).toEqual([]);
    expect(parseTscOutput(undefined, '/project')).toEqual([]);
  });

  it('skips non-matching lines', () => {
    const output = [
      'Version 5.0.0',
      'src/index.ts(10,5): error TS2345: Some error.',
      '',
      'Found 1 error.',
    ].join('\n');

    const result = parseTscOutput(output, '/project');
    expect(result).toHaveLength(1);
    expect(result[0].code).toBe('TS2345');
  });

  it('converts absolute paths to relative', () => {
    const output = '/project/src/index.ts(1,1): error TS1234: msg.';
    const result = parseTscOutput(output, '/project');
    expect(result[0].file).toBe('src/index.ts');
  });

  it('normalizes backslashes to forward slashes', () => {
    const output = 'src\\utils\\helper.ts(1,1): error TS1234: msg.';
    const result = parseTscOutput(output, '/project');
    expect(result[0].file).toBe('src/utils/helper.ts');
  });

  it('respects MAX_DIAGNOSTICS_PER_SOURCE limit', () => {
    const lines = Array.from({ length: 600 }, (_, i) =>
      `src/file${i}.ts(1,1): error TS1234: msg${i}.`
    ).join('\n');

    const result = parseTscOutput(lines, '/project');
    expect(result.length).toBeLessThanOrEqual(MAX_DIAGNOSTICS_PER_SOURCE);
  });
});

// ---------------------------------------------------------------------------
// parseEslintOutput()
// ---------------------------------------------------------------------------
describe('parseEslintOutput()', () => {
  it('parses standard eslint JSON output', () => {
    const output = JSON.stringify([
      {
        filePath: '/project/src/utils.js',
        messages: [
          { line: 5, column: 3, severity: 2, message: 'Unexpected var', ruleId: 'no-var' },
          { line: 10, column: 1, severity: 1, message: 'Unused variable', ruleId: 'no-unused-vars' },
        ],
      },
    ]);

    const result = parseEslintOutput(output, '/project');
    expect(result).toHaveLength(2);

    expect(result[0]).toEqual({
      file: 'src/utils.js',
      line: 5,
      column: 3,
      severity: 'error',
      message: 'Unexpected var',
      code: 'no-var',
      source: 'eslint',
    });

    expect(result[1].severity).toBe('warning');
    expect(result[1].code).toBe('no-unused-vars');
  });

  it('handles missing ruleId gracefully', () => {
    const output = JSON.stringify([
      {
        filePath: '/project/src/a.js',
        messages: [
          { line: 1, severity: 2, message: 'Parsing error' },
        ],
      },
    ]);

    const result = parseEslintOutput(output, '/project');
    expect(result).toHaveLength(1);
    expect(result[0]).not.toHaveProperty('code');
    expect(result[0].message).toBe('Parsing error');
  });

  it('handles missing column gracefully', () => {
    const output = JSON.stringify([
      {
        filePath: '/project/src/a.js',
        messages: [
          { line: 1, severity: 2, message: 'msg' },
        ],
      },
    ]);

    const result = parseEslintOutput(output, '/project');
    expect(result[0]).not.toHaveProperty('column');
  });

  it('returns empty array for invalid JSON', () => {
    expect(parseEslintOutput('not json', '/project')).toEqual([]);
  });

  it('returns empty array for empty input', () => {
    expect(parseEslintOutput('', '/project')).toEqual([]);
    expect(parseEslintOutput(null, '/project')).toEqual([]);
    expect(parseEslintOutput(undefined, '/project')).toEqual([]);
  });

  it('returns empty array for non-array JSON', () => {
    expect(parseEslintOutput('{}', '/project')).toEqual([]);
    expect(parseEslintOutput('"hello"', '/project')).toEqual([]);
  });

  it('handles files with no messages', () => {
    const output = JSON.stringify([
      { filePath: '/project/clean.js', messages: [] },
    ]);
    expect(parseEslintOutput(output, '/project')).toEqual([]);
  });

  it('handles missing messages property', () => {
    const output = JSON.stringify([{ filePath: '/project/clean.js' }]);
    expect(parseEslintOutput(output, '/project')).toEqual([]);
  });

  it('handles multiple files', () => {
    const output = JSON.stringify([
      {
        filePath: '/project/a.js',
        messages: [{ line: 1, severity: 2, message: 'err1', ruleId: 'r1' }],
      },
      {
        filePath: '/project/b.js',
        messages: [{ line: 2, severity: 1, message: 'warn1', ruleId: 'r2' }],
      },
    ]);

    const result = parseEslintOutput(output, '/project');
    expect(result).toHaveLength(2);
    expect(result[0].file).toBe('a.js');
    expect(result[1].file).toBe('b.js');
  });

  it('respects MAX_DIAGNOSTICS_PER_SOURCE limit', () => {
    const messages = Array.from({ length: 600 }, (_, i) => ({
      line: i + 1,
      severity: 2,
      message: `msg${i}`,
      ruleId: `rule${i}`,
    }));

    const output = JSON.stringify([{ filePath: '/project/big.js', messages }]);
    const result = parseEslintOutput(output, '/project');
    expect(result.length).toBeLessThanOrEqual(MAX_DIAGNOSTICS_PER_SOURCE);
  });
});

// ---------------------------------------------------------------------------
// addDiagnosticContext()
// ---------------------------------------------------------------------------
describe('addDiagnosticContext()', () => {
  const sampleDiagnostics = [
    { file: 'src/a.ts', line: 1, severity: 'error', message: 'Type error', code: 'TS2345', source: 'tsc' },
    { file: 'src/a.ts', line: 5, severity: 'error', message: 'Type error', code: 'TS2345', source: 'tsc' },
    { file: 'src/b.ts', line: 10, severity: 'warning', message: 'Unused var', code: 'TS6133', source: 'tsc' },
    { file: 'src/c.js', line: 3, severity: 'warning', message: 'No console', code: 'no-console', source: 'eslint' },
  ];

  it('returns structured diagnostic context from array', () => {
    const ctx = addDiagnosticContext(sampleDiagnostics);

    expect(ctx.diagnosticContext).toBeDefined();
    expect(ctx.diagnosticContext.errorCount).toBe(2);
    expect(ctx.diagnosticContext.warningCount).toBe(2);
    expect(ctx.diagnosticContext.hasCriticalErrors).toBe(true);
    expect(ctx.diagnosticContext.affectedFiles).toHaveLength(3);
    expect(ctx.diagnosticContext.affectedFiles).toContain('src/a.ts');
    expect(ctx.diagnosticContext.affectedFiles).toContain('src/b.ts');
    expect(ctx.diagnosticContext.affectedFiles).toContain('src/c.js');
  });

  it('aggregates top issues by frequency', () => {
    const ctx = addDiagnosticContext(sampleDiagnostics);
    const topIssues = ctx.diagnosticContext.topIssues;

    expect(topIssues.length).toBeGreaterThan(0);
    // TS2345: Type error appears twice so should be first
    expect(topIssues[0]).toContain('TS2345');
    expect(topIssues[0]).toContain('x2');
  });

  it('accepts a DiagnosticSummary object', () => {
    const summary = {
      total: 2,
      errors: 1,
      warnings: 1,
      sources: ['tsc'],
      diagnostics: sampleDiagnostics.slice(0, 2),
      collectedAt: Date.now(),
    };

    const ctx = addDiagnosticContext(summary);
    expect(ctx.diagnosticContext.errorCount).toBe(2);
  });

  it('handles empty diagnostics', () => {
    const ctx = addDiagnosticContext([]);
    expect(ctx.diagnosticContext.errorCount).toBe(0);
    expect(ctx.diagnosticContext.warningCount).toBe(0);
    expect(ctx.diagnosticContext.hasCriticalErrors).toBe(false);
    expect(ctx.diagnosticContext.affectedFiles).toEqual([]);
    expect(ctx.diagnosticContext.topIssues).toEqual([]);
  });

  it('handles null/undefined input', () => {
    const ctx = addDiagnosticContext(null);
    expect(ctx.diagnosticContext.errorCount).toBe(0);

    const ctx2 = addDiagnosticContext(undefined);
    expect(ctx2.diagnosticContext.errorCount).toBe(0);
  });

  it('deduplicates affected files', () => {
    const diagnostics = [
      { file: 'src/a.ts', line: 1, severity: 'error', message: 'msg1', source: 'tsc' },
      { file: 'src/a.ts', line: 5, severity: 'error', message: 'msg2', source: 'tsc' },
    ];
    const ctx = addDiagnosticContext(diagnostics);
    expect(ctx.diagnosticContext.affectedFiles).toEqual(['src/a.ts']);
  });

  it('limits top issues to 10', () => {
    const diagnostics = Array.from({ length: 20 }, (_, i) => ({
      file: `src/f${i}.ts`,
      line: 1,
      severity: 'error',
      message: `Unique error ${i}`,
      code: `E${i}`,
      source: 'tsc',
    }));
    const ctx = addDiagnosticContext(diagnostics);
    expect(ctx.diagnosticContext.topIssues.length).toBeLessThanOrEqual(10);
  });
});

// ---------------------------------------------------------------------------
// parseDiagnostic()
// ---------------------------------------------------------------------------
describe('parseDiagnostic()', () => {
  it('normalizes numeric severity', () => {
    const d = parseDiagnostic({ file: 'a.ts', line: 1, severity: 1, message: 'err' });
    expect(d.severity).toBe('error');

    const d2 = parseDiagnostic({ file: 'a.ts', line: 1, severity: 2, message: 'warn' });
    expect(d2.severity).toBe('warning');

    const d3 = parseDiagnostic({ file: 'a.ts', line: 1, severity: 3, message: 'info' });
    expect(d3.severity).toBe('information');

    const d4 = parseDiagnostic({ file: 'a.ts', line: 1, severity: 4, message: 'hint' });
    expect(d4.severity).toBe('hint');
  });

  it('normalizes string severity to lowercase', () => {
    const d = parseDiagnostic({ file: 'a.ts', line: 1, severity: 'ERROR', message: 'err' });
    expect(d.severity).toBe('error');
  });

  it('defaults severity to information for unknown values', () => {
    const d = parseDiagnostic({ file: 'a.ts', line: 1, severity: 99, message: 'msg' });
    expect(d.severity).toBe('information');
  });

  it('ensures line is at least 1 (converts 0-based)', () => {
    const d = parseDiagnostic({ file: 'a.ts', line: 0, severity: 1, message: 'msg' });
    expect(d.line).toBe(1);
  });

  it('includes column only when provided', () => {
    const d1 = parseDiagnostic({ file: 'a.ts', line: 1, severity: 1, message: 'msg' });
    expect(d1).not.toHaveProperty('column');

    const d2 = parseDiagnostic({ file: 'a.ts', line: 1, column: 5, severity: 1, message: 'msg' });
    expect(d2.column).toBe(5);
  });

  it('includes code only when provided', () => {
    const d1 = parseDiagnostic({ file: 'a.ts', line: 1, severity: 1, message: 'msg' });
    expect(d1).not.toHaveProperty('code');

    const d2 = parseDiagnostic({ file: 'a.ts', line: 1, severity: 1, message: 'msg', code: 'TS1234' });
    expect(d2.code).toBe('TS1234');
  });

  it('defaults source to external', () => {
    const d = parseDiagnostic({ file: 'a.ts', line: 1, severity: 1, message: 'msg' });
    expect(d.source).toBe('external');
  });

  it('preserves custom source', () => {
    const d = parseDiagnostic({ file: 'a.ts', line: 1, severity: 1, message: 'msg', source: 'vscode' });
    expect(d.source).toBe('vscode');
  });

  it('handles missing/null fields gracefully', () => {
    const d = parseDiagnostic({ file: null, line: null, severity: null, message: null });
    expect(d.file).toBe('');
    expect(d.line).toBe(1);
    expect(d.severity).toBe('information');
    expect(d.message).toBe('');
  });
});

// ---------------------------------------------------------------------------
// getLastDiagnostics() / resetDiagnostics()
// ---------------------------------------------------------------------------
describe('getLastDiagnostics() / resetDiagnostics()', () => {
  it('returns null when no diagnostics have been collected', () => {
    expect(getLastDiagnostics()).toBeNull();
  });

  it('clears state on reset', () => {
    // We can't easily test collectDiagnostics without real tools,
    // but we can verify reset works
    resetDiagnostics();
    expect(getLastDiagnostics()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// collectDiagnostics() (with non-existent project)
// ---------------------------------------------------------------------------
describe('collectDiagnostics()', () => {
  it('returns empty summary for non-existent project', async () => {
    const result = await collectDiagnostics('/nonexistent/project', {
      timeout: 1000,
    });

    expect(result).toEqual(expect.objectContaining({
      total: 0,
      errors: 0,
      warnings: 0,
      sources: [],
      diagnostics: [],
    }));
    expect(result.collectedAt).toBeGreaterThan(0);
  });

  it('stores result as last diagnostics', async () => {
    await collectDiagnostics('/nonexistent/project', { timeout: 1000 });
    const last = getLastDiagnostics();
    expect(last).not.toBeNull();
    expect(last.total).toBe(0);
  });

  it('can disable tsc collection', async () => {
    const result = await collectDiagnostics('/nonexistent/project', {
      tsc: false,
      timeout: 1000,
    });
    expect(result.total).toBe(0);
  });

  it('can disable eslint collection', async () => {
    const result = await collectDiagnostics('/nonexistent/project', {
      eslint: false,
      timeout: 1000,
    });
    expect(result.total).toBe(0);
  });
});
