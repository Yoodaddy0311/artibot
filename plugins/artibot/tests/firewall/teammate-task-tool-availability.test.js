/**
 * Firewall — 팀원이 Task 도구가 꺼진 세션에서도 호출을 낭비하지 않는가
 * (`agents/*.md` 의 On Start · Claim Work · Complete Work · Shutdown 단계) + `commands/team.md` 의 스폰 운영 주의가 남아 있는가.
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
 * 같은 날 후속: 위 수정은 On Start 만 조건부로 바꿨다. 같은 `## Team Collaboration` 절의 2단계(Claim
 * Work — `TaskUpdate(in_progress)`)와 4단계(Complete Work — `TaskUpdate(completed)`)는 여전히 무조건 호출을
 * 지시하고 있었다(측정 2026-10-13: `agents/*.md` 29개가 두 줄을 글자 그대로 같게 갖고 있었다). On Start 에서
 * "disabled" 를 받은 팀원이 2·4단계에서 같은 호출을 다시 시도하는지는 보고에 없다(미확인) — 정의가 그
 * 지시를 남기지 않는 것까지가 이 플러그인이 고칠 수 있는 범위다.
 *
 * 같은 날 후속 2(교차검수 제안): 6단계(Shutdown)의 "mark it completed" 도 같은 문제였다 — `TaskUpdate` 없이
 * task 갱신으로 읽힐 수 있는 무조건 문구(추론 — 팀원이 그렇게 읽는지는 미확인)가 29개 정의에 글자 그대로
 * 같게 있었다(측정 2026-10-13). `TaskUpdate` 가 있을 때만 완료 처리하고, `shutdown_response` 는 조건 밖에서
 * 항상 보내도록 바꿨다.
 *
 * ── 무엇을 지키는가 ──────────────────────────────────────────────────────────
 *  1. `agents/*.md`(INDEX.md 제외) 의 On Start · Claim Work · Complete Work · Shutdown 단계가 각각
 *     정본 한 줄과 **글자 그대로** 같다. 옛 무조건 문구("Call `TaskList()` to find tasks assigned to you. …",
 *     "Use `TaskUpdate(taskId, …)` when …", "…mark it completed, and respond with …")는 어느 정의에도 없다.
 *     정본 문구는 아래 `CANONICAL_*` 상수이고, 29개 정의가 같은 줄을 쓴다. 네 단계가 **없는** 정의는
 *     `NO_COLLABORATION_STEPS` 허용 목록에만 둘 수 있다 (rules §8 — 부정 목록이 아니라 허용 목록이라,
 *     새 에이전트가 옛 줄을 베껴 와도 RED 다). Complete Work 의 `SendMessage` 보고와 Shutdown 의
 *     `shutdown_response` 는 Task 도구 조건문 **밖**의 마지막 문장이다 — 보고·응답 채널은 Task 도구와
 *     무관하게 필수라서, 상수의 이 구조도 따로 핀한다.
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
 *     것은 다른 진술이다(§2). 조건부 문구 도입 뒤 첫 호출(On Start)과 `TaskUpdate`(Claim Work ·
 *     Complete Work · Shutdown) 낭비가 줄었는지는 **미측정**이다.
 *  2. **호스트 동작 자체.** "disabled for this session" · 락 충돌 · 메시지 지연은 점검 팀원
 *     보고이고 리더가 재현하지 않았다. 7/8 이라는 비율이 다른 호스트·세션에서도 그런지는
 *     미확인이다. 이 게이트는 문서가 그 보고를 옮겨 적고 있는지만 본다.
 *  3. **Task 도구가 꺼졌을 때 TaskUpdate·TaskGet 도 꺼져 있는지.** 점검 보고는 첫 `TaskList`
 *     응답만 말한다. 정본 줄은 "task tool 이 disabled 로 응답하면 재시도하지 말라" 로 일반화했다.
 *     Claim Work · Complete Work · Shutdown 줄도 같은 일반화다 — `TaskUpdate` 가 있으면 부르고 "disabled"
 *     응답이면 재시도 없이 멈추는 형태라, TaskList 가 꺼지면 TaskUpdate 도 꺼진다는 가정은 하지 않는다.
 *  4. **orchestrator.md.** 네 단계(On Start · Claim Work · Complete Work · Shutdown)가 모두 없어 허용
 *     목록에 있다. 리더 역할 정의라 `Task*` 사용(생성·배정·TaskList/TaskGet 게이트)이 많은데 이 게이트는 그
 *     줄들을 보지 않는다 — Sub-Agent Fallback 이 "노출됐지만 disabled" 를 다루는지는 그 문서를 직접 읽어
 *     확인해야 한다.
 *  5. **`plugins/artibot-cowork/**`.** 같은 On Start 줄이 cowork 에이전트 11개와
 *     `commands/sdk.md` 에 있고, Claim Work · Complete Work 의 무조건 줄도 같은 12곳에 남아 있다
 *     (측정 2026-10-13: `grep -rhE '\*\*(Claim Work|Complete Work|On Start)\*\*' plugins/artibot-cowork`
 *     — 세 단계 모두 12줄. Shutdown 의 "mark it completed" 줄은 cowork 에이전트 11개에 있고
 *     `commands/sdk.md` 의 Shutdown 줄은 문구가 다르다). 배포 ZIP 과 CRC 로 묶여 있어
 *     (`cowork-plugin-zip-drift.test.js`) 이 편집에서 손대지 않았고 이 스캔도 `plugins/artibot/agents/`
 *     만 읽는다.
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

/** 2단계 정본 — On Start 와 같은 문체: 도구가 있으면 부르고, "disabled" 응답이면 재시도 없이 건너뛴다. */
const CANONICAL_CLAIM_WORK = '2. **Claim Work**: If `TaskUpdate` is available, call `TaskUpdate(taskId, status="in_progress")` when you begin a task. If a task tool answers "disabled for this session", do not retry it and skip this step';

