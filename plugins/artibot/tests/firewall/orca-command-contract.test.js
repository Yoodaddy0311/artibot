/**
 * Firewall — `/orca` 커맨드 계약 (`commands/orca.md`).
 *
 * ── 왜 이 게이트가 따로 있는가 ──────────────────────────────────────────────
 * orca.md 는 `[보고 계약]`·`[중계 계약]` 을 team.md 와 문자 단위로 같게 싣는다. 그 동일성을 지키는
 * 중앙 게이트(`tests/commands/report-contract-parity.test.js#CARRIERS`)에는 등록하지 않았다 — 리더 결정
 * E3 (d). 등록하면 `command-output-invariance.test.js` 가 그 배열을 소스에서 파싱해
 * `registry.carriers ∪ unresolved.files` 와의 등식을 단언하고 `unresolved.files` 를 정확히
 * ['sc.md', 'ultraplan.md'] 로 고정하므로 orca.md 를 넣을 자리가 없다. 그래서 이 파일이 team.md 를
 * 직접 읽어 같은 동일성을 핀한다. (착수 전 확인 — "`[보고 계약]` 을 담은 모든 커맨드가 CARRIERS 에
 * 등록돼야 한다"는 역방향 스캔은 어디에도 없다. assemble·spawn·orchestrate 는 그 문자열을 담고도
 * 등록 밖이고 스위트는 그린이다.)
 *
 * 핀하는 것: 프론트매터·허용 도구 · 200줄 래칫 · 두 계약 블록의 team.md 동일성(+변이 자기검증) ·
 * 서브커맨드 7개 · 리더가 직접 치는 변경 verb 허용 목록 · 기상 처리 표 · launch 의 고정 문구와 순서 ·
 * integrate 한 줄이 `/split` 의 것과 락 경로 말고는 같다는 것 · close 의 replay 규칙 · "못 보는 것" 절 ·
 * 금지 리터럴(경로·위험 플래그·숨은 문자·모델 이름) · 문서가 지목한 설정 키와 스크립트 flag 의 실재.
 *
 * launch 순서(Run 생성 → 전체 구간 열기 → 승인)는 설계안 §4.4 의 "승인 → run-create" 와 **다르다.**
 * 사람 대기 구간은 Orca runId 키로 기록되는데(`scripts/orca/mark.mjs`, 설계안 §11.1 E1) runId 는
 * `run-create` 뒤에야 생기므로, 설계안의 순서로는 승인 앞뒤를 감쌀 키가 없다. 빈 Run 은 워커·프로세스를
 * 만들지 않는다. 이 순서를 바꾸려면 mark 의 키 설계부터 다시 정해야 하므로 여기서 핀한다.
 *
 * ── 이 게이트가 못 보는 것 (rules §9 — 게이트 옆에 적는다) ────────────────────
 *  1. **리더가 문서를 따르는지.** 문구의 존재만 본다. 문서 존재 ≠ 준수다.
 *  2. **Orca 의 실제 동작.** 문서의 Orca 진술은 P0 1회(2026-11-19, Orca 1.4.259)의 실측에 기댄다.
 *     이 파일의 그린은 그 진술이 지금도 참이라는 증거가 아니다. P0 미측정 항목을 실측하면 문서와 이
 *     파일의 "못 보는 것" 핀을 함께 고쳐라.
 *  3. **문구 핀은 부분 문자열·정규식이다.** 문구가 남아 있어도 뜻이 뒤집히면 통과한다.
 *  4. **스크립트 flag 대조는 소스 텍스트에 그 이름이 있는지만 본다.** flag 의 뜻·필수 여부·값 형식은
 *     못 본다. 약식 표기(`bind.mjs dispatch …`)는 보지만, 스크립트 이름이 안 붙은 flag(`--force-new`)는
 *     못 본다.
 *  5. **다른 게이트의 몫은 복제하지 않는다.** 진행률 마커 스캔(`command-output-invariance`) · 본문의
 *     도구 호출 표기(`command-body-tool-parity`) · cwd 상대 실행과 finder 블록 등록제
 *     (`plugin-root-finder`) · `kind:` 리터럴 · 인용 해소 · 표/백틱 렌더링.
 *  6. **줄 수 래칫은 상한뿐이다.** 문서가 줄어드는 것(내용 소실)은 위의 문구 핀이 잡는다.
 *
 * @module tests/firewall/orca-command-contract
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { KNOWN_TOOL_NAMES, normalizeToolName, parseCommandTools } from './frontmatter-tools.js';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const exists = (rel) => existsSync(path.join(PLUGIN_ROOT, rel));
// CRLF 정규화는 read 에서 한 번만 한다(Windows CI 러너는 autocrlf 로 CRLF 체크아웃 — split-window-contract 와 같은 이유).
const read = (rel) => readFileSync(path.join(PLUGIN_ROOT, rel), 'utf-8').replace(/\r\n/g, '\n');

// 파일 부재·읽기 실패는 fail-closed 다 — 조용한 스킵 가드를 두지 않는다.
const orcaMd = read('commands/orca.md');
const teamMd = read('commands/team.md');
const splitMd = read('commands/split.md');
const config = JSON.parse(read('artibot.config.json'));

/** 200줄 상한 — `/split` 의 300줄 승격 래칫(split-window-contract)과 같은 방식. 재현: `wc -l commands/orca.md`. */
const LINE_RATCHET = 200;
const SUBCOMMANDS = ['plan', 'launch', 'status', 'integrate', 'close', 'resume', 'run'];
/** 본문이 실제로 쓰는 도구 — Bash(스크립트·orca) · Read · Write(tasks.json) · SendMessage(계약 블록) · AskUserQuestion(승인). */
const REQUIRED_TOOLS = ['Bash', 'Read', 'Write', 'SendMessage', 'AskUserQuestion'];
/** 리더가 한 줄씩 직접 치는 변경 verb — 설계안 §4.1-4 ∪ §11.2. 스크립트는 이것을 부르지 않고 출력만 한다. */
const LEADER_MUTATING_VERBS = [
  'run-create', 'task-create', 'worktree create', 'worker-start', 'send', 'reply',
  'deny', 'task-update', 'worker-release', 'worktree rm', 'terminal close',
];
const LABELS = ['보고 계약', '중계 계약'];
const POSTURE_PHRASE =
  '워커는 Orca 새 에이전트 설정을 따른다(권한 모드는 CLI 로 읽을 수 없다 — 이 PC 실측은 bypass permissions, 훅은 계속 차단)';
