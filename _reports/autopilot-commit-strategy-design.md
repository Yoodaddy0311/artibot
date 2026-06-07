# Autopilot Commit Strategy Redesign
## "의미 단위 커밋" (Semantic Commit) 전환 설계

```
Date:     2026-05-26
Author:   Artibot /implement pipeline
Status:   DESIGN REVIEW
Version:  Artibot v4.13.1 → v4.14.0
```

---

## 1. 현재 문제

### 커밋 빈도 문제
| 시나리오 | 현재 동작 | 문제 |
|---------|----------|------|
| closeOnStop=true | 매 턴마다 `chore: artibot session close` 커밋 | **커밋 스팸** — 세션당 수십 개 |
| closeOnStop=false (현재 기본값) | 120분 간격 WIP 커밋 | 4시간 세션 = 2개 WIP, 맥락 없는 커밋 메시지 |
| autopilot 7-phase | 타이머 기반, phase 무관 | **의미 단위가 아님** — PLAN 중간에 커밋 발생 가능 |

### 히스토리 오염
```
git log --oneline (현재)
─────────────────────────
a1b2c3d wip: artibot auto-save 2026-05-26 14:30:00
e4f5g6h wip: artibot auto-save 2026-05-26 12:30:00
i7j8k9l wip: artibot auto-save 2026-05-26 10:30:00
m0n1o2p chore: artibot session close 2026-05-26 09:15:00
...

git log --oneline (목표)
─────────────────────────
x1y2z3a feat(autopilot): implement user auth flow [EXECUTE complete]
b4c5d6e docs(autopilot): plan user auth implementation [PLAN complete]
```

---

## 2. 벤치마크 분석

### 업계 패턴 비교

| 도구 | 커밋 단위 | 롤백 방식 | 히스토리 오염 | 평가 |
|------|----------|----------|-------------|------|
| **Codex Cloud** | 태스크 완료 시 1개 | git revert | 낮음 | 이상적이나 클라우드 전용 |
| **Hermes Agent** | 섀도우 ref (매 턴) | /rollback | **제로** | 가장 깔끔, 복잡도 높음 |
| **ConTree** | VM 스냅샷 | 포크/리버트 | **제로** | 인프라 종속 |
| **Aider** | 매 편집마다 atomic | git revert | 높음 | 쌍 프로그래밍에만 적합 |
| **Antigravity** | 안정 마일스톤 | TBD | 낮음 | Artibot 목표와 일치 |
| **GitButler** | 에이전트 관리 | 무제한 undo | 낮음 | 별도 클라이언트 필요 |

### 핵심 인사이트
1. **"커밋은 의미 단위로, 안전망은 git 외부로"** — Hermes/ConTree/Claude Code 공통 패턴
2. **섀도우 ref** 패턴은 zero-dep로 구현 가능 (git plumbing 명령만 사용)
3. **Squash-on-complete 논쟁**: AI 코드에서는 bisect 불가 → 오히려 세분화 유지가 유리하다는 반론 있음

---

## 3. 설계: 3-레이어 커밋 전략

```
┌─────────────────────────────────────────────┐
│          Layer 3: Semantic Commits           │
│  Phase 완료 시에만 의미 있는 커밋 생성        │
│  PLAN → EXECUTE → VERIFY → REPORT           │
├─────────────────────────────────────────────┤
│          Layer 2: Stash Checkpoints          │
│  크래시 안전망 — git stash (히스토리 무오염)   │
│  configurable interval (기본 30분)           │
├─────────────────────────────────────────────┤
│          Layer 1: File Snapshots             │
│  Claude Code /rewind 네이티브 체크포인트 활용  │
│  매 턴마다 자동 (기존 인프라)                 │
└─────────────────────────────────────────────┘
```

### Layer 1: File Snapshots (변경 없음)
- Claude Code 네이티브 `/rewind` 기능 그대로 활용
- Write/Edit 도구 사용 시 자동 스냅샷
- **변경 불필요** — 이미 작동 중

### Layer 2: Stash Checkpoints (WIP 커밋 대체)
**현재**: `git add -A && git commit -m "wip: artibot auto-save"` (120분 간격)
**변경**: `git stash push --include-untracked -m "artibot-checkpoint-{phase}-{timestamp}"`

```
동작 흐름:
1. UserPromptSubmit 훅에서 interval 체크 (기본 30분)
2. 변경사항 있으면 git stash push (커밋 아님!)
3. 최대 N개 stash 유지 (기본 10개), 초과 시 oldest drop
4. 크래시 복구: git stash list → git stash pop

장점:
- git log 완전히 깨끗 (stash는 reflog에만 존재)
- 복구 가능성 유지
- 간격을 30분으로 줄여도 히스토리 무오염

단점:
- stash는 장기 저장에 부적합 (gc 대상)
- 브랜치 전환 시 stash 충돌 가능
```

