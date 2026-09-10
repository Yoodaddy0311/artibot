# 조사 보고서 — 호스트가 artibot SKILL.md description 을 렌더하지 않는 원인

- 런: split-b87130 · 줄기 skill-description-render · 브랜치 `worktree-split-artibot-skill-description-render` · base `5d51e9fc`
- 측정 시각 범위: 2026-09-11 00:07 ~ 00:38 KST (팀원 5명: docs · corpus(investigator) · exp · tdd-guide(게이트) · 리더 재측정; exp 추가 실측 00:37~00:38 포함)
- 호스트: Claude Code 2.1.267 (`claude --version`, 00:07). 실험 모델: `claude-haiku-4-5-20251001`(200K 창). 리더 창 모델: Fable 5.1.
- 세션이 로드한 코퍼스: `~/.claude/plugins/cache/artibot/artibot/4.58.0`(installed_plugins.json `lastUpdated 2026-09-10T06:07Z`, gitCommitSha 90505f0c). **worktree HEAD 5d51e9fc 와 skills 114 · commands 79 · plugin.json 바이트 동일**(`diff -rq` 출력 0줄, 00:17).
- 등급 표기: **실측** = 직접 실행/조회한 출력 있음 · **추론** = 코드·문서에서 유도했으나 실행 안 함 · **미확인** = 확인 안 함.

## 요약

1. **원인은 호스트 규약이다.** 스킬 목록에는 문자 예산(컨텍스트 창 × 4 바이트/토큰 × 1%; 200K 창 = **8,000자** 실측, 1M 창은 ≥24,904자 실측·상한 미측정; `SLASH_COMMAND_TOOL_CHAR_BUDGET` 으로 덮어쓰기 가능)이 있고, 초과하면 이름은 전부 남기되 description 을 **`~/.claude.json#skillUsage` 의 정확 키 `<plugin>:<name>` 사용 점수 내림차순 그리디**로만 채운다. artibot 비병합 스킬 101개는 `artibot:<skill>` 키가 0/101 이라 전부 0점이고(동명 6 은 커맨드 항목으로 병합) 목록 뒤쪽이라 잔여 예산 0 — 그래서 렌더 0. (실측: 통제 실험 6런 + 바이너리 알고리즘 추출 + skillUsage 대조 반례 0)
2. **리포 쪽 원인은 전부 배제됐다.** 매니페스트 `skills` 키 · CRLF · 블록 스칼라 · `platforms` 중복 키 · 길이 · 동명 병합 · mtime — 어느 것도 렌더 집합을 가르지 못했고, 임시 플러그인 실험에서도 전 변형이 렌더됐다. (실측)
3. **렌더 관련 게이트는 넣지 않는다**(브리프 §완료기준 2 경로). 부수로 발견한 검증기 fail-open 1건(`validate-skills.js` 가 빈 `description: |` 를 PASS)만 리더 승인(00:3x) 아래 소유 안에서 최소 수리한다 — §7.
4. **함의**: 사용자 레벨 `~/.claude/commands/*.md` 무접두 사본(파일 79, 목록 열거 73)이 `/team` 같은 입력을 흡수해 `team`(386회) 만 오르고 `artibot:team`(1회) 은 거의 안 오른다. 그 사본의 description ≤7,802자(dmi 5 제외 74파일 합; 정정: 초판 8,306 은 79파일 전체 합)가 예산을 먼저 소비하기도 한다. (카운트 실측, 귀속 경로 추론)
5. **후속(소유 밖, 보고만)**: `platforms` 중복 2파일, >1,024자 2파일(호스트 캡은 1,536), 114 일괄 수정 wave 의 목표 재정의, 공용 파서 `extractFrontmatter` 의 블록 스칼라 원문 저장, `plugin details` 토큰 수치의 의미 — §8.
6. 이 보고서 파일 자체가 `.gitignore:24 plugins/artibot/docs/*` 대상이다 — 커밋 시 `git add -f` 로 추적(리더 결정 00:16 KST, 같은 규칙 아래 이미 추적 중인 선례 5파일).

## 1. 관측 (리더 시스템 프롬프트 직접 계수, 00:07 KST)

리더 창의 시스템 프롬프트 "available skills" 목록을 리더가 직접 셌다(스크래치패드 `observed-skill-listing.md`). "렌더" = 이름 뒤에 description 문구가 있음.

| 그룹 | 목록 항목 수 | 렌더 | 비고 |
|---|---|---|---|
| 사용자 스킬(`~/.claude/skills`) | 6 | 6/6 | articlaw 외 |
| 사용자 커맨드 사본(`~/.claude/commands/`, 무접두) | 73(목록 열거 기준; 파일 79) | 73/73 | 문구가 `(Artibot) …`. 정정(auditor): 리더 원 관측은 "~90개" 라 쓰고 73개를 열거 — 파일 79 − dmi:true 5(codex·dynamic·orchestrate·spawn·swarm, 사용자 사본도 dmi 키 보유 실측) − go(사용자 스킬 `go` 와 동명이라 스킬 항목으로 표시, 추론) = 73. description 합 ≤7,802(dmi 5 제외 74파일 합; go 길이 별도 미측정. 초판 8,306 은 79파일 전체 합 = 캐시 commands 79 합과 동일). 생성 주체 미확인, 위치 `~/.claude/commands/` 는 실측 |
| artibot-cowork 커맨드 | 21 | 21/21 | |
| artibot 커맨드 | 74 | **12/74** | 렌더: ad · adr · adversarial-review · analytics · blindspot · git · resume · save · scorecard · split · team · watch |
| artibot-cowork 스킬 | 46 | **3/46** | 렌더: ad-compliance · claude-design · long-form-writing |
| artibot 스킬 | 101 | **0/101** | 리포 SKILL.md 는 114 → 13개는 목록에 아예 없음 |
| nexus-lab-hello / nexus-lab-skill | 4 | 1/4 | lab-hello 만 렌더 |
| ui-ux-pro-max | 1 | 1/1 | |
| 내장(dataviz 등) | 16 | 14/16 | init · security-review 이름만 |

