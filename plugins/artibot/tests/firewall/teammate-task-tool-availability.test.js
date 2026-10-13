/**
 * Firewall — 팀원이 Task 도구가 꺼진 세션에서도 첫 호출을 낭비하지 않는가
 * (`agents/*.md` 의 On Start 단계) + `commands/team.md` 의 스폰 운영 주의가 남아 있는가.
 *
 * ── 왜 필요했나 (2026-10-13 라이브 점검 — 점검 팀원 보고, 리더 재현 없음) ─────────
 * 다른 터미널의 `/team` 런에서 팀원 8명 중 7명의 첫 `TaskList()` 호출이 "disabled for
 * this session" 으로 응답했다. 에이전트 정의 29개의 On Start 단계는 무조건 `TaskList()` 를
 * 부르라고 적고 있었다 — 첫 호출이 TaskList 였던 것은 그 단계를 따른 결과로 보이나(추론)
 * 7명이 어느 정의의 팀원이었는지는 보고에 없다(미확인). 같은 점검에서 Bash 가 없는
 * doc-updater 에 셸 재측정이 배정됐고, 병렬 스폰 8개 중 2개가 락 충돌로 실패했으며,
 * 작업 중인 팀원에게 보낸 리더 메시지가 16분+ 배달되지 않았다. 호스트 동작은 이 플러그인이
 * 고치지 못한다 — 고칠 수 있는 것은 정의와 리더 문서가 그 동작을 안다고 적는 것까지다.
 *
 * ── 무엇을 지키는가 ──────────────────────────────────────────────────────────
 *  1. `agents/*.md`(INDEX.md 제외) 의 On Start 단계가 정본 한 줄과 **글자 그대로** 같다.
 *     옛 무조건 문구("Call `TaskList()` to find tasks assigned to you. …")는 어느 정의에도
 *     없다. 정본 문구는 아래 `CANONICAL_ON_START` 이고, 29개 정의가 같은 줄을 쓴다.
 *     On Start 단계가 **없는** 정의는 `NO_ON_START_STEP` 허용 목록에만 둘 수 있다
 *     (rules §8 — 부정 목록이 아니라 허용 목록이라, 새 에이전트가 옛 줄을 베껴 와도 RED 다).
 *  2. `commands/team.md` 에 2026-10-13 점검에서 나온 리더 쪽 규칙 셋(제약은 스폰 프롬프트에
 *     / 실패한 병렬 스폰은 한 번 / 팀원 Task 도구 꺼짐)이 남아 있다.
 *  3. team.md Phase 1 의 "Bash 가 없는 에이전트" 목록이 에이전트 프론트매터의 `tools:` 판독과
 *     **같다**. 목록은 손으로 옮긴 사본이라 낡는다 — 처음 옮길 때 정규식 하나가 항목 뒤
 *     주석(`- Bash # team ops only`)을 못 읽어 orchestrator 를 Bash 없음으로 잘못 셌다
 *     (2026-10-13 작성 중 실측). 이 비교가 그 종류의 오차를 상시 잡는다. 파서는
 *     `frontmatter-tools.js#parseAgentTools` 를 쓴다 — 주석 줄·항목 뒤 주석을 처리하는 정본.
 *     `agents/INDEX.md` 에 도구 열이 없다는 team.md 의 진술도 같이 핀한다.
 *
 * ── 이 게이트가 못 보는 것 (rules §9 — 게이트 옆에 못 보는 것을 적어 둔다) ────────
 *  1. **팀원이 그 줄을 따르는지.** 문구가 있다는 것과 "disabled" 응답에서 재시도를 멈춘다는
 *     것은 다른 진술이다(§2). 조건부 문구 도입 뒤 첫 호출 낭비가 줄었는지는 **미측정**이다.
 *  2. **호스트 동작 자체.** "disabled for this session" · 락 충돌 · 메시지 지연은 점검 팀원
 *     보고이고 리더가 재현하지 않았다. 7/8 이라는 비율이 다른 호스트·세션에서도 그런지는
 *     미확인이다. 이 게이트는 문서가 그 보고를 옮겨 적고 있는지만 본다.
 *  3. **Task 도구가 꺼졌을 때 TaskUpdate·TaskGet 도 꺼져 있는지.** 점검 보고는 첫 `TaskList`
 *     응답만 말한다. 정본 줄은 "task tool 이 disabled 로 응답하면 재시도하지 말라" 로 일반화했다.
 *  4. **orchestrator.md.** On Start 단계가 없어 허용 목록에 있다. 그 정의의 Sub-Agent Fallback
 *     트리거는 "도구 부재" 만 말하고 "노출됐지만 disabled" 는 말하지 않는다 — 고치지 않았고
 *     이 게이트도 보지 않는다.
 *  5. **`plugins/artibot-cowork/**`.** 같은 On Start 줄이 cowork 에이전트 11개와
 *     `commands/sdk.md` 에 있다. 배포 ZIP 과 CRC 로 묶여 있어(`cowork-plugin-zip-drift.test.js`)
 *     이 편집에서 손대지 않았고 이 스캔도 `plugins/artibot/agents/` 만 읽는다.
 *  6. **글자 그대로 비교라서** 줄바꿈만 CRLF/LF 로 정규화한다. 같은 뜻의 다른 문장은 RED 다
 *     (의도: 29개 정의가 같은 줄을 쓰는 것이 이 게이트의 목적이다).
 *
 * @module tests/firewall/teammate-task-tool-availability
 */

