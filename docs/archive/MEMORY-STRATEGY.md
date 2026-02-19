# MEMORY-STRATEGY.md - Artibot 메모리 시스템 최적화 전략

## 1. 현행 분석

### 1.1 프로젝트별 메모리 현황

| 프로젝트 | 메모리 파일 수 | MEMORY.md 줄 수 | 토픽 파일 | 세션 파일 |
|----------|---------------|-----------------|----------|----------|
| Artibot | 6 | 85줄 | 4 (arch, dev-protocol, lessons, team) | 1 (session-logs) |
| certpractice-ai | 11 | 158줄 | 2 (build-errors, team-playbook) | 5 (session-*, changelog) |

### 1.2 발견된 문제점

**MEMORY.md 비대화**
- certpractice-ai MEMORY.md: 158줄, 200줄 제한에 근접
- 완료된 기능 상세 (v2 gamification, leaderboard 등)가 MEMORY.md에 남아 토큰 소비
- 세션별 기록이 MEMORY.md 본문에 인라인되어 구조적 분리 부족

**중복 콘텐츠**
- team-structure.md와 MEMORY.md의 팀 구성 테이블 중복
- team-playbook.md (certpractice-ai)와 development-protocol.md (Artibot) 80% 동일
- lessons-learned.md와 MEMORY.md의 "Critical Gotchas" 섹션 중복

**세션 로그 비효율**
- certpractice-ai: `session-0212-*`, `session-0213-*` 등 날짜 기반 파일 5개
- 참조 빈도 낮은 완료 세션 상세가 디스크와 인덱스 공간 차지
- Artibot의 session-logs.md는 단일 파일에 모든 세션 기록 (확장성 부족)

**토픽 분류 불명확**
- architecture-decisions.md: 기술 스택 + 아키텍처 원칙 + 디자인 시스템 혼합
- 도메인별 분리가 아닌 문서 유형별 분리 (기능 관점에서 비효율)

**컨텍스트 보존 한계**
- 세션 인수인계 형식은 정의되어 있으나 자동화된 메커니즘 없음
- "다음 세션 점검 사항" 체크리스트가 실제로 소비/처리되는 워크플로우 부재

### 1.3 잘 작동하는 패턴

- **Quick Reference Links** (MEMORY.md 상단): 토픽 파일 빠른 참조
- **심각도 기반 리포트** (CRITICAL/HIGH/MEDIUM/LOW): 검색 용이
- **검증됨 태그** (예: "검증됨 2026-02-13"): 패턴 신뢰도 표시
- **교훈 섹션**: 반복 실수 방지에 직접 기여
- **build-errors.md**: 빌드 트러블슈팅 전용 파일 분리 (높은 참조 빈도)

---

## 2. 최적 MEMORY.md 구조 설계

### 2.1 설계 원칙

1. **200줄 제한 엄수**: MEMORY.md는 인덱스 + 핵심 규칙만. 상세는 토픽 파일로.
2. **Hot/Cold 분리**: 자주 참조되는 정보(Hot) vs 아카이브(Cold) 명확히 구분
3. **DRY**: 동일 정보가 두 곳 이상에 존재하지 않도록
4. **검색 친화적**: 일관된 태그, 심각도 마커, 파일명 규약
5. **자동 감쇠**: 완료된 항목은 일정 기간 후 아카이브로 이동

### 2.2 권장 MEMORY.md 템플릿