- 브리프의 "6/114" 관측은 **커맨드 착시**였다: artibot 스킬 렌더는 0/101 이고, 렌더된 12개는 전부 `commands/<n>.md` 의 문구다(리더 정찰 + corpus Q3 확인). (실측)
- 목록 결측 13 스킬 · 5 커맨드의 정체(corpus Q2, 실측 집합 일치): `disable-model-invocation: true` 스킬 9개(daily · hook-event-emitter · persona-distill · prompt-caching-strategy · scheduled-learning · session-worklog · setup · skill-authoring · tool-approval) ∪ 커맨드 동명 스킬 6개(adversarial-review · daily · quickstart · setup · split · team) = 13(겹침 daily · setup). 114 − 13 = 101. 커맨드도 같은 규약: 캐시 79 중 목록에 없는 5개(codex · dynamic · orchestrate · spawn · swarm) = `disable-model-invocation: true` 커맨드 5개. 즉 커맨드 79 = 렌더 12 + 이름만 62 + 은닉 5. **결측은 의도된 은닉이지 렌더 결함이 아니다.** (집합 일치 실측, 은닉 규약 자체는 추론)

## 2. 가설과 소거 순서

| # | 가설 | 판정 | 근거(실험/실측) | 등급 |
|---|---|---|---|---|
| H1 | plugin.json `"skills": ["./skills/"]` 명시가 자동 탐색을 대체하거나 메타를 떨어뜨린다 | **기각** | exp E1: 키 있음(pgA)/없음(pgB) 둘 다 2/2 렌더. E5(00:37): `"skills": ["./extra/"]` + `skills/` 양쪽 스킬 **둘 다 로드**(pgi:iextra) — 키는 추가(additive). debug 로그 `skillsPaths=0 paths` 는 로더가 기본 `skills/` 와 같은 경로를 중복 필터링한 결과(§3.5 정정). 문서: `skills` 는 "Adds to default"(대체 아님) | 실측 |
| H2 | CRLF | **기각** | corpus: 114/114 전부 CRLF 라 변별력 0. exp E3 `dcrlf` 렌더(73자) | 실측 |
| H3 | YAML 형태(블록 스칼라 `\|`) · 파싱 실패 | **기각** | corpus: 파싱 실패 0 · BOM 0 · U+FFFD 0 · name≠디렉터리 0. 렌더 12 중 블록 0 vs 이름만 67(목록 62 + 은닉 dmi 5; 분모 79) 중 블록 1 — 무분리. exp E1: 블록 스칼라 + 빈 줄 포함 스킬도 렌더(빈 줄 보존됨) | 실측 |
| H4 | `platforms` 중복 키 | **기각** | 중복 2파일(git-unified · lang-reference)은 목록에 이름으로 남아 있고 렌더 여부는 다른 101 과 동일(0). exp E3 `ddup` 렌더(79자) | 실측 |
| H5 | description 길이(>250/>1024) | **기각** | corpus Q3: descLen>100 은 렌더 10/12 vs 이름만 19/67(목록 62 + 은닉 5; auditor 재계수로 18 → 19 정정) — 편향은 있으나 분리 안 됨(resume 51 · save 52 렌더, daily 52 이름만). cowork 렌더 3 의 길이 순위 10·23·43위. exp E3: 1,300자 무손실, 1,800자 → 1,536자 절단(이름만이 아님) | 실측 |
| H6 | 커맨드+스킬 동명 병합이 렌더 12 를 만든다 | **기각(부분)** | 동명은 6개뿐이고 그중 daily · quickstart · setup 은 이름만. 병합 자체는 실재(exp E4: 목록 1항목, 커맨드 문구 승) 하나 렌더 12 의 원인이 아님 | 실측 |
| H7 | 파일 mtime(최근 수정 우선) | **기각** | corpus: mtime≥09-09 렌더 3/12 vs 이름만 1/67, doctor · plan · design · ultraplan 은 최근인데 이름만. exp E2-mtime: s50~s60 touch 후에도 렌더 집합 s01~s04 불변, 블록 길이 8,093 동일 | 실측 |
| H8 | 호스트 문자 예산 + `skillUsage` 우선순위 | **채택** | §3 알고리즘 추출 + 5런 예산 경계 검산 + §4 skillUsage 대조 반례 0 + 문서 §5 | 실측(집합·경계) / 추론(리더 창 상한값) |

## 3. 통제 실험 (exp 팀원, 00:19~00:31 KST API 호출 6회 + 추가 실측 00:37~00:38 KST 3회, 누적 9회)

### 3.1 격리와 채취
- 격리: `claude -p --setting-sources "" --strict-mcp-config --plugin-dir <임시>` — debug 로그 `Found 1 plugins (1 enabled, 0 disabled)` · `Loaded 0 unique skills (... user: 0 ...)`(raw/E1A.debug :28, :31). 설치 플러그인 제거 성공. (실측)
- `--tools ""` 는 Skill 도구 자체를 제거해 목록이 사라진다(E1A 렌더 0/0) → 이후 `--tools Skill`.
- 채취: 스킬 목록은 시스템 프롬프트 본문이 아니라 **user 메시지에 붙는 attachment** 다. 세션 jsonl 의 `$.rendered[0].content`(record 5, `<system-reminder>` 블록)에 원문이 저장된다. 기록된 `systemPrompt`(27,173자)에는 목록이 없다. 아래 수치는 전부 호스트가 만든 문자열을 직접 잰 값이지 모델 자기보고가 아니다. (실측)
- 모든 실험은 스크래치패드 mkdtemp 아래 임시 플러그인, cwd 도 임시 디렉터리(git 리포 밖). `~/.claude/plugins` · `~/.claude/settings.json` 접촉 0, 리포 파일 수정 0, `~/.claude.json` 읽기만.

### 3.2 바이너리에서 추출한 알고리즘 (`C:\Users\HeechangLee\.local\bin\claude.exe` 2.1.267, 220,051,616 B, 오프셋 191,857,681; 난독화 심볼 `bke` 예산 · `tor` 선정 · `WFe` 우선순위 · `QHe` 설명 상한 · `Wis` 면제)

