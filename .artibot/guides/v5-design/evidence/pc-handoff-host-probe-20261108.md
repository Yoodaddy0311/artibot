# PC 인수인계 호스트 프로브 — 2026-11-08 KST (2026-11-07 15:1x~15:22Z)

- 환경: Windows 11 10.0.26200 · Node 22.19.0 · claude **2.1.319** · 플러그인은 `--plugin-dir` 로만 태움(설치본 4.71.14 는 건드리지 않음). `init` 행의 plugins 목록에 artibot 은 `--plugin-dir` 경로 하나뿐 — **같은 이름이면 `--plugin-dir` 가 설치본을 대신한다**(실측).
- 작업 디렉터리: 세션 스크래치패드의 임시 git 리포(커밋 1개, `README.md` 한 줄). 홈 절대경로는 이 문서에서 `~` 로 적었다.
- 기준 트리: master `3cae1ca8`(= `onFailure: "block"` 착지 뒤). 비용은 각 실행의 `result.total_cost_usd`(클라이언트 계산, `costBasis: list`).

## 1. 비용 (오너 승인 상한 약 $0.6)

| # | 무엇 | 모델 | 턴 | 비용 USD |
|---|---|---|---|---|
| 1 | §A-3 1차 | claude-opus-5-5(기본값) | 1 | 0.4797 — 첫 턴 캐시 쓰기 58,793 토큰 × $8/MTok(1h) + 출력 467 × $20/MTok. `--max-budget-usd 0.2` 는 턴이 끝난 **뒤** 검사돼 1턴 만에 넘었다 |
| 2 | §A-3 2차 | claude-haiku-5-5 | 5 | 0.0148 |
| 3 | onFailure M1 | claude-haiku-5-5 | 2 | 0.0100 |
| 4 | onFailure M0(대조) | claude-haiku-5-5 | 2 | 0.0099 |
| 5 | onFailure M2 | claude-haiku-5-5 | 2 | 0.0099 |
| 6 | §A-5 훅 지연 | claude-haiku-5-5 | 2 | 0.0101 |
| | **합계** | | | **0.5344** |

단가는 `plugins/artibot/lib/core/model-catalog.js#MODELS`(2026-10-12 확인값). 1번의 청구액이 그 단가로 정확히 재현된다. 2~6번을 Haiku 로 돌린 이유: 프로브는 훅 발화를 재는 것이지 모델 품질을 재는 것이 아니고, 같은 첫 턴이 Haiku 로 약 $0.012 다.

## 2. §A-3 호스트 통합 (D-01 · D-03) — PASS

```
claude --model claude-haiku-5-5 --plugin-dir <checkout>/plugins/artibot -p "README.md 파일을 Read 도구로 정확히 3번 연속 읽어라(매번 같은 인자). 그 다음 Bash 도구로 echo artibot-probe 를 1번 실행하라. 다른 도구는 쓰지 말고, 끝나면 끝 이라는 한 단어만 답하라." --allowedTools "Read" "Bash(echo artibot-probe)" --output-format stream-json --verbose --include-hook-events --max-budget-usd 0.05
node .artibot/guides/v5-design/practicality-improvement-20261023/pc-handoff.mjs host-probe --verify --session 086b6598-8ced-41ca-8fe1-573356fc9c96
```

- 러너가 출력한 명령에 `--allowedTools` 와 `--model` 만 더했다(`-p` 에서 Bash 가 권한 거부되면 PostToolUse 가 안 생긴다).
- 세션 `086b6598-…`: 도구 호출 Read 3 + Bash 1 → `~/.claude/artibot/runtime/sessions/<sid>/loop-state.json` 의 `history` **4** · `detections` **1**(`warn`, Read, count 3). 격리 재현(05 §8.1)의 기준값과 같다. **D-01 호스트 통합 PASS(실측).**
- D-03: `tool-history.json#contexts` 에 `bash:unknown:shell` 키가 있다(행 200, 실제 호스트 훅만 쓰는 파일). 다만 행에 세션 id 가 없고 같은 시각에 이 리더 세션의 Bash 도 같은 파일에 썼으므로 **이 프로브의 echo 가 쓴 행이라고는 특정 못 한다(미확인)**. "실제 호스트가 `bash:unknown:shell` 행을 쓴다" 까지가 실측이다.
- 1차(Opus)는 Read 1회 뒤 예산 초과로 끝났다 — 그래도 `loop-state.json` 이 `history 1` 로 생겨, 세션별 파일 생성 자체는 거기서 이미 보였다(세션 `36377dd4-…`).