/** 4단계 정본 — 조건은 `TaskUpdate` 에만 걸리고, `SendMessage` 보고는 조건 밖의 마지막 문장이다. */
const CANONICAL_COMPLETE_WORK = '4. **Complete Work**: If `TaskUpdate` is available, call `TaskUpdate(taskId, status="completed")` when done; if a task tool answers "disabled for this session", do not retry it. Then always `SendMessage` your deliverable summary to `<leader>`';

/** 2026-10-13 후속 이전의 무조건 Claim Work 문구 — 어느 정의에도 돌아오면 안 된다. */
const LEGACY_CLAIM_WORK = '2. **Claim Work**: Use `TaskUpdate(taskId, status="in_progress")` when you begin a task';

/** 2026-10-13 후속 이전의 무조건 Complete Work 문구 — 어느 정의에도 돌아오면 안 된다. */
const LEGACY_COMPLETE_WORK = '4. **Complete Work**: Use `TaskUpdate(taskId, status="completed")` when done, then `SendMessage` your deliverable summary to `<leader>`';

/** 6단계 정본 — 조건은 완료 처리(`TaskUpdate`)에만 걸리고, `shutdown_response` 는 조건 밖의 마지막 문장이다. */
const CANONICAL_SHUTDOWN = '6. **Shutdown**: When you receive a `shutdown_request`, finish any in-progress task and, if `TaskUpdate` is available, mark it completed (if a task tool answers "disabled for this session", do not retry it). Then always respond with `SendMessage(to="<leader>", message={type: "shutdown_response", request_id: "...", approve: true})`';

/** 2026-10-13 후속 2 이전의 무조건 Shutdown 문구 — 어느 정의에도 돌아오면 안 된다. */
const LEGACY_SHUTDOWN = '6. **Shutdown**: When you receive a `shutdown_request`, finish any in-progress task, mark it completed, and respond with `SendMessage(to="<leader>", message={type: "shutdown_response", request_id: "...", approve: true})`';

/** 검사하는 네 단계. `label` 이 줄 머리(`N. **label**:`)에서 단계를 찾는 키다. */
const ON_START = Object.freeze({ label: 'On Start', canonical: CANONICAL_ON_START, legacy: LEGACY_ON_START });
const CLAIM_WORK = Object.freeze({ label: 'Claim Work', canonical: CANONICAL_CLAIM_WORK, legacy: LEGACY_CLAIM_WORK });
const COMPLETE_WORK = Object.freeze({ label: 'Complete Work', canonical: CANONICAL_COMPLETE_WORK, legacy: LEGACY_COMPLETE_WORK });
const SHUTDOWN = Object.freeze({ label: 'Shutdown', canonical: CANONICAL_SHUTDOWN, legacy: LEGACY_SHUTDOWN });

/**
 * 네 단계(On Start · Claim Work · Complete Work · Shutdown) 자체가 없는 정의. 리더 역할 정의라 `TaskList()` 를
 * "시작 시 한 번" 이 아니라 단계 검증 때 부른다(orchestrator.md 의 Phase 검증). 이름 목록이지
 * 면제가 아니다 — 여기 있는 파일이 단계를 얻으면 정본 줄과 같아야 한다(아래 테스트).
 */
const NO_COLLABORATION_STEPS = new Set(['orchestrator.md']);

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
 * 에이전트 정의의 한 단계(`N. **label**:` 로 시작하는 줄)를 분류한다.
 * @param {string} text
 * @param {{label: string, canonical: string, legacy: string}} step
 * @returns {'conforming'|'legacy'|'other'|'duplicate'|'absent'}
 */