/** 문서가 이름으로 부르는 `scripts/orca/*.mjs` — 이 집합이 바뀌면 문서와 이 핀을 함께 고친다. */
const DOC_SCRIPTS = ['preflight', 'plan', 'bind', 'status', 'close', 'mark'];

// ── 순수 판정 함수 (자기검증이 뮤테이션을 직접 먹인다) ─────────────────────────────

/** BOM·CRLF 무관 줄 수(`citation-resolution.js#countLines` 와 같은 규칙). */
export function countLines(text) {
  let s = String(text);
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  const arr = s.split(/\r\n|\r|\n/);
  if (arr.length > 0 && arr[arr.length - 1] === '') arr.pop();
  return arr.length;
}

/** ```-펜스 안의 `[{label}]` 블록 — parity 테스트와 같은 추출 규칙(사본이 아니라 규칙 복제). */
export function extractBlock(src, label) {
  const m = src.match(new RegExp('```\\r?\\n(\\[' + label + '\\][\\s\\S]*?)\\r?\\n```'));
  return m ? m[1].replace(/\r\n/g, '\n').trim() : null;
}

export function frontmatterOf(src) {
  const m = src.match(/^---\n([\s\S]*?)\n---/);
  return m ? m[1] : null;
}

/** 헤딩 줄부터 같거나 높은 레벨의 다음 헤딩 직전까지. 못 찾으면 null. */
export function sectionOf(src, headingRe) {
  const lines = src.split('\n');
  const start = lines.findIndex((l) => headingRe.test(l));
  if (start === -1) return null;
  const level = lines[start].match(/^#+/)[0].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    const m = lines[i].match(/^(#+)\s/);
    if (m && m[1].length <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

const PIPE_MASK = '§PIPE§';
const maskCodePipes = (line) => line.replace(/`[^`\n]*`/g, (s) => s.split('|').join(PIPE_MASK));
const isSeparator = (line) => /^\|[\s\-:|]+\|$/.test(String(line ?? '').trim());

/** 헤더 첫 칸이 `firstCell` 인 GFM 표의 데이터 행(셀 문자열 배열). 표가 없으면 null. */
export function tableRows(src, firstCell) {
  const lines = src.split('\n');
  const start = lines.findIndex((l, i) => l.startsWith(`| ${firstCell} |`) && isSeparator(lines[i + 1]));
  if (start === -1) return null;
  const rows = [];
  for (let i = start + 2; i < lines.length && lines[i].startsWith('|'); i += 1) {
    rows.push(maskCodePipes(lines[i]).split('|').slice(1, -1).map((c) => c.split(PIPE_MASK).join('|').trim()));
  }
  return rows;
}

/** 문서의 모든 표 헤더 행(첫 줄) 목록. */
export function tableHeaders(src) {
  const lines = src.split('\n');
  return lines.filter((l, i) => l.startsWith('|') && isSeparator(lines[i + 1]));
}

const HIDDEN_RANGES = [
  [0x00a0, 0x00a0], [0x00ad, 0x00ad], [0x061c, 0x061c], [0x200b, 0x200f], [0x202a, 0x202e],
  [0x2060, 0x2064], [0x2066, 0x2069], [0xfeff, 0xfeff], [0xe0000, 0xe007f],
];

/** 숨은 문자(unicode-hygiene 의 8범위 + NBSP) 위치 목록. 리터럴이 아니라 코드포인트 숫자로 정의한다. */
export function hiddenCodePoints(text) {
  const hits = [];
  text.split('\n').forEach((line, i) => {
    for (const ch of line) {
      const cp = ch.codePointAt(0);
      if (HIDDEN_RANGES.some(([s, e]) => cp >= s && cp <= e)) hits.push({ line: i + 1, cp: cp.toString(16) });
    }
  });
  return hits;
}

/** 허용 목록 줄에서 빠진 변경 verb. */
export function missingVerbs(line, verbs = LEADER_MUTATING_VERBS) {
  return verbs.filter((v) => !String(line).includes('`' + v + '`'));
}

/** `…name.mjs 인자…` 형태의 호출에서 스크립트별 flag 와 첫 위치 인자(서브커맨드) 를 모은다. */
export function scriptCalls(src, names = DOC_SCRIPTS) {
  const re = new RegExp('\\b(' + names.join('|') + ')\\.mjs"?[ ]*([^`\\n]*)', 'g');
  const calls = new Map();
  for (const m of src.matchAll(re)) {
    const entry = calls.get(m[1]) ?? { flags: new Set(), subs: new Set() };
    for (const f of m[2].matchAll(/--[a-z][a-z-]*/g)) entry.flags.add(f[0]);
    const first = m[2].trim().split(/\s+/)[0] ?? '';
    if (/^[a-z][a-z-]*$/.test(first)) entry.subs.add(first);
    calls.set(m[1], entry);
  }
  return calls;
}