```
budget = env.SLASH_COMMAND_TOOL_CHAR_BUDGET
       || floor(contextWindow(=200000 기본) * bytesPerToken(=4) * skillListingBudgetFraction(=0.01))
maxDescChars = settings.skillListingMaxDescChars ?? 1536
entryLen = name.length + 2                          (이름만)
         = name.length + 4 + min(descLen, 1536)     (렌더)
F = sum(entryLen) + (count - 1)
F <= budget  -> budgetMode "fits", 전부 렌더
F >  budget  -> budgetMode "priority":
   면제집합 U = (type=="prompt" && source=="bundled") 또는 name-only 선언
   나머지를 priority DESC 로 정렬 후, 남은 예산에 들어가면 설명 유지, 안 들어가면 이름만
   (루프는 계속 — 뒤의 짧은 항목이 들어갈 수 있음)
priority = WFe(name):
   r = config.skillUsage[name]; 없으면 0
   days = (now - r.lastUsedAt)/86400000
   return r.usageCount * max(0.5^(days/7), 0.1)
description 본문 = `${description} - ${when_to_use}` (when_to_use 있을 때만; 합산 후 1,536 캡)
렌더 줄 = `- ${name}: ${desc.slice(0,1536)}`   (@191859019 — 순수 slice, 절단 표식 없음)
```

등급: 코드 추출은 실측(문자열 오프셋 명시), 동작은 아래 실험으로 검증. 정정(00:37): 초판은 `whenToUse`(camelCase) 로 적었으나 실제 frontmatter 키는 **`when_to_use`(snake_case)** 다(파서 위치 claude.exe@192450401, E5 실측 1,400+400 → 정확히 1,536). 매니페스트 로더는 기본 `skills/` 스캔과 선언 경로를 push 로 합치고(@192482205) 같은 경로는 중복 필터링한다(@192675480).

### 3.3 실험표

| 실험 | 플러그인 | 항목 n | 렌더 | F(호스트 회계) | 블록 문자수 | 원시 |
|---|---|---|---|---|---|---|
| E1 | pgA(`skills` 키) + pgB(자동탐색) | 17 | 17/17 | 6,752 | 6,853 | `raw/E1AB.skillblock.txt` |
| E2 기준 | pgC 60×300자 | 73 | 17 (pgc 4/60) | 7,992 | 8,093 | `raw/E2A.skillblock.txt` |
| E2 혼합 | pgF 60×100자 + pgG 60×30자 | 133 | 19 (pgf 7/60, pgg 1/60) | 7,995 | 8,097 | `raw/E2FG.skillblock.txt` |
| E2 mtime | pgC, s50~s60 touch | 73 | 17 (pgc 4/60, s01~s04 동일) | 7,992 | 8,093 | `raw/E2MTIME.skillblock.txt` |
| E3+E4 | pgD 8개 + pgE, env budget=100000 | 22 | 22/22 | 9,668 | 9,769 | `raw/E34.skillblock.txt` |
| E5(00:37~38) | pgI(`when_to_use` · `./extra/` 추가 경로) + pgC 를 **claude-opus-5[1m]** 1M 창으로 | 73(pgC 런) | **60/60**(pgC) | 24,904 | 25,005 | `raw/E5*.{out,debug}`, `E5-6/7/8.skillblock.txt` |

(n 에는 번들 스킬 **13**개 포함(73−60 · 17−4 · 22−9 전부 13). 정정(auditor): 초판 "16" 은 리더 창 내장 16 이 혼입된 오기. 예산 초과 런에서 E2A 는 번들 13/13 설명 유지, **E2FG 는 11/13 — `init` · `security-review` 가 이름만**(raw/E2FG.skillblock.txt). 즉 면제집합 U(type prompt && source bundled) 밖의 번들 항목은 예산 대상이다.)

예산이 컨텍스트 창에 비례함을 실측(E5): 동일 pgC(60×300자) 가 haiku 200K 창에서는 4/60(블록 8,093, F 7,992), claude-opus-5[1m] 1M 창에서는 60/60(블록 25,005, F 24,904). **200K 예산 8,000 확정**, 1M 은 ≥24,904 실측 · 상한 미측정(공식 40,000 은 미검증).

`--debug` 경고 줄 원문(E5B.debug:130): `[WARN] Skill listing over budget: 73 skills, 24901 chars > 8000 budget — descriptions will be truncated. Run /skills to disable some, or raise skillListingBudgetFraction in settings.` — 찍히는 값은 총수 · 무삭감 필요 문자수 · 예산 3개이고 "영향받은 개수" 는 안 찍힌다(§5 docs 서술 정정). 예산 내 런에는 이 줄이 없다 → 부재가 "예산 내" 신호. 24,901 vs F 24,904 의 3자 차는 파서 다중행 처리로 추정(미확인).

이력 0 세션(격리 런)은 전원 동점 0 → 원래 목록 순서로 채움(s01~s04, f01~f07). mtime 영향 0 재확인.

예산 경계 검산(budget = 200,000 × 4 × 0.01 = 8,000):
- E2 기준: 7,992 + 다음 후보 pgc:s05(300+2) = 8,294 > 8,000 → 거부.
- E2 혼합: 7,995 + 다음 후보 pgg:g02(30+2) = 8,027 > 8,000 → 거부. **pgf 가 잘린 뒤에도 pgg:g01 이 렌더된 것**이 "그리디 계속" 동작의 직접 증거.
- env `SLASH_COMMAND_TOOL_CHAR_BUDGET=100000`: F=9,668 인데도 22/22 전량 렌더 → 변수 유효. 변수명은 바이너리 3곳에 실재(오프셋 183,613,475 export 목록, 183,739,351 정수형 env 화이트리스트).

### 3.4 frontmatter 변형 (pgD, `claude plugin validate` 전부 exit 0 — 경고는 author 누락 1건뿐)

| 스킬 | 변형 | 렌더 설명 길이 |
|---|---|---|
| dctl | 대조군 | 101 |
| ddup | `platforms:` 키 2회 선언 | 79 |
| dcrlf | CRLF 줄끝 | 73 |
| dfork | `context: fork` 선언 | 79 |
| dnoname | `name:` 키 없음(폴더명 사용) | 78 |
| dlong | 원본 1,300자 | 1,300(무손실) |
| dvlong | 원본 1,800자 | **1,536(절단)** |
| dwhen | `whenToUse:` 별도 키 | 38(whenToUse 미반영) — **정정(E5)**: camelCase 가 실험 오류. `when_to_use:`(snake_case) 는 반영되어 `${description} - ${when_to_use}` 로 렌더, 합산 1,536 캡(1,400+400 → 1,536 실측) |