function classifyStep(text, step) {
  const head = new RegExp(`^\\d+\\. \\*\\*${step.label}\\*\\*:`);
  const lines = normalize(text).split('\n').filter((line) => head.test(line));
  if (lines.length === 0) return 'absent';
  if (lines.length > 1) return 'duplicate';
  if (lines[0] === step.canonical) return 'conforming';
  if (lines[0] === step.legacy) return 'legacy';
  return 'other';
}

/**
 * 한 정의에서 정본이 아닌 단계를 `label: kind` 로 돌려준다 — 빈 배열이면 통과다.
 * 파일별 게이트와 변이 자기검증이 이 함수 하나를 쓴다. 자기검증이 게이트와 다른 술어를 돌리면
 * 게이트가 RED 가 되는지에 대해 아무것도 증명하지 못한다.
 * @param {string} text
 * @param {ReadonlyArray<{label: string, canonical: string, legacy: string}>} steps
 * @param {boolean} mayLackSteps 허용 목록 파일이면 true — 단계가 없는(absent) 것은 위반이 아니다
 * @returns {string[]}
 */
function stepViolations(text, steps, mayLackSteps) {
  return steps
    .map((step) => ({ label: step.label, kind: classifyStep(text, step) }))
    .filter(({ kind }) => kind !== 'conforming' && !(mayLackSteps && kind === 'absent'))
    .map(({ label, kind }) => `${label}: ${kind}`);
}

/** `agents/*.md` 에서 INDEX.md 를 뺀 정의 파일 이름 목록. */
const AGENT_FILES = fsSync.readdirSync(AGENTS_DIR)
  .filter((name) => name.endsWith('.md') && name !== 'INDEX.md')
  .sort();

describe('agents/*.md — On Start 단계는 Task 도구가 꺼진 세션을 안다', () => {
  it('분모 — 에이전트 정의가 있고, 허용 목록 파일이 실재한다', () => {
    expect(AGENT_FILES.length).toBeGreaterThan(0);
    for (const name of NO_COLLABORATION_STEPS) expect(AGENT_FILES).toContain(name);
  });

  it.each(AGENT_FILES)('%s — On Start 단계가 정본 줄과 같다 (허용 목록 파일은 단계가 없어도 된다)', (name) => {
    const kind = classifyStep(read(path.join(AGENTS_DIR, name)), ON_START);
    if (NO_COLLABORATION_STEPS.has(name)) expect(['absent', 'conforming']).toContain(kind);
    else expect(kind).toBe('conforming');
  });

  it('옛 무조건 문구는 어느 정의에도 없다', () => {
    const offenders = AGENT_FILES.filter((name) => normalize(read(path.join(AGENTS_DIR, name))).includes(LEGACY_ON_START));
    expect(offenders).toEqual([]);
  });

  it('자기검증 — 옛 줄 · 꼬리 없는 근사 줄 · 중복 · 단계 없음이 conforming 으로 읽히지 않는다', () => {
    expect(classifyStep(CANONICAL_ON_START, ON_START)).toBe('conforming');
    expect(classifyStep(LEGACY_ON_START, ON_START)).toBe('legacy');
    expect(classifyStep(CANONICAL_ON_START.replace(/\. If a task tool.*$/, ''), ON_START)).toBe('other');
    expect(classifyStep(`${CANONICAL_ON_START}\n${CANONICAL_ON_START}`, ON_START)).toBe('duplicate');
    expect(classifyStep('## Team Collaboration\n', ON_START)).toBe('absent');
    // CRLF 로 저장된 같은 줄도 정본으로 읽힌다 — 이 리포의 워킹트리 모양이다.
    expect(classifyStep(`${CANONICAL_ON_START}\r\n2. **Claim Work**: x\r\n`, ON_START)).toBe('conforming');
  });
});

