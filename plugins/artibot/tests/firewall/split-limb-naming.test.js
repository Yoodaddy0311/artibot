/**
 * 검사 목적: `/split` 이 만드는 줄기 이름(worktree 이름·브랜치·세션 접두)이
 * **in-process 에이전트·커맨드 이름과 교집합 0** 인가.
 *
 * ── 왜 (공식 스키마 인용, teammate-name-session-discriminator 와 같은 근거) ──
 * `SendMessage` 는 이름 충돌을 조용히 해소한다 — *"if the same name also names
 * an in-process agent, the bare name always wins"*. 줄기 창의 세션 이름이 출하
 * 에이전트 이름과 같아지면 리더의 `SendMessage(to=…)` 가 창이 아니라 자기 세션의
 * 서브에이전트에게 배달되고, 그 오배달은 성공처럼 보인다.
 *
 * 이름 정본은 `lib/git/repo-identity.js` 다(리더 결정 2026-08-26, ADR-002 내장
 * provider 전용): worktree `split-<repo>-<limb>`(`splitWorktreeName`), 브랜치
 * `worktree-split-<repo>-<limb>`(`splitLimbBranch`), bare `split/…` 는
 * `isSplitLimbBranch` 가 거부. `lib/git/limb-completion.js#limbNames` 는 그 정본을
 * 호출하되 slug 를 `^[a-z0-9][a-z0-9-]{1,30}$` 로 먼저 검증한다(정본의 sanitize 는
 * 조용히 고쳐 쓰므로 계획 단계에서는 던지는 쪽이 맞다). 이 파일은 (a) 래퍼 출력이
 * 정본과 문자 단위로 같고 (b) `split-` 접두가 출하 이름 공간에서 비어 있으며
 * (c) 출하 이름을 어느 자리에 넣어도 완성 이름이 출하 이름과 같아질 수 없음을
 * 고정한다 — 규약이 **구조적으로** 충돌을 막는다.
 *
 * ── `agent-name-references.test.js` 를 확장하지 않은 이유 ──────────────────
 * 그 게이트는 "마크다운이 **참조하는** 에이전트 이름이 출하 목록에 있는가"를 본다
 * (참조 → 존재). 여기는 "우리가 **생성하는** 이름이 출하 목록에 없는가"(생성 →
 * 부재)다. 방향이 반대라 한 파일에 섞으면 분모 단언(≥28)이 서로 다른 뜻을 갖게
 * 된다. 스캔 **방식**(agents/*.md 프론트매터 `name:`)만 같이 쓴다.
 *
 * ── 이 게이트가 못 보는 것 (rules §9) ───────────────────────────────────────
 *  1. **세션 이름은 Claude Code 가 짓는다.** 2026-08-26 관측(n=4)은
 *     `{worktree 디렉터리명}-{hex2}` 였다. 하네스가 이 규칙을 바꾸면 접두 보장은
 *     worktree 이름에만 남고 세션 이름에는 남지 않는다 — 규칙은 관측이지 계약이 아니다.
 *  2. **사용자가 손으로 지은 worktree 이름은 대상 밖이다.** `claude --worktree foo`
 *     를 직접 치면 `foo-xx` 가 되고, 그 `foo` 가 에이전트 이름일 수 있다.
 *  3. **`commands/split.md` 가 실제로 정본 이름을 쓰는지는 보지 않는다.**
 *     그 파일은 다른 소유자가 동시 편집 중이라 이 게이트가 읽지 않는다(스냅샷
 *     의존을 피한다). 문서↔모듈 결합은 `split-name-collision.test.js`(cmd 소유)와
 *     그 파일이 정본으로 갱신된 뒤의 별도 단언이 맡는다.
 *  4. **`--worktree` 이름의 `/` 허용 여부는 미확인이다**(프로브 P2). 정본이 하이픈
 *     형만 만들므로 여기서는 하이픈 형만 본다.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { limbNames } from '../../lib/git/limb-completion.js';
import {
  isSplitLimbBranch,
  SPLIT_BRANCH_PREFIXES,
  splitLimbBranch,
  splitWorktreeName,
} from '../../lib/git/repo-identity.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(__dirname, '..', '..');

/** 출하 에이전트 이름 — `agents/*.md` 프론트매터 `name:` 이 정본. */
function shippedAgentNames() {
  const names = new Set();
  for (const f of readdirSync(join(PLUGIN_ROOT, 'agents'))) {
    if (!f.endsWith('.md') || f === 'INDEX.md') continue;
    const m = readFileSync(join(PLUGIN_ROOT, 'agents', f), 'utf-8').match(/^name:\s*(.+)$/m);
    if (m) names.add(m[1].trim());
  }
  return names;
}

/** `commands/*.md` 파일명이 곧 커맨드 이름이다. */
function shippedCommandNames() {
  return new Set(
    readdirSync(join(PLUGIN_ROOT, 'commands'))
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.slice(0, -3)),
  );
}

const SLUG = /^[a-z0-9][a-z0-9-]*$/;

/** 관측된 세션 이름 형태 — worktree 이름 + `-` + hex2. */
function observedSessionName(worktreeName, hex2 = '3f') {
  return `${worktreeName}-${hex2}`;
}