### 3.5 기타 관측
- **정정(00:37)**: 초판 "`skills` 키가 skillsPaths 로 파싱되지 않는다" 는 오독. 로더가 기본 `skills/` 와 동일 경로를 중복 필터링해 `0 paths` 로 찍힌 것이며, 다른 경로(`./extra/`)를 선언하면 기본 스캔에 **추가**된다(E5 pgi:iextra 실측).
- **블록 스칼라 `|`**: 본문의 빈 줄이 **그대로 보존**된다 — `- pga:zqxa-two: MARKER ZQXA2 …` 다음 빈 줄, 그 다음 줄에 나머지 본문. 한 스킬이 3줄을 차지해 "한 줄 = 한 스킬" 구조가 깨진다. (실측)
- **E4 동명 커맨드+스킬**: 목록 1항목, 문구는 **커맨드 쪽**(`MKE-CMD`). 스킬 문구(`MKE-SKILL`)는 사라진다. 문서에는 플러그인 내부 동명 승자 서술 없음. (실측)
- **`claude plugin details`**: 경로가 아니라 이름을 받고 `claude --plugin-dir <path> plugin details <name>` 형태로만 동작(서브커맨드 뒤 `--plugin-dir` 은 unknown option). "Projected token cost" 는 **설명 전량이 always-on 이라고 가정**한다(pgC 60개 → ~6,127 tok, dvlong 1,800자 → ~440 tok) — 실제 프롬프트에서는 pgC 4개만 렌더되고 dvlong 은 1,536자로 잘리므로 실렌더 비용과 다르다. (실측)
- 리더 스크래치패드 인용 대조: exp 가 대조한 항목 전부 일치, 틀린 인용 0.

### 3.6 원시 산출물 (절대경로)
- 원시 출력: `C:\Users\HEECHA~1\AppData\Local\Temp\claude\C--Users-HeechangLee-Desktop-AI-Artibot\7f2cf483-6554-4775-bb07-fd4a3b9938ec\scratchpad\exp\raw\` — `E0-validate-details.txt`, `E0b-details.txt`, `E1A.out`, `E1A.debug`, `E1AB.out`, `E1AB.skillblock.txt`, `E1AB.sysprompt.txt`, `E2A.out`, `E2A.skillblock.txt`, `E2FG.out`, `E2FG.skillblock.txt`, `E34.out`, `E34.skillblock.txt`, `E2MTIME.out`, `E2MTIME.skillblock.txt`
- 입력 플러그인 트리: `…\scratchpad\exp\run1\pgA` ~ `pgG`
- 스크립트: `…\scratchpad\exp\` — `gen.js`, `gen2.js`, `gen3.js`, `gen4.js`(E5), `e1a.sh`, `e1ab.sh`, `e2a.sh`, `e2fg.sh`, `e34.sh`, `e2mtime.sh`, `e5.sh`, `findskills.js`(jsonl→목록 블록 추출), `budget.js`(호스트 회계 F 재계산), `measure.js`, `usage.js`(WFe 점수), `bingrep.js`, `desclen.js`
- E5 입력: `…\scratchpad\exp\run1\pgI`, 원시 `raw\E5*.{out,debug}`, `E5-6.skillblock.txt` · `E5-7.skillblock.txt` · `E5-8.skillblock.txt`
- 스크래치패드는 세션 임시 영역이다 — 리포에 보존되지 않으므로 재현은 §10 명령으로.

## 4. 라이브 코퍼스 대조 (corpus 팀원 investigator, 00:15~00:27 KST, 읽기 전용)

| Q | 결과 | 등급 |
|---|---|---|
| Q1 캐시 4.58.0 vs worktree HEAD | `diff -rq` skills(114/114) · commands(79/79) · plugin.json 전부 출력 0줄(00:17). `git diff --stat 90505f0c HEAD -- plugins/artibot/{skills,commands,.claude-plugin}` 출력 없음. 리더 정찰 수치(결측 0 · dq 72/block 42 · dup platforms 2 · plugin.json:75 · cowork `skills` 키 0건) 전부 재확인 일치. 추가: BOM 0 · U+FFFD 0 · name≠디렉터리 0 · CRLF 114/114 | 실측 |
| Q2 목록 결측 13 | §1 표 아래 참조(dmi 9 ∪ 동명 6 = 13, 커맨드 은닉 5 = dmi 5) | 실측(집합) / 추론(규약) |
| Q3 렌더 12 vs 이름만 67(목록 62 + 은닉 dmi 5; 분모 79) 2×2 | 따옴표 형태 · 블록 · argument-hint(전부 있음) · allowed-tools(전부 있음) · model/user-invocable(없음) · mtime · size · CRLF · BOM · dup key · 동명 스킬 · frontmatter 줄수 — **어느 속성도 분리 못 함**. `history.jsonl`(4,903행) 사용 빈도도 무분리(update 34회 이름만 vs analytics 0회 렌더). 같은 description 텍스트(79파일 합계 8,306 동일)가 `~/.claude/commands` 위치에선 73/73(목록 열거; 파일 79, §1 정정), 플러그인 위치에선 12/79 렌더 → 파일 내용이 아니라 위치·호스트 처리가 변수 | 실측 / (텍스트 동일성은 합계로만) |
| Q4 cowork 3 vs 43, nexus | 어떤 속성도 분리 못 함. mtime 46 전부 2026-07-09. lab-hello(렌더) · lab-skill(이름만)은 같은 블록 형식 · 같은 키 집합 | 실측 |
| Q5 렌더 description 합산 | 사용자 스킬 1,795 + 사용자 커맨드 ≤7,802(정정: 초판 8,306 은 dmi 5 포함 79파일 합) + cowork 커맨드 1,848 + artibot 12 커맨드 1,743 + cowork 3 스킬 987 + lab-hello 309 = ≤14,484 / + ui-ux 914 = **≤15,395**(정정: 초판 15,902; 내장 14 미확인). 참고: artibot 79 커맨드 전체 8,306 · cowork 46 스킬 전체 15,552 · artibot 114 스킬 전체 **39,326**. 잘린 경계는 정확히 analytics(101자) \| analyze(74자) | 실측(합·경계) / 추론(상한 단위) |
| Q6 호스트 사용 저장소 | 1차 "없음" 은 탐색 범위 오류 — **정정**: 홈 루트 `C:\Users\HeechangLee\.claude.json` 의 `skillUsage` 키, 65항목, 값 `{usageCount, lastUsedAt(ms epoch)}`(105,896 B, mtime 00:26 갱신 중). 무접두 키(`team` 386 · `save` 253 · `resume` 217 · `autopilot` 138 …)와 플러그인 한정 키(`artibot:save` 7 · `artibot:split` 4 · `artibot:team` 1 …) 공존 | 실측 |
| Q7 `ci-utils.js#extractFrontmatter` | 블록 스칼라 3종(본문 2줄 · 빈 본문 · 빈 줄 포함) 전부 값 `"|"` 반환, 인라인은 따옴표 포함 원문. `validate-skills.js` 는 `if (!frontmatter[field])` 만 검사(00:21 기준 :51-58) → `"|"` 는 truthy → **빈 `description: |` 도 PASS**. 현 코퍼스에 빈 블록 0(실해 0) | 실측 |

