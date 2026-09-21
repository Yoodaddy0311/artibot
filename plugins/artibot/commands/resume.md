---
description: (Artibot) 이전 세션 핸드오프 복원 — 전체 HANDOFF + 첫 프롬프트 후보 표시
argument-hint: '[--run] [--list] [--contract] [--read-order]'
allowed-tools: [Read, Bash, Grep]
toolset: team
---

# /resume

이전 세션이 `/save` 로 작성한 `.artibot/HANDOFF.md` 를 그대로 stdout 에 출력해 다음 작업을 5초 안에 이어가도록 합니다. 자동 실행은 절대 하지 않으며, `--run` 플래그가 있을 때만 1순위 첫 프롬프트를 확인 프롬프트로 제안합니다 (push/deploy/release/force/delete 키워드는 강제 confirm).

기본 모드·`--list`·`--run` 에서 읽는 파일은 `.artibot/HANDOFF.md` **하나뿐이다** — `lib/handoff/handoff-store.js#readLatestHandoff` 는 그 포인터 파일만 연다. 크로스머신 요지본 `.artibot/guides/NEXT-SESSION.md` 와 `/split` 줄기 worktree 의 `.artibot/HANDOFF.md` 는 읽지 않는다 — 필요하면 직접 `Read` 하라. opt-in 플래그 `--contract` 는 그 세 경로를 그대로 둔 채 보고 블록만 뒤에 덧붙이고, `--read-order` 는 ARTIBOT 6단계를 **먼저** 읽은 뒤 `.artibot/HANDOFF.md` 를 **폴백으로 뒤로 미룬다**. 둘 다 읽기만 하며, 각각의 절이 정본이다.

Also routed from: 자연어 "이어가기", "어제 어디까지 했지", "지난 세션 복원", "핸드오프 보여줘"

## Arguments

Parse $ARGUMENTS:
- `--run`: 1순위 첫 프롬프트 후보를 사용자 confirm 후 실행 제안. **자동 실행 없음 — 항상 사용자 승인 필요**
- `--list`: `.artibot/handoffs/` 의 아카이브 목록 (mtime · size · filename) 표시 후 종료
- `--archive <filename>`: 특정 아카이브를 stdout으로 표시 (latest 대신)
- `--contract`: Resume Contract + lane reconcile 보고를 기본 출력 **뒤에** 덧붙임. **보고 전용 — 상태 전이·재개 실행 없음.** 플래그가 없으면 출력은 종전과 완전히 동일
- `--read-order`: 리포 루트 `ARTIBOT.md` 의 `## Read Order` 6단계를 그 순서대로 **먼저** 읽어 출력하고, `.artibot/HANDOFF.md` 는 부재 단계가 있을 때만 그 뒤에 폴백으로 **최대 1회** 읽음. **읽기 전용 — 쓰기·상태 전이 없음.** 플래그가 없으면 출력은 종전과 완전히 동일

## Execution Flow

### `--list` 모드

1. `lib/handoff/handoff-store.js` 의 `listHandoffs(projectRoot)` 호출
2. 반환된 배열을 mtime 내림차순으로 표 출력:
   ```
   | # | 파일명 | mtime | size |
   |---|--------|-------|------|
   ```
3. 종료. 다른 단계 실행 안 함.

### 기본 모드

1. `readLatestHandoff(projectRoot)` 호출
   - 반환 `null` → "핸드오프 없음 — 먼저 `/save` 로 작성하세요." 메시지 + 종료
2. `content` 를 stdout 으로 그대로 출력 (마크다운 원문 보존, ANSI 추가 금지)
3. 마크다운에서 `## 6. 다음 세션 첫 프롬프트 후보` 섹션을 정규식으로 추출:
   - `/^##\s+6\..*다음 세션 첫 프롬프트 후보.*$([\s\S]*?)(?=^##\s|\Z)/m`
   - 1~3 번 항목을 박스로 강조 출력