```markdown
# [Project Name] Memory

## Project Identity
- **Service**: [한 줄 설명]
- **Stack**: [핵심 기술 3-5개]
- **Repo**: [git remote URL]

## Topic Files
- [tech-stack.md](tech-stack.md) - 기술 스택, 아키텍처, 디자인 시스템
- [gotchas.md](gotchas.md) - 반복 실수 방지, 빌드 에러 패턴
- [team-ops.md](team-ops.md) - 팀 구성, 워크플로우, 프로토콜
- [decisions.md](decisions.md) - 아키텍처 결정, 검증된 패턴
- [session-latest.md](session-latest.md) - 최근 세션 상태 (1개만 유지)
- [archive/](archive/) - 완료된 세션 로그 (Cold)

## Active Rules (항상 적용)
1. [규칙 1]
2. [규칙 2]
...최대 10개

## Current State
- **Phase**: [현재 개발 단계]
- **Active Feature**: [진행 중인 작업]
- **Last Session**: [날짜] - [요약]
- **Blockers**: [차단 요인]

## Next Session Checklist
- [ ] [점검 항목 1]
- [ ] [점검 항목 2]
...최대 10개

## User Preferences
- [설정 1]
- [설정 2]
```

**예상 줄 수**: 60-80줄 (여유 확보)

### 2.3 줄 수 예산 배분

| 섹션 | 줄 수 | 비율 |
|------|-------|------|
| Project Identity | 5줄 | 3% |
| Topic Files (인덱스) | 10줄 | 5% |
| Active Rules | 25줄 | 13% |
| Current State | 15줄 | 8% |
| Next Session Checklist | 15줄 | 8% |
| User Preferences | 10줄 | 5% |
| **여유 버퍼** | **120줄** | **60%** |
| **합계** | **200줄** | **100%** |

60% 여유는 프로젝트 성장에 따른 규칙 추가 + 임시 메모를 위한 공간.

---

## 3. 토픽별 메모리 파일 분류 체계

### 3.1 표준 파일 구조

```
memory/
├── MEMORY.md              # 인덱스 + 핵심 규칙 (200줄 제한)
├── tech-stack.md           # 기술 스택, 의존성, 빌드 설정
├── gotchas.md              # 반복 실수, 빌드 에러, 트러블슈팅
├── team-ops.md             # 팀 구성, 워크플로우, 프로토콜
├── decisions.md            # 아키텍처 결정, 검증된 패턴
├── session-latest.md       # 최근 세션 상태 (롤링: 항상 최신 1개)
└── archive/                # Cold 스토리지
    ├── session-YYYYMMDD-topic.md
    └── ...
```

### 3.2 파일별 책임과 크기 제한

| 파일 | 책임 | 최대 줄 수 | 갱신 빈도 |
|------|------|-----------|----------|
| MEMORY.md | 인덱스, 핵심 규칙, 현재 상태 | 200 | 매 세션 |
| tech-stack.md | 기술 선택, 빌드 설정, 디자인 시스템 | 150 | 스택 변경 시 |
| gotchas.md | 반복 실수, 에러 패턴, 체크리스트 | 200 | 이슈 발견 시 |
| team-ops.md | 팀 구성, 역할, 프로토콜 | 100 | 팀 변경 시 |
| decisions.md | ADR(Architecture Decision Record) | 200 | 결정 시 |
| session-latest.md | 최근 세션 컨텍스트 | 100 | 매 세션 |

### 3.3 파일명 규약

- **토픽 파일**: `kebab-case.md` (예: `tech-stack.md`, `team-ops.md`)
- **아카이브**: `session-YYYYMMDD-topic.md` (예: `session-20260213-i18n.md`)
- **금지**: 날짜 접두사 토픽 파일, 번호 접미사, 대문자(MEMORY.md 제외)

---

## 4. 세션 간 컨텍스트 보존 전략

### 4.1 롤링 세션 패턴

**현행 문제**: 세션 파일이 무한 누적 (certpractice-ai: 5개 세션 파일)

**개선안: 롤링 1+N 패턴**
```
session-latest.md  ← 항상 최신 세션 (덮어쓰기)
archive/           ← 이전 세션 (Cold, 필요시만 참조)
```

1. 세션 시작 시: `session-latest.md` 읽어 이전 컨텍스트 복원
2. 세션 중: `session-latest.md`에 실시간 업데이트
3. 세션 종료 시:
   - 현재 `session-latest.md`를 `archive/session-YYYYMMDD-topic.md`로 복사
   - `session-latest.md`를 새 세션 상태로 갱신
   - MEMORY.md의 "Current State"와 "Next Session Checklist" 갱신

