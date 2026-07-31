import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  emptyAttribution,
  pickPrimary,
  resolveTranscriptModels,
  toRecordFields,
} from '../../lib/learning/model-identity.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const dirs = [];

/**
 * Write a transcript fixture and return its path.
 * @param {object[]} entries - Raw JSONL entries (objects, one per line)
 * @param {string} [trailing] - Extra raw text appended verbatim
 */
function makeTranscript(entries, trailing = '') {
  const dir = mkdtempSync(path.join(tmpdir(), 'artibot-model-id-'));
  dirs.push(dir);
  const file = path.join(dir, 'session.jsonl');
  writeFileSync(file, entries.map(e => JSON.stringify(e)).join('\n') + trailing, 'utf-8');
  return file;
}

const assistant = (model, extra = {}) => ({
  type: 'assistant',
  message: { model, content: [] },
  ...extra,
});

/**
 * Build the real on-disk layout Claude Code uses:
 *   <dir>/session.jsonl                  (main thread)
 *   <dir>/session/subagents/<name>.jsonl (one file per subagent)
 * @param {object[]} mainEntries
 * @param {Record<string, object[]>} subagents - filename -> entries
 * @returns {string} path to the main transcript
 */
function makeSession(mainEntries, subagents = {}) {
  const file = makeTranscript(mainEntries);
  const subDir = path.join(file.replace(/\.jsonl$/, ''), 'subagents');
  mkdirSync(subDir, { recursive: true });
  for (const [name, entries] of Object.entries(subagents)) {
    writeFileSync(
      path.join(subDir, `${name}.jsonl`),
      entries.map(e => JSON.stringify(e)).join('\n'),
      'utf-8',
    );
  }
  return file;
}