4. `--run` 플래그가 있을 때만 Step 5 진행. 아니면 안내만 출력 후 종료.

### `--run` 안전 가드

1. 1순위 prompt 텍스트를 추출
2. 다음 sensitive 키워드 검출 (대소문자 무관, regex `\b(push|deploy|release|force|delete|rm|reset)\b`):
   - push, deploy, release, force, delete, rm, reset
3. **검출 시 강제 confirm**: 키워드를 빨간색으로 강조 + "이 액션은 destructive 입니다. 진행할까요? (y/N)" — 기본 N
4. **검출 안 됨**: 일반 confirm — "1번 프롬프트를 실행하시겠습니까? (y/N)" — 기본 N
5. 사용자 응답 `y/Y/yes` 외에는 모두 거부로 처리 → "사용자 거부 — 종료" 출력 후 종료
6. 승인 시: prompt 텍스트를 Claude에게 다음 message 로 전달 — **자동 Bash 실행 절대 없음**

### `--contract` 모드 (opt-in · 보고 전용)

플래그가 없으면 이 절은 **통째로 건너뛴다** — 기본 출력은 한 글자도 달라지지 않는다. `--contract` 가 있을 때만 기본 핸드오프 출력이 **끝난 뒤에** 아래 두 블록을 덧붙인다. (`--read-order` 가 함께 있으면 블록의 위치와 HANDOFF 출력 여부는 "ARTIBOT 읽기 순서" 절의 플래그 조합 문단이 정한다 — HANDOFF 가 아예 출력되지 않는 경우에도 두 블록은 맨 마지막에 그대로 덧붙는다.)

1. **Resume Contract 보고** — `lib/checkpoint/resume-controller.js#buildResumeReport` 로 Scorecard §51 의 10단계 중 **1~9 단계**(스키마 검증 → `intent_revision`/`plan_revision` 대조 → 아티팩트·커서 확인)를 평가해 단계별 `ok` / `blocked_by` 를 표로 출력한다. 10단계 Resume(실제 재개)는 Canary 라 **이 커맨드의 범위 밖이며 실행하지 않는다**.
2. **lane reconcile 보고** — `lib/supervisor/lane-reconcile.js#reconcileLanes` 로 리더의 split 런 상태 파일(`run.json`)의 레인 상태를 git 증거와 대조해 레인별 `blocked_by: ['reconcile:<사유>']` 를 출력한다. 허용 목록 밖 상태·state↔git 불일치는 fail-closed 로 사유를 남긴다 (설계 §3.5).

위 두 블록은 산문으로 가리키기만 하지 않고 **실제로 실행해서** 만든다 — Bash 로 `node scripts/checkpoint/resume-report.mjs --all --cwd <projectRoot>` 를 돌리고 그 stdout 을 기본 핸드오프 출력 **뒤에** 그대로 덧붙인다. 이 CLI 도 읽기·계산·출력만 하며(`allowed-tools` 에 Write 가 없다), 실행이 실패하면 아래 실패 규칙대로 그 블록만 `측정 불가:` 한 줄로 대체한다.

출력·실패 규칙:

- 두 블록 모두 **읽기·계산·출력만** 한다. 어느 단계도 파일을 쓰지 않고, 어떤 상태도 전이시키지 않는다.
- `blocked_by` 가 빈 항목은 `-` 로 표시한다. 빈 배열을 "검증 통과"로 바꿔 쓰지 말 것 — 둘은 다른 진술이다.
- 모듈 부재·JSON 파싱 실패는 그 블록만 `측정 불가: <사유>` 한 줄로 적고, 기본 핸드오프 출력은 그대로 유지한다 (부분 실패가 `/resume` 본래 기능을 막지 않는다).

### 체크포인트 읽기 순서 (`--contract` 모드에서만)