### 4.2 세션 인수인계 템플릿

```markdown
# Session: YYYY-MM-DD [Topic]

## Summary
- [1-2줄 요약]

## Completed
- [완료 항목 리스트]

## In Progress
- [진행 중 항목 + 현재 상태]

## Decisions Made
- [결정 사항 + 근거]

## Discovered Issues
- [발견된 이슈 + 심각도]

## Next Steps
- [ ] [다음 액션 아이템]

## Promoted to Permanent Memory
- [gotchas.md에 추가된 항목]
- [decisions.md에 추가된 항목]
```

### 4.3 컨텍스트 승격 메커니즘

세션 중 발견된 정보의 영속성 판단:

| 정보 유형 | 승격 대상 | 판단 기준 |
|----------|----------|----------|
| 반복 실수 패턴 | gotchas.md | 2회 이상 발생 또는 CRITICAL 심각도 |
| 기술 결정 | decisions.md | 아키텍처/스택에 영향 |
| 팀 프로토콜 변경 | team-ops.md | 운영 방식 변경 |
| 빌드/배포 이슈 | gotchas.md | 재현 가능한 에러 |
| 검증된 패턴 | decisions.md | 2+ 세션에서 효과 확인 |
| 사용자 선호 변경 | MEMORY.md | 직접 요청 |

**승격 없는 정보**: 세션별 태스크 상세, 커밋 해시, 임시 디버그 기록 -> archive/로 이동

---

## 5. 자동 학습/패턴 기록 메커니즘

### 5.1 기록 트리거

| 트리거 | 기록 대상 | 자동/수동 |
|--------|----------|----------|
| 빌드 실패 후 해결 | gotchas.md | 자동 (빌드 에러 + 해결책) |
| 동일 이슈 2회 발생 | gotchas.md (우선순위 UP) | 자동 |
| 사용자 "기억해" 요청 | MEMORY.md 또는 적절 토픽 | 수동 즉시 |
| 사용자 "잊어" 요청 | 해당 항목 삭제 | 수동 즉시 |
| 아키텍처 결정 | decisions.md | 반자동 (결정 감지 시 제안) |
| 새 라이브러리 도입 | tech-stack.md | 반자동 |
| 세션 종료 | session-latest.md 갱신 | 자동 |
| 팀원 실수 패턴 | gotchas.md | 자동 (리포트 분석 후) |

### 5.2 감쇠 메커니즘 (Decay)

메모리가 무한 증가하는 것을 방지:

**Hot -> Warm -> Cold 전이**
- **Hot** (MEMORY.md, 토픽 파일): 활발히 참조, 수정 가능
- **Warm** (session-latest.md): 최근 세션, 다음 세션에서 참조
- **Cold** (archive/): 이전 세션, 필요시만 검색

**감쇠 규칙**:
1. 완료된 기능 상세: 세션 종료 시 archive/로 이동. MEMORY.md에는 1줄 요약만 유지.
2. 3세션 이상 참조 안 된 gotchas 항목: "검증 필요" 태그 추가
3. archive/ 파일 30개 초과 시: 가장 오래된 것부터 삭제 제안
4. MEMORY.md 180줄 초과 시: 자동으로 --uc (압축) 제안

### 5.3 패턴 학습 프로토콜

```
1. 이슈 발생
2. 해결
3. 기록 후보 판별:
   - 재현 가능한가? -> Y -> gotchas.md
   - 아키텍처에 영향? -> Y -> decisions.md
   - 팀 운영에 영향? -> Y -> team-ops.md
   - 위 모두 N -> session-latest.md에만 기록
4. 2회 이상 발생 확인 시 -> 심각도 UP + "검증됨" 태그
```

---

## 6. Artibot 프로젝트 즉시 적용 계획

