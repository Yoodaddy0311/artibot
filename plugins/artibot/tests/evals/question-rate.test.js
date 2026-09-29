/**
 * Contract for `scripts/evals/question-rate.mjs` - the read-only census of how
 * often the model asks the owner a question (V5-BACKLOG SH-09).
 *
 * WHAT THE FIXTURES PROVE. Each transcript is built in a temp directory with
 * KNOWN counts (N ask calls, M typed prompts, K questions), so the expected
 * numbers below are hand-derived from the fixture, not read back from the tool.
 * Positive controls: the counts come out exact. Negative controls: text that
 * merely MENTIONS `AskUserQuestion` (prompt, assistant prose, tool result), a
 * near-miss tool name, a tool_use in the wrong entry type, and a sidechain
 * call add nothing - which is what separates a JSON parse from a text search.
 *
 * WHAT A GREEN RUN HERE DOES NOT PROVE (rules section 9):
 *  - That the live transcript shape matches these fixtures. The fixtures are a
 *    handful of lines; the live input is ~150,000 lines / ~288 MB. The live
 *    numbers are in the SH-09 evidence document, produced by a real run.
 *  - That the typed-prompt classifier is right about every injected turn the
 *    host can emit. Unknown shapes fall into `human_unlabeled` by design and
 *    are visible in `prompts.byClass`.
 *  - That any measured difference between windows is caused by a change.
 *
 * Home isolation: the CLI cases run with HOME/USERPROFILE pointed at a temp
 * directory and the session-id env vars blanked, so nothing here reads the real
 * home directory or inherits the host session.
 *
 * @module tests/evals/question-rate
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  analyzeTranscripts, buildWindows, classifyPromptText, classifyUserEntry, collectFiles, parseArgs,
  parseWindowSpec, poissonScoreInterval, slugForCwd, UsageError, wilsonInterval, windowIndex,
} from '../../scripts/evals/question-rate.mjs';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(PLUGIN_ROOT, 'scripts', 'evals', 'question-rate.mjs');
const T0 = Date.UTC(2026, 8, 21, 0, 0, 0);
const at = (min) => new Date(T0 + min * 60_000).toISOString();

let tmp;
let uid = 0;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'qrate-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/* ------------------------------------------------------------ entry builders */

const base = (type, min, extra) => ({ type, uuid: `u-${++uid}`, timestamp: at(min), sessionId: 'sess-secret-777', ...extra });
const userText = (text, min, extra = {}) => base('user', min, {
  entrypoint: 'cli', message: { role: 'user', content: text }, ...extra,
});
const human = (text, min, extra = {}) => userText(text, min, { origin: { kind: 'human' }, permissionMode: 'auto', ...extra });
const toolResult = (id, min, isError = false, body = 'ok') => base('user', min, {
  entrypoint: 'cli', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: body, is_error: isError }] },
});
const asst = (msgId, min, blocks, extra = {}) => base('assistant', min, {
  message: { id: msgId, role: 'assistant', content: blocks }, ...extra,
});
const askBlock = (id, nQuestions) => ({
  type: 'tool_use', id, name: 'AskUserQuestion',
  input: { questions: Array.from({ length: nQuestions }, (_, i) => ({ question: `SECRET-QUESTION-TEXT-${i}` })) },
});
const textBlock = (text) => ({ type: 'text', text });

function writeJsonl(dir, name, entries, rawLines = []) {
  mkdirSync(dir, { recursive: true });
  const body = [...entries.map((e) => JSON.stringify(e)), ...rawLines].join('\n');
  writeFileSync(path.join(dir, name), `${body}\n`, 'utf-8');
}

async function run(dir, windowSpecs = []) {
  const { files, missingDirs } = collectFiles([dir]);
  const windows = buildWindows(windowSpecs.map(parseWindowSpec));
  return analyzeTranscripts({ files, windows, measuredAt: '2026-09-29T00:00:00.000Z', dirs: [dir], missingDirs });
}

/* ------------------------------------------------------------------ statistics */