이 절은 `--contract` 가 있을 때 덧붙는 보고 블록의 입력 순서만 정한다. 기본 모드·`--list`·`--run` 이 읽는 파일과 출력은 종전과 동일하며, 위 "읽는 파일은 `.artibot/HANDOFF.md` 하나뿐이다" 는 그 세 경로에 대한 진술로 그대로 유효하다.

1. `.artibot/HANDOFF.md` 를 먼저 읽어 기본 출력을 낸다. 이 단계는 config 와 무관하게 항상 같다.
2. `artibot.config.json` 의 `runtime.checkpoint.saveOnSave` 가 `true` 일 때 `/save` 가 체크포인트를 **남긴다** (`lib/checkpoint/save-checkpoint.js#isSaveCheckpointEnabled` 가 단독 판정 — 엄격 boolean 이라 `true` 가 아닌 값(부재·문자열 `"true"`·`1`)은 전부 off). 체크포인트가 남아 있으면 HANDOFF **다음에** 그것을 읽어 Resume Contract 보고의 입력으로 쓴다. 이 키는 **쓰는 쪽의 게이트**이며 읽기를 막지 않는다 — 보고는 config 를 보지 않고 체크포인트 스토어를 그대로 읽는다.
3. 해당 미션의 체크포인트가 없으면 읽을 것이 없을 뿐, 보고 자체는 그대로 나온다 — 그 미션 행에 `blocked_by: ['reconcile:checkpoint-missing']` (`lib/checkpoint/resume-controller.js#RESUME_BLOCK_REASONS`) 이 찍힌다. 부재는 오류가 아니고, 기본 핸드오프 출력도 영향을 받지 않는다.

`--read-order` 가 함께 있으면 HANDOFF 를 읽는 **시점과 읽을지 여부**를 아래 "ARTIBOT 읽기 순서" 절이 정한다 — 6단계 뒤 폴백으로 최대 1회이고, 6단계가 전부 실재하면 **아예 읽지 않는다**. 위 1단계는 그 판단을 따르며(읽지 않으면 그 기본 출력도 나오지 않는다), 이 절의 나머지 순서와 의미는 그대로다.

체크포인트는 **읽기만** 한다 — `/resume` 은 새 체크포인트를 남기지도, 기존 것을 갱신하지도 않는다. 그 쓰기는 `/save` 의 책임이다 (`/resume` 은 read-only).

### ARTIBOT 읽기 순서 (`--read-order` 모드에서만 · opt-in)

플래그가 없으면 이 절은 **통째로 건너뛴다** — 기본 출력은 한 글자도 달라지지 않는다. `--read-order` 가 있을 때는 기본 모드보다 **먼저** 아래 6단계를 번호 순서대로 읽어 출력하고, `.artibot/HANDOFF.md` 는 그 **뒤로 밀려 폴백**이 된다 (설계 "커맨드별 운명" 문단 — `/resume` 은 ARTIBOT 읽기 순서를 실행하고 HANDOFF 는 폴백이다).

정본 순서의 **단일 진실원은 리포 루트 `ARTIBOT.md` 의 `## Read Order`** 다. 이 절은 그것의 사본일 뿐이며, 둘이 어긋나면 핀 테스트 `tests/firewall/resume-contract-report-only.test.js` 가 RED 가 된다. 순서를 여기서 고치지 말고 `ARTIBOT.md` 를 고쳐라.

단계별 출력 형태: 실재하면 머리줄 `[n/6] <경로>` 뒤에 **요지 5줄 이내**로 적는다 — 정본 파일은 길므로 원문 전재는 하지 않는다. 부재하면 `부재: <경로>` 한 줄이 그 단계의 전부다.