### 4.1 결정 대조 — `skillUsage` 플러그인 한정 키 vs 렌더 집합 (분모 247 = artibot 커맨드 74 + cowork 커맨드 21 + cowork 스킬 46 + artibot 스킬 101 + nexus 4 + ui-ux 1, 00:27)

| | 렌더 | 이름만 |
|---|---|---|
| 플러그인 키 usageCount ≥ 1 | **13**(artibot 8: team · resume · watch · save · blindspot · git · split · scorecard / cowork 3: claude-design · ad-compliance · long-form-writing / lab-hello / ui-ux) | **0** |
| usage 0 | 25(목록 앞쪽: artibot ad · adr · adversarial-review · analytics 4 + cowork 커맨드 21) | 209(artibot 커맨드 62 + cowork 스킬 43 + artibot 스킬 101 + lab-submit 2 + lab-skill 1) |

- 반례 0. 무접두 키를 플러그인 항목에 적용하는 대안은 반례 다수(daily · sc · index · explain · theme · dreaming · ultrareview · design 1회인데 이름만, analytics 0회인데 렌더) → 호스트는 **정확 키만** 조회(§3.2 `WFe` 와 정합). (실측 / 조회 규칙은 코드 추출)
- usage 0 인데 렌더된 25 는 전부 목록 순서상 앞쪽이고, 이름만이 시작되는 analyze 이후로는 usage 0 항목이 하나도 렌더되지 않음(내장 제외) — 동률 0 은 원래 순서대로 예산 잔여만큼 채워진다. (추론, 단일 스냅샷)
- exp 가 `usage.js` 로 계산한 `WFe` 점수 > 0 인 `artibot:` 항목은 정확히 8개(split 3.99 · save 3.76 · scorecard 0.269 · git 0.224 · team 0.100 · resume 0.100 · watch 0.100 · blindspot 0.100), `artibot-cowork:` 는 정확히 3개(long-form-writing 0.214 · claude-design 0.100 · ad-compliance 0.100) → 리더 관측과 **완전 일치**. (실측)
- **리더 재측정(artibot-ce, 00:33 KST)**: 플러그인 한정 키 usageCount≥1 = 정확히 13, 목록 동일, `artibot:` 키 보유 8(커맨드 항목; 비병합 스킬 101 은 0/101), `team` 386 vs `artibot:team` 1, 리더 자신의 시스템 프롬프트 렌더 집합과 일치 — 반례 0. (실측)
- 내장 중 keybindings-help · simplify · fewer-permission-prompts · schedule · workflow-authoring · run · artifact-diagramming · artifact-capabilities 는 skillUsage 키 없이 렌더 → §3.2 면제집합 U(bundled prompt) 와 정합. (추론)
- 트랜스크립트 교차(`~/.claude/projects/**/*.jsonl` 1,498 파일 1.7 GB, Skill 도구 138건): save 24+artibot:save 5, split 4+artibot:split 3, scorecard 4+artibot:scorecard 1 … cowork 스킬 0건. `<command-name>` 태그: /resume 108 · /team 101 · /save 52 …. **트랜스크립트만으로는 렌더 집합이 재구성되지 않는다**(cowork 3 스킬은 트랜스크립트 0건인데 skillUsage 에는 1씩) → skillUsage 증가 이벤트는 **미확인**.

## 5. 문서 근거 (docs 팀원 claude-code-guide, 문서·changelog 기준 — 실행 미확인)

주의: `docs.claude.com/en/docs/claude-code/*` 는 전부 301 → `code.claude.com/docs/en/*`.

| 항목 | 문서 내용 | 등급 | 출처 |
|---|---|---|---|
| 총 예산 | `skillListingBudgetFraction` 기본 0.01("1% of the context window"). env `SLASH_COMMAND_TOOL_CHAR_BUDGET` = 고정 문자수 덮어쓰기, "fallback of 8,000 characters", legacy name | 문서 확인 | https://code.claude.com/docs/en/settings-reference#skilllistingbudgetfraction · https://code.claude.com/docs/en/env-vars |
| 초과 시 | "The listing always contains every skill name … drops descriptions starting with the skills you invoke least". 디버그 로그에 경고. `/context` Skills 행은 예산 적용 후 크기(2.1.196+). **정정(E5 실측)**: 문서·changelog 2.1.178 의 "영향받은 description 개수 표시" 는 2.1.267 실물 경고 줄에 없다 — 찍히는 값은 총수 · 무삭감 필요 문자수 · 예산 3개뿐(§3.3 원문) | 문서 확인 / 개수 표시는 실측 불일치 | https://code.claude.com/docs/en/skills |
| 개별 캡 | `description` + `when_to_use` 합산 **1,536자 절단**, `skillListingMaxDescChars` 기본 1536 | 문서 확인 | https://code.claude.com/docs/en/settings-reference#skilllistingmaxdescchars |
| plugin.json `skills` | `string \| array`, `./` 상대경로, `"."` 허용. 생략해도 `skills/` 항상 스캔. **명시해도 "Adds to default"**(commands · agents 는 "Replaces default"). 예외: marketplace root source | 문서 확인 | https://code.claude.com/docs/en/plugins-reference |
| commands 와 skills | `commands/` = "Skills as flat .md files", `plugin details` 의 Skills 그룹에 둘 다 포함. 사용자/프로젝트 레벨 동명은 스킬 승. **플러그인 내부 동명 승자는 문서 없음** | 문서 확인 / 문서 없음 | https://code.claude.com/docs/en/skills#resolve-skills-that-share-a-name |
| frontmatter | description 생략 시 본문 첫 문단. YAML 파싱 실패 시 "empty metadata … no description"(이름만 남는 두 번째 경로). 블록 스칼라 · 중복 키 · CRLF · 미지 키 처리는 **문서 없음**. `user-invocable: false` 는 `/` 메뉴만 숨김. 플러그인 스킬은 `skillOverrides` 영향 없음 | 부분 확인 | https://code.claude.com/docs/en/skills |
| CLI | `claude plugin validate <path> [--strict] [--json]` exit 0/1/2, 미인식 필드는 경고. `plugin details` always-on = "listing text … computed via count_tokens API … per-component proportionally scaled". `--plugin-dir` 세션 한정. `--setting-sources user,project,local` 존재. `--restricted` 의 플러그인 영향은 문서 없음 | 문서 확인 | https://code.claude.com/docs/en/cli-reference |