import { describe, expect, it } from 'vitest';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeToolName, parseAgentTools } from './frontmatter-tools.js';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const AGENTS_DIR = path.join(PLUGIN_ROOT, 'agents');
const TEAM = path.join(PLUGIN_ROOT, 'commands', 'team.md');
const AGENT_INDEX = path.join(AGENTS_DIR, 'INDEX.md');

/** 정본 한 줄 — 29개 에이전트 정의가 글자 그대로 같은 줄을 쓴다. */
const CANONICAL_ON_START = '1. **On Start**: If `TaskList` is available, call `TaskList()` to find tasks assigned to you and use `TaskGet(taskId)` to read full task details before starting work. If a task tool answers "disabled for this session", do not retry it: the spawn prompt is your assignment and `SendMessage` is your report channel';

/** 2026-10-13 이전의 무조건 문구 — 어느 정의에도 돌아오면 안 된다. */
const LEGACY_ON_START = '1. **On Start**: Call `TaskList()` to find tasks assigned to you. Use `TaskGet(taskId)` to read full task details before starting work';

/**
 * On Start 단계 자체가 없는 정의. 리더 역할 정의라 `TaskList()` 를 "시작 시 한 번" 이 아니라
 * 단계 검증 때 부른다(orchestrator.md 의 Phase 검증). 이름 목록이지 면제가 아니다 — 여기 있는
 * 파일이 On Start 단계를 얻으면 정본 줄과 같아야 한다(아래 테스트).
 */
const NO_ON_START_STEP = new Set(['orchestrator.md']);

/** 파일을 읽되 없으면 던진다 — 파일이 사라지면 "0건 위반" 으로 조용히 통과하지 않고 RED 다. */
function read(file) {
  if (!fsSync.existsSync(file)) throw new Error(`missing canonical file: ${file}`);
  return fsSync.readFileSync(file, 'utf-8');
}

/** 줄 종결자를 정규화한다 — 이 리포의 문서는 워킹트리에서 CRLF 다. */
function normalize(source) {
  return source.replace(/\r\n/g, '\n');
}

