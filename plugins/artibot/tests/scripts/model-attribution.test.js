/**
 * Tests for scripts/model-attribution.js — the retroactive per-model report
 * over Claude Code transcripts.
 *
 * The SUT guards its main() (direct-run check), so importing it here does NOT
 * scan every transcript on the machine. Pure helpers are imported directly;
 * `listTranscripts` is exercised against a real temp directory tree because
 * the whole point of that function is matching the on-disk layout.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CORRECTION_RE,
  emptyBucket,
  foldAssistant,
  foldToolResults,
  listTranscripts,
  messageText,
  parseArgs,
  sessionKeyOf,
  toRows,
} from '../../scripts/model-attribution.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const dirs = [];

/**
 * Build a projects tree mirroring the real layout:
 *   <root>/<project>/<session>.jsonl
 *   <root>/<project>/<session>/subagents/<name>.jsonl
 * @param {Record<string, {sessions: string[], subagents?: Record<string,string[]>}>} spec
 * @returns {string} projects root
 */
function makeProjects(spec) {
  const root = mkdtempSync(path.join(tmpdir(), 'artibot-attr-'));
  dirs.push(root);
  for (const [project, cfg] of Object.entries(spec)) {
    const pdir = path.join(root, project);
    mkdirSync(pdir, { recursive: true });
    for (const session of cfg.sessions ?? []) {
      writeFileSync(path.join(pdir, `${session}.jsonl`), '', 'utf-8');
    }
    for (const [session, agents] of Object.entries(cfg.subagents ?? {})) {
      const sdir = path.join(pdir, session, 'subagents');
      mkdirSync(sdir, { recursive: true });
      for (const agent of agents) {
        writeFileSync(path.join(sdir, `${agent}.jsonl`), '', 'utf-8');
      }
    }
  }
  return root;
}

const assistant = (model, extra = {}) => ({
  type: 'assistant',
  message: { model, content: extra.content ?? [] },
  ...extra,
});

