---
name: feedback
context: fork
triggers:
  - "버그"
  - "버그 신고"
  - "이상해"
  - "안 돼"
  - "기능 요청"
  - "개선해줘"
  - "bug"
  - "broken"
  - "doesn't work"
  - "feature request"
description: |
  Auto-captures user bug reports and feature requests, conducts a structured interview, and creates a GitHub issue on the Artibot repository — all without the user typing any slash-command. Triggered by natural complaint/request language.

  MUST trigger when user says any of:
  - "버그", "버그 신고", "이상해", "안 돼", "안 됨", "작동 안 해", "에러 나", "오류 나"
  - "기능 요청", "이런 기능 있으면", "추가해주면", "~되게 해줘"
  - "개선해줘", "불편해", "느려", "느린 것 같아"
  - "bug", "broken", "doesn't work", "feature request", "please add"

  DO NOT trigger for:
  - Casual frustration about unrelated things ("오늘 날씨 이상해")
  - Questions about how something works ("이거 어떻게 써?")
  - Rhetorical complaints inside code ("이 코드 이상하네" during review)

  The user never needs to type `/feedback` — Claude detects intent and starts the flow.
whenNotToUse: "Rhetorical complaints about unrelated topics, questions about how a feature works, or code-review comments that mention bugs in the code being reviewed (not Artibot itself)."
auto-invoke: true
user-invocable: false
---

# feedback — Auto Bug/Feature Capture → GitHub Issues

Pattern adopted from `modu-ai/cowork-plugins`. Adapted to Artibot's auto-invoke DNA: the user never types a command.

## Trigger Detection

Parse the latest user message for complaint/request signals (see description). If matched AND the complaint is about Artibot itself (not unrelated), enter this flow. Otherwise skip.

## 4-Step Flow

```
[1 분류]   버그 vs 기능 요청 vs 개선 제안
[2 인터뷰] 필수 정보만 짧게 질문 (최대 3개)
[3 확인]   이슈 미리보기 → 유저 승인
[4 등록]   gh issue create → URL 전달
```

### 1. 분류

| 키워드 | 유형 | 라벨 |
|---|---|---|
| "안 됨", "작동 안 해", "에러", "오류" | **bug** | `bug`, `triage` |
| "기능", "추가", "~되면 좋겠어" | **feature request** | `enhancement` |
| "불편", "느려", "개선" | **improvement** | `improvement` |

### 2. 인터뷰 — 최대 3개 질문만

**Bug:**
1. 무슨 동작을 하려 할 때 생긴 문제인가요? (재현 경로)
2. 어떤 에러/이상 동작이 나왔나요? (메시지·스크린샷이면 더 좋음)
3. 마지막으로 제대로 되던 때가 언제였나요? (버전·날짜)

**Feature request:**
1. 지금 어떤 문제를 해결하려 하시나요? (use-case)
2. 이 기능이 있으면 뭐가 달라질까요? (value)
3. 이미 비슷하게 써본 다른 도구가 있나요? (reference)

**Improvement:**
1. 어느 기능이 느리거나 불편한가요?
2. 얼마나 자주 쓰시나요? (빈도가 우선순위 판단)
3. 기대했던 동작은 어떤 거였나요?

> **규칙**: 이미 유저 메시지에 답이 들어있으면 그 질문은 생략. 3개 질문은 최댓값이지 기본값이 아님.

### 3. 이슈 미리보기

아래 형식으로 유저에게 보여주고 "이대로 등록할까요?" 한 문장만 확인:

```markdown
**[타입]** [한 문장 제목]

### 상황
[재현 경로 또는 use-case]

### 기대 동작 / 실제 동작  (bug only)
- 기대: ...
- 실제: ...

### 환경
- Artibot: v2.4.0
- OS: Windows 11 (from cwd detection)
- Node: detected from package.json engines

### 라벨
`bug`, `triage` (or `enhancement`, `improvement`)
```

### 4. 등록

유저가 승인하면:

```bash
gh issue create \
  --repo Yoodaddy0311/artibot \
  --title "<title>" \
  --body "<body from step 3>" \
  --label "<labels>"
```

실패 시 (gh 미설치·인증 안 됨 등):
- 대체안: 이슈 본문을 clipboard로 복사하거나 파일로 저장
- 유저에게 수동 등록 링크 제공: `https://github.com/Yoodaddy0311/artibot/issues/new`

## 중복 방지

등록 전 `gh issue list --repo Yoodaddy0311/artibot --search "<키워드>"` 로 유사 이슈 검색. 매치되면:
- "비슷한 이슈 #N 이 이미 있습니다. 댓글로 추가하시겠어요?" 제안

## 데이터 프라이버시

- 로그·스크린샷 포함 시 자동 PII 스크러버 경유 (`lib/privacy/pii-scrubber.js`)
- 유저 환경변수·API 키·경로의 사용자명은 본문에서 마스킹
- 절대 외부 시스템으로 데이터 전송 금지 (GitHub Issues는 예외 — 사용자 승인 기반, 공개 레포 자기 소유)

## 실패 모드 · 에러 라벨

| 시나리오 | 라벨 | 대체 동작 |
|---|---|---|
| gh CLI 미설치 | `E_GH_MISSING` | 수동 등록 링크 + 본문 텍스트 제공 |
| gh 미인증 | `E_GH_AUTH` | `gh auth login` 안내, 이슈 본문은 파일로 저장 |
| 네트워크 실패 | `E_GH_NETWORK` | 이슈 본문 `./artibot-feedback-<ts>.md`에 저장 |
| 중복 이슈 존재 | `I_GH_DUPLICATE` | 기존 이슈 링크만 제공 |

## 유저 관점 흐름

```
유저: "이거 왜 안 되지... 팀 모드에서 에이전트가 안 움직여"
Artibot: (intent 감지 → feedback skill 자동 진입)
        "버그처럼 들리네요. 몇 가지만 여쭐게요.
         1) 어떤 커맨드/요청이었나요?
         2) 에이전트가 어떻게 동작했나요? (시작 자체가 안 됐나요, 아니면 멈췄나요?)"
유저: "/team 모드에서 분석 시켰는데 1명만 돌고 나머지는 idle."
Artibot: "환경·버전까지 제가 채울게요. 아래 이슈로 등록할까요?"
        [이슈 미리보기 표시]
유저: "응"
Artibot: "등록 완료 — #42 https://github.com/.../issues/42"
```

유저는 `gh` 명령이나 이슈 포맷을 몰라도 됩니다. Claude가 전부 처리.