describe('interval helpers', () => {
  it('wilson: known values', () => {
    expect(wilsonInterval(0, 10)).toEqual([0, 0.2775]);
    expect(wilsonInterval(5, 10)).toEqual([0.2366, 0.7634]);
    expect(wilsonInterval(0, 0)).toBeNull();
  });

  it('poisson score interval: k = 0 has lower bound 0 and upper bound z^2 per unit', () => {
    const [lo, hi] = poissonScoreInterval(0, 100, 100);
    expect(lo).toBe(0);
    expect(hi).toBeCloseTo(3.8415, 3);
    expect(poissonScoreInterval(3, 0)).toBeNull();
    const [l2, h2] = poissonScoreInterval(10, 100, 100);
    expect(l2).toBeLessThan(10);
    expect(h2).toBeGreaterThan(10);
  });
});

/* ------------------------------------------------------------------ windows */

describe('windows', () => {
  it('parses specs and builds start-inclusive / end-exclusive windows', () => {
    const specs = [parseWindowSpec('b1=2026-09-21T01:00:00Z'), parseWindowSpec('b2=2026-09-21T02:00:00Z')];
    const w = buildWindows(specs);
    expect(w.map((x) => x.name)).toEqual(['before-b1', 'b1', 'b2']);
    const b1 = Date.parse('2026-09-21T01:00:00Z');
    expect(windowIndex(b1 - 1, w)).toBe(0);
    expect(windowIndex(b1, w)).toBe(1);
    expect(windowIndex(Date.parse('2026-09-21T02:00:00Z'), w)).toBe(2);
  });

  it('no specs = one window called all', () => {
    expect(buildWindows([]).map((x) => x.name)).toEqual(['all']);
  });

  it('rejects bad specs (fail closed)', () => {
    expect(() => parseWindowSpec('b1')).toThrow(UsageError);
    expect(() => parseWindowSpec('b1=2026-09-21T01:00:00')).toThrow(UsageError); // no zone
    expect(() => parseWindowSpec('b 1=2026-09-21T01:00:00Z')).toThrow(UsageError);
    const a = parseWindowSpec('a=2026-09-21T02:00:00Z');
    const b = parseWindowSpec('b=2026-09-21T01:00:00Z');
    expect(() => buildWindows([a, b])).toThrow(UsageError); // not ascending
    expect(() => buildWindows([a, a])).toThrow(UsageError); // duplicate
  });

  it('derives the host directory name from a project root', () => {
    expect(slugForCwd('C:\\Users\\HeechangLee\\Desktop\\AI\\Artibot')).toBe('C--Users-HeechangLee-Desktop-AI-Artibot');
  });
});

/* -------------------------------------------------------------- classification */

describe('classifyUserEntry', () => {
  const cls = (e) => classifyUserEntry(e);
  it('separates typed prompts from everything the harness injects', () => {
    expect(cls(human('hello', 0))).toBe('human_explicit');
    expect(cls(userText('hello', 0))).toBe('human_unlabeled');
    expect(cls(toolResult('t', 0))).toBe('tool_result');
    expect(cls(userText('x', 0, { isMeta: true }))).toBe('meta');
    expect(cls(userText('x', 0, { isCompactSummary: true }))).toBe('compact_summary');
    expect(cls(userText('<task-notification>done</task-notification>', 0))).toBe('task_notification');
    expect(cls(userText('x', 0, { origin: { kind: 'task-notification' } }))).toBe('task_notification');
    expect(cls(userText('x', 0, { origin: { kind: 'peer' } }))).toBe('peer_message');
    expect(cls(userText('<teammate-message id="a">hi</teammate-message>', 0))).toBe('peer_message');
    expect(cls(userText('<command-name>/verify</command-name>', 0))).toBe('command');
    expect(cls(userText('<local-command-stdout>ok</local-command-stdout>', 0))).toBe('local_command');
    expect(cls(userText('[Request interrupted by user]', 0))).toBe('interrupt');
    expect(cls(userText('x', 0, { scheduledTaskId: 's1' }))).toBe('scheduled');
    expect(cls(userText('x', 0, { origin: { kind: 'some-future-kind' } }))).toBe('other_origin');
    expect(cls({ message: { content: [{ type: 'text', text: 'typed in an array' }] }, origin: { kind: 'human' } })).toBe('human_explicit');
    expect(cls(userText('   ', 0))).toBe('other');
  });

  it('classifyPromptText: an unknown origin kind is never a typed prompt', () => {
    expect(classifyPromptText('hi', 'channel')).toBe('other_origin');
    expect(classifyPromptText('hi', null)).toBe('human_unlabeled');
  });
});