changelog(원문 `raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md` 6,475줄 직접 grep; docs 팀원이 1차 요약의 버전 오귀속 2건을 원문 재매핑으로 정정한 결과):

| 버전 | 문구 |
|---|---|
| 2.1.265 | "a plugin skill is now found by its bare name"; `claude plugin details` 가 marketplace 항목 메타 우선 |
| 2.1.261 | "Added `/skill-doctor` to show which loaded skills go unused and what they cost in context" |
| 2.1.259 | "Added `--json` to `claude plugin validate`" |
| 2.1.246 | plugin skill `name` 에 `<plugin>:` 접두 중복 표시 수정; `/reload-plugins` 가 `skills/*/SKILL.md` 를 0 으로 세던 것 수정 |
| 2.1.239 | UTF-8 BOM 으로 시작하는 agents/skills/commands 가 무시되던 것 수정 |
| 2.1.233 | `plugin validate` 가 bare `.claude/skills` 디렉터리의 frontmatter 파싱 실패를 보고 |
| 2.1.178 | "Improved the skill listing truncation warning to show how many skill descriptions are affected" |
| 2.1.174 | 단일 스킬 변경 시 목록 전체 재전송 수정 |
| 2.1.70 | `--resume` 마다 목록 재주입 수정(~600 토큰) |

2.1.x 에 예산값 · 1,536 캡 · env 변수 도입/변경 항목은 없음 — 규칙은 skills/settings-reference 문서에만 기술.

## 6. 판정

| 판정 | 등급 |
|---|---|
| 원인 = 호스트 규약: 목록 문자 예산(컨텍스트 창 비례 — 200K 창 8,000자 확정, 1M 창 ≥24,904 실측) 초과 시 `skillUsage` 정확 키 `<plugin>:<name>` 점수 내림차순 그리디로 description 배분. artibot 스킬은 키 0/101(비병합 스킬 기준; 동명 6 은 커맨드 항목으로 병합되어 `artibot:team`·`artibot:split` 키는 그쪽에 귀속) · 목록 뒤쪽 → 잔여 예산 0 → 렌더 0 | 실측(알고리즘 추출 · 6런 경계 검산 · 200K/1M 비례 실측 · skillUsage 대조 반례 0 · 리더 재측정 일치). 리더 창(Fable 5.1)의 실제 상한값은 추론(§9) |
| 리포 frontmatter · 매니페스트 · 인코딩 · 캐시 불일치는 원인이 아님 | 실측(§2 H1~H7) |
| 목록 결측 13 스킬 · 5 커맨드는 `disable-model-invocation` · 동명 병합에 의한 의도된 은닉 | 실측(집합 일치) / 추론(규약) |
| 게이트 결정: 브리프 §완료기준 2 — 렌더 관련 게이트 **0**. 부수 fail-open 1건만 최소 수리(§7, 리더 승인) | — |

함의:
- 사용자 레벨 `~/.claude/commands/*.md` 79개(캐시 commands 와 description 합계 동일)가 `/team` · `/save` 입력을 흡수해 무접두 키(`team` 386 · `save` 253)만 오르고 플러그인 키(`artibot:team` 1 · `artibot:save` 7)는 거의 오르지 않는다 → 플러그인 항목은 우선순위 경쟁에서 구조적으로 진다. (카운트 실측 / 귀속 경로 추론)
- 같은 사본(목록 73, 파일 79)의 description ≤7,802자(정정: 초판 8,306)가 예산의 대부분을 먼저 소비한다(사용자 항목이 목록 앞). (실측 합계 / 소비 순서는 추론)
- 목록 예산은 창 크기에 비례한다(E5 실측: 200K 8,000 / 1M ≥24,904). 200K 창 사용자에게는 artibot 스킬 description 이 사실상 전혀 보이지 않고, 1M 창에서도 사용자·cowork 항목이 앞서 소비한 뒤 남는 만큼만 보인다. 스킬 발동은 이름(`artibot:<skill>`)과 `/name` 호출에 주로 의존한다. (비례는 실측, 리더 창 적용은 추론)

## 7. 부수 결함 수리 — `validate-skills.js` 블록 스칼라 fail-open