### 6.1 현행 파일 마이그레이션

| 현행 파일 | 조치 | 대상 |
|----------|------|------|
| MEMORY.md | 리팩터링 | 새 템플릿 적용, 상세 분리 |
| architecture-decisions.md | 분할 | tech-stack.md + decisions.md |
| development-protocol.md | 이동 | team-ops.md |
| lessons-learned.md | 이동 | gotchas.md |
| session-logs.md | 이동 | session-latest.md + archive/ |
| team-structure.md | 병합 | team-ops.md에 통합 |

### 6.2 리팩터링된 MEMORY.md 예시

```markdown
# Artibot Project Memory

## Project Identity
- **Service**: Artibot - Artience 사내 AI 봇/도구 플랫폼
- **Stack**: Next.js, TypeScript, Python/FastAPI, Firestore, pnpm
- **Origin**: certpractice-ai 프로젝트에서 검증된 패턴 기반

## Topic Files
- [tech-stack.md](tech-stack.md) - 기술 스택, 빌드 설정, 디자인 시스템
- [gotchas.md](gotchas.md) - 반복 실수, 빌드 에러 패턴
- [team-ops.md](team-ops.md) - 팀 구성(10명), 5-Phase 워크플로우
- [decisions.md](decisions.md) - 아키텍처 결정, 검증된 패턴
- [session-latest.md](session-latest.md) - 최근 세션 컨텍스트

## Active Rules
1. 팀장은 코딩하지 않는다 - 태스크 배정/관리 + 사용자 대응 전담
2. 조사 먼저, 수정 나중에 - 조사 리포트 -> 승인 -> 수정
3. 추측 금지 - Grep/Glob 검증 후 발언
4. 수정 전 import 참조 확인 - grep 검증 필수
5. reader/writer 양쪽 수정 - Firestore 데이터 쓰기/읽기 서비스 동시 수정
6. camelCase + snake_case 양쪽 기록 - Firestore 필드 호환성
7. 프론트엔드 타입 <-> 백엔드 API model 대조 필수
8. 병렬 실행 원칙 - 독립 영역 동시 진행, 의존성은 blockedBy

## Current State
- **Phase**: 초기 설정 (SuperClaude 플러그인 설계)
- **Active Feature**: 없음
- **Last Session**: 2026-02-13
- **Blockers**: 없음

## Next Session Checklist
- [ ] 프로젝트 기본 구조 생성
- [ ] SuperClaude 플러그인 아키텍처 확정

## User Preferences
- 언어: 한국어 커뮤니케이션
- 도구: pnpm, Vitest, Tailwind CSS
- 병렬 작업 선호, 증거 기반 리포트 요구
```

**줄 수**: ~45줄 (155줄 여유)

---

## 7. SuperClaude 프레임워크와의 통합

### 7.1 Token Efficiency 연동

MODES.md의 Token Efficiency Mode와 메모리 시스템 연동:

- **컨텍스트 75% 초과 시**: MEMORY.md의 "Topic Files" 섹션만 로드, 토픽 파일은 필요시만 Read
- **--uc 모드 활성 시**: 메모리 기록도 압축 형식 사용 (심볼 시스템 적용)
- **세션 종료 시**: 자동으로 session-latest.md 갱신 제안

### 7.2 페르소나별 메모리 접근 패턴

| 페르소나 | 우선 참조 파일 | 이유 |
|---------|--------------|------|
| architect | decisions.md, tech-stack.md | 아키텍처 결정 이력 |
| frontend/backend | tech-stack.md, gotchas.md | 기술 제약, 실수 방지 |
| security | gotchas.md (보안 섹션) | 보안 이슈 패턴 |
| qa | gotchas.md, session-latest.md | 이슈 이력, 최근 변경 |
| scribe | team-ops.md, decisions.md | 문서화 컨텍스트 |
| memory-manager | 전체 | 메모리 관리 전담 |

### 7.3 memory-manager 에이전트 역할 표준화