/* ------------------------------------------------- positive control: known N / M */

describe('positive control - known counts', () => {
  it('one transcript with M = 6 typed prompts and N = 4 ask calls (10 questions) reads back exactly', async () => {
    writeJsonl(tmp, 'known.jsonl', [
      human('p1', 0), asst('m1', 1, [askBlock('a1', 1)]), toolResult('a1', 2),
      human('p2', 3), asst('m2', 4, [textBlock('no question here')]),
      human('p3', 5), asst('m3', 6, [askBlock('a2', 2), askBlock('a3', 3)]), toolResult('a2', 7), toolResult('a3', 7, true),
      human('p4', 8), human('p5', 9), asst('m4', 10, [askBlock('a4', 4)]), toolResult('a4', 11),
      userText('<command-name>/verify</command-name>', 12),
      userText('noise', 13, { origin: { kind: 'task-notification' } }),
      userText('noise', 14, { origin: { kind: 'peer' } }),
      userText('noise', 15, { isMeta: true }),
      userText('[Request interrupted by user]', 16),
      userText('<local-command-stdout>x</local-command-stdout>', 17),
    ]);
    const r = await run(tmp);
    const w = r.windows[0];
    expect(r.ok).toBe(true);
    expect(w.name).toBe('all');
    expect(w.prompts.typedBroad).toBe(6); // p1..p5 + the /verify command
    expect(w.prompts.typedStrict).toBe(5);
    expect(w.prompts.nonToolResultUserTurns).toBe(11); // 6 typed + task-notification, peer, meta, interrupt, local-command
    expect(w.rates.callsPer100NonToolResultUserTurns.prompts).toBe(11);
    expect(w.asks.calls).toBe(4);
    expect(w.asks.questions).toBe(10);
    expect(w.asks.answered).toBe(3);
    expect(w.asks.errored).toBe(1);
    expect(w.asks.unresolved).toBe(0);
    expect(w.asks.promptsWithAsk).toBe(3); // p1, p3, p5 (a4 follows p5)
    expect(w.rates.callsPer100TypedPrompts.value).toBeCloseTo(66.6667, 3);
    expect(w.rates.promptsWithAskShare.value).toBe(0.5);
    expect(w.turns.assistantTurns).toBe(4);
    expect(w.prompts.byClass.tool_result).toBe(4);
    expect(w.prompts.byClass.task_notification).toBe(1);
    expect(w.prompts.commandsByName.other).toBe(1);
    expect(w.sessions.active).toBe(1);
  });

  it('a window with no typed prompt reports null rates, not 0 or NaN', async () => {
    writeJsonl(tmp, 'noprompt.jsonl', [asst('m1', 1, [askBlock('a1', 1)])]);
    const w = (await run(tmp)).windows[0];
    expect(w.asks.calls).toBe(1);
    expect(w.asks.callsBeforeAnyTypedPrompt).toBe(1);
    expect(w.rates.callsPer100TypedPrompts.value).toBeNull();
    expect(w.rates.callsPer100TypedPrompts.ci95).toBeNull();
    expect(w.rates.promptsWithAskShare.value).toBeNull();
  });
});

/* ---------------------------------------------- negative controls: parse, not grep */