/** 헤딩 문자열만 뽑는다. */
function headings(source) {
  return normalize(source).split('\n')
    .map((line) => line.trim())
    .filter((line) => /^#{1,6}\s/.test(line));
}

/**
 * 에이전트 정의의 On Start 단계를 분류한다.
 * @param {string} text
 * @returns {'conforming'|'legacy'|'other'|'duplicate'|'absent'}
 */
function classifyOnStart(text) {
  const lines = normalize(text).split('\n').filter((line) => /^\d+\. \*\*On Start\*\*:/.test(line));
  if (lines.length === 0) return 'absent';
  if (lines.length > 1) return 'duplicate';
  if (lines[0] === CANONICAL_ON_START) return 'conforming';
  if (lines[0] === LEGACY_ON_START) return 'legacy';
  return 'other';
}

/** `agents/*.md` 에서 INDEX.md 를 뺀 정의 파일 이름 목록. */
const AGENT_FILES = fsSync.readdirSync(AGENTS_DIR)
  .filter((name) => name.endsWith('.md') && name !== 'INDEX.md')
  .sort();

describe('agents/*.md — On Start 단계는 Task 도구가 꺼진 세션을 안다', () => {
  it('분모 — 에이전트 정의가 있고, 허용 목록 파일이 실재한다', () => {
    expect(AGENT_FILES.length).toBeGreaterThan(0);
    for (const name of NO_ON_START_STEP) expect(AGENT_FILES).toContain(name);
  });

  it.each(AGENT_FILES)('%s — On Start 단계가 정본 줄과 같다 (허용 목록 파일은 단계가 없어도 된다)', (name) => {
    const kind = classifyOnStart(read(path.join(AGENTS_DIR, name)));
    if (NO_ON_START_STEP.has(name)) expect(['absent', 'conforming']).toContain(kind);
    else expect(kind).toBe('conforming');
  });

  it('옛 무조건 문구는 어느 정의에도 없다', () => {
    const offenders = AGENT_FILES.filter((name) => normalize(read(path.join(AGENTS_DIR, name))).includes(LEGACY_ON_START));
    expect(offenders).toEqual([]);
  });

  it('자기검증 — 옛 줄 · 꼬리 없는 근사 줄 · 중복 · 단계 없음이 conforming 으로 읽히지 않는다', () => {
    expect(classifyOnStart(CANONICAL_ON_START)).toBe('conforming');
    expect(classifyOnStart(LEGACY_ON_START)).toBe('legacy');
    expect(classifyOnStart(CANONICAL_ON_START.replace(/\. If a task tool.*$/, ''))).toBe('other');
    expect(classifyOnStart(`${CANONICAL_ON_START}\n${CANONICAL_ON_START}`)).toBe('duplicate');
    expect(classifyOnStart('## Team Collaboration\n')).toBe('absent');
    // CRLF 로 저장된 같은 줄도 정본으로 읽힌다 — 이 리포의 워킹트리 모양이다.
    expect(classifyOnStart(`${CANONICAL_ON_START}\r\n2. **Claim Work**: x\r\n`)).toBe('conforming');
  });
});

describe('commands/team.md — 스폰 운영 주의 (2026-10-13 라이브 점검)', () => {
  const body = normalize(read(TEAM));

  it('절 머리글이 있다', () => {
    expect(headings(body)).toContain('#### 스폰 운영 주의 (라이브 점검 2026-10-13 — 점검 팀원 보고, 리더 재현 없음)');
  });

  it('세 규칙이 남아 있다 — 제약은 스폰 프롬프트에 · 실패한 스폰은 한 번 · 팀원 Task 도구 꺼짐', () => {
    expect(body).toContain('**제약은 전부 스폰 프롬프트에 싣는다**');
    expect(body).toContain('중간 보정은 팀원이 현재 작업을 끝낸 뒤에야 처리');
    expect(body).toContain('**병렬 스폰이 실패하면 실패한 호출만 한 번 다시 부른다.**');
    expect(body).toContain('`Lock file is already being held`');
    expect(body).toContain('**팀원 쪽 Task 도구가 꺼져 있을 수 있다.**');
    expect(body).toContain('"disabled for this session"');
  });

  it('보고된 수치는 점검 팀원 보고라는 등급과 함께 있다 — 리더 재현 없음, 분할 효과 미측정', () => {
    expect(body).toContain('점검 팀원 보고, 리더 재현 없음');
    expect(body).toContain('나누면 경합이 줄어드는지는 미측정이다');
  });

  it('Phase 1 의 "Bash 가 없는 에이전트" 목록이 프론트매터 tools: 판독과 같다', () => {
    const listed = body.match(/Bash 가 없는 에이전트\(`tools:` 판독 \d{4}-\d{2}-\d{2}: ([a-z0-9-]+(?: · [a-z0-9-]+)*)\)/);
    expect(listed, 'team.md 에서 Bash 없는 에이전트 목록을 읽지 못했다').not.toBeNull();

    const withoutBash = AGENT_FILES.filter((name) => {
      const parsed = parseAgentTools(read(path.join(AGENTS_DIR, name)));
      expect(parsed.ok, `${name}: ${parsed.ok ? '' : parsed.reason}`).toBe(true);
      return !parsed.tools.some((declared) => {
        const normalized = normalizeToolName(declared);
        return !normalized.skip && normalized.base === 'Bash';
      });
    }).map((name) => name.replace(/\.md$/, ''));

    expect(listed[1].split(' · ').sort()).toEqual(withoutBash.sort());
    // 분모 — 파서가 전부 "Bash 없음" 으로 읽어 목록과 우연히 같아지는 일을 막는다.
    expect(withoutBash.length).toBeGreaterThan(0);
    expect(withoutBash.length).toBeLessThan(AGENT_FILES.length);
  });

  it('"INDEX.md 에는 도구 열이 없다" 는 진술이 참이다', () => {
    expect(body).toContain('`agents/INDEX.md` 에는 도구 열이 없다');
    // 표 머리글 = 바로 다음 줄이 `|---|---|` 구분선인 `|` 줄. 머리글이 하나도 안 읽히면 RED 다.
    const lines = normalize(read(AGENT_INDEX)).split('\n');
    const headers = lines.filter((line, i) => line.startsWith('|') && /^\|[-| :]+\|$/.test(lines[i + 1] ?? ''));
    expect(headers.length).toBeGreaterThan(0);
    for (const line of headers) expect(line).not.toMatch(/\btools?\b/i);
  });
});