- **결정**: 리더(artibot-ce) 00:33 KST "최소 수리 허용". 사유: 검증기 fail-open 은 코퍼스 실해 0 이어도 게이트 자체가 거짓 그린의 근거가 된다(verification-discipline §10). 범위 = `validate-skills.js` 블록 스칼라 처리 + 빈 `description: |` red 케이스. 렌더 원인 게이트(§6 결정 0)와는 별건이다.
- **구현**(tdd-guide, 00:34~00:36 KST): `scripts/ci/validate-skills.js` — `inspectBlockScalarDescription(content)` 가 컬럼 0 의 `description:` 블록 헤더(`|` `|-` `|+` `>` `>-` `>+` `|2`) 본문(들여쓰기 연속 줄 · 빈 줄 허용 · 컬럼 0 의 다음 키에서 종료)이 공백뿐이면 `Empty block scalar description` FAIL(`Missing required field: description` 과 분리). 검사 로직을 `validateSkillsDir(dir)` 로 export 하고 `main()` 은 `isMainEntry(import.meta.url)` 가드(형제 `scripts/ci/lint-skill-descriptions.js:603` 패턴; `ci-utils.js#getPluginRoot()` 에 env 오버라이드가 없어 함수 export 방식 선택). 출력 문자열 · 종료코드 형식 유지. `ci-utils.js` 무수정. `git diff --stat`: validate-skills.js +129/−30(00:37).
- **테스트** `tests/ci/validate-skills.test.js`(신규, mkdtemp 픽스처만, 리포 SKILL.md 무접촉) 19건(00:37 시점; 후속 수리 후 21건, 00:48, 아래 문단): red 5(빈 `|` · 헤더 7종 · 공백 본문 · 다음 키 종료 · CRLF) · green 8(본문+빈 줄 · 인라인 · 값 안의 `|` · `metadata:` 중첩 `description: |` 무시 · CRLF 3종) · 기존 판정 보존 5 · 라이브 코퍼스 offenders 0(114 를 하드코딩하지 않음). 수리 전 코드로 RED 런: 19 중 6 fail(00:34:25) — 표적 red 증명.
- **리더 재확인**(00:37 KST): `npx vitest run tests/ci/validate-skills.test.js tests/ci/direct-run-guard.test.js` 38/38 pass(00:37 시점; 후속 수리 후 40/40, 00:48, 아래 문단) · `node scripts/ci/validate-skills.js` exit 0, 마지막 줄 `All 114 skill(s) validated successfully.` · `npx eslint scripts/ci/validate-skills.js tests/ci/validate-skills.test.js --max-warnings=0` exit 0 · `git status --porcelain` = 그 2파일만, 인덱스 비어 있음. 구현자 실행 firewall 11스위트(`scripts/ci` 스캔 게이트): 263 pass / 1 skip / 0 fail(00:35:03, skip 1건 정체 미확인).
- **소비처**(그대로 실행됨): `scripts/git-hooks/pre-push:533`(`run_gate skills`), `.github/workflows/ci.yml:108`, `.github/workflows/release.yml:114`.
- **남긴 구멍(의도)**: `name: |` 빈 블록은 통과(코퍼스 사례 0, 범위 밖). 리포 전체 vitest · prebuild · build 미실행(브리프 "표적 스위트만"). 이 게이트가 못 보는 것: 블록 본문이 있으나 의미 없는 문자열(`.` 한 글자 등)은 통과 — 내용 품질은 사이드 린터 `lint-skill-descriptions.js` 영역.
- **검수**(code-reviewer, fable, 00:38~00:45 KST): **APPROVE**(차단 0 · 비차단 3). HEAD 판과 수리판을 같은 코퍼스에 실행해 stdout `cmp` 동일(md5 809e2753…) · stderr 0바이트 · exit 0 확인. 파서 합성 30케이스 거짓 양성 0. RED 구조 독립 재현(빈 블록 검사만 죽인 사본 → 19 중 6 fail). firewall 전체 65파일 1,269 pass / 2 skip / 0 fail(00:41:12) — skip 2건은 `git-hooks-install.test.js:669` · `install-files-smoke.test.js:315` 의 win32 조건 스킵(기존, 무관). 비차단 A: 헤더 뒤 주석 `description: | # c` 를 정규식이 못 잡아 잔여 fail-open. 비차단 B: NBSP(U+00A0) 만인 본문을 `trim()` 이 지워 empty 판정(YAML 은 내용, 코퍼스 0). 비차단 C: 스타일.
- **후속 수리**(tdd-guide, 00:47 KST): A 를 닫음 — `BLOCK_SCALAR_DESCRIPTION` 정규식에 선택적 후행 주석 허용(`(?:#.*)?$`), 역주입 대조 `OLD-REGEX-MATCH: false | NEW-REGEX-MATCH: true`(00:47:16), 테스트 +2(주석 헤더+빈 본문 → red 단독 메시지 · 주석 헤더+본문 → green). B 는 테스트 헤더 "보지 못하는 것" 절에 명시(불일치 방향은 실패를 보고하는 쪽). 리더 재확인(00:48 KST): vitest 2파일 **40/40** · validate 114 exit 0 · eslint 0 · porcelain 2파일 · NBSP 포함 SKILL.md 0/114. firewall 은 이 라운드 미재실행(변경 = 정규식 1줄 + 주석 + 테스트 — 영향 없음은 추론).

## 8. 소유 밖 후속 (보고만 — 고치지 않았다)

| # | 대상 | 내용 |
|---|---|---|
| (a) | `skills/git-unified/SKILL.md`, `skills/lang-reference/SKILL.md` | frontmatter `platforms:` 키 2회 선언(YAML duplicate key). 렌더 원인은 아니나(§2 H4) 파서에 따라 마지막 값 승/오류. 114 일괄 wave 에서 정리 |
| (b) | `skills/lang-reference/SKILL.md:4`(2,363자), `skills/polish/SKILL.md:15`(1,149자) | 호스트 캡 1,536자 기준이면 lang-reference 만 절단 대상. 사이드 린터 `scripts/ci/lint-skill-descriptions.js:52 MAX_DESC_LEN = 1024`(00:3x 기준) 는 호스트 캡과 기준이 다르다 — 1,536 으로 맞출지는 그 린터 소유자 결정 |
| (c) | 114 SKILL.md 일괄 수정 wave | **목표 재정의 필요**: 총 description 39,326자는 어떤 예산(8,000 ~ 40,000)에도 사용자·cowork 항목과 함께 들어가지 않으므로 "description 을 다듬어 렌더시킨다" 는 목표는 달성 불가. 대안 ① 렌더를 기대하지 않고 트리거를 이름 · 본문 · `/name` 호출로 설계 ② 모델 자동 발동이 필요 없는 스킬은 `disable-model-invocation: true` 로 목록에서 빼 예산 회수(현재 9개) ③ 사용자 `~/.claude/commands` 사본 79(목록 73) 정리로 ≤7,802자 회수(설치 스크립트가 만든 것인지 확인 필요 — 미확인) ④ 오너 환경에서 `SLASH_COMMAND_TOOL_CHAR_BUDGET` 상향(리포 밖 설정). 소유 파일 제안: `skills/**/SKILL.md` 114 + `lint-skill-descriptions` baseline 2종 + README 카운트 sync(`scripts/ci/sync-readme-claims.js`) + `tests/ci/lint-skill-descriptions.test.js` |
| (d) | `scripts/ci/ci-utils.js#extractFrontmatter`(:478-495, 00:07) | 블록 스칼라를 원문 `"\|"` 로 저장(주석이 의도적이라 밝힘). 같은 함수를 쓰는 다른 검증기(agents · commands)도 빈 블록 description 을 통과시킬 가능성 — **미확인**. 공용 파서 수정은 소유 밖 |
| (e) | `.claude-plugin/plugin.json:75` `"skills": ["./skills/"]` | 키는 추가(additive) 의미이나 기본 `skills/` 와 같은 경로라 로더가 중복 필터링 → **효과 0**(debug `skillsPaths=0 paths`). 제거해도 무해, 유지해도 무해. 권고 diff 없음 |
| (f) | 문서 · README | `claude plugin details` 의 "projected token cost" 는 설명 전량 always-on 가정이라 실렌더 비용과 다르다 — README 수치 근거로 쓰지 말 것 |
| (g) | 팀 프로세스 | 브리프 §환경 "plugins/artibot/docs/ 는 추적 디렉터리" 는 부분 오류 — `.gitignore:24 plugins/artibot/docs/*` 아래 명시 재포함 파일만 추적. 리더 결정(00:16): 이 보고서는 `git add -f` 로 추적, .gitignore 무수정 |