describe('negative controls - mentions are not calls', () => {
  it('counts zero calls for every look-alike, while a raw text search would count many', async () => {
    const entries = [
      human('please use AskUserQuestion for this SECRET-PROMPT-TEXT', 0),
      asst('m1', 1, [textBlock('I could call AskUserQuestion here'), { type: 'tool_use', id: 'x1', name: 'AskUserQuestionExtra', input: {} }]),
      asst('m2', 2, [{ type: 'tool_use', id: 'x2', name: 'askuserquestion', input: {} }]),
      base('user', 3, { entrypoint: 'cli', message: { role: 'user', content: [{ type: 'tool_use', id: 'x3', name: 'AskUserQuestion', input: { questions: [{}] } }] } }),
      toolResult('x1', 4, false, 'tool listing mentions AskUserQuestion twice: AskUserQuestion'),
      asst('m3', 5, [askBlock('side-1', 2)], { isSidechain: true }),
    ];
    writeJsonl(tmp, 'neg.jsonl', entries);
    const rawMentions = readFileSync(path.join(tmp, 'neg.jsonl'), 'utf8').split('AskUserQuestion').length - 1;
    expect(rawMentions).toBeGreaterThanOrEqual(6); // a text search would report all of these
    const r = await run(tmp);
    expect(r.windows[0].asks.calls).toBe(0);
    expect(r.windows[0].asks.questions).toBe(0);
    expect(r.windows[0].prompts.typedBroad).toBe(1);
    expect(r.input.sidechainEntriesSkipped).toBe(1);
  });

  it('a call with no questions array is still a call, and is flagged', async () => {
    writeJsonl(tmp, 'q0.jsonl', [
      human('p', 0), asst('m1', 1, [{ type: 'tool_use', id: 'a1', name: 'AskUserQuestion', input: {} }]),
    ]);
    const w = (await run(tmp)).windows[0];
    expect(w.asks.calls).toBe(1);
    expect(w.asks.questions).toBe(0);
    expect(w.asks.callsWithoutQuestionsArray).toBe(1);
  });
});

/* ------------------------------------------------------------- dedup and damage */

describe('input hygiene', () => {
  it('counts an entry copied into a later file once', async () => {
    const original = [human('p1', 0), asst('m1', 1, [askBlock('a1', 2)])];
    writeJsonl(tmp, 'a-original.jsonl', original);
    writeJsonl(tmp, 'b-resumed.jsonl', [...original, human('p2', 5)]);
    const r = await run(tmp);
    expect(r.input.files).toBe(2);
    expect(r.input.duplicateEntriesSkipped).toBe(2);
    expect(r.windows[0].asks.calls).toBe(1);
    expect(r.windows[0].prompts.typedBroad).toBe(2);
  });

  it('survives a torn line and an undated entry, and reports both', async () => {
    writeJsonl(tmp, 'damaged.jsonl', [
      human('p1', 0), { type: 'user', uuid: 'u-undated', message: { role: 'user', content: 'no timestamp' } },
    ], ['{"type":"user","uuid":"torn', '']);
    const r = await run(tmp);
    expect(r.input.parseFailures).toBe(1);
    expect(r.input.undatedEntries).toBe(1);
    expect(r.windows[0].prompts.typedBroad).toBe(1);
  });

  it('no transcripts => ok:false, never invented numbers', async () => {
    const r = await run(path.join(tmp, 'does-not-exist'));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no-transcripts');
    expect(r.input.missingDirs).toHaveLength(1);
  });

  it('ignores files below the top level (sub-agent transcripts) and non-jsonl files', async () => {
    writeJsonl(tmp, 'main.jsonl', [human('p1', 0)]);
    writeJsonl(path.join(tmp, 'sess', 'subagents'), 'agent-1.jsonl', [human('sub', 0), asst('s', 1, [askBlock('s1', 1)])]);
    writeFileSync(path.join(tmp, 'notes.txt'), 'x', 'utf-8');
    const r = await run(tmp);
    expect(r.input.files).toBe(1);
    expect(r.windows[0].asks.calls).toBe(0);
  });
});

/* -------------------------------------------------------- windows end to end */