const src = (over = {}) => ({
  file: 'f.jsonl', project: 'proj', session: 's1', kind: 'main', ...over,
});

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop(), { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// parseArgs — fail-closed on bad input
// ---------------------------------------------------------------------------

describe('model-attribution/parseArgs', () => {
  it('기본값을 채운다', () => {
    const o = parseArgs([]);
    expect(o.since).toBe(0);
    expect(o.scope).toBe('all');
    expect(o.project).toBeNull();
    expect(o.json).toBe(false);
  });

  it('플래그를 읽는다', () => {
    const o = parseArgs(['--since', '2026-07-24', '--project', 'Arti', '--scope', 'main', '--json']);
    expect(o.since).toBe(Date.parse('2026-07-24'));
    expect(o.project).toBe('Arti');
    expect(o.scope).toBe('main');
    expect(o.json).toBe(true);
  });

  // 조용한 무효화가 이 리포트의 최악 실패 모드다: NaN 은 falsy 라 필터가 스스로
  // 꺼지고, 기간 한정이라 믿는 전체 히스토리 통계가 출력된다.
  it('파싱 불가한 --since 는 던진다 — 조용히 필터를 끄지 않는다', () => {
    expect(() => parseArgs(['--since', 'last week'])).toThrow(/invalid --since/);
  });

  it('알 수 없는 --scope 는 던진다', () => {
    expect(() => parseArgs(['--scope', 'bogus'])).toThrow(/invalid --scope/);
  });

  it('--since 를 안 주면 던지지 않는다', () => {
    expect(() => parseArgs(['--json'])).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// sessionKeyOf — subagent files belong to their parent session
// ---------------------------------------------------------------------------

describe('model-attribution/sessionKeyOf', () => {
  it('메인 transcript 는 파일명이 세션 id', () => {
    expect(sessionKeyOf('/p/proj/abc-123.jsonl')).toBe('abc-123');
  });

  it('서브에이전트 파일은 부모 세션 id 로 귀속된다', () => {
    expect(sessionKeyOf('/p/proj/abc-123/subagents/agent-x.jsonl')).toBe('abc-123');
  });

  it('Windows 백슬래시 경로도 동일하게 처리한다', () => {
    expect(sessionKeyOf('C:\\p\\proj\\abc-123\\subagents\\agent-x.jsonl')).toBe('abc-123');
  });

  it('서로 다른 세션을 한 버킷으로 합치지 않는다', () => {
    expect(sessionKeyOf('/p/proj/s1/subagents/a.jsonl'))
      .not.toBe(sessionKeyOf('/p/proj/s2/subagents/a.jsonl'));
  });
});

// ---------------------------------------------------------------------------
// listTranscripts — real directory tree
// ---------------------------------------------------------------------------

describe('model-attribution/listTranscripts', () => {
  const spec = {
    projA: { sessions: ['s1', 's2'], subagents: { s1: ['agent-a', 'agent-b'] } },
    projB: { sessions: ['s3'] },
  };

  it('메인과 서브에이전트 transcript 를 모두 재귀 수집한다', () => {
    const root = makeProjects(spec);
    const files = listTranscripts(root, null, 'all');
    expect(files).toHaveLength(5);
    expect(files.filter(f => f.kind === 'subagent')).toHaveLength(2);
  });

  it('scope=main 은 서브에이전트를 뺀다', () => {
    const root = makeProjects(spec);
    expect(listTranscripts(root, null, 'main')).toHaveLength(3);
  });

  it('scope=subagent 는 서브에이전트만 남긴다', () => {
    const root = makeProjects(spec);
    const files = listTranscripts(root, null, 'subagent');
    expect(files).toHaveLength(2);
    expect(files.every(f => f.kind === 'subagent')).toBe(true);
  });

  it('project 필터가 디렉터리명 부분일치로 걸린다', () => {
    const root = makeProjects(spec);
    expect(listTranscripts(root, 'projB', 'all')).toHaveLength(1);
  });

  it('서브에이전트 파일에 부모 세션이 붙는다', () => {
    const root = makeProjects(spec);
    const subs = listTranscripts(root, 'projA', 'subagent');
    expect(subs.every(f => f.session === 's1')).toBe(true);
  });

  it('없는 디렉터리는 빈 배열 — 던지지 않는다', () => {
    expect(listTranscripts(path.join(tmpdir(), 'artibot-nope-xyz'), null, 'all')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// foldAssistant / foldToolResults
// ---------------------------------------------------------------------------

describe('model-attribution/foldAssistant', () => {
  it('모델별 버킷을 만들고 턴을 센다', () => {
    const buckets = new Map();
    foldAssistant(buckets, new Map(), assistant('m-a'), src());
    foldAssistant(buckets, new Map(), assistant('m-a'), src());
    expect(buckets.get('m-a').turns).toBe(2);
    expect(buckets.get('m-a').mainTurns).toBe(2);
  });

  it('경로 기준으로 서브에이전트 턴을 분류한다', () => {
    const buckets = new Map();
    foldAssistant(buckets, new Map(), assistant('m-a'), src({ kind: 'subagent' }));
    expect(buckets.get('m-a').subagentTurns).toBe(1);
    expect(buckets.get('m-a').mainTurns).toBe(0);
  });

  it('인라인 isSidechain 도 서브에이전트로 센다', () => {
    const buckets = new Map();
    foldAssistant(buckets, new Map(), assistant('m-a', { isSidechain: true }), src());
    expect(buckets.get('m-a').subagentTurns).toBe(1);
  });

  it('<synthetic> 과 model 없는 항목은 버킷을 만들지 않는다', () => {
    const buckets = new Map();
    foldAssistant(buckets, new Map(), assistant('<synthetic>'), src());
    foldAssistant(buckets, new Map(), { type: 'assistant', message: {} }, src());
    expect(buckets.size).toBe(0);
  });

  it('effort 를 집계하고 누락은 unspecified', () => {
    const buckets = new Map();
    foldAssistant(buckets, new Map(), assistant('m-a', { effort: 'high' }), src());
    foldAssistant(buckets, new Map(), assistant('m-a'), src());
    expect(buckets.get('m-a').effortMix).toEqual({ high: 1, unspecified: 1 });
  });

  it('세션과 파일을 따로 센다 — 서브에이전트 파일이 세션 수를 부풀리지 않는다', () => {
    const buckets = new Map();
    const owner = new Map();
    foldAssistant(buckets, owner, assistant('m-a'), src({ file: 'a.jsonl', session: 's1' }));
    foldAssistant(buckets, owner, assistant('m-a'), src({ file: 'b.jsonl', session: 's1' }));
    expect(buckets.get('m-a').sessions.size).toBe(1);
    expect(buckets.get('m-a').files.size).toBe(2);
  });
});

describe('model-attribution/foldToolResults', () => {
  it('tool_use 를 낸 모델에게 오류를 역귀속한다', () => {
    const buckets = new Map();
    const owner = new Map();
    const call = assistant('m-a', { content: [{ type: 'tool_use', id: 'tu-1' }] });
    foldAssistant(buckets, owner, call, src());

    foldToolResults(buckets, owner, {
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu-1', is_error: true }] },
    });
    expect(buckets.get('m-a').toolCalls).toBe(1);
    expect(buckets.get('m-a').toolErrors).toBe(1);
  });

  it('성공한 tool_result 는 오류로 세지 않는다', () => {
    const buckets = new Map();
    const owner = new Map();
    foldAssistant(buckets, owner, assistant('m-a', {
      content: [{ type: 'tool_use', id: 'tu-1' }],
    }), src());
    foldToolResults(buckets, owner, {
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu-1' }] },
    });
    expect(buckets.get('m-a').toolErrors).toBe(0);
  });

  // fail-closed: 소유자를 모르면 세지 않는다 (아무 모델에나 붙이지 않는다)
  it('소유 모델을 모르는 오류는 버린다 — 오귀속하지 않는다', () => {
    const buckets = new Map();
    foldToolResults(buckets, new Map(), {
      message: { content: [{ type: 'tool_result', tool_use_id: 'ghost', is_error: true }] },
    });
    expect(buckets.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// messageText / CORRECTION_RE
// ---------------------------------------------------------------------------

describe('model-attribution/messageText', () => {
  it('text 블록만 이어붙인다', () => {
    expect(messageText({ content: [
      { type: 'text', text: 'a' },
      { type: 'tool_use', id: 'x' },
      { type: 'text', text: 'b' },
    ] })).toBe('a\nb');
  });

  it('문자열 content 와 빈 입력을 견딘다', () => {
    expect(messageText({ content: 'plain' })).toBe('plain');
    expect(messageText({})).toBe('');
    expect(messageText(undefined)).toBe('');
  });
});

describe('model-attribution/CORRECTION_RE', () => {
  it('정정 표현을 잡는다', () => {
    for (const s of ['정정합니다', '제 실수입니다', '다시 보니 아니었다', 'my mistake', 'I was wrong']) {
      expect(CORRECTION_RE.test(s)).toBe(true);
    }
  });

  // 프록시가 넓으면 일상 산문에 걸려 지표가 무의미해진다.
  it('평범한 산문에는 걸리지 않는다', () => {
    for (const s of ['하지만 이 경우는 다르다', 'However, the build passed', '수정 사항을 적용했다']) {
      expect(CORRECTION_RE.test(s)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// toRows
// ---------------------------------------------------------------------------

describe('model-attribution/toRows', () => {
  /** @returns {Map<string, object>} single-model bucket map */
  function oneBucket(over = {}) {
    const b = { ...emptyBucket(), ...over };
    return new Map([['m-a', b]]);
  }

  it('비율을 백분율로 낸다', () => {
    const rows = toRows(oneBucket({
      turns: 10, toolCalls: 200, toolErrors: 4, corrections: 1,
    }));
    expect(rows[0].toolErrorRate).toBe(2);
    expect(rows[0].correctionRate).toBe(10);
  });

  it('분모가 0 이면 0% — NaN 을 내지 않는다', () => {
    const rows = toRows(oneBucket({ turns: 0, toolCalls: 0 }));
    expect(rows[0].toolErrorRate).toBe(0);
    expect(rows[0].correctionRate).toBe(0);
  });

  it('turnsPerSession 은 파일이 아니라 세션으로 나눈다', () => {
    const b = { ...emptyBucket(), turns: 100 };
    b.sessions = new Set(['s1', 's2']);
    b.files = new Set(['a', 'b', 'c', 'd']);
    const rows = toRows(new Map([['m-a', b]]));
    expect(rows[0].sessions).toBe(2);
    expect(rows[0].files).toBe(4);
    expect(rows[0].turnsPerSession).toBe(50);
  });

  it('턴 수 내림차순으로 정렬한다', () => {
    const rows = toRows(new Map([
      ['lo', { ...emptyBucket(), turns: 1 }],
      ['hi', { ...emptyBucket(), turns: 9 }],
    ]));
    expect(rows.map(r => r.model)).toEqual(['hi', 'lo']);
  });

  it('관측 창을 날짜로 요약한다', () => {
    const rows = toRows(oneBucket({
      turns: 1,
      firstSeen: Date.parse('2026-07-24T00:00:00Z'),
      lastSeen: Date.parse('2026-07-31T00:00:00Z'),
    }));
    expect(rows[0].firstSeen).toBe('2026-07-24');
    expect(rows[0].lastSeen).toBe('2026-07-31');
  });

  it('버킷이 없으면 빈 배열', () => {
    expect(toRows(new Map())).toEqual([]);
  });
});
