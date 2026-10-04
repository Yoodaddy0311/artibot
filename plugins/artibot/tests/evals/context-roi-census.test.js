/**
 * Contract for `scripts/evals/context-roi-census.mjs` - the read-only census of
 * tool-result size next to model usage counters.
 *
 * WHAT THE FIXTURES PROVE: counts are hand-derived from tiny synthetic
 * transcripts (positive controls) and a planted secret never reaches any output
 * (negative control). requestId split lines carry DIFFERENT output_tokens so a
 * first-wins implementation fails.
 *
 * WHAT A GREEN RUN DOES NOT PROVE: that live transcripts have this shape (the
 * fixtures are a handful of lines; real sessions are megabytes), or that the
 * chars/4 heuristic tracks a real tokenizer. No real transcript is used here.
 *
 * @module tests/evals/context-roi-census
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  aggregateLines, collectFiles, main, parseArgs, UsageError,
} from '../../scripts/evals/context-roi-census.mjs';

const SECRET = 'SECRET-TOKEN-do-not-print-9f3a';
const j = (o) => JSON.stringify(o);
const usage = (i, cr, cc, o, extra = {}) => ({
  input_tokens: i, cache_read_input_tokens: cr, cache_creation_input_tokens: cc, output_tokens: o, ...extra,
});
const asst = (content, u, requestId) => j({
  type: 'assistant', ...(requestId ? { requestId } : {}), message: { content, ...(u ? { usage: u } : {}) },
});
const user = (content) => j({ type: 'user', message: { content } });
const toolUse = (id, name) => ({ type: 'tool_use', id, name, input: {} });
const toolResult = (id, content, extra = {}) => ({ type: 'tool_result', tool_use_id: id, content, ...extra });

const byTool = (r, name) => r.tool_results.by_tool.find((t) => t.tool === name);

describe('aggregateLines', () => {
  it('maps two tool ids to two tool names and aggregates bytes per tool', () => {
    const r = aggregateLines([
      asst([toolUse('t1', 'Bash'), toolUse('t2', 'Read')], usage(1, 2, 3, 4), 'r1'),
      user([toolResult('t1', 'aaaa'), toolResult('t2', 'héllo')]), // héllo = 5 chars, 6 bytes
      asst([toolUse('t3', 'Bash')], usage(1, 2, 3, 4), 'r2'),
      user([toolResult('t3', 'bb')]),
    ]);
    expect(byTool(r, 'Bash')).toMatchObject({ results: 2, bytes: 6, chars: 6, est_tokens_heuristic: 2 });
    expect(byTool(r, 'Read')).toMatchObject({ results: 1, bytes: 6, chars: 5, est_tokens_heuristic: 2 });
    expect(r.tool_results.count).toBe(3);
    expect(r.tool_results.bytes).toBe(12);
  });

  it('sums valid usage counters and exposes the ratio components', () => {
    const r = aggregateLines([
      asst([toolUse('t1', 'Bash')], usage(10, 100, 40, 7, { output_tokens_details: { thinking_tokens: 3 } }), 'r1'),
      user([toolResult('t1', 'x'.repeat(80))]),
    ]);
    expect(r.model_usage).toMatchObject({
      usage_rows_measured: 1, input_tokens: 10, cache_read_input_tokens: 100,
      cache_creation_input_tokens: 40, output_tokens: 7, thinking_tokens_reported: 3,
    });
    expect(r.tool_results.new_context_tokens_denominator).toBe(50);
    expect(r.tool_results.est_tokens_heuristic).toBe(20);
    expect(r.tool_results.tool_result_to_new_context_ratio_heuristic).toBe(0.4);
  });

  it('counts a malformed line and keeps going', () => {
    const r = aggregateLines(['{not json', '[1,2]', asst([toolUse('t1', 'Bash')], usage(1, 1, 1, 1), 'r1'), '']);
    expect(r.input.malformed_lines).toBe(2);
    expect(r.model_usage.usage_rows_measured).toBe(1);
  });

  it('puts an unknown tool_use_id in the explicit unknown bucket', () => {
    const r = aggregateLines([user([toolResult('ghost', 'abcd'), { type: 'tool_result', content: 'zz' }])]);
    expect(byTool(r, 'unknown')).toMatchObject({ results: 2, bytes: 6 });
  });

  it('dedupes split lines per requestId by taking the LAST line (differing output_tokens)', () => {
    const r = aggregateLines([
      asst([{ type: 'text', text: 'a' }], usage(5, 50, 20, 2), 'req-1'),
      asst([toolUse('t1', 'Bash')], usage(5, 50, 20, 9), 'req-1'),
      asst([{ type: 'text', text: 'b' }], usage(5, 50, 20, 40), 'req-1'),
      asst([{ type: 'text', text: 'c' }], usage(1, 1, 1, 1)),
      asst([{ type: 'text', text: 'd' }], usage(1, 1, 1, 1)),
    ]);
    expect(r.model_usage.usage_rows_measured).toBe(3);
    expect(r.model_usage.output_tokens).toBe(40 + 1 + 1);
    expect(r.model_usage.input_tokens).toBe(5 + 1 + 1);
  });

  it('sums text blocks of array-form content and counts non-text blocks without sizing them', () => {
    const r = aggregateLines([
      asst([toolUse('t1', 'Read')], usage(1, 1, 1, 1), 'r1'),
      user([toolResult('t1', [
        { type: 'text', text: 'abc' }, { type: 'image', source: { data: 'AAAAAAAAAAAAAAAA' } }, { type: 'text', text: 'de' },
      ])]),
    ]);
    expect(byTool(r, 'Read')).toMatchObject({ bytes: 5, chars: 5, non_text_blocks: 1 });
  });

  it('records is_error only when the key is explicit', () => {
    const r = aggregateLines([
      asst([toolUse('a', 'Bash'), toolUse('b', 'Bash'), toolUse('c', 'Bash')], usage(1, 1, 1, 1), 'r1'),
      user([toolResult('a', 'x', { is_error: true }), toolResult('b', 'x', { is_error: false }), toolResult('c', 'x')]),
    ]);
    expect(byTool(r, 'Bash')).toMatchObject({ is_error_true: 1, is_error_false: 1, is_error_absent: 1 });
  });

  it('distinguishes a measured zero from a missing usage key', () => {
    const missing = { input_tokens: 1, cache_read_input_tokens: 1, output_tokens: 1 };
    const r = aggregateLines([
      asst([{ type: 'text', text: 'a' }], usage(0, 0, 0, 0), 'r1'),
      asst([{ type: 'text', text: 'b' }], missing, 'r2'),
    ]);
    expect(r.model_usage.usage_rows_measured).toBe(1);
    expect(r.model_usage.usage_rows_missing_required_keys).toBe(1);
    expect(r.model_usage.input_tokens).toBe(0);
    expect(r.tool_results.tool_result_to_new_context_ratio_heuristic).toBeNull();
  });

  it('counts a repeated tool_use_id result once', () => {
    const r = aggregateLines([
      asst([toolUse('t1', 'Bash')], usage(1, 1, 1, 1), 'r1'),
      user([toolResult('t1', 'abcd')]),
      user([toolResult('t1', 'abcd')]),
    ]);
    expect(r.tool_results.count).toBe(1);
    expect(r.input.duplicate_tool_results_skipped).toBe(1);
  });

  it('ignores other top-level types and is deterministic', () => {
    const lines = [
      j({ type: 'attachment', message: { content: [toolResult('t1', 'zzzz')] } }),
      asst([toolUse('t1', 'Bash'), toolUse('t2', 'Grep')], usage(1, 1, 1, 1), 'r1'),
      user([toolResult('t2', 'ab'), toolResult('t1', 'ab')]),
    ];
    const a = aggregateLines(lines);
    const b = aggregateLines([...lines]);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.tool_results.count).toBe(2);
    expect(a.tool_results.by_tool.map((t) => t.tool)).toEqual(['Bash', 'Grep']); // equal bytes -> name order
    expect(Object.keys(a)).toEqual(['schema', 'input', 'model_usage', 'tool_results', 'caveats']);
  });

  it('sanitizes odd tool names instead of echoing them', () => {
    const r = aggregateLines([
      asst([toolUse('t1', `weird name ${SECRET}`)], usage(1, 1, 1, 1), 'r1'),
      user([toolResult('t1', 'ab')]),
    ]);
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(byTool(r, 'other')).toBeDefined();
  });
});

describe('CLI', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), 'roi-census-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const run = async (argv) => {
    let stdout = '';
    let stderr = '';
    const code = await main(argv, { stdout: (s) => { stdout += s; }, stderr: (s) => { stderr += s; } });
    return { code, stdout, stderr };
  };
  const body = [
    asst([toolUse('t1', 'Bash')], usage(2, 4, 6, 8), 'r1'),
    user([toolResult('t1', `output ${SECRET}`)]),
    'garbage line',
  ].join('\n');

  it('never renders tool-result content (json and pretty)', async () => {
    writeFileSync(path.join(dir, 's1.jsonl'), body);
    for (const extra of [[], ['--pretty']]) {
      const { code, stdout, stderr } = await run(['--dir', dir, ...extra]);
      expect(code).toBe(0);
      expect(stdout).not.toContain(SECRET);
      expect(stderr).not.toContain(SECRET);
      expect(stdout).not.toContain('s1.jsonl');
    }
    const { stdout } = await run(['--dir', dir]);
    const r = JSON.parse(stdout);
    expect(r.input).toMatchObject({ files_scanned: 1, malformed_lines: 1 });
    expect(byTool(r, 'Bash').results).toBe(1);
  });

  it('reads the subagents folder and does not double count the same file', async () => {
    const main1 = path.join(dir, 's1.jsonl');
    writeFileSync(main1, body);
    mkdirSync(path.join(dir, 's1', 'subagents'), { recursive: true });
    writeFileSync(path.join(dir, 's1', 'subagents', 'agent-a.jsonl'), asst([toolUse('x1', 'Read')], usage(1, 1, 1, 1), 'rx') + '\n' + user([toolResult('x1', 'ab')]));
    const { stdout } = await run(['--dir', dir, '--transcript', main1, '--dir', dir]);
    const r = JSON.parse(stdout);
    expect(r.input).toMatchObject({ files_scanned: 2, main_files: 1, subagent_files: 1 });
    expect(r.tool_results.count).toBe(2);
    expect(collectFiles({ transcripts: [main1, main1], dirs: [dir] }).files).toHaveLength(2);
  });

  it('counts missing inputs without aborting and rejects bad usage', async () => {
    writeFileSync(path.join(dir, 's1.jsonl'), body);
    const { code, stdout } = await run(['--dir', dir, '--transcript', path.join(dir, 'nope.jsonl')]);
    expect(code).toBe(0);
    expect(JSON.parse(stdout).input.missing_inputs).toBe(1);
    expect((await run([])).code).toBe(2);
    expect((await run(['--bogus'])).code).toBe(2);
    const none = await run(['--transcript', path.join(dir, 'nope.jsonl')]);
    expect(none.code).toBe(2);
    expect(none.stdout).toBe('');
    expect(none.stderr).toContain('no readable transcript');
    expect(() => parseArgs(['--dir'])).toThrow(UsageError);
  });
});
