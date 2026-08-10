import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  emptySignals,
  resolveSessionSignals,
} from '../../lib/learning/session-signals.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const dirs = [];

/**
 * Build the on-disk layout Claude Code uses:
 *   <dir>/session.jsonl                  (main thread)
 *   <dir>/session/subagents/<name>.jsonl (one file per subagent)
 *
 * @param {object[]} mainEntries
 * @param {Record<string, object[]>} [subagents] - filename -> entries
 * @param {string} [trailing] - raw text appended verbatim to the main file
 * @returns {string} path to the main transcript
 */
function makeSession(mainEntries, subagents = {}, trailing = '') {
  const dir = mkdtempSync(path.join(tmpdir(), 'artibot-signals-'));
  dirs.push(dir);
  const file = path.join(dir, 'session.jsonl');
  writeFileSync(file, mainEntries.map(e => JSON.stringify(e)).join('\n') + trailing, 'utf-8');

  const names = Object.keys(subagents);
  if (names.length > 0) {
    const subDir = path.join(file.replace(/\.jsonl$/, ''), 'subagents');
    mkdirSync(subDir, { recursive: true });
    for (const name of names) {
      writeFileSync(
        path.join(subDir, name),
        subagents[name].map(e => JSON.stringify(e)).join('\n'),
        'utf-8',
      );
    }
  }
  return file;
}

/** An assistant entry carrying tool_use blocks. */
const use = (blocks, timestamp) => ({
  type: 'assistant',
  ...(timestamp ? { timestamp } : {}),
  message: { content: blocks },
});

/** A user entry carrying tool_result blocks (where Claude Code puts them). */
const result = (blocks, timestamp) => ({
  type: 'user',
  ...(timestamp ? { timestamp } : {}),
  message: { content: blocks },
});

const toolUse = (id, name, input = {}) => ({ type: 'tool_use', id, name, input });
const toolResult = (id, isError) => ({
  type: 'tool_result',
  tool_use_id: id,
  ...(isError === undefined ? {} : { is_error: isError }),
});