팀 구성에 memory-manager 포함 시 자동 수행 항목:
1. 세션 시작: session-latest.md 읽어 팀장에게 이전 상태 브리핑
2. 세션 중: 주요 결정/이슈 발생 시 적절한 토픽 파일에 기록
3. 세션 종료: session-latest.md 갱신, MEMORY.md "Current State" 업데이트
4. 감쇠 판단: 참조 빈도 낮은 항목 아카이브 제안

---

## 8. 측정 지표

### 8.1 메모리 품질 KPI

| 지표 | 목표 | 측정 방법 |
|------|------|----------|
| MEMORY.md 줄 수 | < 120줄 (60% 활용) | wc -l |
| 중복 콘텐츠 비율 | 0% | 수동 검토 |
| 세션 복원 시간 | < 30초 (읽기 시간) | Read 호출 횟수 |
| gotchas 적중률 | > 80% (기록된 이슈가 실제 재발 방지에 기여) | 세션별 집계 |
| archive/ 크기 | < 30 파일 | ls 카운트 |
| 토픽 파일 평균 줄 수 | < 100줄 | wc -l 평균 |

---

## 9. 외부 레포 메모리/컨텍스트 패턴 분석

4개 GitHub 레포의 메모리 및 컨텍스트 관리 패턴을 분석하여 Artibot 플러그인에 적용 가능한 인사이트를 추출한다.

### 9.1 레포별 분석 요약

#### everything-claude-code (가장 관련성 높음)

**세션 관리 시스템** - Hook 기반 자동 세션 추적
- `session-start.js` (SessionStart hook): 최근 7일 세션 파일 검색, 최신 세션 내용을 Claude 컨텍스트에 자동 주입
- `session-end.js` (Stop hook): JSONL 트랜스크립트 파싱하여 자동 요약 생성 (user messages, tools used, files modified)
- `session-manager.js`: 세션 CRUD 라이브러리 (list/load/alias/info/delete)
- `session-aliases.js`: 세션에 별칭 부여 (예: `today`, `auth-refactor`)
- 저장 위치: `~/.claude/sessions/YYYY-MM-DD-<short-id>-session.tmp`

**연속 학습 시스템** - 자동 패턴 추출
- `evaluate-session.js` (Stop hook): 세션 종료 시 트랜스크립트 분석
- 최소 10개 사용자 메시지 이상 세션만 학습 대상 (짧은 세션 스킵)
- 학습된 스킬 저장: `~/.claude/learned-skills/` (마크다운 파일)
- 설정 가능: `skills/continuous-learning/config.json`

**핵심 패턴**: Hook 기반 자동화 + 트랜스크립트 파싱 + 조건부 학습

#### bkit-claude-code (가장 정교한 구현)

**4계층 컨텍스트 계층 구조** (`context-hierarchy.js`)
```
L1: Plugin Policy (bkit.config.json)       - 우선순위 1 (최저)
L2: User Config (~/.claude/bkit/)           - 우선순위 2
L3: Project Config (프로젝트/bkit.config.json) - 우선순위 3
L4: Session Context (인메모리 런타임)        - 우선순위 4 (최고)
```
- 상위 레벨이 하위 레벨을 오버라이드 (L4 > L3 > L2 > L1)
- 충돌 감지: 같은 키에 다른 값이 있으면 conflicts 배열에 기록
- TTL 기반 캐시 (5초), `invalidateCache()`로 수동 무효화

**메모리 스토어** (`memory-store.js`)
- JSON 기반 키-값 저장소 (`docs/.bkit-memory.json`)
- 인메모리 캐시 + 파일 영속화 (동기 I/O)
- API: `getMemory(key)`, `setMemory(key, value)`, `deleteMemory(key)`, `updateMemory(partial)`, `clearMemory()`
- 세션 카운터, 마지막 세션 정보, PDCA 상태 추적에 사용
- 실제 데이터 예: `sessionCount: 104`, `lastSession`, `currentPDCA`, `pipelineStatus`