describe('windowed census', () => {
  async function buildFixture() {
    // s1: interactive, window 0. 4 typed (P1 P2 P3 + /verify), 3 calls (7 questions), one error result.
    writeJsonl(tmp, 's1.jsonl', [
      human('P1', 0), asst('m1', 1, [askBlock('A1', 2)]), toolResult('A1', 2),
      human('P2', 3), asst('m2', 4, [textBlock('plain')]),
      userText('P3', 5), asst('m3', 6, [askBlock('A2', 4), askBlock('A3', 1)]), toolResult('A2', 7, true), toolResult('A3', 8),
      userText('n', 9, { origin: { kind: 'task-notification' } }), userText('n', 10, { origin: { kind: 'peer' } }),
      userText('n', 11, { isMeta: true }), userText('<command-name>/verify</command-name>', 12),
      userText('[Request interrupted by user]', 13), userText('<local-command-stdout>x</local-command-stdout>', 14),
    ]);
    // s2: window 1, orchestrated by an Agent spawn. 2 typed, 1 call (1 question).
    writeJsonl(tmp, 's2.jsonl', [
      human('Q1', 70), asst('m4', 71, [{ type: 'tool_use', id: 'T1', name: 'Agent', input: {} }]), toolResult('T1', 72),
      human('Q2', 80), asst('m5', 81, [askBlock('B1', 1)]), toolResult('B1', 82),
    ]);
    // s3: window 2, headless (sdk entrypoint). 1 typed, 0 calls.
    writeJsonl(tmp, 's3.jsonl', [
      userText('H1', 150, { entrypoint: 'sdk-cli' }), asst('m6', 151, [textBlock('answer')]),
    ]);
    // s4: straddles both boundaries. prompt in w0, its ask in w1 (3 questions, no result), prompt in w2.
    writeJsonl(tmp, 's4.jsonl', [
      human('S1', 50), asst('m7', 65, [askBlock('C1', 3)]), human('S2', 125),
    ]);
    return run(tmp, ['b1=2026-09-21T01:00:00Z', 'b2=2026-09-21T02:00:00Z']);
  }

  it('assigns each entry to the window of its own timestamp, with exact counts', async () => {
    const r = await buildFixture();
    const [w0, w1, w2] = r.windows;
    expect([w0.name, w1.name, w2.name]).toEqual(['before-b1', 'b1', 'b2']);
    expect(w0.startInclusive).toBeNull();
    expect(w0.endExclusive).toBe('2026-09-21T01:00:00.000Z');
    expect(w2.endExclusive).toBeNull();

    expect(w0.sessions.active).toBe(2);
    expect(w0.sessions.started).toBe(2);
    expect(w0.prompts.typedBroad).toBe(5); // s1: P1 P2 P3 /verify, s4: S1
    expect(w0.prompts.typedStrict).toBe(3); // P1 P2 S1
    expect(w0.asks.calls).toBe(3);
    expect(w0.asks.questions).toBe(7);
    expect(w0.asks.answered).toBe(2);
    expect(w0.asks.errored).toBe(1);
    expect(w0.asks.unresolved).toBe(0);
    expect(w0.asks.promptsWithAsk).toBe(3); // P1, P3, and S1 (its ask lands in w1 but is credited to the prompt's window)
    expect(w0.rates.callsPer100TypedPrompts.value).toBe(60);
    expect(w0.rates.callsPer100TypedPrompts.ci95[0]).toBeLessThan(60);
    expect(w0.rates.callsPer100TypedPrompts.ci95[1]).toBeGreaterThan(60);
    expect(w0.rates.promptsWithAskShare.value).toBe(0.6);
    expect(w0.byMode.interactive.sessions).toBe(2);

    expect(w1.sessions.active).toBe(2); // s2 and s4 (assistant entry only)
    expect(w1.prompts.typedBroad).toBe(2);
    expect(w1.asks.calls).toBe(2); // B1 and C1
    expect(w1.asks.questions).toBe(4);
    expect(w1.asks.answered).toBe(1);
    expect(w1.asks.unresolved).toBe(1); // C1 has no result entry
    expect(w1.asks.promptsWithAsk).toBe(1); // Q2 only
    expect(w1.turns.agentSpawns).toBe(1);
    expect(w1.byMode.orchestrated.sessions).toBe(1);
    expect(w1.byMode.interactive.sessions).toBe(1);

    expect(w2.sessions.active).toBe(2);
    expect(w2.prompts.typedBroad).toBe(2); // H1 (unlabeled) + S2
    expect(w2.prompts.typedStrict).toBe(1);
    expect(w2.asks.calls).toBe(0);
    expect(w2.rates.callsPer100TypedPrompts.value).toBe(0);
    expect(w2.byMode.headless.sessions).toBe(1);
  });

  it('reports sessions that straddle a boundary and the by-session-start view', async () => {
    const r = await buildFixture();
    expect(r.boundaries.map((b) => b.sessionsStraddling)).toEqual([1, 1]);
    expect(r.boundaries[0].between).toEqual(['before-b1', 'b1']);
    expect(r.boundaries[0].at).toBe('2026-09-21T01:00:00.000Z');
    const s = r.sensitivity.bySessionStart;
    expect(s.map((x) => [x.sessions, x.typedBroad, x.calls])).toEqual([[2, 6, 4], [1, 2, 1], [1, 1, 0]]);
  });

  it('adds up: window calls sum to the whole-input calls', async () => {
    const r = await buildFixture();
    const whole = await run(tmp);
    const sum = (k) => r.windows.reduce((t, w) => t + w.asks[k], 0);
    expect(sum('calls')).toBe(whole.windows[0].asks.calls);
    expect(sum('questions')).toBe(whole.windows[0].asks.questions);
    expect(r.windows.reduce((t, w) => t + w.prompts.typedBroad, 0)).toBe(whole.windows[0].prompts.typedBroad);
  });
});