### Layer 3: Semantic Commits (Phase 기반)
**현재**: 타이머 기반 WIP 커밋 (120분)
**변경**: autopilot phase 완료 시에만 커밋

```
커밋 타이밍:
┌──────────┬────────────────────────────────────────┐
│ Phase    │ 커밋 조건                               │
├──────────┼────────────────────────────────────────┤
│ INTAKE   │ 커밋 안 함 (요구사항 분석만)             │
│ PLAN     │ PRD/계획 파일 생성 시 커밋              │
│ EXECUTE  │ 구현 완료 + 테스트 통과 시 커밋          │
│ CROSS_CHECK│ 커밋 안 함 (리뷰만)                   │
│ VERIFY   │ 검증 완료 시 커밋 (린트/타입체크 통과)   │
│ IMPROVE  │ 개선 사항 있으면 커밋                   │
│ REPORT   │ 최종 리포트 커밋                        │
└──────────┴────────────────────────────────────────┘

커밋 메시지 포맷:
  {type}(autopilot): {summary} [{phase} complete]

예시:
  docs(autopilot): plan user auth implementation [PLAN complete]
  feat(autopilot): implement user auth flow [EXECUTE complete]
  fix(autopilot): resolve lint errors in auth module [VERIFY complete]
  docs(autopilot): add session completion report [REPORT complete]

기대 결과: 7-phase 세션에서 최대 4-5개 의미 있는 커밋 (현재 2-3개 무의미 WIP)
```

---

## 4. 구현 설계

### 4.1 변경 파일 목록

| 파일 | 변경 유형 | 변경 내용 |
|------|----------|----------|
| `scripts/hooks/git-autopilot-save.js` | **수정** | WIP 커밋 → stash checkpoint 전환 |
| `scripts/hooks/git-autopilot-close.js` | **수정** | phase 기반 semantic commit 로직 추가 |
| `artibot.config.json` | **수정** | 새 설정 키 추가 |
| `lib/autopilot/wip-stats.js` | **수정** | stash 기반 통계로 전환 |
| `commands/squash.md` | **수정** | stash cleanup 안내 추가 |
| `tests/` | **추가/수정** | 새 동작 테스트 |

### 4.2 설정 변경

```jsonc
// artibot.config.json > git.autopilot
{
  "git": {
    "autopilot": {
      "bypassPreCommitHooks": false,
      "bypassPrePushHooks": false,
      "closeOnStop": false,
      // ── 신규 설정 ──
      "commitStrategy": "semantic",     // "semantic" | "interval" | "none"
      "stashCheckpoint": {
        "enabled": true,
        "intervalMinutes": 30,          // stash 간격 (커밋 아님)
        "maxStashes": 10,               // 최대 유지 stash 수
        "includeUntracked": true        // untracked 파일 포함
      },
      "semanticCommit": {
        "enabled": true,
        "commitOnPhases": ["PLAN", "EXECUTE", "VERIFY", "REPORT"],
        "requireTestPass": true,        // EXECUTE phase: 테스트 통과 필수
        "requireLintClean": true,       // VERIFY phase: 린트 클린 필수
        "messageFormat": "{type}(autopilot): {summary} [{phase} complete]"
      }
    }
  }
}
```

### 4.3 git-autopilot-save.js 변경 (핵심)

```javascript
// 현재 (v4.13.1):
async function createWipCommit(cwd, opts) {
  await exec('git add -A', { cwd });
  await exec(`git commit -m "wip: artibot auto-save ${timestamp}"`, { cwd });
}

// 변경 후 (v4.14.0):
async function createStashCheckpoint(cwd, opts) {
  const phase = opts.currentPhase || 'unknown';
  const label = `artibot-checkpoint-${phase}-${timestamp}`;
  await exec(`git stash push --include-untracked -m "${label}"`, { cwd });
  
  // 최대 stash 수 유지
  const stashCount = await countStashes(cwd, 'artibot-checkpoint-');
  if (stashCount > opts.maxStashes) {
    await dropOldestArtiStash(cwd);
  }
  
  // stash 직후 pop하여 작업 계속 (stash는 백업 역할만)
  await exec('git stash pop', { cwd });
}
```

**핵심 트릭**: `stash push` → 즉시 `stash pop`. stash는 reflog에 기록되지만 작업 디렉토리는 그대로. 크래시 시 `git stash list`로 복구 가능.

### 4.4 Phase 감지 메커니즘