**컨텍스트 포크** (`context-fork.js`)
- 스킬/에이전트 실행 시 격리된 컨텍스트 복사본 생성
- deep clone으로 원본 보호, 실행 후 선택적 머지
- `forkContext()` -> 격리 실행 -> `mergeForkedContext()` 또는 `discardFork()`
- 배열은 중복 제거 머지, 객체는 스프레드 머지, 원시값은 교체

**컨텍스트 압축** (`context-compaction.js`)
- PreCompact hook으로 컨텍스트 압축 전 PDCA 상태 스냅샷 저장
- `docs/.pdca-snapshots/snapshot-{timestamp}.json`
- 최근 10개만 보관, 오래된 것은 자동 삭제
- 압축 후 복원을 위한 요약 출력

**핵심 패턴**: 4계층 계층 구조 + JSON 메모리 스토어 + 컨텍스트 포크/머지 + 압축 보호

#### cc-wf-studio (제한적 관련성)

**에이전트 컨텍스트 자동 업데이트** (`update-agent-context.sh`)
- `plan.md`에서 기술 스택, 프레임워크, DB 정보 자동 추출
- CLAUDE.md 등 에이전트 파일에 자동 반영 (15개 AI 에이전트 지원)
- `<!-- MANUAL ADDITIONS START/END -->` 마커로 수동 추가 섹션 보호
- `Recent Changes` 섹션에 최근 3개 변경만 유지 (자동 감쇠)

**핵심 패턴**: plan.md -> 에이전트 컨텍스트 파일 자동 동기화 + 수동 섹션 보호

#### ui-ux-pro-max-skill (낮은 관련성)

- 메모리/컨텍스트 관리 시스템 없음
- CLAUDE.md는 프로젝트 가이드 역할만 수행
- 검색 기반 데이터 접근 (BM25 + regex), 상태 비보존

### 9.2 핵심 패턴 비교 매트릭스

| 패턴 | everything-cc | bkit | cc-wf-studio | 현행 SuperClaude |
|------|:---:|:---:|:---:|:---:|
| Hook 기반 자동화 | O (session-start/end) | O (SessionStart, PreCompact) | O (plan 파싱) | X (수동) |
| 세션 자동 요약 | O (트랜스크립트 파싱) | X | X | X |
| 계층적 컨텍스트 | X | O (4계층) | X | X |
| JSON 메모리 스토어 | X | O (.bkit-memory.json) | X | X |
| 컨텍스트 포크/머지 | X | O (격리 실행) | X | X |
| 압축 보호 | X | O (PreCompact 스냅샷) | X | X |
| 연속 학습 | O (evaluate-session) | X | X | X |
| 자동 감쇠 | X (수동) | O (스냅샷 10개 제한) | O (Recent Changes 3개) | X |
| 세션 별칭 | O | X | X | X |
| Markdown 기반 | O (.tmp 마크다운) | 일부 (.json + .md) | O (.md) | O (.md) |

### 9.3 Artibot 플러그인 적용 권장 사항

#### 즉시 도입 (P0) - 검증된 패턴

**1. Hook 기반 세션 자동 관리** (everything-cc 패턴)
- `SessionStart` hook: session-latest.md 로드 -> Claude 컨텍스트 주입
- `Stop` hook: 세션 요약 자동 생성 -> session-latest.md 갱신
- 기존 수동 관리 -> 자동화로 전환

**2. JSON 메모리 스토어** (bkit 패턴)
- `.artibot-memory.json`: 세션 카운터, 마지막 세션 정보, 활성 작업 상태
- Markdown 메모리(MEMORY.md)와 보완적 역할: 구조적 데이터는 JSON, 서술적 지식은 Markdown
- 인메모리 캐시 + 파일 영속화

**3. Recent Changes 자동 감쇠** (cc-wf-studio 패턴)
- 최근 N개만 유지, 오래된 것은 자동 아카이브
- MEMORY.md "Current State" 섹션에 적용