afterEach(() => {
  while (dirs.length > 0) {
    rmSync(dirs.pop(), { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Unit: pickPrimary
// ---------------------------------------------------------------------------

describe('model-identity/pickPrimary', () => {
  it('최다 사용 모델을 고른다', () => {
    expect(pickPrimary({ a: 1, b: 5, c: 3 })).toBe('b');
  });

  it('빈 맵은 null', () => {
    expect(pickPrimary({})).toBeNull();
    expect(pickPrimary(undefined)).toBeNull();
  });

  it('동점이면 사전순으로 안정적으로 결정된다', () => {
    expect(pickPrimary({ zeta: 4, alpha: 4 })).toBe('alpha');
    expect(pickPrimary({ alpha: 4, zeta: 4 })).toBe('alpha');
  });
});

// ---------------------------------------------------------------------------
// Unit: resolveTranscriptModels
// ---------------------------------------------------------------------------

describe('model-identity/resolveTranscriptModels', () => {
  it('메인 스레드 모델을 집계하고 primary 를 정한다', async () => {
    const file = makeTranscript([
      assistant('claude-opus-5'),
      assistant('claude-opus-5'),
      assistant('claude-fable-5'),
    ]);
    const got = await resolveTranscriptModels(file);
    expect(got.source).toBe('transcript');
    expect(got.primary).toBe('claude-opus-5');
    expect(got.mix).toEqual({ 'claude-opus-5': 2, 'claude-fable-5': 1 });
    expect(got.turns).toBe(3);
  });

  it('서브에이전트 턴은 별도 집계되어 primary 를 오염시키지 않는다', async () => {
    const file = makeTranscript([
      assistant('claude-opus-5'),
      assistant('claude-fable-5', { isSidechain: true }),
      assistant('claude-fable-5', { isSidechain: true }),
      assistant('claude-fable-5', { isSidechain: true }),
    ]);
    const got = await resolveTranscriptModels(file);
    expect(got.primary).toBe('claude-opus-5');
    expect(got.mix).toEqual({ 'claude-opus-5': 1 });
    expect(got.sidechainMix).toEqual({ 'claude-fable-5': 3 });
  });

  it('effort 를 집계하고 누락은 unspecified 로 센다', async () => {
    const file = makeTranscript([
      assistant('claude-opus-5', { effort: 'high' }),
      assistant('claude-opus-5', { effort: 'high' }),
      assistant('claude-opus-5'),
    ]);
    const got = await resolveTranscriptModels(file);
    expect(got.effortMix).toEqual({ high: 2, unspecified: 1 });
  });

  it('<synthetic> 은 primary 후보에서 제외되고 따로 센다', async () => {
    const file = makeTranscript([
      assistant('<synthetic>'),
      assistant('<synthetic>'),
      assistant('claude-opus-5'),
    ]);
    const got = await resolveTranscriptModels(file);
    expect(got.primary).toBe('claude-opus-5');
    expect(got.syntheticTurns).toBe(2);
    expect(got.mix).toEqual({ 'claude-opus-5': 1 });
  });

  it('깨진 줄은 건너뛰고 나머지를 계속 읽는다', async () => {
    const file = makeTranscript(
      [assistant('claude-opus-5')],
      '\n{not json at all\n' + JSON.stringify(assistant('claude-opus-5')) + '\n',
    );
    const got = await resolveTranscriptModels(file);
    expect(got.turns).toBe(2);
    expect(got.primary).toBe('claude-opus-5');
  });

  it('assistant 가 아닌 항목과 model 없는 항목은 무시한다', async () => {
    const file = makeTranscript([
      { type: 'user', message: { content: [] } },
      { type: 'assistant', message: { content: [] } },
      assistant('claude-opus-5'),
    ]);
    const got = await resolveTranscriptModels(file);
    expect(got.turns).toBe(1);
  });

  it('별도 파일로 존재하는 서브에이전트 transcript 를 함께 읽는다', async () => {
    const file = makeSession(
      [assistant('claude-opus-5'), assistant('claude-opus-5')],
      {
        'agent-a': [assistant('claude-fable-5'), assistant('claude-fable-5')],
        'agent-b': [assistant('claude-sonnet-5')],
      },
    );
    const got = await resolveTranscriptModels(file);
    expect(got.primary).toBe('claude-opus-5');
    expect(got.mix).toEqual({ 'claude-opus-5': 2 });
    expect(got.sidechainMix).toEqual({ 'claude-fable-5': 2, 'claude-sonnet-5': 1 });
    expect(got.sidechainTurns).toBe(3);
    expect(got.turns).toBe(5);
  });

  it('서브에이전트 모델은 리더 모델(primary)을 바꾸지 않는다', async () => {
    const file = makeSession(
      [assistant('claude-opus-5')],
      { 'agent-a': Array.from({ length: 9 }, () => assistant('claude-fable-5')) },
    );
    const got = await resolveTranscriptModels(file);
    expect(got.primary).toBe('claude-opus-5');
    expect(got.sidechainMix['claude-fable-5']).toBe(9);
  });

  it('subagents 디렉터리가 없어도 정상 동작한다', async () => {
    const file = makeTranscript([assistant('claude-opus-5')]);
    const got = await resolveTranscriptModels(file);
    expect(got.sidechainMix).toEqual({});
    expect(got.sidechainTurns).toBe(0);
    expect(got.primary).toBe('claude-opus-5');
  });

  it('메인이 비어도 서브에이전트만으로 귀속이 성립한다', async () => {
    const file = makeSession([], { 'agent-a': [assistant('claude-fable-5')] });
    const got = await resolveTranscriptModels(file);
    expect(got.source).toBe('transcript');
    expect(got.primary).toBeNull();
    expect(got.sidechainMix).toEqual({ 'claude-fable-5': 1 });
  });

  it('파일이 없으면 미귀속(none)을 돌려주고 던지지 않는다', async () => {
    const got = await resolveTranscriptModels('/definitely/not/here.jsonl');
    expect(got).toEqual(emptyAttribution());
    expect(got.source).toBe('none');
  });

  it('경로가 비었거나 문자열이 아니면 미귀속', async () => {
    expect(await resolveTranscriptModels('')).toEqual(emptyAttribution());
    expect(await resolveTranscriptModels(undefined)).toEqual(emptyAttribution());
    expect(await resolveTranscriptModels(null)).toEqual(emptyAttribution());
  });

  it('모델 턴이 하나도 없는 transcript 는 미귀속', async () => {
    const file = makeTranscript([{ type: 'user', message: { content: [] } }]);
    expect(await resolveTranscriptModels(file)).toEqual(emptyAttribution());
  });
});

// ---------------------------------------------------------------------------
// Unit: toRecordFields
// ---------------------------------------------------------------------------

describe('model-identity/toRecordFields', () => {
  it('레코드용 필드로 축약한다', () => {
    const fields = toRecordFields({
      source: 'transcript',
      primary: 'claude-opus-5',
      mix: { 'claude-opus-5': 3 },
      sidechainMix: { 'claude-fable-5': 7 },
      turns: 10,
    });
    expect(fields).toEqual({
      model: 'claude-opus-5',
      modelMix: { 'claude-opus-5': 3 },
      subagentMix: { 'claude-fable-5': 7 },
      modelSource: 'transcript',
    });
  });

  it('서브에이전트 믹스를 버리지 않는다 — 위임 작업 귀속의 핵심', () => {
    const fields = toRecordFields({
      source: 'transcript',
      primary: 'claude-opus-5',
      mix: { 'claude-opus-5': 1 },
      sidechainMix: { 'claude-fable-5': 40 },
    });
    expect(fields.subagentMix).toEqual({ 'claude-fable-5': 40 });
  });

  it('null/undefined 는 미귀속으로 안전 변환된다', () => {
    expect(toRecordFields(null)).toEqual({
      model: null, modelMix: {}, subagentMix: {}, modelSource: 'none',
    });
    expect(toRecordFields(undefined).modelSource).toBe('none');
  });
});
