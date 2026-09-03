/**
 * Gate — `/scorecard` gained two flags and lost nothing.
 *
 * WHY THIS GATE EXISTS
 * ---------------------------------------------------------------------------
 * PRD §3 draws the Phase 0 boundary at "출력 무변경", and lists `/scorecard`'s
 * new flags as the ONE thing allowed through it: "`/scorecard` 의 신규 플래그는
 * 기존 출력 경로를 건드리지 않으므로 유지". "Does not touch" is a claim, and a
 * claim about a Markdown file that a model edits is exactly the kind that decays
 * quietly — a reworded sentence in the `--diff` section changes what the command
 * does without changing anything a test would normally look at.
 *
 * So the baseline is not a copy kept here. It is `git show HEAD:` of the file,
 * read on every run. A copy in this file would be a second source of truth for
 * the command body, and the two would drift the first time someone updated one.
 *
 * ── WHAT THIS GATE CANNOT SEE ───────────────────────────────────────────────
 *   - WHETHER THE NEW SECTION IS CORRECT. It checks the snippet is present and
 *     names the port handoff. It does not execute it, so an argv-parsing bug or
 *     a wrong path in the Bash block passes here. Nothing in this repo executes
 *     a command body; that gap is the command layer's, not this file's.
 *   - DRIFT AFTER THIS COMMIT. The baseline is HEAD. Once this change lands,
 *     HEAD contains the new sections and the invariance assertions become
 *     tautological for anything added later — they will still catch DELETION of
 *     the old text, which is the failure mode that matters, but they stop
 *     policing additions. A later wave that changes the `--diff` section must
 *     be caught by review, not by this file.
 *   - THE FRONTMATTER'S EFFECT. `argument-hint` is a display string; nothing
 *     asserts the harness parses `--session` out of it, because nothing here
 *     runs the harness.
 *   - NON-COMMAND SURFACES. README, CHANGELOG and skills could describe
 *     `/scorecard` differently and this gate would not look there. Those files
 *     are outside T-42's ownership.
 *
 * @module tests/scorecard/command-doc
 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const REPO_ROOT = path.resolve(PLUGIN_ROOT, '..', '..');
const DOC_PATH = path.join(PLUGIN_ROOT, 'commands', 'scorecard.md');
const GIT_PATH = 'plugins/artibot/commands/scorecard.md';

/** Read as UTF-8 with CRLF normalized — the repo checks out CRLF on this host. */
const norm = (s) => s.replace(/\r\n/g, '\n');
const current = norm(readFileSync(DOC_PATH, 'utf-8'));

/**
 * The committed version of the command body.
 *
 * Read through git rather than kept as a literal here. A failure to read it is
 * thrown rather than skipped: a gate that silently passes when it cannot obtain
 * its baseline is worse than no gate, because it reports green for the exact
 * condition it was built to detect.
 *
 * @returns {string} HEAD's copy, newline-normalized.
 */
function headVersion() {
  const out = execFileSync('git', ['show', `HEAD:${GIT_PATH}`], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    maxBuffer: 4 * 1024 * 1024,
  });
  return norm(out);
}

const head = headVersion();

/**
 * Extract a section: its heading line through to the next heading of the same
 * or a higher level.
 *
 * @param {string} text - document.
 * @param {string} heading - the heading line, verbatim (e.g. `## 출력`).
 * @returns {string} the section including its heading.
 */