describe('limbNames — 정본 repo-identity.js 와 문자 단위 동일 (리더 결정 2026-08-26: worktree-split-<repo>-<limb>)', () => {
  it('worktree split-<repo>-<limb>, 브랜치 worktree-split-<repo>-<limb>, 세션·팀원 접두 = worktree 이름 + "-"', () => {
    const n = limbNames({ repoShort: 'artibot', limb: 'auth' });
    expect(n).toEqual({
      worktreeName: 'split-artibot-auth',
      branch: 'worktree-split-artibot-auth',
      sessionPrefix: 'split-artibot-auth-',
      teammatePrefix: 'split-artibot-auth-',
    });
    expect(limbNames({ repoShort: 'artibot', limb: 'auth' })).toEqual(n);
    expect(Object.isFrozen(n)).toBe(true);
  });

  it('정본 함수의 출력을 그대로 쓴다 — 여기서 이름을 따로 조립하지 않는다', () => {
    for (const [repo, limb] of [['artibot', 'auth'], ['minute', 'api-v2'], ['ontology', 'x1']]) {
      const n = limbNames({ repoShort: repo, limb });
      expect(n.worktreeName).toBe(splitWorktreeName(repo, limb));
      expect(n.branch).toBe(splitLimbBranch(repo, limb));
      expect(isSplitLimbBranch(n.branch)).toBe(true);
    }
    // PRD 초안의 bare `split/<repo>/<limb>` 는 정본이 거부한다 — 내장 provider 가 만들 수 없는 형태.
    expect(isSplitLimbBranch('split/artibot/auth')).toBe(false);
    expect(SPLIT_BRANCH_PREFIXES).toContain('worktree-split-');
  });

  it('slug 가 아니면 던진다(정본의 sanitize 보다 엄격) — 빈 값·1글자·대문자·슬래시·경로 탈출·선행 하이픈·32자 초과·생략', () => {
    for (const bad of ['', 'a', 'Auth', 'a/b', '..', '-x', 'a b', 'x'.repeat(32), undefined, null, 3]) {
      expect(() => limbNames({ repoShort: 'rr', limb: bad }), JSON.stringify(bad)).toThrow(TypeError);
      expect(() => limbNames({ repoShort: bad, limb: 'ok' }), JSON.stringify(bad)).toThrow(TypeError);
    }
    // 정본은 같은 입력을 조용히 고쳐 쓴다 — 계획 단계에서는 그 관용이 버그를 숨기므로 여기서 막는다.
    expect(splitWorktreeName('rr', 'Auth/x')).toBe('split-rr-Auth-x');
  });
});

describe('줄기 이름 ∩ 출하 이름 = ∅', () => {
  const agents = shippedAgentNames();
  const commands = shippedCommandNames();
  const shipped = new Set([...agents, ...commands]);

  // 분모 먼저. "교집합 0" 이 "0개 스캔" 으로 통과하는 것을 막는다.
  it('스캔한 출하 목록이 하한을 넘는다 (2026-08-26 실측: 에이전트 28 / 커맨드 78+)', () => {
    expect(agents.size, '에이전트를 하나도 읽지 못했다').toBeGreaterThanOrEqual(28);
    expect(commands.size, '커맨드를 하나도 읽지 못했다').toBeGreaterThanOrEqual(78);
  });

  it('출하 이름 공간에 `split-`/`split/` 접두가 비어 있다 (규약이 기대는 전제)', () => {
    // `split` 자체(커맨드)는 접두가 아니라 맨이름이라 허용된다 — 생성 이름은
    // 항상 `split-<repo>-<limb>` 이므로 길이가 다르다.
    const taken = [...shipped].filter((n) => n.startsWith('split-') || n.startsWith('split/'));
    expect(taken).toEqual([]);
  });

  /** 한 limb 에서 나오는 모든 이름 형태: worktree·브랜치·관측 세션·팀원. */
  function allShapes(n) {
    return [
      n.worktreeName,
      n.branch,
      observedSessionName(n.worktreeName),
      `${n.teammatePrefix}afd778-worker`,
    ];
  }

  it('출하 이름을 limb 자리에 넣어도 어느 이름 형태도 출하 이름과 겹치지 않는다', () => {
    const collisions = [];
    for (const name of shipped) {
      if (!SLUG.test(name)) continue; // 규약이 애초에 거부하는 이름
      for (const candidate of allShapes(limbNames({ repoShort: 'artibot', limb: name }))) {
        if (shipped.has(candidate)) collisions.push(candidate);
      }
    }
    expect(collisions).toEqual([]);
  });

  it('출하 이름을 repoShort 자리에 넣어도 마찬가지다', () => {
    const collisions = [];
    for (const name of shipped) {
      if (!SLUG.test(name)) continue;
      for (const candidate of allShapes(limbNames({ repoShort: name, limb: 'worker' }))) {
        if (shipped.has(candidate)) collisions.push(candidate);
      }
    }
    expect(collisions).toEqual([]);
  });

  it('두 리포의 같은 limb 은 repoShort 로 갈리고(기계 전역 ListAgents), 한 리포 안의 다른 limb 도 다른 이름이다', () => {
    const a = limbNames({ repoShort: 'artibot', limb: 'auth' });
    const b = limbNames({ repoShort: 'minute', limb: 'auth' });
    const c = limbNames({ repoShort: 'artibot', limb: 'api' });
    expect(new Set([a.worktreeName, b.worktreeName, c.worktreeName]).size).toBe(3);
    expect(new Set([a.branch, b.branch, c.branch]).size).toBe(3);
    expect(a.sessionPrefix).not.toBe(b.sessionPrefix);
  });
});
