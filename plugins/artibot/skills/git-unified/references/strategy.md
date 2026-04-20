# Git Strategy Recommender

## 목적

팀의 상황(규모, 배포 주기, 환경 수, 릴리즈 방식)을 물어보고
최적의 Git 브랜치 전략을 추천 + 규칙과 설정 방법 안내.

---

## When This Skill Applies

- 새 프로젝트 시작 시 브랜치 전략 결정
- 기존 전략의 문제점 느끼고 변경 검토 중
- 팀원 온보딩 시 전략 문서화 필요

---

## Strategy Matrix

| 전략 | 적합한 팀 | 배포 주기 | 복잡도 |
|------|----------|----------|:------:|
| **Trunk-Based** | 1-5명, CI/CD 완비 | 수시 (하루 여러번) | LOW |
| **GitHub Flow** | 5-15명, 웹 서비스 | 수시~주 1회 | LOW |
| **Git Flow** | 15명+, 버전 릴리즈 | 주기적 (2주~월) | HIGH |
| **GitLab Flow** | 다중 환경 (dev/stage/prod) | 환경별 승격 | MEDIUM |

---

## Workflow

### Step 1: 팀 상황 파악

```
[브랜치 전략 추천]

몇 가지 질문으로 최적 전략을 찾겠습니다:

Q1. 팀 인원은 몇 명인가요?
  1) 1-3명 (개인/소규모)
  2) 4-10명
  3) 11-30명
  4) 30명+
> _

Q2. 배포는 얼마나 자주 하나요?
  1) 하루에도 여러 번 (수시 배포)
  2) 하루 1-2번
  3) 주 1-2회
  4) 2주~월 단위 릴리즈
> _

Q3. 환경은 몇 개인가요?
  1) 1개 (prod만)
  2) 2개 (staging + prod)
  3) 3개+ (dev + staging + prod)
> _

Q4. 릴리즈 버전 관리가 필요한가요?
  1) 네 (v1.0, v1.1 같은 버전 태그)
  2) 아니요 (항상 최신 배포)
> _
```

### Step 2: 전략 추천

답변에 따른 추천 로직:

- `소규모 + 수시 배포 + 버전없음` → **Trunk-Based Development**
- `중간 + 수시~주단위 + 버전없음` → **GitHub Flow**
- `대규모 OR 버전관리` → **Git Flow**
- `다중 환경 + 환경별 승격` → **GitLab Flow**

### Step 3: 추천 전략 상세 안내

#### Trunk-Based Development
```
브랜치 구조:
  main ──────────────────────────── (항상 배포 가능)
        └ feat/x (수명: 1-2일 이내)

규칙:
- 브랜치는 1-2일 이내에 main으로 머지
- Feature flags로 미완성 기능 숨기기
- PR 없이도 가능 (소규모), 있으면 빠른 리뷰
- main = 항상 배포 가능 상태

설정:
  main 브랜치 보호: require PR review (선택)
  CI: 모든 커밋에 자동 테스트
```

#### GitHub Flow
```
브랜치 구조:
  main ──────────────────────────── (항상 배포 가능)
        └ feat/기능명 (PR로 머지)
        └ fix/버그명 (PR로 머지)

규칙:
- main에서 분기, PR로 머지
- PR = 코드 리뷰 + CI 통과 필수
- 머지 = 즉시 배포 (또는 수동 트리거)

설정:
  main 브랜치 보호: require PR + 1 review + CI pass
```

#### Git Flow
```
브랜치 구조:
  main ─────────────────────────── (릴리즈 태그)
  develop ────────────────────────  (다음 릴리즈 준비)
        └ feat/기능명
        └ release/v1.2.0
        └ hotfix/긴급버그
```

#### GitLab Flow
```
브랜치 구조:
  main → staging → production (환경별 승격)
  feat/* → main (PR로 머지)
```

### Step 4: 규칙 문서 생성

요청 시 `.github/CONTRIBUTING.md` 또는 `docs/git-strategy.md` 생성:
- 브랜치 네이밍 규칙
- PR 생성 규칙
- 머지 전 체크리스트
- 커밋 컨벤션 (workflow 참조)

---

## 전략 전환 가이드

기존 전략에서 다른 전략으로 마이그레이션:

| 전환 | 주의사항 |
|------|---------|
| Git Flow → GitHub Flow | `develop` 브랜치 정리, release 프로세스 간소화 |
| GitHub Flow → Trunk-Based | Feature flag 시스템 먼저 구축 필요 |
| 단일 브랜치 → Git Flow | 기존 커밋을 develop으로 이동 |

---

## Checklist

- [ ] 팀 규모, 배포 주기, 환경 수, 버전 관리 여부 모두 확인
- [ ] 추천 전략의 장단점 함께 설명
- [ ] 브랜치 보호 규칙 설정 방법 안내
- [ ] 요청 시 규칙 문서 생성

## Guardrails

- 단 하나의 "정답" 전략은 없음 — 항상 트레이드오프 설명
- 전략 전환 시 기존 브랜치/히스토리 영향 반드시 경고
- Git Flow는 소규모 팀에게 과도하게 복잡할 수 있음을 명시
- 추천은 팀 상황 기반 — 강요하지 않고 최종 선택은 사용자에게

## Rationalizations

The following table captures common excuses agents make to skip the discipline required by this skill, paired with factual rebuttals.

| Excuse | Rebuttal |
|--------|----------|
| "git flow works for everyone" | git flow was designed for versioned desktop releases — it is overkill for continuous delivery web apps |
| "trunk-based requires feature flags we don't have" | you can adopt trunk-based incrementally; the flags come with it, not before it |
| "long-lived branches are fine for big features" | long-lived branches become merge disasters — slice the feature behind a flag instead |
| "we'll pick a strategy when we grow" | by the time you grow, the ad-hoc strategy is entrenched; choose early even for small teams |
| "release branches protect stability" | release branches protect nothing if hotfixes skip them; pick one path and enforce it |