1. `.artibot/project.md` — 프로젝트 정본. 요지는 목적·범위·제약. 부재 시 `부재: .artibot/project.md` 한 줄만 적고 다음 단계로 간다.
2. `.artibot/state.yaml` — 라이브 실행 진실. 여기서 **활성 미션 id** 를 얻어 3·4단계에 넘긴다. 부재 시 `부재: .artibot/state.yaml` 한 줄.
3. 활성 미션의 `intent.md` — `.artibot/missions/<미션 id>/intent.md`, 성공의 정의. 미션 id 는 2단계에서 온다; 2단계가 부재이거나 활성 미션이 지목되지 않으면 `부재: 활성 미션 미확정` 한 줄. `not yet landed` 산출물이라 부재가 흔하다.
4. 활성 미션의 `plan.md` — `.artibot/missions/<미션 id>/plan.md`, 현재 실행 전략. 미션 id 가 미확정이면 역시 `부재: 활성 미션 미확정` 한 줄. 이것도 `not yet landed` 다.
5. 관련 ADR — `.artibot/adr/` 아래에서 이번 작업에 걸리는 결정 기록만 읽는다. 여러 건이어도 요지 5줄 상한은 **건별이 아니라 이 단계 합계**이며, 머리줄도 `[5/6]` 하나로 묶는다 (출력 총량 상한 유지). `INDEX.md` 는 수기 정본이라 **읽기만** 하고 재생성·재번호 매기기를 절대 호출하지 않는다. 부재 시 `부재: .artibot/adr/` 한 줄.
6. Review / Outcome — 해당하는 경우에만 읽는다. 경로 단서는 활성 미션 아래의 `review.md`·`outcome.md` (`.artibot/missions/<미션 id>/`). 해당 없음이면 `부재: review/outcome` 한 줄.

**HANDOFF 폴백 (번호 단계가 아니다).** 위 6단계 중 **부재 단계가 하나라도 있으면** 6단계 출력이 끝난 **뒤에** 기본 모드 절차를 **한 번** 수행한다 — `readLatestHandoff(projectRoot)` → 원문 그대로 출력 → 첫 프롬프트 후보 박스 (`lib/handoff/handoff-store.js#readLatestHandoff`, 기본 모드와 같은 경로). 6단계가 **전부 실재하면 HANDOFF 는 읽지 않는다**. HANDOFF 파일 자체가 없으면 6단계 출력은 그대로 둔 채 그 뒤에 "핸드오프 없음 — 먼저 `/save` 로 작성하세요." 한 줄만 적는다 — 6단계를 건너뛰고 종료하지 않는다. HANDOFF 는 어떤 경우에도 **한 번을 넘겨 출력하지 않는다**.

플래그 조합 (이 문단이 정본 — 다른 절에서 다시 정의하지 않는다):

- `--list`·`--archive` 는 종전대로 그 모드만 수행하고 종료한다. `--read-order` 는 무시된다.
- `--run` 은 HANDOFF 의 첫 프롬프트 후보를 입력으로 쓴다. HANDOFF 가 위 폴백으로 **실제로 읽힌 경우에만** `--run` 안전 가드로 진행한다. 읽히지 않았으면 "`--run` 은 HANDOFF 후보가 필요하다" 한 줄을 적고 **`--run` 단계만 건너뛴다** — 커맨드를 종료하지는 않으며, `--contract` 블록은 아래 규칙대로 그대로 덧붙는다 (자동 실행 없음 원칙 불변).
- `--contract` 블록은 `--read-order` 와 함께 와도 **항상 맨 마지막**에 덧붙는다.

이 절은 **읽기 전용**이다 — 어느 단계도 파일을 쓰지 않고, 어떤 상태도 **전이시키지 않는다**. 확인 가능한 사실은 frontmatter `allowed-tools` 에 `Write`·`Edit` 가 없다는 것까지다. `Bash` 는 허용돼 있으므로 "쓰기 0" 의 나머지는 이 산문 규율이 맡는다 — 이 절의 어느 단계도 Bash 로 파일을 만들거나 고치지 않는다. 부재는 오류가 아니며, 부재를 "통과"·"검증됨"으로 바꿔 쓰지 말 것 — 둘은 다른 진술이다.