/* ------------------------------------------------------------ queued prompts */

describe('queued_command attachments', () => {
  it('counts a typed prompt delivered only as an attachment, but not one that is also a user entry', async () => {
    const queued = (text, min, extra = {}) => base('attachment', min, {
      attachment: { type: 'queued_command', prompt: text, commandMode: 'prompt', ...extra },
    });
    writeJsonl(tmp, 'q.jsonl', [
      human('typed while idle', 0), queued('typed while idle', 1), // same text also a user entry => duplicate
      queued('typed while busy', 2), // only as attachment => extra prompt
      queued('x', 3, { origin: { kind: 'task-notification' } }), // not typed
      asst('m1', 4, [textBlock('ok')]),
    ]);
    const w = (await run(tmp)).windows[0];
    expect(w.prompts.typedBroad).toBe(1);
    expect(w.prompts.queuedTypedNotInUserEntries).toBe(1);
    expect(w.rates.callsPer100TypedPromptsPlusQueued.prompts).toBe(2);
    expect(w.prompts.queuedAttachments.byClass.task_notification).toBe(1);
  });
});

/* ---------------------------------------------------- privacy and read-only */

function snapshot(dir) {
  const out = [];
  const walk = (d) => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else out.push([path.relative(dir, p), statSync(p).size, statSync(p).mtimeMs, createHash('sha1').update(readFileSync(p)).digest('hex')]);
    }
  };
  walk(dir);
  return out.sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

describe('privacy and read-only', () => {
  it('prints no prompt text, question text, session id or file name', async () => {
    writeJsonl(tmp, 'secret-session-file.jsonl', [
      human('SECRET-PROMPT-TEXT', 0, { permissionMode: 'SECRET PERMISSION TEXT with spaces' }),
      userText('<command-name>/SECRET-COMMAND</command-name><command-args>SECRET-ARGS</command-args>', 1),
      asst('m1', 2, [askBlock('a1', 2)]),
      userText('x', 3, { entrypoint: 'SECRET ENTRY POINT' }),
    ]);
    const text = JSON.stringify(await run(tmp));
    for (const secret of ['SECRET-PROMPT-TEXT', 'SECRET-QUESTION-TEXT', 'sess-secret-777', 'secret-session-file', 'SECRET-COMMAND', 'SECRET-ARGS', 'SECRET PERMISSION', 'SECRET ENTRY']) {
      expect(text).not.toContain(secret);
    }
  });

  it('leaves the transcript directory byte-identical (bytes, size, mtime, listing)', async () => {
    writeJsonl(tmp, 'a.jsonl', [human('p', 0), asst('m1', 1, [askBlock('a1', 1)])]);
    writeJsonl(path.join(tmp, 'sess', 'subagents'), 'agent-1.jsonl', [human('p', 0)]);
    const before = snapshot(tmp);
    await run(tmp, ['w=2026-09-21T00:30:00Z']);
    const r = spawnSync(process.execPath, [CLI, '--dir', tmp], { encoding: 'utf8', env: cleanEnv() });
    expect(r.status).toBe(0);
    expect(snapshot(tmp)).toEqual(before);
  });

  it('source opens files for reading only', () => {
    const src = readFileSync(CLI, 'utf8');
    const banned = /\b(writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|mkdir|mkdirSync|rmSync|unlink|unlinkSync|rename|renameSync|copyFile|copyFileSync|truncate|utimes|chmod|symlink)\b/;
    expect(src).not.toMatch(banned);
  });
});