#### 단기 도입 (P1) - 적응 필요

**4. 4계층 컨텍스트 계층 구조** (bkit 패턴 축소 적용)
```
L1: SuperClaude 기본값 (CLAUDE.md rules)
L2: 프로젝트 설정 (MEMORY.md Active Rules)
L3: 세션 컨텍스트 (session-latest.md)
```
- bkit의 4계층에서 User Config 제외한 3계층으로 단순화
- 상위 레벨 오버라이드 원칙 유지

**5. 연속 학습 시스템** (everything-cc 패턴 적용)
- 세션 종료 시 트랜스크립트에서 반복 패턴 추출
- 최소 세션 길이 기준 (10+ 사용자 메시지) 이상만 학습 대상
- 추출된 패턴은 gotchas.md 또는 decisions.md로 승격

#### 중기 도입 (P2) - 설계 필요

**6. 컨텍스트 압축 보호** (bkit 패턴)
- PreCompact hook으로 현재 작업 상태 스냅샷
- 압축 후 복원을 위한 요약 자동 출력
- 스냅샷 자동 정리 (최근 10개)

**7. 컨텍스트 포크** (bkit 패턴, 팀 운영 시)
- 병렬 에이전트 실행 시 격리된 컨텍스트 복사본
- 작업 완료 후 선택적 머지 (배열 중복 제거, 객체 스프레드)

### 9.4 도입하지 않는 패턴 (이유)

| 패턴 | 출처 | 미도입 이유 |
|------|------|-----------|
| 세션 별칭 시스템 | everything-cc | 롤링 세션 패턴으로 불필요 (항상 1개 최신 세션) |
| 8개 언어 인텐트 감지 | bkit | 한국어/영어 2개만 필요, 과도한 복잡성 |
| 에이전트 컨텍스트 자동 동기화 | cc-wf-studio | plan.md 기반 워크플로우 미사용 |
| Permission 계층 (FR-05) | bkit | SuperClaude 자체 안전 모드로 충분 |
| PDCA 싸이클 통합 | bkit | SuperClaude의 5-Phase 시스템과 중복 |

---

## 10. 결론 및 권장 사항

### 즉시 실행 (P0) - 기존 + 외부 패턴
1. Artibot memory/ 디렉토리를 새 분류 체계로 마이그레이션
2. MEMORY.md를 새 템플릿으로 리팩터링 (45줄 이하)
3. 중복 콘텐츠 제거 (team-structure.md -> team-ops.md 통합)
4. **[NEW]** Hook 기반 세션 자동 관리 구현 (everything-cc 패턴: SessionStart로 컨텍스트 로드, Stop으로 자동 저장)
5. **[NEW]** JSON 메모리 스토어 도입 (.artibot-memory.json, bkit 패턴)
6. **[NEW]** Recent Changes 자동 감쇠 (최근 3-5개만 유지)

### 단기 (P1)
7. 롤링 세션 패턴 (session-latest.md + archive/) 도입
8. 컨텍스트 승격 메커니즘 문서화 및 팀 교육
9. memory-manager 에이전트 프롬프트에 자동 감쇠 규칙 포함
10. **[NEW]** 3계층 컨텍스트 계층 구조 도입 (SuperClaude 기본값 < 프로젝트 설정 < 세션 컨텍스트)
11. **[NEW]** 연속 학습 시스템 (세션 종료 시 반복 패턴 자동 추출)

### 중기 (P2)
12. SuperClaude Token Efficiency Mode와 메모리 연동 구현
13. 페르소나별 메모리 접근 패턴 자동화
14. 메모리 품질 KPI 추적 시스템 구축
15. **[NEW]** PreCompact hook으로 컨텍스트 압축 보호 구현
16. **[NEW]** 팀 운영 시 컨텍스트 포크/머지 메커니즘 (병렬 에이전트 격리 실행)