## 3. `onFailure: "block"` 라이브 프로브 — 예측대로 3/3

`git archive HEAD plugins/artibot` 사본 셋에서 `scripts/hooks/pre-bash.js` 만 바꿨다. 적용 확인: 각 사본의 `pre-bash.js` 둘째 줄과 `hooks.json` 의 pre-bash 항목 `onFailure` 값을 읽어 표로 찍었고, M1 사본의 훅을 단독 실행하면 exit 1 이다.

| 실행 | `pre-bash.js` | `onFailure` | 결과 (tool_result) |
|---|---|---|---|
| M1 | 없는 모듈 import → 로드 시 `ERR_MODULE_NOT_FOUND`, exit 1 | `block` | **막힘** — `PreToolUse:Bash hook error: [...pre-bash.js]: failed; blocking because onFailure is "block"` |
| M0 (대조) | 같음 | 없음(키 삭제) | **실행됨** — `artibot-onfailure-probe` 출력. 훅은 `exit 1 outcome error` 였다 = 이번 변경 전의 fail-open 구멍 |
| M2 | 최상위 `await` 9초 | `block` | **막힘** — `…: timed out; blocking because onFailure is "block"`, 훅 `outcome cancelled` |

프롬프트(공통): `Bash 도구로 echo artibot-onfailure-probe 를 정확히 1번 실행하라. 막히면 다시 시도하지 말고, 받은 결과나 오류를 한 줄로 그대로 답하라.` · `--allowedTools "Bash(echo artibot-onfailure-probe)"`. 세션: M1 `b1f3d21b-…` · M0 `344df22b-…` · M2 `62220dbb-…`. 세 실행 모두 다른 `PreToolUse:Bash` 훅 응답 1개는 `exit 0 success` 였다 — 플러그인의 Bash 훅은 둘뿐이라 `bash-risk-guard.js`(변경 없음)로 보이지만, 스트림의 `hook_name` 에 파일명이 없어 추론이다.

## 4. §A-5 훅 지연 — Write 1회, n=1

`--debug=hooks --debug-file <file>` 로 Write 1회(세션 동일 조건, Haiku). PreToolUse:Write 다섯 훅은 **병렬**로 돌았고(종료 시각 − 소요 = 시작 시각이 다섯 개 모두 15:22:19.677Z ±1 ms):

| 훅 | 소요 ms |
|---|---|
| pre-write.js | 330 |
| pre-write-checkpoint.js | 340 |
| intent-observe-pre.js | 405 |
| pre-write-guard.js | 409 |
| git-autopilot-guard.js | 414 |

- Write 1회의 PreToolUse 벽시계 ≈ **414 ms**(가장 느린 훅). 06 §2 의 샌드박스 벤치(훅당 68~94 ms, 호스트 IPC 제외)의 4~5배이고, 호스트가 Git Bash 를 거쳐 node 를 띄운 값과 같은 대역이다(2026-10-06 메모: Bash 툴 경유 node 기동 391~464 ms, 네이티브 58~98 ms — 추론으로 연결).
- 병렬이므로 훅을 하나로 합쳐도(06 §8 #6 디스패처 통합) 벽시계는 "가장 느린 하나" 에서 "합친 하나" 로 바뀔 뿐이다. 표본 1개라 판정 근거로는 약하다.