function sectionOf(text, heading) {
  const lines = text.split('\n');
  const level = heading.match(/^#+/)[0].length;
  const start = lines.indexOf(heading);
  expect(start, `heading 없음: ${JSON.stringify(heading)}`).toBeGreaterThanOrEqual(0);
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

/**
 * Is `sub` a subsequence of `all` — same lines, same relative order?
 *
 * Order matters. A containment check on a set would pass a document whose
 * sections had been shuffled, and a reordered command body is a changed command
 * body.
 *
 * @param {string[]} sub - lines that must survive.
 * @param {string[]} all - lines of the current document.
 * @returns {string|null} the first line that broke the order, or null.
 */
function firstOutOfOrder(sub, all) {
  let cursor = 0;
  for (const wanted of sub) {
    const at = all.indexOf(wanted, cursor);
    if (at === -1) return wanted;
    cursor = at + 1;
  }
  return null;
}

// ---------------------------------------------------------------------------
describe('/scorecard — 기존 본문 무변경', () => {
  it('HEAD 에서 사라진 줄은 교체된 argument-hint 뿐이다', () => {
    // 이 어서션은 T-42 가 착지하기 전과 후에 모두 그린이어야 한다. 착지 전 HEAD 는
    // 옛 argument-hint 를 갖고 있으므로 removed 는 그 한 줄이고, 착지 후 HEAD 는
    // 새 줄을 갖고 있으므로 removed 는 빈 배열이다. 등식으로 고정하면 이 게이트가
    // 자기 커밋 직후 레드가 되고, 그때 사람이 하는 일은 게이트를 지우는 것이다.
    // 허용되는 것은 "argument-hint 한 줄의 교체"뿐이고 그 외 삭제는 전부 레드다.
    const currentLines = new Set(current.split('\n'));
    const removed = head.split('\n').filter((l) => !currentLines.has(l));
    expect(removed.filter((l) => !l.startsWith('argument-hint:'))).toEqual([]);
    expect(removed.length).toBeLessThanOrEqual(1);
  });

  it('남은 HEAD 줄이 전부 같은 순서로 남아 있다 (재배치도 변경이다)', () => {
    const kept = head.split('\n').filter((l) => !l.startsWith('argument-hint:'));
    const broke = firstOutOfOrder(kept, current.split('\n'));
    expect(broke, `순서가 깨진 첫 줄: ${JSON.stringify(broke)}`).toBeNull();
  });

  it.each([
    ['### 채점 (기본 / `--baseline`)'],
    ['### 전후 비교 (`--diff`)'],
    ['### 목록 (`list`)'],
    ['## 출력'],
    ['## 제약 / 안전'],
    ['## Next Steps'],
  ])('%s 절이 바이트 그대로다', (heading) => {
    expect(sectionOf(current, heading)).toBe(sectionOf(head, heading));
  });

  it('기존 엔진 경로의 CLI 호출이 그대로다 (add·diff·list)', () => {
    for (const sub of ['node "$ENGINE" add', 'node "$ENGINE" diff', 'node "$ENGINE" list']) {
      expect(current, `${sub} 가 사라졌다`).toContain(sub);
    }
    expect(current).toContain('lib/planning/scorecard.js');
  });

  it('description 과 allowed-tools 는 손대지 않았다', () => {
    const line = (text, prefix) => text.split('\n').find((l) => l.startsWith(prefix));
    expect(line(current, 'description:')).toBe(line(head, 'description:'));
    expect(line(current, 'allowed-tools:')).toBe(line(head, 'allowed-tools:'));
  });
});

// ---------------------------------------------------------------------------
describe('/scorecard — 신규 플래그', () => {
  const hint = current.split('\n').find((l) => l.startsWith('argument-hint:'));

  it('argument-hint 가 기존 3종을 유지한 채 2종을 더 싣는다', () => {
    for (const flag of ['--baseline', '--diff', '--areas <n>', '--session [id]', '--routing']) {
      expect(hint, `argument-hint 에 ${flag} 없음`).toContain(flag);
    }
  });

  it('Arguments 절이 기존 세 줄을 그대로 두고 두 줄을 더 싣는다', () => {
    // 줄 수 증가분을 2 로 못박지 않는 이유는 위 removed 어서션과 같다 — 착지 후
    // HEAD 에는 이미 다섯 줄이 있어 증가분이 0 이 된다. 고정해야 하는 것은
    // "기존 세 줄이 순서대로 살아 있고, 새 두 줄이 있다" 이지 산술 차이가 아니다.
    const before = sectionOf(head, '## Arguments').split('\n');
    const after = sectionOf(current, '## Arguments').split('\n');
    expect(firstOutOfOrder(before.filter((l) => !l.startsWith('- `--session')
      && !l.startsWith('- `--routing')), after)).toBeNull();
    // `--baseline` 은 "(없음) 또는 `--baseline` →" 형태라 줄머리가 아니다. 플래그
    // 토큰의 존재만 본다 — 문장 형태를 고정하면 위 무변경 어서션과 중복이다.
    for (const flag of ['`--baseline`', '`--diff`', '`--areas <n>`']) {
      expect(after.some((l) => l.includes(flag)), `${flag} 없음`).toBe(true);
    }
    expect(after.filter((l) => l.startsWith('- `--session [id]`'))).toHaveLength(1);
    expect(after.filter((l) => l.startsWith('- `--routing`'))).toHaveLength(1);
  });

  it('신규 절이 포트 주입 두 단계를 이름으로 적는다', () => {
    const section = sectionOf(current, '### 세션/라우팅 카드 (`--session` / `--routing`)');
    expect(section).toContain('readAllEvents');
    expect(section).toContain('loadReplay');
    expect(section).toContain('buildSessionScorecard');
    expect(section).toContain('buildRoutingScorecard');
    expect(section).toContain('renderScorecardMarkdown');
  });

  it('신규 절이 저장 없음과 unmeasured 규칙을 명시한다', () => {
    const section = sectionOf(current, '### 세션/라우팅 카드 (`--session` / `--routing`)');
    expect(section).toContain('아무것도 저장하지 않는다');
    expect(section).toMatch(/`unmeasured` 로 렌더된다/);
    expect(section).toContain('`0%` 로 쓰지 않는다');
  });

  it('신규 절이 기존 엔진과 다른 엔진임을 먼저 말한다', () => {
    // 같은 커맨드 안에 두 엔진이 있는 것이 이 절의 가장 큰 오해 지점이다.
    const section = sectionOf(current, '### 세션/라우팅 카드 (`--session` / `--routing`)');
    expect(section).toContain('lib/scorecard/');
    expect(section).toContain('.artibot/scorecard.json');
  });
});

// ---------------------------------------------------------------------------
describe('완료 블록은 여전히 렌더되지 않는다 (T-48 경계)', () => {
  it.each([
    ['📊 작업 진행률'],
    ['🎉 작업 완료'],
    ['✅ 완료 {done} / 전체 {total}'],
    ['└ 현재 단계:'],
    ['✓ MISSION COMPLETE'],
    ['Running independent review'],
  ])('scorecard.md 에 %s 가 없다', (needle) => {
    // tests/firewall/command-output-invariance.test.js 가 커맨드 전건을 보지만,
    // 이 파일이 이 커맨드를 편집하므로 여기에도 둔다 — 편집자 옆의 가드다.
    expect(current).not.toContain(needle);
  });
});