afterEach(() => {
  while (dirs.length > 0) {
    rmSync(dirs.pop(), { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// emptySignals — the honest "not measured" record
// ---------------------------------------------------------------------------

describe('session-signals/emptySignals', () => {
  it("source 는 'none' 이고 모든 카운트가 0, wallClock 은 null 이다", () => {
    expect(emptySignals()).toEqual({
      source: 'none',
      toolCalls: 0,
      toolErrors: 0,
      filesTouched: 0,
      filesSeen: 0,
      wallClockMs: null,
      firstTs: null,
      lastTs: null,
      byTool: {},
      main: { toolCalls: 0, toolErrors: 0, filesTouched: 0, filesSeen: 0 },
      subagent: { toolCalls: 0, toolErrors: 0, filesTouched: 0, filesSeen: 0 },
      subagentFiles: 0,
    });
  });

  it('호출마다 새 객체를 반환한다 (공유 상태 없음)', () => {
    const a = emptySignals();
    const b = emptySignals();
    expect(a).not.toBe(b);
    expect(a.byTool).not.toBe(b.byTool);
    expect(a.main).not.toBe(b.main);
  });
});

// ---------------------------------------------------------------------------
// Failure modes — R6: a silent zero must be impossible
// ---------------------------------------------------------------------------

describe('session-signals/실패 모드', () => {
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['빈 문자열', ''],
    ['문자열 아님', 42],
  ])('경로가 %s 이면 source:none (0 이 아니다)', async (_label, input) => {
    const signals = await resolveSessionSignals(input);
    expect(signals.source).toBe('none');
  });

  it('존재하지 않는 경로에서 던지지 않고 source:none 을 준다', async () => {
    const signals = await resolveSessionSignals(
      path.join(tmpdir(), 'artibot-does-not-exist-9e3f', 'nope.jsonl'),
    );
    expect(signals).toEqual(emptySignals());
  });

  it('디렉터리를 가리켜도 던지지 않는다', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'artibot-signals-dir-'));
    dirs.push(dir);
    await expect(resolveSessionSignals(dir)).resolves.toEqual(emptySignals());
  });

  it('빈 파일은 source:none — 측정 못 한 것과 0 회 사용을 섞지 않는다', async () => {
    const file = makeSession([]);
    expect((await resolveSessionSignals(file)).source).toBe('none');
  });

  it('도구는 0건이어도 타임스탬프가 있으면 실측이다 (source:transcript)', async () => {
    const file = makeSession([
      { type: 'assistant', timestamp: '2026-08-10T00:00:00.000Z', message: { content: [] } },
      { type: 'assistant', timestamp: '2026-08-10T00:05:00.000Z', message: { content: [] } },
    ]);
    const signals = await resolveSessionSignals(file);
    expect(signals.source).toBe('transcript');
    expect(signals.toolCalls).toBe(0);
    expect(signals.wallClockMs).toBe(5 * 60 * 1000);
  });

  it('깨진 JSON 줄은 건너뛰고 나머지를 집계한다', async () => {
    const file = makeSession(
      [use([toolUse('a', 'Read', { file_path: '/x.js' })], '2026-08-10T00:00:00.000Z')],
      {},
      '\n{ not json at all\n\n',
    );
    const signals = await resolveSessionSignals(file);
    expect(signals.source).toBe('transcript');
    expect(signals.toolCalls).toBe(1);
  });

  it('content 가 배열이 아니거나 블록이 null 이어도 견딘다', async () => {
    const file = makeSession([
      { type: 'assistant', timestamp: '2026-08-10T00:00:00.000Z', message: { content: 'plain' } },
      { type: 'assistant', message: {} },
      { type: 'summary' },
      { type: 'user', message: { content: [null, undefined, 7, {}] } },
      use([toolUse('a', 'Bash')], '2026-08-10T00:01:00.000Z'),
    ]);
    const signals = await resolveSessionSignals(file);
    expect(signals.toolCalls).toBe(1);
    expect(signals.toolErrors).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Core counting
// ---------------------------------------------------------------------------

describe('session-signals/도구 호출·오류 집계', () => {
  it('tool_use 를 세고 is_error:true 만 오류로 센다', async () => {
    const file = makeSession([
      use([toolUse('1', 'Bash'), toolUse('2', 'Read', { file_path: '/a.js' })], '2026-08-10T00:00:00.000Z'),
      result([toolResult('1', true), toolResult('2', false)], '2026-08-10T00:00:10.000Z'),
      use([toolUse('3', 'Grep')], '2026-08-10T00:00:20.000Z'),
      result([toolResult('3')], '2026-08-10T00:00:30.000Z'),
    ]);
    const signals = await resolveSessionSignals(file);
    expect(signals.toolCalls).toBe(3);
    expect(signals.toolErrors).toBe(1);
  });

  it("is_error 가 문자열 'true' 여도 오류로 세지 않는다 (엄격 비교)", async () => {
    const file = makeSession([
      use([toolUse('1', 'Bash')], '2026-08-10T00:00:00.000Z'),
      result([{ type: 'tool_result', tool_use_id: '1', is_error: 'true' }]),
    ]);
    expect((await resolveSessionSignals(file)).toolErrors).toBe(0);
  });

  it('byTool 이 tool_use_id 로 오류를 도구명에 결합한다', async () => {
    const file = makeSession([
      use([toolUse('1', 'Bash'), toolUse('2', 'Bash'), toolUse('3', 'Edit', { file_path: '/a.js' })],
        '2026-08-10T00:00:00.000Z'),
      result([toolResult('1', true), toolResult('2', false), toolResult('3', true)]),
    ]);
    const signals = await resolveSessionSignals(file);
    expect(signals.byTool).toEqual({
      Bash: { calls: 2, errors: 1 },
      Edit: { calls: 1, errors: 1 },
    });
  });

  it('결합되지 않는 tool_use_id 의 오류는 <unknown> 버킷에 남는다 (조용히 버리지 않는다)', async () => {
    const file = makeSession([
      use([toolUse('1', 'Bash')], '2026-08-10T00:00:00.000Z'),
      result([toolResult('ghost-id', true)]),
    ]);
    const signals = await resolveSessionSignals(file);
    expect(signals.toolErrors).toBe(1);
    expect(signals.byTool['<unknown>']).toEqual({ calls: 0, errors: 1 });
  });

  it('이름 없는 tool_use 는 세지만 byTool 에서 <unknown> 으로 간다', async () => {
    const file = makeSession([
      use([{ type: 'tool_use', id: '1', input: {} }], '2026-08-10T00:00:00.000Z'),
    ]);
    const signals = await resolveSessionSignals(file);
    expect(signals.toolCalls).toBe(1);
    expect(signals.byTool['<unknown>']).toEqual({ calls: 1, errors: 0 });
  });
});

// ---------------------------------------------------------------------------
// Live transcript shapes — observed across all 26 transcript files of this
// project on 2026-08-10 and pinned here so a harness change surfaces as a red
// test rather than a quietly shrinking error count (R6).
// ---------------------------------------------------------------------------

describe('session-signals/실측 관측 형태', () => {
  it('결과가 외부 파일로 빠져도(<persisted-output>) 호출로 세고 오류로 오인하지 않는다', async () => {
    // Claude Code replaces oversized output with a pointer string, keeping the
    // block inline with tool_use_id but no is_error key.
    const file = makeSession([
      use([toolUse('1', 'Bash')], '2026-08-10T00:00:00.000Z'),
      result([{
        type: 'tool_result',
        tool_use_id: '1',
        content: '<persisted-output>\nOutput too large (62.5KB). Full output saved to: /tmp/x.txt',
      }]),
    ]);
    const signals = await resolveSessionSignals(file);
    expect(signals.toolCalls).toBe(1);
    expect(signals.toolErrors).toBe(0);
    expect(signals.byTool.Bash).toEqual({ calls: 1, errors: 0 });
  });

  it('응답 없는 tool_use(중단된 호출)는 호출로만 세고 오류가 아니다', async () => {
    // Observed: one completed session carried 4 tool_use with no matching result.
    const file = makeSession([
      use([toolUse('1', 'Bash'), toolUse('2', 'Read', { file_path: '/a.js' })],
        '2026-08-10T00:00:00.000Z'),
      result([toolResult('1', false)]),
    ]);
    const signals = await resolveSessionSignals(file);
    expect(signals.toolCalls).toBe(2);
    expect(signals.toolErrors).toBe(0);
  });

  it('오류 텍스트가 content 에 있어도 is_error:true 가 아니면 오류가 아니다', async () => {
    // 26개 파일 전수에서 is_error:true 가 아닌 실패-형태 블록은 0건이었다. 이
    // 규율이 뒤집히면(문자열로만 오류를 알리기 시작하면) 여기가 먼저 깨져야 한다.
    const file = makeSession([
      use([toolUse('1', 'Bash')], '2026-08-10T00:00:00.000Z'),
      result([{ type: 'tool_result', tool_use_id: '1', content: 'Error: something failed' }]),
    ]);
    expect((await resolveSessionSignals(file)).toolErrors).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// File denominators — filesTouched (edit tools) vs filesSeen (any tool)
// ---------------------------------------------------------------------------

describe('session-signals/파일 집계', () => {
  it('filesTouched 는 편집도구만, filesSeen 은 전체 file_path 를 센다', async () => {
    const file = makeSession([
      use([
        toolUse('1', 'Read', { file_path: '/read-only.js' }),
        toolUse('2', 'Edit', { file_path: '/edited.js' }),
        toolUse('3', 'Write', { file_path: '/written.js' }),
        toolUse('4', 'MultiEdit', { file_path: '/multi.js' }),
        toolUse('5', 'NotebookEdit', { file_path: '/nb.ipynb' }),
        toolUse('6', 'Bash'),
      ], '2026-08-10T00:00:00.000Z'),
    ]);
    const signals = await resolveSessionSignals(file);
    expect(signals.filesTouched).toBe(4);
    expect(signals.filesSeen).toBe(5);
  });

  it('같은 파일을 여러 번 편집해도 1건이다', async () => {
    const file = makeSession([
      use([
        toolUse('1', 'Edit', { file_path: '/same.js' }),
        toolUse('2', 'Edit', { file_path: '/same.js' }),
        toolUse('3', 'Write', { file_path: '/same.js' }),
      ], '2026-08-10T00:00:00.000Z'),
    ]);
    const signals = await resolveSessionSignals(file);
    expect(signals.filesTouched).toBe(1);
    expect(signals.filesSeen).toBe(1);
  });

  it('file_path 가 빈 문자열이거나 문자열이 아니면 무시한다', async () => {
    const file = makeSession([
      use([
        toolUse('1', 'Edit', { file_path: '' }),
        toolUse('2', 'Edit', { file_path: 123 }),
        toolUse('3', 'Edit', {}),
        toolUse('4', 'Edit'),
      ], '2026-08-10T00:00:00.000Z'),
    ]);
    const signals = await resolveSessionSignals(file);
    expect(signals.toolCalls).toBe(4);
    expect(signals.filesTouched).toBe(0);
    expect(signals.filesSeen).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Wall clock
// ---------------------------------------------------------------------------

describe('session-signals/wall-clock', () => {
  it('타임스탬프 최초/최종 차를 ms 로 준다 (순서 무관)', async () => {
    const file = makeSession([
      use([toolUse('1', 'Bash')], '2026-08-10T01:00:00.000Z'),
      use([toolUse('2', 'Bash')], '2026-08-10T00:00:00.000Z'),
      use([toolUse('3', 'Bash')], '2026-08-10T02:30:00.000Z'),
    ]);
    const signals = await resolveSessionSignals(file);
    expect(signals.wallClockMs).toBe(2.5 * 60 * 60 * 1000);
    expect(signals.firstTs).toBe('2026-08-10T00:00:00.000Z');
    expect(signals.lastTs).toBe('2026-08-10T02:30:00.000Z');
  });

  it('타임스탬프가 없으면 null 이다 (0 이 아니다)', async () => {
    const file = makeSession([use([toolUse('1', 'Bash')])]);
    const signals = await resolveSessionSignals(file);
    expect(signals.source).toBe('transcript');
    expect(signals.wallClockMs).toBeNull();
    expect(signals.firstTs).toBeNull();
  });

  it('파싱 불가 타임스탬프는 무시한다', async () => {
    const file = makeSession([
      use([toolUse('1', 'Bash')], 'not-a-date'),
      use([toolUse('2', 'Bash')], '2026-08-10T00:00:00.000Z'),
    ]);
    const signals = await resolveSessionSignals(file);
    expect(signals.wallClockMs).toBe(0);
    expect(signals.firstTs).toBe('2026-08-10T00:00:00.000Z');
  });

  it('타임스탬프가 하나면 span 은 0 이다', async () => {
    const file = makeSession([use([toolUse('1', 'Bash')], '2026-08-10T00:00:00.000Z')]);
    expect((await resolveSessionSignals(file)).wallClockMs).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Subagent recursion — the signal that a 1-level scan would lose entirely
// ---------------------------------------------------------------------------

describe('session-signals/서브에이전트', () => {
  it('subagents/*.jsonl 를 수집해 분리 기록하고 최상위는 합산한다', async () => {
    const file = makeSession(
      [
        use([toolUse('m1', 'Bash'), toolUse('m2', 'Edit', { file_path: '/main.js' })],
          '2026-08-10T00:00:00.000Z'),
        result([toolResult('m1', true)]),
      ],
      {
        'agent-a.jsonl': [
          use([toolUse('s1', 'Edit', { file_path: '/sub-a.js' })], '2026-08-10T00:10:00.000Z'),
          result([toolResult('s1', true)]),
        ],
        'agent-b.jsonl': [
          use([toolUse('s2', 'Read', { file_path: '/sub-b.js' })], '2026-08-10T00:20:00.000Z'),
        ],
      },
    );
    const signals = await resolveSessionSignals(file);

    expect(signals.main).toEqual({
      toolCalls: 2, toolErrors: 1, filesTouched: 1, filesSeen: 1,
    });
    expect(signals.subagent).toEqual({
      toolCalls: 2, toolErrors: 1, filesTouched: 1, filesSeen: 2,
    });
    expect(signals.toolCalls).toBe(4);
    expect(signals.toolErrors).toBe(2);
    expect(signals.subagentFiles).toBe(2);
  });

  it('main 과 subagent 가 같은 파일을 편집하면 합산은 UNION 이다 (중복 계산 금지)', async () => {
    const file = makeSession(
      [use([toolUse('m1', 'Edit', { file_path: '/shared.js' })], '2026-08-10T00:00:00.000Z')],
      { 'a.jsonl': [use([toolUse('s1', 'Edit', { file_path: '/shared.js' })], '2026-08-10T00:01:00.000Z')] },
    );
    const signals = await resolveSessionSignals(file);
    expect(signals.main.filesTouched).toBe(1);
    expect(signals.subagent.filesTouched).toBe(1);
    expect(signals.filesTouched).toBe(1);
  });

  it('byTool 은 main+subagent 합산이다', async () => {
    const file = makeSession(
      [use([toolUse('m1', 'Bash')], '2026-08-10T00:00:00.000Z')],
      { 'a.jsonl': [use([toolUse('s1', 'Bash')], '2026-08-10T00:01:00.000Z')] },
    );
    expect((await resolveSessionSignals(file)).byTool).toEqual({
      Bash: { calls: 2, errors: 0 },
    });
  });

  it('wall-clock 은 서브에이전트 타임스탬프까지 포함한다', async () => {
    const file = makeSession(
      [use([toolUse('m1', 'Bash')], '2026-08-10T00:00:00.000Z')],
      { 'a.jsonl': [use([toolUse('s1', 'Bash')], '2026-08-10T00:30:00.000Z')] },
    );
    expect((await resolveSessionSignals(file)).wallClockMs).toBe(30 * 60 * 1000);
  });

  it('subagents 디렉터리가 없으면 subagent 는 0 이고 main 만 집계된다', async () => {
    const file = makeSession([use([toolUse('m1', 'Bash')], '2026-08-10T00:00:00.000Z')]);
    const signals = await resolveSessionSignals(file);
    expect(signals.subagentFiles).toBe(0);
    expect(signals.subagent).toEqual({
      toolCalls: 0, toolErrors: 0, filesTouched: 0, filesSeen: 0,
    });
    expect(signals.toolCalls).toBe(1);
  });

  it('.jsonl 이 아닌 파일은 무시한다', async () => {
    const file = makeSession(
      [use([toolUse('m1', 'Bash')], '2026-08-10T00:00:00.000Z')],
      {
        'a.jsonl': [use([toolUse('s1', 'Bash')], '2026-08-10T00:01:00.000Z')],
        'notes.txt': [use([toolUse('s2', 'Bash')], '2026-08-10T00:02:00.000Z')],
      },
    );
    const signals = await resolveSessionSignals(file);
    expect(signals.subagentFiles).toBe(1);
    expect(signals.subagent.toolCalls).toBe(1);
  });

  it('서브에이전트에만 작업이 있어도 실측으로 잡힌다 (위임 세션)', async () => {
    const file = makeSession(
      [],
      { 'a.jsonl': [use([toolUse('s1', 'Edit', { file_path: '/only.js' })], '2026-08-10T00:00:00.000Z')] },
    );
    const signals = await resolveSessionSignals(file);
    expect(signals.source).toBe('transcript');
    expect(signals.toolCalls).toBe(1);
    expect(signals.filesTouched).toBe(1);
  });
});