## Output Format

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  HANDOFF RESUMED                                        YYYY-MM-DD HH:MM    │
│  source: .artibot/HANDOFF.md (saved Nh ago)                                 │
└──────────────────────────────────────────────────────────────────────────────┘

[전체 핸드오프 마크다운 원문]

┌─────────────────────────────────────────────────────────────────────────────┐
│  권장 첫 프롬프트                                                            │
├─────────────────────────────────────────────────────────────────────────────┤
│  1. [prompt 1] — [rationale]                                                │
│  2. [prompt 2] — [rationale]                                                │
│  3. [prompt 3] — [rationale]                                                │
└─────────────────────────────────────────────────────────────────────────────┘

> 위 후보 중 하나를 메시지로 입력하면 이어집니다. `--run` 으로 1번을 confirm 실행할 수 있습니다.
```

## `--list` 출력

```
| # | 파일명 | mtime | size |
|---|--------|-------|------|
| 1 | 2026-05-19-1144.md | 2026-05-19 11:44 | 8.2 KB |
| 2 | 2026-05-18-2201.md | 2026-05-18 22:01 | 9.1 KB |
| ... |
```

## Anti-Patterns

- Do NOT 첫 프롬프트를 자동 실행하지 말 것 — `--run` 도 사용자 confirm 필수
- Do NOT push/deploy/release/force/delete/rm/reset 키워드가 포함된 프롬프트를 사용자 명시적 승인 없이 진행하지 말 것
- Do NOT 핸드오프 마크다운을 수정하거나 ANSI 색상을 추가하지 말 것 — 원문 보존
- Do NOT 핸드오프 부재 시 빈 출력으로 종료하지 말 것 — 항상 `/save` 권장 메시지 출력
- Do NOT advisor 신호를 `/resume` 에서 마킹하지 말 것 — `/save` 의 책임 (`/resume` 은 read-only)
- Do NOT `--contract` 가 lease 회수·claimTask·reconcile({apply:true})·이벤트 기록을 하게 하지 말 것 — 보고 전용
- Do NOT `--read-order` 가 6단계 중 어느 파일이든 쓰거나 생성하거나 상태를 전이시키게 하지 말 것 — 읽기 전용 (`ARTIBOT.md` 정본도 읽기만 한다)

## Edge Cases

| 시나리오 | 처리 |
|----------|------|
| 핸드오프 파일 없음 (`--read-order` 없음) | "핸드오프 없음 — `/save` 로 먼저 작성하세요." + 종료 |
| 마크다운 파싱 실패 | 원문만 출력, "권장 첫 프롬프트" 섹션 스킵 + 경고 |
| 권장 프롬프트 섹션 비어있음 | "다음 액션 자유 입력" 박스로 대체 |
| `--archive <filename>` 미존재 | "아카이브 없음 — `--list` 로 확인하세요." + 종료 |
| `--run` 키워드 검출 + 사용자 N | "사용자 거부 — 종료" 출력 후 종료 (실행 안 함) |
| `.artibot/HANDOFF.md` size 0 | 빈 핸드오프 경고 + `/save` 권장 |
| `--read-order` + 핸드오프 파일 없음 | 6단계 출력은 그대로 내고, 그 뒤에 "핸드오프 없음 — `/save` 로 먼저 작성하세요." 한 줄 (6단계 생략·조기 종료 안 함) |

## Next Steps

| # | 액션 | 커맨드 | 설명 |
|---|------|--------|------|
| 1 | 새 핸드오프 저장 | `/save` | 이번 세션 진행 후 다음 세션용 핸드오프 작성 |
| 2 | 아카이브 목록 | `/resume --list` | 과거 핸드오프 비교 |
| 3 | 작업 상태 | `/task` | TaskList 기반 현재 작업 확인 |