/** 스크립트 소스에 flag 이름이 있는가 — `--flag` 문자열 또는 따옴표 친 키(`parseArgs` 옵션). */
export const sourceHasFlag = (source, flag) =>
  source.includes(flag) || new RegExp('[\'"]' + flag.slice(2) + '[\'"]').test(source);

/** 스크립트 소스에 서브커맨드 낱말이 있는가. */
export const sourceHasWord = (source, word) => new RegExp('(?<![A-Za-z0-9_-])' + word + '(?![A-Za-z0-9_-])').test(source);

const indexOfNeedle = (src, needle) => {
  const i = src.indexOf(needle);
  expect(i, `orca.md 에서 못 찾았다: ${needle}`).toBeGreaterThanOrEqual(0);
  return i;
};

/** integrate 의 `node --input-type=module -e "…"` 스크립트 본문(`-e "` 와 `" "<pluginRoot>"` 사이). */
const landScript = (src) => {
  const m = src.match(/^node --input-type=module -e "(import path from[\s\S]*?)" "<pluginRoot>" <runId>/m);
  return m ? m[1] : null;
};

// 위험 리터럴은 소스에 통째로 쓰지 않고 조립한다(land 인용 게이트와 위험 명령 훅이 이 파일의 추가 줄도 본다).
const SPLIT_DIR_LITERAL = ['.artibot', 'split', ''].join('/');
const DRIVE_USERS = new RegExp('[A-Za-z]:\\\\' + 'Us' + 'ers\\\\');
const RM_WITH_FORCE = new RegExp('worktree rm[^\\n]*' + '--for' + 'ce');
const RAW_MODEL_PATTERN =
  /model="(opus|sonnet|haiku|fable)"|(?:opus|sonnet|haiku)\s+4\.\d|(?:opus|sonnet|haiku)\s+3\.\d|claude-(?:opus|sonnet|haiku|fable)-[\w.-]+/i;

// ── 1. 프론트매터 · 허용 도구 ─────────────────────────────────────────────────