describe('agents/*.md — Claim Work · Complete Work · Shutdown 단계도 Task 도구가 꺼진 세션을 안다', () => {
  const TASK_STEPS = [CLAIM_WORK, COMPLETE_WORK, SHUTDOWN];

  it.each(AGENT_FILES)('%s — Claim Work · Complete Work · Shutdown 단계가 정본 줄과 같다 (허용 목록 파일은 단계가 없어도 된다)', (name) => {
    const text = read(path.join(AGENTS_DIR, name));
    expect(stepViolations(text, TASK_STEPS, NO_COLLABORATION_STEPS.has(name))).toEqual([]);
  });

  it('옛 무조건 Claim Work · Complete Work · Shutdown 문구는 어느 정의에도 없다', () => {
    const offenders = AGENT_FILES.filter((name) => {
      const body = normalize(read(path.join(AGENTS_DIR, name)));
      return TASK_STEPS.some((step) => body.includes(step.legacy));
    });
    expect(offenders).toEqual([]);
  });

  it.each([
    ['Complete Work', COMPLETE_WORK, 'Then always `SendMessage` your deliverable summary to `<leader>`'],
    ['Shutdown', SHUTDOWN, 'Then always respond with `SendMessage(to="<leader>", message={type: "shutdown_response", request_id: "...", approve: true})`'],
  ])('%s 의 SendMessage 보고·응답은 Task 도구 조건문 밖의 마지막 문장이다', (_label, step, lastSentence) => {
    const sentences = step.canonical.replace(/^\d+\. \*\*[A-Za-z ]+\*\*: /, '').split(/\.\s+/);
    expect(sentences.length).toBeGreaterThan(1);
    expect(sentences.at(-1)).toBe(lastSentence);
    // 조건이 걸린 앞 문장(TaskUpdate · "disabled" 응답)은 보고·응답을 품지 않는다 — 품으면 도구가 꺼진 세션에서 보고도 사라진다.
    for (const sentence of sentences.slice(0, -1)) expect(sentence).not.toContain('SendMessage');
  });

  it('자기검증 — 옛 줄 · 꼬리 없는 근사 줄 · 중복 · 단계 없음이 conforming 으로 읽히지 않는다', () => {
    for (const step of TASK_STEPS) {
      expect(classifyStep(step.canonical, step)).toBe('conforming');
      expect(classifyStep(step.legacy, step)).toBe('legacy');
      expect(classifyStep(`${step.canonical}\n${step.canonical}`, step)).toBe('duplicate');
      expect(classifyStep('## Team Collaboration\n', step)).toBe('absent');
      // CRLF 로 저장된 같은 줄도 정본으로 읽힌다 — 이 리포의 워킹트리 모양이다.
      expect(classifyStep(`${step.canonical}\r\n5. **Peer Communication**: x\r\n`, step)).toBe('conforming');
    }
    // 근사 줄 — "disabled" 꼬리를 뗀 Claim Work, SendMessage 문장을 뗀 Complete Work · Shutdown 은 정본이 아니다.
    const withoutTail = CANONICAL_CLAIM_WORK.replace(/\. If a task tool.*$/, '');
    const withoutReport = CANONICAL_COMPLETE_WORK.replace(/\. Then always.*$/, '');
    const withoutResponse = CANONICAL_SHUTDOWN.replace(/\. Then always.*$/, '');
    expect(withoutTail).not.toBe(CANONICAL_CLAIM_WORK);
    expect(withoutReport).not.toBe(CANONICAL_COMPLETE_WORK);
    expect(withoutResponse).not.toBe(CANONICAL_SHUTDOWN);
    expect(classifyStep(withoutTail, CLAIM_WORK)).toBe('other');
    expect(classifyStep(withoutReport, COMPLETE_WORK)).toBe('other');
    expect(classifyStep(withoutResponse, SHUTDOWN)).toBe('other');
  });

  it('자기검증(변이) — 실제 정의에서 정본 줄을 옛 줄로 되돌리거나 지우면 파일별 게이트와 같은 술어가 위반으로 읽는다', () => {
    const name = AGENT_FILES.find((candidate) => !NO_COLLABORATION_STEPS.has(candidate));
    const original = normalize(read(path.join(AGENTS_DIR, name)));
    // 대조군 — 변이 전 실제 정의는 통과한다. 이게 위반으로 읽히면 아래 변이 단언은 아무것도 증명하지 못한다.
    expect(stepViolations(original, TASK_STEPS, false)).toEqual([]);
    for (const step of TASK_STEPS) {
      // 치환이 실제로 일어나야 한다 — 정본 줄을 못 찾으면 변이가 공전해 "위반 없음" 으로 통과한다.
      expect(original).toContain(`${step.canonical}\n`);
      const restored = original.replace(`${step.canonical}\n`, () => `${step.legacy}\n`);
      const removed = original.replace(`${step.canonical}\n`, () => '');
      expect(restored).not.toBe(original);
      expect(removed).not.toBe(original);
      expect(stepViolations(restored, TASK_STEPS, false)).toEqual([`${step.label}: legacy`]);
      expect(stepViolations(removed, TASK_STEPS, false)).toEqual([`${step.label}: absent`]);
    }
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
    // 에이전트 정의 쪽 게이트(위)와 같은 범위를 문서도 말한다 — 네 단계가 조건부이고 보고는 조건 밖이다.
    expect(body).toContain('`agents/*.md` 의 On Start · Claim Work · Complete Work · Shutdown 단계는 이 경우를 위해 조건부로 바뀌었다');
    expect(body).toContain('보고(`SendMessage`)는 조건 밖이라 그대로 필수다');
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