## 9. 미확인 (팀원 3인 + 리더 유보 전부 합침 — 삭제하지 않음)

- 리더 창(Fable 5.1)의 `contextWindow` 인자값과 실제 예산 상한: 리더 세션 렌더 합 ≥15,395자(정정: 초판 15,902; go 길이 미측정이라 하한)는 200K 예산 8,000 을 초과하므로 리더 창은 200K 가 아니다(추론). 1M 창 예산은 ≥24,904 실측(E5)이나 상한 미측정, 공식값 40,000 은 미검증. 리더 창에서 실측된 것은 경계 analytics \| analyze 뿐. 예산 단위는 문자(코드 추출)이나 한글 비율에 따른 토큰 환산은 미측정.
- `skillUsage` 가 증가하는 이벤트 조건 · 기록 시점(Skill 도구 호출만인지, 자동 활성 · 다른 프로젝트 포함인지) — 트랜스크립트 138건과 불일치 사례 있음.
- E5 경고 줄 24,901 vs 회계 F 24,904 의 3자 차 — 파서 다중행 처리로 추정, 미확인.
- `--setting-sources local` 조합 미시도(격리는 `""` 로만).
- `WFe` 의 키가 언제 접두사 포함/미포함으로 기록되는지(`B7n` 은 fallback 이름을 받지만 `WFe` 는 정확 키만 조회) — 코드로만 확인, 실측 안 함.
- 내장(bundled) 스킬 면제의 정확한 조건 — `type=="prompt" && source=="bundled"` 는 코드 추출, init · security-review 가 이름만인 이유는 **부분 해소**(E2FG 격리 런에서도 그 둘만 이름만 → 면제집합 U 밖·예산 대상, §3.3 정정) — 왜 그 둘만 면제 밖인지는 미확인.
- `skillListingBudgetFraction` · `skillListingMaxDescChars` 를 settings 로 바꿨을 때의 동작 — 설정 파일 수정 금지라 미실행.
- ~~1,536자 절단면에 말줄임 표식이 붙는지~~ — **해소(E5)**: `desc.slice(0,1536)` 순수 slice, 표식 없음(§3.2).
- `~/.claude/commands` 79 와 캐시 `commands` 79 의 파일별 바이트 동일성 — description 합계(8,306) 일치로만 확인. 그 사본의 생성 주체(설치 스크립트인지 수동인지) 미확인. 목록 73 계산 중 `go` 가 사용자 스킬 `go` 와 동명이라 스킬 항목으로 표시됐다는 것은 추론.
- 플러그인 내부 커맨드+스킬 동명 승자 — 문서 없음, 실험(E4) 으로만 커맨드 승 확인.
- `disable-model-invocation: true` 가 목록 텍스트 자체를 제거한다는 것 — 코퍼스 집합 일치로 유도(추론), 문서 없음.
- `tengu_skill_file_changed`(`.claude.json`) 값의 의미.
- 내장 14 항목 description 길이(파일 없음) · ui-ux 렌더 문구 출처(SKILL.md 914자 vs plugin.json).
- usage 0 동률의 제거 순서가 "목록 뒤부터" 인지 — 단일 세션 스냅샷과 정합하나 반복 관측 없음.
- `extractFrontmatter` 를 쓰는 다른 검증기의 동일 fail-open 여부(§8 d).
- exp 미해결 1건: exp 는 "114 − 동명 6 = 108 인데 리더 101" 로 7개 차이를 미해결로 남겼다(00:38 갱신에서도 유지) — corpus Q2 가 dmi 7개(hook-event-emitter · persona-distill · prompt-caching-strategy · scheduled-learning · session-worklog · skill-authoring · tool-approval)로 설명(집합 일치 실측). 두 팀원 관측은 모순 없음.
- §7 게이트: firewall 11스위트의 skip 1건 정체 · `name: |` 빈 블록 통과 · 리포 전체 vitest/prebuild/build 미실행.

## 10. 재현 명령 부록

```bash
# 캐시 = worktree 동일성 (worktree 안에서)
diff -rq plugins/artibot/skills  ~/.claude/plugins/cache/artibot/artibot/4.58.0/skills
diff -rq plugins/artibot/commands ~/.claude/plugins/cache/artibot/artibot/4.58.0/commands
git diff --stat 90505f0c HEAD -- plugins/artibot/skills plugins/artibot/commands plugins/artibot/.claude-plugin

# 호스트 사용 저장소
node -e "console.log(JSON.parse(require('fs').readFileSync(process.env.USERPROFILE+'/.claude.json','utf8')).skillUsage)"

# 격리 실험 (임시 디렉터리 cwd — git 리포 안에서 실행 금지: SessionStart 훅이 브랜치를 옮긴다)
claude -p --setting-sources "" --strict-mcp-config --plugin-dir <임시플러그인> --tools Skill \
  --model claude-haiku-4-5-20251001 --max-turns 1 --debug "list skills"   # 목록은 세션 jsonl $.rendered[0].content 에서 추출
SLASH_COMMAND_TOOL_CHAR_BUDGET=100000 claude -p ...                        # 예산 덮어쓰기 검증
grep -n "Skill listing over budget" <debug 로그>                            # 예산 초과 신호: "[WARN] Skill listing over budget: N skills, C chars > B budget — descriptions will be truncated." 부재 = 예산 내
claude -p --model claude-opus-5[1m] ...                                    # 1M 창 예산 비례 확인(E5: 동일 pgC 60/60)
claude plugin validate <임시플러그인> --json
claude --plugin-dir <임시플러그인> plugin details <plugin-name>

# 리포 게이트
node plugins/artibot/scripts/ci/validate-skills.js      # pre-push run_gate skills (scripts/git-hooks/pre-push:533)
```