```javascript
// git-autopilot-close.js에서 phase 감지
function detectCurrentPhase(sessionState) {
  // autopilot 세션 상태에서 현재 phase 읽기
  if (!sessionState?.autopilot?.currentPhase) return null;
  return sessionState.autopilot.currentPhase;
}

function shouldCommitForPhase(phase, config) {
  return config.semanticCommit.commitOnPhases.includes(phase);
}

function generateCommitMessage(phase, changes) {
  const type = phase === 'PLAN' ? 'docs'
    : phase === 'EXECUTE' ? 'feat'
    : phase === 'VERIFY' ? 'fix'
    : phase === 'REPORT' ? 'docs'
    : 'chore';
  
  const summary = summarizeChanges(changes); // 변경 파일 기반 요약
  return `${type}(autopilot): ${summary} [${phase} complete]`;
}
```

---

## 5. 6기준 평가

| 기준 | 점수 (1-5) | 근거 |
|------|-----------|------|
| **실용성** | 5 | 커밋 스팸 문제 직접 해결. 히스토리 품질 대폭 개선 |
| **확장성** | 5 | commitStrategy 설정으로 3가지 모드 지원. 새 phase 추가 시 commitOnPhases 배열에 추가만 |
| **효율성** | 5 | stash는 커밋보다 빠름 (tree object만 생성). 불필요한 커밋 I/O 제거 |
| **미래지향성** | 5 | Hermes shadow-ref 패턴과 Codex per-task 패턴의 중간 — 업계 수렴 방향 |
| **생산성** | 4 | 개발자가 git log를 읽을 수 있게 됨. 단, stash 관리 학습 필요 |
| **경제성** | 4 | 기존 훅 파일 수정으로 구현 가능. 새 모듈 불필요 |
| **TOTAL** | **28/30** | **GO** |

---

## 6. 리스크 분석

| 리스크 | 심각도 | 완화 |
|--------|--------|------|
| stash push/pop 사이 크래시 | MEDIUM | stash는 남아있으므로 `git stash pop`으로 복구 |
| stash 충돌 (dirty tree) | LOW | `--include-untracked` + stash pop 전 clean 체크 |
| phase 감지 실패 | LOW | fallback으로 기존 interval WIP 모드 |
| 기존 WIP 커밋 호환 | LOW | `commitStrategy: "interval"` 설정으로 기존 동작 유지 가능 |
| `git stash` gc | MEDIUM | `gc.reflogExpire` 설정으로 stash 보존 기간 확장 |

### 롤백 계획
```jsonc
// 문제 발생 시 즉시 롤백:
{ "commitStrategy": "interval" }  // 기존 WIP 커밋 모드로 복귀
```

---

## 7. 마이그레이션 경로

```
Phase 1 (v4.14.0): 기본 구현
  ├─ commitStrategy 설정 추가 (기본값: "semantic")
  ├─ stash checkpoint 구현
  ├─ phase 기반 semantic commit 구현
  ├─ 기존 interval 모드 fallback 유지
  └─ 테스트 추가

Phase 2 (v4.14.1): 안정화
  ├─ stash gc 보호 설정
  ├─ /doctor에 stash 건강 체크 추가
  └─ wip-stats.js stash 기반 전환

Phase 3 (향후): 선택적 고급 기능
  ├─ shadow ref 패턴 (Hermes 스타일) — 옵트인
  ├─ worktree isolation 연계
  └─ 팀 모드에서 per-teammate stash 격리
```

---

## 8. 비교: Before vs After

```
BEFORE (v4.13.1, 4시간 autopilot 세션)
──────────────────────────────────────
git log:
  wip: artibot auto-save 2026-05-26 14:30:00
  wip: artibot auto-save 2026-05-26 12:30:00
  chore: previous manual commit

커밋 수: 2개 (무의미)
복구 가능: 120분 단위로만

AFTER (v4.14.0, 동일 4시간 세션)
──────────────────────────────────────
git log:
  docs(autopilot): add completion report [REPORT complete]
  feat(autopilot): implement user auth with JWT [EXECUTE complete]
  docs(autopilot): plan user auth implementation [PLAN complete]
  chore: previous manual commit

git stash list:
  stash@{0}: artibot-checkpoint-VERIFY-2026-05-26T14:00
  stash@{1}: artibot-checkpoint-EXECUTE-2026-05-26T13:30
  stash@{2}: artibot-checkpoint-EXECUTE-2026-05-26T13:00
  stash@{3}: artibot-checkpoint-PLAN-2026-05-26T12:30

커밋 수: 3개 (의미 있음)
복구 가능: 30분 단위 (stash), phase 단위 (commit)
```

---

*설계 완료 — 구현 승인 시 /implement로 진행*