describe('orca.md 프론트매터', () => {
  const fm = frontmatterOf(orcaMd);

  it('프론트매터가 있고 description 은 (Artibot) 접두의 한 줄이다', () => {
    expect(fm).not.toBeNull();
    const line = fm.split('\n').find((l) => l.startsWith('description:'));
    expect(line, 'description 키가 없다').toBeDefined();
    expect(line).toMatch(/^description: \(Artibot\) \S/);
    expect(line.replace(/^description:\s*/, ''), 'YAML 스칼라에 ": " 가 들어가면 파싱이 깨진다').not.toMatch(/: | #/);
  });

  it('argument-hint 가 있고 서브커맨드 7개를 전부 싣는다', () => {
    const line = fm.split('\n').find((l) => l.startsWith('argument-hint:'));
    expect(line, 'argument-hint 키가 없다').toBeDefined();
    for (const sub of SUBCOMMANDS) expect(line, `argument-hint 에 ${sub} 가 없다`).toMatch(new RegExp(`(^|[\\s'|])${sub}([\\s'|<]|$)`));
  });

  it('allowed-tools 의 이름이 전부 실재하는 도구이고 본문이 쓰는 도구를 선언한다', () => {
    const parsed = parseCommandTools(orcaMd);
    expect(parsed.ok, parsed.reason).toBe(true);
    const bases = parsed.tools.map((t) => normalizeToolName(t)).filter((n) => !n.skip).map((n) => n.base);
    for (const base of bases) expect(KNOWN_TOOL_NAMES.has(base), `미지의 도구 이름: ${base}`).toBe(true);
    for (const tool of REQUIRED_TOOLS) expect(bases, `allowed-tools 에 ${tool} 가 없다`).toContain(tool);
  });

  it('disable-model-invocation 을 넣지 않는다 (DMI_EXCEPTIONS 등록이 필요해진다)', () => {
    expect(fm).not.toMatch(/^disable-model-invocation\s*:/m);
  });
});

// ── 2. 줄 수 래칫 ────────────────────────────────────────────────────────────

describe('줄 수 래칫', () => {
  it(`orca.md 는 ${LINE_RATCHET}줄 이하다 — 계약과 절차만 든다 (재현: wc -l commands/orca.md)`, () => {
    expect(countLines(orcaMd)).toBeLessThanOrEqual(LINE_RATCHET);
  });

  it('줄 수 판정이 BOM·CRLF 에 흔들리지 않고 말미 개행을 세지 않는다 (자기검증)', () => {
    expect(countLines('a\nb\n')).toBe(2);
    expect(countLines('a\r\nb\r\n')).toBe(2);
    expect(countLines(String.fromCodePoint(0xfeff) + 'a\nb')).toBe(2);
  });
});

// ── 3. 계약 블록 — team.md 정본과 문자 단위 동일 ─────────────────────────────────

describe('계약 블록 — team.md 와 문자 단위 동일 (E3: 중앙 레지스트리 없이 여기서 핀)', () => {
  it.each(LABELS)('[%s] 블록이 team.md(정본)와 orca.md 양쪽에서 추출된다', (label) => {
    expect(extractBlock(teamMd, label), `team.md 에서 ${label} 추출 실패`).not.toBeNull();
    expect(extractBlock(orcaMd, label), `orca.md 에서 ${label} 추출 실패`).not.toBeNull();
  });

  it.each(LABELS)('[%s] 이 team.md 와 문자 단위로 같다', (label) => {
    expect(extractBlock(orcaMd, label)).toBe(extractBlock(teamMd, label));
  });

  it('두 블록은 서로 다르다 (복붙 사고 감지)', () => {
    expect(extractBlock(orcaMd, LABELS[0])).not.toBe(extractBlock(orcaMd, LABELS[1]));
  });

  it('자기검증: orca.md 쪽 한 글자 변이가 red 를 낸다', () => {
    const mutated = orcaMd.replace('없으면 "미확인: 없음".', '없으면 "미확인: 없음"');
    expect(mutated).not.toBe(orcaMd);
    expect(extractBlock(mutated, LABELS[0])).not.toBe(extractBlock(teamMd, LABELS[0]));
  });

  it('자기검증: 정본(team.md) 쪽 변이도 red 를 낸다 — 비교가 한쪽만 보지 않는다', () => {
    const mutated = teamMd.replace('위임 금지 대상은 구현이다.', '위임 금지 대상은 구현이다!');
    expect(mutated).not.toBe(teamMd);
    expect(extractBlock(orcaMd, LABELS[1])).not.toBe(extractBlock(mutated, LABELS[1]));
  });

  it('Orca 채널 조항이 있고 워커→리더 채널을 Orca 메일로 못박는다', () => {
    const clause = sectionOf(orcaMd, /^## 보고 계약 · Orca 채널 조항/);
    expect(clause, 'Orca 채널 조항 절이 없다').not.toBeNull();
    for (const token of ['Orca 채널 조항', '`worker_done`', '`ask`', '`escalation`', '`[중계 계약]`']) {
      expect(clause, `채널 조항에 ${token} 가 없다`).toContain(token);
    }
    expect(clause, '워커→리더 SendMessage 경로를 미확인으로 남겨야 한다').toMatch(/SendMessage.{0,30}P0 에서 시험하지 않았다.{0,12}미확인/);
  });
});

// ── 4. 서브커맨드 · 변경 verb 허용 목록 ──────────────────────────────────────────

describe('서브커맨드와 리더 허용 목록', () => {
  it.each(SUBCOMMANDS)('### %s 절이 있다', (name) => {
    expect(orcaMd).toMatch(new RegExp(`^### ${name}( |$)`, 'm'));
  });

  it('Subcommands 표가 7개 서브커맨드 행을 전부 싣는다', () => {
    const rows = tableRows(orcaMd, '서브커맨드');
    expect(rows, 'Subcommands 표가 없다').not.toBeNull();
    expect(rows).toHaveLength(SUBCOMMANDS.length);
    SUBCOMMANDS.forEach((name, i) => expect(rows[i][0]).toMatch(new RegExp('^`' + name + '[ `]')));
  });

  it('변경 verb 는 리더가 한 줄씩 직접 친다 — 허용 목록 11개가 전부 있다', () => {
    const line = orcaMd.split('\n').find((l) => l.includes('허용 목록:'));
    expect(line, '허용 목록 줄이 없다').toBeDefined();
    expect(line).toContain('변경 verb 는 리더가 한 줄씩 직접 친다');
    expect(missingVerbs(line)).toEqual([]);
    expect(line).toContain('목록 밖의 변경 verb 는 쓰지 않는다');
  });

  it('스크립트는 읽기 verb 만 부르고 소비 check 는 리더만 한다', () => {
    expect(orcaMd).toContain('스크립트는 Orca 읽기 verb 만 부른다');
    expect(orcaMd).toContain('`check --peek`');
    expect(orcaMd).toMatch(/\*\*폴링 금지\.\*\* 메일을 소비하는 `check` 는 리더 자신만/);
  });

  it('자기검증: 허용 목록에서 verb 하나를 지우면 잡힌다', () => {
    const line = orcaMd.split('\n').find((l) => l.includes('허용 목록:'));
    const mutated = line.replace('`worker-release` · ', '');
    expect(mutated).not.toBe(line);
    expect(missingVerbs(mutated)).toEqual(['worker-release']);
  });

  it('완료는 git 트레일러이고 worker_done 은 신호다 — 착지는 두 조건이다', () => {
    expect(orcaMd).toContain('`worker_done` 은 "지금 다시 읽으라"는 신호이지 완료가 아니다');
    expect(orcaMd).toMatch(/커밋 0 인 줄기는 tip 이 base 라 조상 검사만으로는 "착지"로 읽힌다/);
  });

  it('flag 표를 싣지 않는다 (설계안 §4.8 — CLI 사용법은 버전 일치 가이드를 따른다)', () => {
    const headers = tableHeaders(orcaMd);
    expect(headers.length, '표 헤더를 하나도 못 찾았다 — 스캐너가 공허하다').toBeGreaterThanOrEqual(2);
    for (const h of headers) expect(h, `flag 표처럼 보이는 헤더: ${h}`).not.toMatch(/flag|플래그|옵션|option/i);
    expect(tableHeaders(orcaMd + '\n| 플래그 | 뜻 |\n|---|---|\n| a | b |\n').some((h) => /플래그/.test(h))).toBe(true);
  });
});

// ── 4b. plan — Orca 를 바꾸지 않는다 ────────────────────────────────────────────

describe('plan', () => {
  const plan = sectionOf(orcaMd, /^### plan/);

  it('plan 절이 있다', () => {
    expect(plan).not.toBeNull();
  });

  it('preflight → 작업 메타 → plan.mjs → 표 순서이고 Orca 는 아무것도 바뀌지 않는다', () => {
    const order = [
      'scripts/orca/preflight.mjs" --json',
      '`tasks.json` 에 **Write** 한다',
      'scripts/orca/plan.mjs" --objective',
      '4. 표를 낸다',
    ].map((needle) => plan.indexOf(needle));
    for (const i of order) expect(i).toBeGreaterThanOrEqual(0);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(plan).toContain('여기까지 Orca 는 아무것도 바뀌지 않았다');
  });

  it('줄기는 계획의 전 작업이고 fallbackReason·줄기 수 미달은 명시 중단이다', () => {
    expect(plan).toContain('줄기 = 계획의 **전 작업**(첫 wave 만이 아니다)');
    expect(plan).toMatch(/`fallbackReason` 이 있거나 줄기 수가 미달이면 \*\*명시 중단\*\*한다/);
    expect(plan).toContain('메타가 불완전하면 추측하지 않고 그 작업은 직렬로 남긴다');
  });

  it('런을 담은 상태 파일은 거부하고 --force-new 는 오너 지시 때만이며 시작한 적 없는 계획은 교체된다', () => {
    expect(plan).toMatch(/런을 담은 상태 파일\(`runId` 가 찍혔거나 worktree 바인딩·dispatch 가 있는 것\)이거나 읽을 수 없으면 거부한다/);
    expect(plan).toContain('`--force-new` 는 오너 지시 때만');
    expect(plan).toContain('시작한 적 없는 계획은 플래그 없이 교체된다');
  });
});

// ── 5. launch — 고정 문구와 순서 ────────────────────────────────────────────────

describe('launch', () => {
  const launch = sectionOf(orcaMd, /^### launch/);

  it('launch 절이 있다', () => {
    expect(launch).not.toBeNull();
  });

  it('승인 표에 권한 자세 고정 문구가 문자 그대로 들어간다', () => {
    expect(launch).toContain(POSTURE_PHRASE);
  });

  it('고정 문구의 측정 범위(날짜·Orca 버전·이 PC 한 곳)를 함께 적는다', () => {
    expect(launch).toMatch(/2026-11-19 Orca 1\.4\.259 이 PC 한 곳이다/);
  });

  it('Run 생성 → 전체 구간 열기 → 승인 앞 start → 질문 → 승인 뒤 end → 줄기 시작 순서다', () => {
    const order = [
      '`run-create --objective',
      'mark.mjs" start run --run-id <runId>',
      'mark.mjs" start confirm-launch --run-id <runId> --human-wait',
      'AskUserQuestion 1회',
      'mark.mjs end confirm-launch --run-id <runId>',
      '4. 시작 가능한 줄기',
    ].map((needle) => indexOfNeedle(launch, needle));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('첫 옵션은 (권장) 표기이고 사전 위임이어도 0길이 쌍을 붙여 찍는다', () => {
    expect(launch).toContain('"승인 — 워커 N개 시작 (권장)"');
    expect(launch).toMatch(/`orca\.launch\.requireApproval` 이 false/);
    expect(launch).toContain('붙여 찍는다');
    expect(launch).toContain('0길이 쌍');
  });

  it('줄기는 한 번에 하나씩 만들고 갖추고 시작한다 — Task 생성과 시작을 합치지 않는다', () => {
    expect(launch).toContain('**한 번에 하나씩**');
    expect(launch).toMatch(/`task-create[^`]*` — \*\*`worker-start` 와 합치지 않는다\.\*\*/);
  });

  it('시작 실패는 같은 줄을 다시 치지 않고 같은 Task 로 --retry-of 이며 3회 차단기는 오너에게 올린다', () => {
    expect(launch).toContain('**시작이 실패하면 같은 줄을 다시 치지 않는다.**');
    expect(launch).toMatch(/같은 Task 로 `worker-start --task <taskId> --retry-of <dispatchId>/);
    expect(launch).toMatch(/3회 실패하면 Orca 차단기가 걸린다 — 새 Run·Task 로 돌아가지 않고 오너에게 올린다/);
  });

  it('재시도 dispatch 는 --kind retry 로 기록한다 (bind.mjs 는 두 번째 dispatch 에 --kind 를 요구한다)', () => {
    expect(launch).toMatch(/`bind\.mjs dispatch … --kind retry` 로 기록한다\(같은 줄기의 두 번째 dispatch 는 `--kind` 가 필수다\)/);
    expect(launch).toContain('같은 명령을 다시 쳐도 멱등이다');
  });

  it('첫 워커 시작 뒤 상태줄을 1회 읽어 보고하고 못 읽으면 미확인이다', () => {
    expect(launch).toMatch(/`terminal read` 를 `--screen` 으로 1회/);
    expect(launch).toMatch(/못 읽으면 "미확인"/);
  });

  it('launch 는 턴을 끝내고 폴링하지 않는다', () => {
    expect(launch).toContain('**턴을 끝낸다.**');
    expect(launch).toContain('폴링하지 않는다');
  });

  it('모델 이름을 박지 않는다 (전체 id 는 /model-routing 이 해석한 값만)', () => {
    expect(launch).toContain('/model-routing');
    expect(RAW_MODEL_PATTERN.test(orcaMd)).toBe(false);
    expect(RAW_MODEL_PATTERN.test('--model claude-sonnet-5-5')).toBe(true); // 양성 대조
  });
});

// ── 6. 기상 처리 표 ──────────────────────────────────────────────────────────

describe('기상 처리', () => {
  const rows = tableRows(orcaMd, '메일');

  it('표가 있고 행이 정확히 5개다 (question · worker_done 성공/실패 · escalation lost/권한 프롬프트)', () => {
    expect(rows, '기상 처리 표가 없다').not.toBeNull();
    expect(rows.map((r) => r[0])).toEqual([
      '`worker_done` · 성공',
      '`worker_done` · 실패',
      '`question`',
      '`escalation` · `stopReason: lost`',
      '`escalation` · 권한 프롬프트',
    ]);
  });

  it.each([
    [0, [/land\.mjs/, /새 Task · 새 dispatch · 새 터미널/, /--kind rework/]],
    [1, [/\*\*2회\*\*/, /오너에게 올린다/, /--retry-of/, /트레일러 `done` 이 이미 있으면 git 이 진실원이다/]],
    [2, [/`reply`/, /워커의 훅은 승인을 모른다/]],
    [3, [/\*\*git 부터 본다\*\*/, /--retry-of/, /단정하지 않는다/]],
    [4, [/\*\*승인하지 않는다\.\*\*/, /`deny`/, /미확인/]],
  ])('행 %i 이 핵심 처리 조항을 싣는다', (i, patterns) => {
    for (const re of patterns) expect(rows[i][1], `행 ${i} 에 ${re} 가 없다`).toMatch(re);
  });

  it('줄기 식별은 payload.dispatchId 로만 하고 배치 전체를 처리한 뒤 다음 check 를 한다', () => {
    expect(orcaMd).toContain('**줄기 식별은 `payload.dispatchId` 로만** 한다');
    expect(orcaMd).toMatch(/^### 기상 처리 — 받은 배치 전체를 처리한 뒤 다음 check$/m);
  });

  it('위험 명령 원문 인용 금지를 Anti-Patterns 에 싣는다 (P0-12: 훅이 보고까지 차단)', () => {
    const anti = sectionOf(orcaMd, /^## Anti-Patterns/);
    expect(anti, 'Anti-Patterns 절이 없다').not.toBeNull();
    expect(anti).toMatch(/위험한 명령의 원문을 인용하지 마라/);
    expect(anti).toMatch(/권한 프롬프트를 승인하거나/);
  });
});

// ── 7. integrate — /split 과 같은 한 줄, 락 경로만 세그먼트로 조립 ──────────────────

describe('integrate', () => {
  const orcaScript = landScript(orcaMd);
  const splitScript = landScript(splitMd);
  const splitLock = splitMd.match(/lockDir:'<parentRoot>\/([^']+)'/);

  it('두 문서에서 landBatch 한 줄을 추출한다 (공허한 대조 방지)', () => {
    expect(orcaScript, 'orca.md 에서 landBatch 한 줄을 못 찾았다').not.toBeNull();
    expect(splitScript, 'split.md 에서 landBatch 한 줄을 못 찾았다').not.toBeNull();
    expect(splitLock, 'split.md 의 lockDir 리터럴을 못 찾았다').not.toBeNull();
    expect(orcaScript).toContain('await landBatch(');
  });

  it('락 디렉터리는 /split 과 같은 경로이고(E4) 문서에는 리터럴 없이 세그먼트로 조립한다', () => {
    const segments = splitLock[1].split('/');
    expect(segments.length).toBeGreaterThanOrEqual(3);
    const assembled = `lockDir:path.join(cwd,${segments.map((s) => `'${s}'`).join(',')})`;
    expect(orcaScript).toContain(assembled);
    expect(orcaMd).not.toContain(SPLIT_DIR_LITERAL);
  });

  it('락 경로를 빼면 /split 의 한 줄과 문자 단위로 같다 (base·remote·락 키·check-runs 가 갈라지지 않는다)', () => {
    const segments = splitLock[1].split('/');
    const assembled = `lockDir:path.join(cwd,${segments.map((s) => `'${s}'`).join(',')})`;
    const splitAsOrca = splitScript.replace(`lockDir:'<parentRoot>/${splitLock[1]}'`, assembled);
    expect(splitAsOrca).not.toBe(splitScript); // 뮤테이션이 실제로 적용됐다
    expect(orcaScript).toBe(splitAsOrca);
  });

  it('착지 뒤 조상 확인 · 부분 배치 · 수동 줄기 상태 기록 없음을 적는다', () => {
    const sec = sectionOf(orcaMd, /^### integrate/);
    expect(sec).toMatch(/`landed` 면 \*\*`git fetch` 뒤 줄기 tip 이 `origin\/master` 의 조상인지 확인\*\*/);
    expect(sec).toContain('**부분 배치가 정상 경로다.**');
    expect(sec).toContain('수동 줄기 상태 기록은 없다');
    expect(sec).toMatch(/`mark\.mjs start confirm-integrate --run-id <runId> --human-wait`/);
  });
});

// ── 8. close — replay 규칙 ───────────────────────────────────────────────────

describe('close', () => {
  const close = sectionOf(orcaMd, /^### close/);

  it('close 절이 있다', () => {
    expect(close).not.toBeNull();
  });

  it('닫는 명령은 close.mjs 가 출력한 줄만 출력된 플래그 그대로 친다 — 문서가 rm 플래그를 따로 적지 않는다', () => {
    expect(close).toContain('**출력된 줄만, 출력된 플래그 그대로**');
    expect(RM_WITH_FORCE.test(orcaMd)).toBe(false);
    expect(RM_WITH_FORCE.test('worktree rm --worktree x ' + '--for' + 'ce')).toBe(true); // 양성 대조
  });

  it('replay 규칙 ①~⑤ 가 전부 있다 (종료코드 불신 · 세 목록 판정 · 동일 플래그 1회 · 관리 디렉터리 잔여 허용 · 완료 기준)', () => {
    for (const token of [
      '**replay 규칙**',
      '종료코드를 믿지 않는다',
      '`git worktree list` · 브랜치 목록 · `orca worktree list`',
      '**동일 플래그로 1회**',
      '관리 디렉터리 잔여는 허용한다',
      'git 등록 0 ∧ 브랜치 0 ∧ Orca 목록 0',
    ]) expect(close, `close 절에 ${token} 가 없다`).toContain(token);
  });

  it('junction 은 삭제 전에 teardown 하고 reparse point 0 을 확인한다', () => {
    expect(close).toMatch(/junction 은 삭제 \*\*전에\*\* teardown 한다/);
    expect(close).toContain('reparse point 0');
  });

  it('확인 순서는 close.mjs 와 같다 — 착지 → report.md 복사 → junction teardown → reparse point 0 → 청결 (청결은 teardown 뒤다)', () => {
    const order = ['착지 두 조건', '`report.md` 를', 'junction teardown', 'reparse point 0 →', '워킹트리 청결 순으로']
      .map((needle) => close.indexOf(needle));
    for (const i of order) expect(i).toBeGreaterThanOrEqual(0);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(close).toContain('**전부 통과한 뒤에만** 닫는 명령을 출력한다');
  });

  it('--abandon 은 비파괴 teardown 뒤 worktree·브랜치를 남기고 처분은 Orca 에 남긴다', () => {
    expect(close).toMatch(/`--abandon`\(미착지로 버림\)/);
    expect(close).toContain('**남긴다**');
    expect(close).toContain('task-update … --status failed --result cancelled');
    expect(close).toContain('상태 파일에 처분 키를 만들지 않는다');
    expect(close).toMatch(/살아 있으면 멈추는 것은 오너의 명시 지시이고, 스크립트는 그 명령을 출력하지 않는다/);
  });
});

// ── 9. 통계·측정 고지·못 보는 것 ─────────────────────────────────────────────

describe('측정 고지와 못 보는 것', () => {
  it('전체 구간(run)을 열고 닫고 summary 를 null 그대로 병기한다', () => {
    expect(orcaMd).toContain('`mark.mjs end run --run-id <runId>`');
    expect(orcaMd).toContain('`mark.mjs summary --run-id <runId>`');
    expect(orcaMd).toMatch(/`0` 으로 바꾸지 않는다/);
    expect(orcaMd).toContain('`run` 구간은 다시 열지 않는다');
  });

  it('HG-14 는 분류 전용이라 승인 누락의 검출은 status 의 confirm-launch 경고뿐이라고 적는다', () => {
    expect(orcaMd).toMatch(/HG-14\(에이전트 프로세스 스폰\)는 분류 전용이라 적중이 원장에 행을 남기지 않으므로/);
    expect(orcaMd).toContain('`confirm-launch` 쌍이 원장에 닫혀 있지 않으면 경고 행을 낸다');
  });

  it('비용 표는 워커 영수증이 오지 않음(P0-7)과 TABLE OMITTED 를 적는다 — 다른 출처의 숫자로 대신하지 않는다', () => {
    expect(orcaMd).toContain('**워커의 영수증은 오지 않는다**(P0-7');
    expect(orcaMd).toContain('`TABLE OMITTED <사유 한 줄>`');
    expect(orcaMd).toContain('다른 출처의 숫자로 대신하지 않는다');
  });

  it('"못 보는 것" 절이 있고 P0 미측정 항목과 실 런 수락 미실시를 남긴다', () => {
    const sec = sectionOf(orcaMd, /^## 이 커맨드가 못 보는 것/);
    expect(sec, '못 보는 것 절이 없다').not.toBeNull();
    for (const token of ['P0 1회', 'P0-13', 'P0-14', 'P0-17', 'P0-6', 'P0-7', 'P0-18', '미실시', '채팅 세션', '`master` 로 고정한다']) {
      expect(sec, `못 보는 것에 ${token} 가 없다`).toContain(token);
    }
  });

  it('끝없이 도는 워커 절은 Orca 의 알림 여부와 타이머 기상을 미확인으로 남긴다', () => {
    const sec = sectionOf(orcaMd, /^## 끝없이 도는 워커/);
    expect(sec, '끝없이 도는 워커 절이 없다').not.toBeNull();
    expect(sec).toMatch(/알리는지는 \*\*미확인\*\*/);
    expect(sec).toMatch(/P0-14 가 \*\*미실측\*\*/);
    expect(sec).toContain('`orca.stallCheckMinutes`');
  });

  it('점검은 status.mjs --stall 이고 worker-read 를 못 보는 약한 판정임을 밝힌다 (구현이 읽기 허용 목록 밖이라 뺐다)', () => {
    const sec = sectionOf(orcaMd, /^## 끝없이 도는 워커/);
    expect(sec).toMatch(/status\.mjs" --stall`/);
    expect(sec).toContain('로컬 파일 1개를 쓴다');
    expect(sec).toMatch(/`worker-read`\)는 읽기 허용 목록 밖이라 보지 않는다 — 설계안보다 약한 판정이다/);
  });

  it('status 절 제목은 Orca 에는 읽기 전용이라고만 말한다 (--fetch 와 --stall 은 로컬에 쓴다)', () => {
    expect(orcaMd).toMatch(/^### status — Orca 에는 읽기 전용$/m);
  });
});

// ── 10. 금지 리터럴 ──────────────────────────────────────────────────────────

describe('금지 리터럴', () => {
  it('숨은 문자(BOM·NBSP·zero-width·bidi 등)가 없다 — unicode-hygiene 가 못 보는 NBSP 포함', () => {
    expect(hiddenCodePoints(orcaMd)).toEqual([]);
  });

  it('숨은 문자 스캐너 자기검증: NBSP·BOM·ZWSP 를 각각 잡고 평문은 안 잡는다', () => {
    for (const cp of [0x00a0, 0xfeff, 0x200b, 0x202e]) {
      expect(hiddenCodePoints(`a${String.fromCodePoint(cp)}b`)).toEqual([{ line: 1, cp: cp.toString(16) }]);
    }
    expect(hiddenCodePoints('평문 — · ∧ → 와 ASCII')).toEqual([]);
  });

  it('상태 디렉터리 리터럴과 드라이브 사용자 경로를 추가 줄에 쓰지 않는다 (land 인용 게이트)', () => {
    expect(orcaMd.includes(SPLIT_DIR_LITERAL)).toBe(false);
    expect(DRIVE_USERS.test(orcaMd)).toBe(false);
    expect(orcaMd.includes(SPLIT_DIR_LITERAL.replace(/\/$/, '') + '/locks')).toBe(false);
    expect(DRIVE_USERS.test('C:' + '\\' + 'Us' + 'ers' + '\\' + 'x')).toBe(true); // 양성 대조
  });

  it('탭 문자를 쓰지 않는다', () => {
    expect(orcaMd.includes('\t')).toBe(false);
  });
});

// ── 11. 문서가 지목한 것의 실재 — 설정 키 · 상태 파일 경로 · 스크립트 flag ─────────────

describe('문서 ↔ 설정 · 상태 파일', () => {
  // 낱말 경계 토큰으로 읽는다 — `--agent <orca.agent>` 처럼 더 큰 코드 스팬 안의 키도 잡고, 경로(`commands/split.md`)는 건너뛴다.
  const keyRe = /(?<![\w/.-])((?:orca|split)\.[A-Za-z]+(?:\.[A-Za-z]+)*)(?![\w/-])/g;
  const keys = [...new Set([...orcaMd.matchAll(keyRe)].map((m) => m[1]))];

  it('설정 키 스캐너 자기검증: 스팬 안 키는 잡고 경로·확장자 이름은 안 잡는다', () => {
    const sample = '`--agent <orca.agent>` 와 `split.maxWindows` 와 commands/split.md 와 `orca.launch.requireApproval`.';
    expect([...sample.matchAll(keyRe)].map((m) => m[1])).toEqual(['orca.agent', 'split.maxWindows', 'orca.launch.requireApproval']);
  });

  it('문서가 이름으로 부르는 설정 키를 충분히 찾는다 (0건이면 아래 단언이 공허하다)', () => {
    expect(keys.length).toBeGreaterThanOrEqual(9);
    for (const k of ['orca.enabled', 'orca.agent', 'orca.branchPrefix', 'orca.worktreeSetup', 'orca.launch.requireApproval', 'orca.stallCheckMinutes']) {
      expect(keys, `문서에 ${k} 가 없다`).toContain(k);
    }
  });

  it.each(keys)('설정 키 %s 가 artibot.config.json 에 실재한다', (key) => {
    const value = key.split('.').reduce((acc, part) => (acc !== null && typeof acc === 'object' ? acc[part] : undefined), config);
    expect(value, `artibot.config.json 에 ${key} 가 없다`).not.toBeUndefined();
  });

  it('상태 파일 경로(.artibot/orca/run.json)가 lib/git/orca-run-file.js 와 같다', () => {
    expect(orcaMd).toContain('`<parentRoot>` 아래 `.artibot/orca/`');
    expect(read('lib/git/orca-run-file.js')).toMatch(/path\.join\(parentRoot,\s*'\.artibot',\s*'orca',\s*'run\.json'\)/);
  });
});

describe('문서 ↔ scripts/orca (L4·L5 산출물이 있어야 한다 — 부재는 red, 조용히 건너뛰지 않는다)', () => {
  const calls = scriptCalls(orcaMd);

  it('문서가 부르는 스크립트 집합이 DOC_SCRIPTS 와 같다 (새 스크립트 참조는 이 핀도 함께 고친다)', () => {
    expect([...calls.keys()].sort()).toEqual([...DOC_SCRIPTS].sort());
  });

  it('스캐너 자기검증: 풀 경로·약식·서브커맨드·대괄호 flag 를 읽고 다른 스크립트는 무시한다', () => {
    const sample = [
      'node "<pluginRoot>/scripts/orca/bind.mjs" worktree <limb> --worktree "x"',
      '`status.mjs mail --file <f> --json` 와 `node "<pluginRoot>/scripts/orca/status.mjs" [--fetch] [--json]`',
      '`land.mjs <limb> --plan <p>` 는 split 의 것이다',
    ].join('\n');
    const got = scriptCalls(sample);
    expect([...got.get('bind').subs]).toEqual(['worktree']);
    expect([...got.get('bind').flags]).toEqual(['--worktree']);
    expect([...got.get('status').subs]).toEqual(['mail']);
    expect([...got.get('status').flags].sort()).toEqual(['--fetch', '--file', '--json']);
    expect(got.has('land')).toBe(false);
  });

  it.each(DOC_SCRIPTS)('scripts/orca/%s.mjs 가 있고 문서가 쓰는 flag·서브커맨드가 소스에 있다', (name) => {
    const rel = `scripts/orca/${name}.mjs`;
    expect(exists(rel), `${rel} 가 없다 — L4/L5 산출물이 아직 착지하지 않았거나 이름이 바뀌었다`).toBe(true);
    const source = read(rel);
    const { flags, subs } = calls.get(name);
    for (const flag of flags) expect(sourceHasFlag(source, flag), `${rel} 소스에 ${flag} 가 없다`).toBe(true);
    for (const sub of subs) expect(sourceHasWord(source, sub), `${rel} 소스에 서브커맨드 ${sub} 가 없다`).toBe(true);
  });

  it('스캐너 자기검증: 소스에 없는 flag·낱말은 잡힌다', () => {
    expect(sourceHasFlag("const a = '--json';", '--json')).toBe(true);
    expect(sourceHasFlag("options: { 'human-wait': { type: 'boolean' } }", '--human-wait')).toBe(true);
    expect(sourceHasFlag("const a = '--json';", '--nope')).toBe(false);
    expect(sourceHasWord("case 'summary':", 'summary')).toBe(true);
    expect(sourceHasWord("const summarize = 1;", 'summary')).toBe(false);
  });
});