/* ------------------------------------------------------------------ CLI process */

function cleanEnv(extra = {}) {
  return {
    ...process.env, CLAUDE_CODE_SESSION_ID: '', CLAUDE_SESSION_ID: '', HOME: tmp, USERPROFILE: tmp, ...extra,
  };
}

describe('CLI process', () => {
  it('prints one JSON document with the promised top-level keys and nothing on stderr', () => {
    writeJsonl(tmp, 'a.jsonl', [human('p', 0), asst('m1', 1, [askBlock('a1', 1)])]);
    const r = spawnSync(process.execPath, [CLI, '--dir', tmp, '--window', 'w=2026-09-21T00:00:30Z', '--now', '2026-09-29T00:00:00Z'], { encoding: 'utf8', env: cleanEnv() });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    const out = JSON.parse(r.stdout);
    expect(Object.keys(out)).toEqual(['schema', 'ok', 'reason', 'measuredAt', 'metric', 'input', 'boundaries', 'windows', 'sensitivity', 'blindSpots']);
    expect(out.measuredAt).toBe('2026-09-29T00:00:00.000Z');
    expect(out.windows.map((w) => w.name)).toEqual(['before-w', 'w']);
    expect(out.blindSpots.length).toBeGreaterThanOrEqual(5);
  });

  it('usage errors exit 2 with empty stdout', () => {
    for (const args of [['--nope'], ['--window'], ['--window', 'x=2026-09-21T00:00:00'], ['--slug', '../..'], ['--now', 'yesterday']]) {
      const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: cleanEnv() });
      expect(r.status, args.join(' ')).toBe(2);
      expect(r.stdout).toBe('');
      expect(r.stderr).toContain('usage:');
    }
  });

  it('a missing directory exits 0 with ok:false', () => {
    const r = spawnSync(process.execPath, [CLI, '--dir', path.join(tmp, 'nope')], { encoding: 'utf8', env: cleanEnv() });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).ok).toBe(false);
  });

  it('default lookup reads <home>/.claude/projects/<slug> of the ENVIRONMENT home, and --with-worktrees adds siblings', () => {
    const cwd = path.join(tmp, 'proj-x');
    const slug = slugForCwd(cwd);
    const projects = path.join(tmp, '.claude', 'projects');
    writeJsonl(path.join(projects, slug), 'main.jsonl', [human('p', 0)]);
    writeJsonl(path.join(projects, `${slug}--claude-worktrees-agent-1`), 'wt.jsonl', [human('p', 0), human('q', 1)]);
    writeJsonl(path.join(projects, `${slug}-other`), 'other.jsonl', [human('p', 0)]);
    const plain = JSON.parse(spawnSync(process.execPath, [CLI, '--cwd', cwd], { encoding: 'utf8', env: cleanEnv() }).stdout);
    expect(plain.input.files).toBe(1);
    expect(plain.windows[0].prompts.typedBroad).toBe(1);
    const withWt = JSON.parse(spawnSync(process.execPath, [CLI, '--cwd', cwd, '--with-worktrees'], { encoding: 'utf8', env: cleanEnv() }).stdout);
    expect(withWt.input.files).toBe(2);
    expect(withWt.windows[0].prompts.typedBroad).toBe(3);
  });

  it('parseArgs is exported and strict', () => {
    expect(parseArgs(['--dir', 'x', '--with-worktrees']).withWorktrees).toBe(true);
    expect(() => parseArgs(['--dir'])).toThrow(UsageError);
  });
});
