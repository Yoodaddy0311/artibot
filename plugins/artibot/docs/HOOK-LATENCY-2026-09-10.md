# 훅 지연 실측 — N=20 본측정 (2026-09-10 UTC / 2026-09-11 KST)

`scripts/bench/hook-latency.mjs` 로 `hooks/hooks.json` 에 등록된 19개 슬롯 전부를
N=20, warmup=2 로 측정한 결과다. 이 문서는 **측정 기록**이며, 훅·디스패처·러너·테스트
소스는 하나도 고치지 않았다. 예산을 넘는 슬롯이 있으면 고치는 게 아니라 표에 적는다.

측정은 **4회** 실행했다.

| 실행 | 시각(KST) | 러너 커밋 | 모드 | exit | `strictWouldFail` | 비고 |
|---|---|---|---|---|---|---|
| run 1 | 00:31~00:34 | 없음(워킹트리 수정 중) | strict 상당 | 2 | 필드 없음 | guard 오탐 — 아래 guards 절 |
| run 2 | 00:37~00:42 | 없음(워킹트리 수정 중) | strict 상당 | 2 | 필드 없음 | 라이브 세션 동시 쓰기 |
| run 3 | 00:53~00:57 | `7c3309f5` | strict 상당 | 0 | 필드 없음 | **strict 대조군 — 6/6 통과** |
| **run 4** | **01:12~01:16** | **`4a7983a6`** | **tolerate** | **0** | **`true`** | **본표의 출처** |

**모드 열 읽는 법.** `--writers strict|tolerate` 플래그는 run 1~3 시점에 **존재하지 않았다.**
세 실행 모두 "실 스토어의 어떤 변화든 위반"이라는 단일 동작이었고, 그것이 지금의 `strict`
기본값과 같은 판정이므로 **`strict 상당`** 이라고 적었다. 플래그로 고른 `strict` 가 아니다.
같은 이유로 `strictWouldFail` 필드도 세 실행의 JSON 에 **없다** — 그 필드는 `4a7983a6` 의
러너가 만든다. 세 실행에서 그에 대응하는 관측치는 프로세스 exit code 뿐이다(2 / 2 / 0).

**본표는 run 4 다.** 러너 최종 커밋 `4a7983a6` 위에서 `--writers tolerate` 로 돌았고 exit 0 이다.
run 1·2 는 커밋되지 않은 러너로 잰 값이라 어떤 커밋에도 대응하지 않으며, 재현성 대조로만 남긴다.

**run 3 은 strict 대조군으로 남긴다.** run 4 의 exit 0 은 `strictWouldFail: true` 를 동반한다 —
즉 **strict 였다면 실패했을 창**에서 잰 값이다. tolerate 의 exit 0 자체는 무해함의 증거가
아니므로(재현 명령 절의 "tolerate 가 못 보는 것"), 벤치가 실 스토어를 오염시키지 않는다는
판정은 계속 run 3 의 **strict clean exit 0** 이 담당한다. 두 실행은 서로를 대체하지 않는다.

## 요약

아래는 run 4(본표) 기준이며, 괄호 안은 run 3(strict 대조군) 값이다.

- 19개 슬롯 전부 측정 성공. **훅 exit code 전부 0, timeout 0건**(19슬롯 × 20회 = 380 런).
  run 3 도 같다.
- 선언 예산을 넘긴 슬롯 **0개**. p95 대비 예산 소진율이 가장 높은 슬롯도 **14.7%**
  (PreCompact 1,179.43ms / 8,000ms; run 3 은 16.1%). 그다음이
  `PreToolUse:pre-write-guard` 12.2%, 나머지 17개는 전부 10% 미만이다.
- 가장 느린 슬롯은 `SessionStart`(p50 1,047.89ms; run 3 은 1,297.35ms) — 자식 9개를 팬아웃한다.
- **자식 수: 측정 = 정적 선언, 19슬롯 전부 일치.** 손자 프로세스는 **전 슬롯 0개** — 어떤
  디스패처도 Node 프로세스를 2단계로 중첩해 띄우지 않는다. 두 실행 모두 그렇다.
- **guard: 벤치 지문이 실 스토어에 도달한 건 0건**(양쪽 다 `clean (0 of 570 …)`).
  단 run 4 는 `strictWouldFail: true` 다 — 라이브 세션이 실 스토어에 쓴 창이었다는 뜻이고,
  그 쓴 주체는 `unattributedRows` 에 기록돼 있다. **오염 없음의 판정 근거는 run 3 의
  strict clean exit 0 이다.**
- `HEADROOM_MS = 3000` 은 **유지 권고**. run 4 로 재계산해도 결론은 바뀌지 않는다(아래 절).

## 본표 — run 4 (N=20, warmup=2, 러너 커밋 `4a7983a6`, 모드 tolerate, exit 0, `strictWouldFail: true`)

`자식` 은 `측정/정적`(pid 프로브로 실제 센 수 / `hooks/dispatch-table.json` 이 선언한 수).
`여유` 는 `선언 예산 − p95`. 단위는 전부 ms.

| 슬롯 | 종류 | N | warmup | p50 | p95 | max | min | mean | 자식 | 손자 | 예산 | 여유 | stdout(B) | exit | 미측정 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| SessionStart | dispatcher | 20 | 2 | 1047.89 | 1176.76 | 1192.61 | 929.14 | 1058.75 | 9/9 | 9 | 30000 | 28823 | 422 | 0 | 없음 |
| UserPromptSubmit | dispatcher | 20 | 2 | 717.24 | 917.60 | 1053.12 | 548.21 | 736.41 | 1/1 | 1 | 15000 | 14082 | 142 | 0 | 없음 |
| PostToolUse:Write | dispatcher | 20 | 2 | 744.89 | 931.93 | 1262.95 | 665.45 | 794.56 | 5/5 | 5 | 30000 | 29068 | 0 | 0 | 없음 |
| PostToolUse:Bash | dispatcher | 20 | 2 | 415.49 | 530.64 | 542.95 | 369.20 | 431.70 | 3/3 | 3 | 30000 | 29469 | 0 | 0 | 없음 |
| Stop | dispatcher | 20 | 2 | 832.47 | 984.75 | 997.18 | 721.22 | 857.81 | 6/6 | 6 | 30000 | 29015 | 0 | 0 | 없음 |
| SessionEnd | dispatcher | 20 | 2 | 640.29 | 915.26 | 919.28 | 560.32 | 689.61 | 6/6 | 6 | 30000 | 29085 | 0 | 0 | 없음 |
| SubagentStop | dispatcher | 20 | 2 | 461.02 | 611.94 | 702.48 | 433.64 | 501.52 | 3/3 | 3 | 15000 | 14388 | 219 | 0 | 없음 |
| PreToolUse:pre-write | direct | 20 | 2 | 190.43 | 262.36 | 293.73 | 162.27 | 201.73 | 0/0 | 0 | 5000 | 4738 | 22 | 0 | 없음 |
| PreToolUse:pre-write-guard | direct | 20 | 2 | 495.54 | 608.36 | 813.79 | 349.75 | 499.44 | 0/0 | 0 | 5000 | 4392 | 22 | 0 | 없음 |
| PreToolUse:pre-write-checkpoint | direct | 20 | 2 | 173.74 | 222.15 | 277.76 | 162.07 | 184.52 | 0/0 | 0 | 5000 | 4778 | 22 | 0 | 없음 |
| PreToolUse:autopilot-guard | direct | 20 | 2 | 296.10 | 440.09 | 611.46 | 248.00 | 325.15 | 0/0 | 0 | 5000 | 4560 | 0 | 0 | 없음 |
| PreToolUse:pre-bash | direct | 20 | 2 | 177.42 | 319.64 | 319.67 | 141.64 | 217.39 | 0/0 | 0 | 5000 | 4680 | 22 | 0 | 없음 |
| PreToolUse:bash-risk-guard | direct | 20 | 2 | 194.29 | 266.10 | 273.33 | 156.07 | 194.69 | 0/0 | 0 | 5000 | 4734 | 0 | 0 | 없음 |
| PreToolUse:route-observe-pre | direct | 20 | 2 | 257.02 | 327.83 | 374.11 | 218.31 | 269.26 | 0/0 | 0 | 5000 | 4672 | 0 | 0 | 없음 |
| PreToolUse:webfetch-cache-pre | direct | 20 | 2 | 220.87 | 320.19 | 340.06 | 172.24 | 236.36 | 0/0 | 0 | 5000 | 4680 | 299 | 0 | 없음 |
| PreCompact | direct | 20 | 2 | 940.31 | 1179.43 | 1189.83 | 733.36 | 941.72 | 0/0 | 0 | 8000 | 6821 | 185 | 0 | 없음 |
| PostCompact | direct | 20 | 2 | 164.23 | 213.07 | 250.46 | 140.98 | 174.59 | 0/0 | 0 | 8000 | 7787 | 0 | 0 | 없음 |
| SubagentStart:subagent-handler | direct | 20 | 2 | 212.73 | 270.64 | 285.48 | 189.12 | 218.43 | 0/0 | 0 | 5000 | 4729 | 68 | 0 | 없음 |
| SubagentStart:workflow-status | direct | 20 | 2 | 172.70 | 239.98 | 246.52 | 156.97 | 187.01 | 0/0 | 0 | 5000 | 4760 | 69 | 0 | 없음 |

`stdout(B)` 는 20회 전부 동일한 바이트 수였다(범위가 아니라 단일값). `exit` 도 20회 전부 0이라
단일값으로 적었다. `미측정` 은 러너가 `unmeasured` 사유를 붙인 슬롯이 없어 전부 "없음"이다.
`4a7983a6` 이 추가한 런 수준 필드 `sandboxLeftovers` 는 **빈 배열**이었다 — 샌드박스 디렉터리가
하나도 남지 않고 정리됐다는 뜻이다.

### strict 대조군 — run 3 (러너 커밋 `7c3309f5`, exit 0, 6/6 통과)

run 4 는 `strictWouldFail: true` 창에서 잰 값이므로, 아래 run 3 값을 대조군으로 함께 둔다.
슬롯별 p95 는 재현성 절의 4-way 표에 전부 있다. 요약 지표만 옮기면:

| 지표 | run 3 (strict, exit 0) | run 4 (tolerate, exit 0) |
|---|---|---|
| 최장 슬롯 p50 | SessionStart 1297.35 | SessionStart 1047.89 |
| 최장 슬롯 p95 | SessionStart 1414.96 | SessionStart 1176.76 |
| 예산 소진율 최댓값 | PreCompact 16.1% | PreCompact 14.7% |
| 자식 수 불일치 | 0건 | 0건 |
| 손자 프로세스 | 전 슬롯 0 | 전 슬롯 0 |
| timeout | 0건 | 0건 |
| 훅 exit code | 380/380 이 0 | 380/380 이 0 |

두 실행의 결론은 같다. **모드 차이는 guard 판정에만 영향을 주고 타이밍에는 영향을 주지
않는다** — 근거는 아래 "러너 커밋 간 diff" 절의 함수 해시 대조다.

### 슬롯 → 스크립트 대응

| 슬롯 | 실행 스크립트 | 자식 스크립트(디스패처 자신 제외) |
|---|---|---|
| SessionStart | `_sessionstart-dispatcher.js` | `git-autopilot-session.js`, `git-autopilot-setup.js`, `image-cleanup.js`, `memory-tracker.js`, `session-digest.js`, `session-readback.mjs`, `session-start.js`, `skill-validation-check.js`, `swarm-download.js` |
| UserPromptSubmit | `_userprompt-dispatcher.js` | `git-autopilot-save.js` |
| PostToolUse:Write | `_posttooluse-dispatcher.js` | `mark-main-agent-edit.js`, `post-edit-recovery.js`, `post-write-tdd.js`, `quality-gate.js`, `tool-tracker.js` |
| PostToolUse:Bash | `_posttooluse-dispatcher.js` | `post-bash-failure.js`, `post-bash.js`, `tool-tracker.js` |
| Stop | `_stop-dispatcher.js` | `dev-verify-gate.js`, `git-autopilot-close.js`, `session-ledger.mjs`, `session-notes.js`, `stop-recap.js`, `stop-review-gate.js` |
| SessionEnd | `_sessionend-dispatcher.js` | `http-notify.js`, `memory-tracker.js`, `rotation-runner.js`, `session-end.js`, `session-ledger.mjs`, `swarm-sync.js` |
| SubagentStop | `_subagentstop-dispatcher.js` | `agent-evaluator.js`, `subagent-handler.js`, `workflow-status.js` |
| PreToolUse:pre-write | `pre-write.js` | 없음(직접 훅) |
| PreToolUse:pre-write-guard | `pre-write-guard.js` | 없음(직접 훅) |
| PreToolUse:pre-write-checkpoint | `pre-write-checkpoint.js` | 없음(직접 훅) |
| PreToolUse:autopilot-guard | `git-autopilot-guard.js` | 없음(직접 훅) |
| PreToolUse:pre-bash | `pre-bash.js` | 없음(직접 훅) |
| PreToolUse:bash-risk-guard | `bash-risk-guard.js` | 없음(직접 훅) |
| PreToolUse:route-observe-pre | `route-observe-pre.js` | 없음(직접 훅) |
| PreToolUse:webfetch-cache-pre | `webfetch-cache-pre.js` | 없음(직접 훅) |
| PreCompact | `pre-compact.js` | 없음(직접 훅) |
| PostCompact | `post-compact-rehydrate.js` | 없음(직접 훅) |
| SubagentStart:subagent-handler | `subagent-handler.js start` | 없음(직접 훅) |
| SubagentStart:workflow-status | `workflow-status.js teammate-update` | 없음(직접 훅) |

**측정 자식 수 = 정적 선언 수, 19슬롯 전부 일치.** 디스패치 테이블이 선언한 팬아웃과 실제
스폰된 Node 프로세스 수가 어긋난 슬롯은 없다.

**손자 프로세스는 전 슬롯 0개다.** run 3 의 pid 프로브가 남긴 `children.rows`(pid/ppid/script)를
전수 검사한 결과, 모든 자식의 `ppid` 가 디스패처 자신의 `rootPid` 였다. 예: SessionStart 는
rows 10건 중 9건이 `ppid=79072`(디스패처), 나머지 1건이 디스패처 자신이다. run 4 도
`grandchildren` 이 슬롯마다 `measured` 와 같은 값이다(9/1/5/3/6/6/3, 직접 훅은 전부 0).
**Node 프로세스가 2단계로 중첩되는 슬롯은 없다.** 단, 프로브는 Node 프로세스만 센다
(아래 "못 보는 것" 6번).

## 재현성 — run 1 / run 2 / run 3 / run 4

네 실행 모두 같은 명령, 같은 머신이다. run 4 만 `--writers tolerate` 이고 나머지는 strict
상당이지만, **모드는 guard 판정에만 관여하고 타이밍 코드는 네 실행에서 동일하다**(러너 커밋 간
diff 절의 함수 해시 대조). run 2 는 다른 Claude 세션이 실 스토어에 쓰는 것이 guard 로 관측된
창에서 돌았고, 그 경합이 tail 에 그대로 보인다.

| 슬롯 | r1 p50 | r2 p50 | r3 p50 | r4 p50 | r1 p95 | r2 p95 | r3 p95 | r4 p95 |
|---|---|---|---|---|---|---|---|---|
| SessionStart | 1455.00 | 1193.83 | 1297.35 | 1047.89 | 1657.57 | 1356.61 | 1414.96 | 1176.76 |
| UserPromptSubmit | 778.86 | 855.23 | 699.09 | 717.24 | 983.92 | 1060.40 | 784.83 | 917.60 |
| PostToolUse:Write | 773.31 | 716.31 | 726.86 | 744.89 | 980.70 | 879.24 | 888.51 | 931.93 |
| PostToolUse:Bash | 434.33 | 573.53 | 478.76 | 415.49 | 600.93 | 754.06 | 593.99 | 530.64 |
| Stop | 1019.00 | 904.79 | 834.89 | 832.47 | 1166.81 | 1073.90 | 1107.16 | 984.75 |
| SessionEnd | 638.08 | 913.67 | 655.04 | 640.29 | 752.80 | 2461.82 | 795.31 | 915.26 |
| SubagentStop | 482.95 | 539.59 | 476.90 | 461.02 | 605.16 | 718.61 | 628.12 | 611.94 |
| PreToolUse:pre-write | 172.01 | 216.25 | 169.04 | 190.43 | 205.06 | 364.57 | 229.74 | 262.36 |
| PreToolUse:pre-write-guard | 410.59 | 461.59 | 391.38 | 495.54 | 511.90 | 688.71 | 550.31 | 608.36 |
| PreToolUse:pre-write-checkpoint | 154.27 | 174.60 | 181.30 | 173.74 | 256.12 | 196.25 | 340.19 | 222.15 |
| PreToolUse:autopilot-guard | 295.89 | 420.19 | 277.80 | 296.10 | 360.06 | 545.00 | 337.43 | 440.09 |
| PreToolUse:pre-bash | 182.22 | 191.37 | 182.16 | 177.42 | 233.32 | 312.66 | 264.18 | 319.64 |
| PreToolUse:bash-risk-guard | 163.19 | 170.89 | 161.52 | 194.29 | 197.14 | 256.75 | 196.76 | 266.10 |
| PreToolUse:route-observe-pre | 202.98 | 249.76 | 217.89 | 257.02 | 247.56 | 352.12 | 329.17 | 327.83 |
| PreToolUse:webfetch-cache-pre | 162.06 | 165.17 | 220.42 | 220.87 | 257.57 | 229.50 | 349.30 | 320.19 |
| PreCompact | 1048.08 | 1110.37 | 1002.17 | 940.31 | 1222.12 | 2729.53 | 1284.59 | 1179.43 |
| PostCompact | 170.32 | 224.47 | 184.16 | 164.23 | 189.53 | 356.60 | 284.43 | 213.07 |
| SubagentStart:subagent-handler | 212.75 | 222.95 | 271.04 | 212.73 | 320.25 | 435.50 | 427.15 | 270.64 |
| SubagentStart:workflow-status | 167.77 | 189.93 | 183.02 | 172.70 | 221.91 | 234.48 | 228.43 | 239.98 |

**run 3 과 run 4 의 p50 차이는 작다.** 19슬롯 중 절댓값이 가장 큰 것이 SessionStart
−249.46ms(1297.35 → 1047.89), 그다음이 `pre-write-guard` +104.16ms 이며, 나머지 17개는
전부 ±65ms 안이다. **strict 로 잰 값과 tolerate 로 잰 값이 타이밍상 구분되지 않는다** —
모드가 측정에 개입하지 않는다는 관측 근거다(코드 근거는 함수 해시 대조).

**p50 은 네 실행에서 안정적이다.** 슬롯별 네 값의 최대-최소 폭이 가장 큰 것이 SessionStart
407.11ms 이고, 직접 훅은 대부분 60ms 안이다.

**p95 는 안정적이지 않다.** `SessionEnd` 는 752.80 / 2,461.82 / 795.31 / 915.26, `PreCompact` 는
1,222.12 / 2,729.53 / 1,284.59 / 1,179.43 로 **run 2 만 홀로 튄다.** 나머지 세 실행은 서로 가깝다.
p50 은 거의 안 움직였는데 p95 만 1.5~1.7초 뛴 형태이므로, 소수 샘플만 길어진 경합 신호다.
**이 문서의 p95 를 "이 훅의 고유 비용"으로 읽지 마라. 같은 머신에서 5분 뒤에 재면 2배가 된다.**

### 리더 n=5 스모크(00:24 KST)와의 비교

| 슬롯 | 스모크 p50 (n=5) | run 3 p50 (n=20) | 차이 |
|---|---|---|---|
| SessionStart | 1284 | 1297.35 | +13 |
| Stop | 853 | 834.89 | -18 |
| SessionEnd | 809 | 655.04 | -154 |
| UserPromptSubmit | 829 | 699.09 | -130 |
| PostToolUse:Write | 838 | 726.86 | -111 |
| SubagentStop | 711 | 476.90 | -234 |
| PreCompact | 943 | 1002.17 | +59 |

n=5 스모크와 본측정 p50 은 SubagentStop(-234ms) 을 빼면 전부 ±160ms 안에서 일치한다.
스모크가 제시한 `PreToolUse 150~585ms` 대역도 본측정 직접 훅 p50 범위(161.52~391.38ms)
안에 든다. **크게 다른 슬롯은 없다.**

## 재현 명령

머신 상태에 따라 두 줄 중 하나를 쓴다. 두 명령 모두 `<repo>` 는 **부모 체크아웃 루트**
(이 워크트리가 아니라 주 체크아웃의 리포 루트)를 가리킨다.

**유휴 머신 — `--writers strict`(기본).** run 3 이 실제로 쓴 형태다.

```
cd plugins/artibot
# <repo> = 부모 체크아웃 루트
node scripts/bench/hook-latency.mjs --slot all --n 20 --warmup 2 --json \
  --guard "<repo>/.artibot/runtime/ledger.jsonl" \
  > <scratch>/hook-latency-n20-run3.json
```

**라이브 머신 — `--writers tolerate`.** 다른 Claude 세션이 도는 동안 쓴다.

```
cd plugins/artibot
# <repo> = 부모 체크아웃 루트
node scripts/bench/hook-latency.mjs --slot all --n 20 --warmup 2 --json \
  --writers tolerate \
  --guard "<repo>/.artibot/runtime/ledger.jsonl" \
  > <scratch>/hook-latency-n20-run4.json
```

> 2026-09-11 갱신: 기본 스펙에 `<git common dir>/artibot/ledger.jsonl` 이 추가됐다(`defaultGuardSpecs` 헤더 주석의 5번 항목 — 아래 run 표의 위치 번호 #5/#6 과는 다른 번호다 —
> 원장이 git 공용 디렉터리로 이관되는 W5-b 착지 대비). 대상이 전후 모두 부재하면 `[SKIP]`(`skipped: true`,
> `absent/absent`) 로 표기되며 `ok` 로 뭉개지지 않는다 — 부재는 통과가 아니다.

**strict clean exit 0 이 가장 강한 증거다.** tolerate 는 판정을 약화시키는 대신 실행 가능성을
얻는 거래이고, 그 거래로 잃는 것이 바로 아래 문단이다. 가능하면 유휴 창을 잡아 strict 로
돌려라.

사람이 읽는 표는 `--json` 을 빼면 나온다. 한 실행에 약 4분 걸린다(19슬롯 × 22런 + 자식 프로브 런).

### tolerate 가 못 보는 것

`tolerate` 는 **정확-일치 지문이 0건인** 스토어 변화를
`CHANGED (unattributed — 0 of N; strict would FAIL)` 로 내리고 exit 0 을 준다. 즉 판정 근거가
"이번 실행이 생성한 값이 스토어에 없다"로 좁아진다. **지문을 남기지 않는 누출은 이 좁은
판정을 그대로 통과한다.** 최소 세 종류가 그렇다.

- **카운터·집계 증가.** 실행 횟수, 누적 토큰, 이벤트 카운트처럼 벤치가 유발했지만 세션 id
  나 샌드박스 경로를 값으로 담지 않는 증분. 숫자만 커지므로 지문이 없다.
- **툴명·슬롯명을 키로 쓰는 행.** `tool-history` 류에서 키가 `Write`·`Bash` 같은 툴 이름이면,
  벤치가 만든 행과 실사용 행이 **문자열로 구분되지 않는다.**
- **프로필·프로파일 성장.** 이 측정에서 실제로 관측된 사례다 — `user-profile.json` 이 실행마다
  약 3~4 KB 자랐는데(informational guard 절), 그 증가분에 벤치 지문이 있는지는 **미확인**이다.
  지문이 없다면 tolerate 는 이것을 unattributed 로 넘긴다.

그래서 tolerate 런의 `strictWouldFail: true` 는 "무해함이 증명됐다"가 아니라 **"이 창에서는
증명을 포기했다"** 로 읽어야 한다. 무해함의 증거는 strict 클린 런뿐이다.

vitest 스모크:

```
npx vitest bench tests/bench/hook-latency.bench.js --run
```

`tests/bench/hook-latency.bench.js` 는 커밋 `a113471b` 로 들어왔다(291줄).
8슬롯 × (warmup 1 + timed 3) × vitest 프로젝트 2개 = **호출당 스폰 64회**.

**이 래퍼의 exit code 는 머신 상태에 달려 있다.** 래퍼는 `ARTIBOT_BENCH_WRITERS` 가 설정되지
않으면 strict 로 돈다. 따라서 다른 세션이 부모 `.artibot/runtime` 에 쓰는 창에서는
**exit 1 이 정상 동작**이다 — 검수 실측(01:14 KST)에서 autopilot 프로젝트 verdict 가 CHANGED
였고 쓴 주체는 세션 `96abcf50` 이었다(본 문서 run 2·run 4 를 흔든 그 세션이다).
`6e98821b` 부터 환경변수로 모드를 고를 수 있다:

```
ARTIBOT_BENCH_WRITERS=tolerate npx vitest bench tests/bench/hook-latency.bench.js --run
```

리더 실측(01:30 KST) 기준 이 형태는 exit 0 이고 `0 of 8 guard(s) would fail under strict` 를
보고했다. 기본(strict) 형태의 exit 0 은 리더 실측(00:4x KST)으로 확인됐다. **두 값 모두
리더 실측 인용이며 내가 재현하지 않았다.**

같은 디렉터리의 `hook-latency.test.js` 는 **스폰 0회의 순수 단위 테스트**이며,
`aa5303ec`(러너 계약 핀 29+29건)와 후속 `6e98821b`(다른 줄기 모듈 `classifyRisk` 의존 제거,
래퍼 짝맺기 수정, 러너 주석)으로 **이미 커밋됐다.**

**vitest 설정은 파일이 두 개다.** 리포 루트 `vitest.config.js` 와 정본인
`plugins/artibot/vitest.config.js` 가 있고, 루트 파일의 주석이 스스로 후자를 "canonical
config" 라고 밝힌다. 정본 쪽은 `include` 를 **프로젝트별로** 둔다(`:21` 주석이 그렇게 명시):
`main` 프로젝트 `:96` `include: ['tests/**/*.test.{js,mjs}']`, `autopilot` 프로젝트 `:89`
`include: ['tests/autopilot/**/*.test.{js,mjs}']`. **두 프로젝트 어느 쪽도 `benchmark.include`
를 좁히지 않는다.** 그래서 `.bench.js` 는 vitest 기본 `benchmark.include` 글롭으로 잡히고,
프로젝트가 둘이라 **같은 파일이 두 번 실행된다** — 위 "스폰 64회"의 ×2 가 이것이다.
(config 변경 제안은 아래 "소유 밖 후속" 절.)

## 측정 환경

| 항목 | run 4 (본표) | run 3 (strict 대조군) |
|---|---|---|
| 시작 | 2026-09-10T16:12:38Z / 01:12:38 KST | 2026-09-10T15:53:24Z / 00:53:24 KST |
| 종료(러너 `measuredAt`) | 2026-09-10T16:16:30Z / 01:16:30 KST | 2026-09-10T15:57:24Z / 00:57:24 KST |
| 모드 | `--writers tolerate` | strict 상당(플래그 이전) |
| exit | 0 | 0 |
| `strictWouldFail`(런 수준) | `true` | 필드 없음 |
| 실행 직전 `git rev-parse HEAD` | `4a7983a6…` (러너 `M` 없음 확인) | `7c3309f5…` (러너 `M` 없음 확인) |
| 러너가 보고한 `headSha` | `4a7983a6325647279bf793b929960b022c3bc353` | `a113471bc9e9dbec80b64c04561fe03c2e267ca8` |
| 러너 커밋(귀속) | `4a7983a6325647279bf793b929960b022c3bc353` | `7c3309f5fea5f810013ce20778178014974e2387` |

공통 환경:

| 항목 | 값 |
|---|---|
| OS | Windows_NT 10.0.26200 (win32, x64) |
| CPU | AMD RYZEN AI MAX+ 395 w/ Radeon 8060S |
| 논리 코어 | 32 |
| 메모리 | 59.6 GB |
| Node | v24.15.0 |
| 플러그인 버전 | 4.58.0 |
| 플러그인 루트 | `<worktree>/plugins/artibot` |
| 브랜치 | `worktree-split-artibot-hook-latency-bench` |

**run 4 는 두 sha 가 일치한다.** 실행 직전 HEAD 와 러너가 종료 시점에 보고한 `headSha` 가
모두 `4a7983a6` 이다. 실행 중 커밋이 없었다는 뜻이므로, run 3 에서 필요했던 아래 귀속 논증이
run 4 에는 필요 없다.

### (run 3 한정) 두 sha 가 다른 이유 — 측정은 여전히 `7c3309f5` 에 귀속된다

실행 **직전**(00:53:2x) HEAD 는 `7c3309f5` 였고 `git status --porcelain` 에 러너의 `M` 이
없었다. 실행 **중** 리더가 `a113471b` 를 커밋했고, 러너는 환경 정보를 실행 종료 시점에
수집하므로 `headSha` 에 `a113471b` 가 찍혔다.

두 커밋 사이에 **러너 파일은 바이트 동일하다**:

```
git diff --stat 7c3309f5 a113471b -- plugins/artibot/scripts/bench/hook-latency.mjs
```

출력이 비어 있다. `a113471b` 는 `tests/bench/hook-latency.bench.js` 291줄 **한 파일만**
추가한다(`git show --stat a113471b`). 따라서 **run 3 이 실행한 러너 코드는 `7c3309f5` 의
것**이고, 리더가 요청한 "커밋 7c3309f5 워킹트리에서의 측정" 조건을 만족한다.

측정 종료 직후(파일 mtime 00:57) 형제 에이전트가 러너에 새 워킹트리 수정을 시작했다.
Node 는 모듈을 프로세스 시작 시점에 로드하므로 00:53:24 에 시작한 런은 이 수정의 영향을
받지 않는다. **다만 이것은 "런 시작 시점 파일 = 커밋 내용"이라는 추론이다** — 러너 파일의
런타임 해시를 런 안에서 찍지는 않았다(미확인 항목).

### 러너 커밋 간 diff — run 3(`7c3309f5`) 대 run 4(`4a7983a6`)

두 본표가 서로 다른 러너 커밋에서 나왔으므로, 그 차이가 타이밍에 개입하지 않음을 보여야 한다.

```
git diff 7c3309f5..4a7983a6 --stat -- plugins/artibot/scripts/bench/hook-latency.mjs
 plugins/artibot/scripts/bench/hook-latency.mjs | 367 ++++++++++++++++++++++---
 1 file changed, 326 insertions(+), 41 deletions(-)
```

**두 sha 를 명시적으로 썼다.** `HEAD` 로 적으면 안 된다 — 이 브랜치는 측정 중에도 커밋이
올라온다. run 4 종료(01:16:30 KST) 뒤 `aa5303ec`(러너 계약 테스트, 01:24 KST)와
`6e98821b`(검수 후속)이 연달아 올라와 `HEAD` 가 두 번 이동했다.

`aa5303ec` 는 러너를 건드리지 않는다(`git diff 4a7983a6..aa5303ec -- <러너>` 빈 출력).
`6e98821b` 는 러너를 건드린다:

```
git diff 4a7983a6..6e98821b --stat -- plugins/artibot/scripts/bench/hook-latency.mjs
 plugins/artibot/scripts/bench/hook-latency.mjs | 154 +++++++++++++++----------
 1 file changed, 95 insertions(+), 59 deletions(-)
```

**95/59 는 작지 않은 숫자이므로 해시로 확인했다.** 측정 경로 함수 8개는 `4a7983a6` 과
`6e98821b` 에서 **전부 바이트 동일**하다(해시 값도 아래 표와 같다). guard 경로도
`compareGuards`·`snapshotOne`·`compareLeakScan` 이 바이트 동일하고, `compareOne` 만
해시가 다르다 — 그러나 그 차이는 **들여쓰기와 중괄호 한 겹뿐**이다(줄을 trim 하고 단독
중괄호를 제거해 정규화하면 양쪽 해시가 `c371ddf808fd` 로 일치, 52줄 → 50줄). 즉
`6e98821b` 는 주석·헤더 문구·재들여쓰기이고 **측정에도 guard 판정에도 의미 변화가 없다.**
따라서 run 4 의 수치와 guard verdict 는 러너 최종 커밋에서도 그대로 성립한다.

`git diff -U0` 으로 hunk 범위를 훑으면 변경은 세 덩어리다.

| 변경된 영역 | 성격 |
|---|---|
| 파일 헤더 JSDoc, 상수, `recordSandboxPaths`, `exactLeakMarkers` | 마커·문서 |
| `benchLeakCounts`, `snapshotOne`, `compareLeakScan`, `summarizeInformational`, `compareGuards` | guard 판정 |
| `printGuardEntries`, `printHuman`, `printUsage`, `parseArgs`, `main` | 보고·CLI |

**hunk 범위만으로는 부족하다.** 커밋된 diff 에는 측정 경로 한가운데(옛 `:949`, `:1040`)에도
hunk 가 두 개 있다. 둘 다 **JSDoc 주석 줄만 바꾼다**(로컬 시각 표기를 UTC+KST 병기로 정규화).
`:949` hunk 의 git 컨텍스트 라벨이 `benchSlot` 이라 함수 본문이 바뀐 것처럼 보이지만, 실제
변경 줄은 그 뒤 `normalizeGuardSpec` 의 주석 블록에 있다.

그래서 hunk 대신 **함수 본문을 직접 해시 대조**했다. 두 커밋에서 소스를 꺼내
(`git show <sha>:<path>`) 측정 경로 함수 8개의 본문을 SHA-256 으로 비교한 결과:

| 함수 | `7c3309f5` 줄 | `4a7983a6` 줄 | 본문 해시(앞 12자) | 판정 |
|---|---|---|---|---|
| `runOnce` | 695-751 | 746-802 | `edb05218a275` | 동일 |
| `benchSlot` | 880-926 | 931-977 | `55b5d68fd836` | 동일 |
| `summarize` | 778-789 | 829-840 | `cf2a8165df2b` | 동일 |
| `percentile` | 762-764 | 813-815 | `0c1edad11823` | 동일 |
| `probeChildren` | 808-865 | 859-916 | `b75a7277f98b` | 동일 |
| `createSandbox` | 578-638 | 629-689 | `05c71fcf1775` | 동일 |
| `buildSlots` | 396-540 | 447-591 | `ce5ef842fc5e` | 동일 |
| `hookEnv` | 650-664 | 701-715 | `764ff63d519c` | 동일 |

`runOnce` 가 벽시계를 재는 함수다(`performance.now()` 와 `spawn(process.execPath, …)` 가
그 본문 안에 있다). **8개 전부 바이트 동일하다.** 따라서 `--writers` 커밋은 타이밍 수치를
만드는 코드를 한 줄도 바꾸지 않았고, run 3 과 run 4 의 지연 값은 같은 계측 코드의 산물이다.

**이 대조가 못 보는 것**: 함수 본문 8개의 동일성만 확인했다. 그 함수들이 부르는 모듈 수준
상수나 import 가 바뀌면 해시는 같아도 동작이 달라질 수 있다. 상수 영역(옛 `:82`~`:238`)에
실제로 변경이 있으나, 그 hunk 들은 누출 마커(`SANDBOX_PREFIX`·`LEAK_MARKERS`·
`EMITTED_SANDBOX_PATHS`)와 헤더 JSDoc 이며 타이밍에 쓰이는 상수는 아니다 — 이건 **읽고
판단한 것이지 기계적으로 증명한 것이 아니다.**

### 부하 조건

이 측정은 **한산한 머신에서 잰 값이 아니다.**

| 시점 | node.exe 프로세스 수 |
|---|---|
| run 1 직전 (00:30:42 KST) | 47 |
| run 2 직전 (00:37:23 KST) | 51 |
| run 3 직전 (00:53:24 KST) | 54 |
| run 3 직후 (00:58:1x KST) | 53 |
| **run 4 직전 (01:12:38 KST)** | **48** |

같은 머신에 Claude 세션 3~4개(worktree 4개)가 동시에 떠 있었다. `tasklist` 로 잰 값이다.
**32코어 머신이라 CPU 포화는 아니지만, 디스크·스토어 잠금 경합은 실재한다.**

프로세스 **개수**는 tail 을 설명하지 못한다. run 3 은 가장 붐빈 시점(54개)에 돌았는데 tail 이
낮았고, run 2 는 51개에서 가장 높은 tail 을 냈다. 지배 변수는 그 순간 **누가 실제로 스토어에
쓰고 있었는지**로 보인다 — run 4 의 `unattributedRows` 가 그 "누가"를 처음으로 기계 판독
가능하게 남겼다(아래 guards 절).

## guards 결과

러너는 `--guard` 인자 1개와 기본 5개, 합쳐 **6종**의 스토어를 측정 전후로 스냅샷한다(run 3/4 당시 러너 기준 — 2026-09-11 이후 기본 스펙 +1, 위 `--guard` 절 참조).
네 가지 모드의 뜻은 `compareGuards()` 의 JSDoc 이 정본이다.

| 모드 | 판정 기준 |
|---|---|
| `tree` | 바이트 동일성 요구. 변화 = 위반(fail-closed) |
| `leak-scan` | **이번 실행이 생성한 값**만 위반. 접두 마커는 세어 보고하되 판정 불참 |
| `observe` | 다이제스트 변화는 파일 목록과 함께 기록만, 귀속 가능한 누출은 여전히 위반 |
| `informational` | 보고만, 절대 실패시키지 않음 |

### `--writers` 모드 — run 1~3 에는 적용되지 않는다

`--writers strict|tolerate` 는 위 네 모드와 **직교하는 별개 축**이다. run 1~3 은 이 플래그가
존재하기 전에 돌았고, **run 4 만 실제로 `--writers tolerate` 로 돌았다.**

| 모드 | `tree` 경로에서 exact 지문 0건인 변화가 났을 때 |
|---|---|
| `strict`(기본) | 위반. **exit 2.** run 1~3 의 동작과 같은 판정 |
| `tolerate` | `CHANGED (unattributed — 0 of N; strict would FAIL)` informational, **exit 0**. 새로 나타난 행의 session_id 앞 8자·ts·event 를 `unattributedRows` 로 기록 |

두 모드 모두 **`strictWouldFail` 을 모든 guard 에 실어 보낸다**(불리언). tolerate 로 돌려
exit 0 이 나와도 `strictWouldFail: true` 면 strict 였다면 실패했을 창이라는 뜻이다. 이
필드가 tolerate 런과 strict 클린 런을 구분하는 유일한 표식이므로, **tolerate 결과를 인용할
때는 반드시 이 값을 함께 인용해야 한다.**

`tolerate` 가 판정에서 놓치는 누출 종류는 재현 명령 절의 "tolerate 가 못 보는 것" 문단에
적었다. 요약하면 **exit 0 자체는 무해함의 증거가 아니다** — 무해함의 증거는 strict 클린
런뿐이다.

### run 4 (본표) — `--writers tolerate`, exit 0, 런 수준 `strictWouldFail: true`

| # | 경로 | 모드 | verdict | violation | `strictWouldFail` |
|---|---|---|---|---|---|
| 1 | `<USERPROFILE>/.artibot` | tree | unchanged | 아니오 | `false` |
| 2 | `<USERPROFILE>/.claude/artibot` | leak-scan | clean (0 of 570 generated values found) | 아니오 | `false` |
| 3 | `<PLUGIN_ROOT>/runtime` | informational | CHANGED (informational — gitignored runtime dir) | 아니오 | `false` |
| 4 | `<worktree>/.artibot/runtime` | observe | CHANGED (observe — recorded, not a failure; compare entries) | 아니오 | `false` |
| 5 | `<main worktree>/.artibot/runtime` | tree | CHANGED (unattributed — 0 of 570 generated values; strict would FAIL) | 아니오 | **`true`** |
| 6 | `<main worktree>/.artibot/runtime/ledger.jsonl` | tree | CHANGED (unattributed — 0 of 570 generated values; strict would FAIL) | 아니오 | **`true`** |

`guardViolation: false`, exit 0. 그러나 **런 수준 `strictWouldFail: true`** 다 — guard #5·#6 이
strict 였다면 이 실행은 exit 2 였다. **exit 0 만 보고 "깨끗했다"고 읽으면 안 되는 이유가
이것이다.** guard #2 의 leak-scan 은 여전히 `clean (0 of 570 …)` 이므로, 벤치 지문이 실
스토어에 도달하지 않았다는 판정 자체는 run 3 과 동일하게 유지된다.

#### `unattributedRows` 전량

`4a7983a6` 이 추가한 필드다. exact 지문이 0건인 변화가 났을 때 **새로 나타난 행**의 파일명,
session_id 앞 8자, ts, event 를 남긴다. run 4 가 기록한 전량:

**guard #5 `<main worktree>/.artibot/runtime`** — 8행

| 파일 | session_id | ts (UTC) | event |
|---|---|---|---|
| `decisions\96abcf50-…events.ndjson` | `null` | 2026-09-10T16:14:59.611Z | `null` |
| `decisions\96abcf50-…events.ndjson` | `null` | 2026-09-10T16:14:59.722Z | `null` |
| `decisions\96abcf50-…events.ndjson` | `null` | 2026-09-10T16:14:59.723Z | `null` |
| `decisions\96abcf50-…events.ndjson` | `null` | 2026-09-10T16:15:51.223Z | `null` |
| `decisions\96abcf50-…events.ndjson` | `null` | 2026-09-10T16:15:51.372Z | `null` |
| `decisions\96abcf50-…events.ndjson` | `null` | 2026-09-10T16:15:51.374Z | `null` |
| `ledger.jsonl` | `96abcf50` | 2026-09-10T16:14:59.616Z | `mission.candidate_deferred` |
| `ledger.jsonl` | `96abcf50` | 2026-09-10T16:15:51.227Z | `mission.candidate_deferred` |

**guard #6 `<main worktree>/.artibot/runtime/ledger.jsonl`** — 2행(위 원장 2행과 같은 사건)

| 파일 | session_id | ts (UTC) | event |
|---|---|---|---|
| (guard 대상이 단일 파일이라 빈 문자열) | `96abcf50` | 2026-09-10T16:14:59.616Z | `mission.candidate_deferred` |
| (guard 대상이 단일 파일이라 빈 문자열) | `96abcf50` | 2026-09-10T16:15:51.227Z | `mission.candidate_deferred` |

**guard #4 `<worktree>/.artibot/runtime`(observe)** — 2행

| 파일 | session_id | ts (UTC) | event |
|---|---|---|---|
| `ledger.jsonl` | `203c4e91` | 2026-09-10T16:13:17.730Z | `route.selected` |
| `ledger.jsonl` | `203c4e91` | 2026-09-10T16:13:20.772Z | `route.bound` |

**읽는 법.** ts 가 전부 run 4 측정 창(16:12:38Z~16:16:30Z) **안**이고, session_id 는 벤치가
발행한 형식이 아니라 라이브 세션의 UUID 앞 8자다. `96abcf50` 은 **run 2 를 FAIL 시킨 것과
같은 세션**이고, 이번에도 같은 `mission.candidate_deferred` 이벤트를 냈다. `203c4e91` 은 **이
벤치를 돌린 세션 자신**이다 — 벤치 프로세스가 아니라 그 세션의 자체 훅이 라우팅 행을 썼다.

즉 run 2 에서 내가 원장 마지막 줄을 손으로 읽어 귀속했던 작업을, `4a7983a6` 부터는 러너가
구조화된 필드로 대신 해 준다. 다만 `decisions\*.events.ndjson` 6행은 `session_id`·`event` 가
`null` 인데, 파일명에 세션 UUID 가 들어 있어 사람은 귀속할 수 있으나 **필드만으로는
귀속되지 않는다.** 파서가 그 포맷의 행에서 값을 못 뽑았다는 뜻이다(원인 미확인).

### run 3 (strict 대조군) — 전부 통과, exit 0

| # | 경로 | 모드 | verdict | violation |
|---|---|---|---|---|
| 1 | `<USERPROFILE>/.artibot` | tree | unchanged | 아니오 |
| 2 | `<USERPROFILE>/.claude/artibot` | leak-scan | clean (0 of 570 generated values found) | 아니오 |
| 3 | `<PLUGIN_ROOT>/runtime` | informational | CHANGED (informational — gitignored runtime dir) | 아니오 |
| 4 | `<worktree>/.artibot/runtime` | observe | unchanged | 아니오 |
| 5 | `<main worktree>/.artibot/runtime` | tree | unchanged | 아니오 |
| 6 | `<main worktree>/.artibot/runtime/ledger.jsonl` | tree | unchanged | 아니오 |

`guardViolation: false`, 프로세스 exit 0. **실 스토어에 벤치가 남긴 흔적은 0건이다.**

이것이 **strict clean exit 0** 이다. **이 문서에서 가장 강한 증거다.** run 4 가 본표를 가져간
뒤에도 "벤치가 실 스토어를 오염시키지 않는다"는 판정의 근거는 계속 이 실행이다 — run 4 는
`strictWouldFail: true` 창에서 잰 값이라 그 판정을 대신할 수 없다. `unattributedRows` 는
tolerate 런만 만드는 필드라 run 3 JSON 에는 **없다**(run 4 의 전량은 위 절에 실었다).

### 새 leak-scan 계약이 run 1 의 오탐 클래스를 구조적으로 제거했다

run 1(00:34)에서 guard #2·#4 가 `LEAK: bench- ids` 로 FAIL 했다. 원인은 누출이 아니라
**문자열 충돌**이었다. 워크트리 이름이 `split-artibot-hook-latency-bench` 라서 이 작업의
모든 에이전트 이름이 `-bench-<세션id>-<역할>` 로 끝났고(`...-bench-019GEYNS-runner` 등),
그 `bench-` 가 러너의 세션 id 접두사 `BENCH_PREFIX = 'bench-'` 와 겹쳤다. 그 문자열을 스토어에
쓴 것은 벤치가 아니라 라이브 세션의 훅이었다.

커밋 `7c3309f5` 가 이 판정 방식을 바꿨다. 이제 `leak-scan` 은 **이번 실행이 실제로 생성한
값**(`exactLeakMarkers()` = 발행한 세션 id 전체 문자열 + 만든 샌드박스 디렉터리)만 위반으로
본다. 샌드박스 경로는 **세 가지 철자**로 등록된다(네이티브 백슬래시 형태, 슬래시 형태,
구분자 없는 basename) — JSONL 안에 `C:\\<...>\\…` 처럼 백슬래시가 이스케이프되어 직렬화된
경로를 놓치지 않기 위해서다.
접두 마커는 `guards[].informational` 로 강등되어 **세어 보고하되 verdict 에 참여하지 않는다.**
그리고 `guards[].exactMarkerCount` 가 판정에 쓰인 정확-일치 집합의 크기를 함께 싣는다.

run 3 이 이 변화를 그대로 보여 준다. guard #2 의 실제 필드:

| 필드 | 값 |
|---|---|
| `verdict` | `clean (0 of 570 generated values found)` |
| `exactMarkerCount` | `570` |
| `informational` | `prefix markers: 368 occurrence(s), grew in daily-experiences.json, tool-history.json (not attributable to this run)` |
| `violation` | `false` |

**run 1 을 FAIL 시켰던 바로 그 증가**(`daily-experiences.json`, `tool-history.json` 의
접두 마커 증가)가 run 3 에서도 똑같이 일어났고 — 368건 — 이번에는 **위반이 아니라
informational 로 기록됐다.** 같은 관측, 다른 판정이다. 오탐 클래스는 사라졌다.

`exactMarkerCount = 570` 이 함께 실린 덕분에 "아무것도 안 새서 clean" 과 "대조 집합이 비어
있어서 clean" 을 구분할 수 있다. 570은 비어 있지 않으므로 이 clean 은 의미 있는 clean 이다.

### `tree` guard 는 여전히 라이브 세션 동시 쓰기에 fail-closed 다

run 2(00:42)는 leak-scan 은 통과했지만 `tree` guard 3종이 CHANGED 로 FAIL 했다. 바뀐 것:

| 경로 | 변화 |
|---|---|
| `<USERPROFILE>/.artibot/runtime/decisions/9120048e-…events.ndjson` | 273,272 → 278,784 (+5,512 B) |
| `<main>/.artibot/runtime/decisions/96abcf50-…events.ndjson` | 2,810 → 4,217 (+1,407 B) |
| `<main>/.artibot/runtime/ledger.jsonl` | 184,224 → 184,484 (+260 B) |

**벤치가 아니라 동시 실행 중인 라이브 세션이 쓴 것이다.** 귀속 근거: 세 파일 모두 벤치 지문
`artibot-bench-`·`bench-agent` 가 0건이고, `ledger.jsonl` 의 새 마지막 줄이 그대로 말해 준다 —
`"ts":"2026-09-10T15:40:06.499Z"`, `"event":"mission.candidate_deferred"`,
`"session_id":"96abcf50-e00b-4fd1-a835-59692d4a3086"`, `"source":"hook"`, `"pid":75764`.
타임스탬프가 run 2 측정 창(00:37:23~00:42:04 KST) **안**이고, 세션 id 가 벤치가 발행한 형식이
아니라 라이브 세션의 UUID 다.

**guard 를 완화하지 않았고 값도 손대지 않았다.** run 3 은 그런 쓰기가 없는 창에 들어맞아
통과한 것이지, 판정이 느슨해져서 통과한 것이 아니다. **이 벤치는 다른 Claude 세션이 실
스토어에 쓰는 동안에는 구조적으로 `tree` guard 를 통과할 수 없다.**

### informational guard 의 CHANGED (실패 아님)

`<PLUGIN_ROOT>/runtime` 은 gitignored 런타임 디렉터리라 실패시키지 않는다. `user-profile.json`
하나만 매 실행 자란다:

| 실행 | `user-profile.json` | 증가 |
|---|---|---|
| run 1 | 1,056 → 4,542 B | +3,486 |
| run 2 | 5,430 → 9,759 B | +4,329 |
| run 3 | 12,867 → 15,864 B | +2,997 |
| run 4 | 16,752 → 20,193 B | +3,441 |

`current-teammates.json`, `first-run-state.json`, `last-main-agent-edit.timestamp`,
`self-control-welcomed.marker`, `token-usage-session.json` 은 **네 실행 모두 크기 불변**이었다.
**벤치를 한 번 돌릴 때마다 `user-profile.json` 이 약 3~4 KB 자란다.** 네 실행에 걸쳐
1,056 → 20,193 B 로 **19배**가 됐다. gitignored 라 커밋에는 영향이 없다. 다만 **무제한 성장은
아니다** — `lib/core/user-profile.js#MAX_STORED_SIGNALS = 200` 이 `signals` 를 링버퍼로 잘라
(`recordSignal` 의 `slice(-MAX_STORED_SIGNALS)`) 상한이 걸린다. 2026-09-11 실측 신호 1건당
약 101 B 이므로 정상상태 상한은 **약 20 KB**이고, 위 네 실행의 1,056 → 20,193 B 는 **상한에
도달하기까지의 구간**이지 상한 없는 성장의 증거가 아니다. 쓰는 주체는
`scripts/hooks/runtime-prompt.js#recordPromptSignals` → `user-profile.js#recordSignal` 이다
(2026-09-11 확인).

이 파일은 재현 명령 절의 "tolerate 가 못 보는 것" 세 번째 항목에 해당한다 — 증가분에 벤치
exact 지문이 있는지 확인하지 않았고, 없다면 `tolerate` 는 이 성장을 unattributed 로 넘긴다.
`informational` 모드라 **strict 에서도 실패시키지 않는다**는 점은 별개로 유의할 것.

## 이 표가 못 보는 것

러너 헤더(`scripts/bench/hook-latency.mjs` 파일 상단 JSDoc, 8항목)가 정본이다. 여기서는
이 측정에 특히 걸리는 것만 추린다. **아래 항목을 읽지 않고 위 숫자를 인용하지 마라.**

1. **호스트 IPC 지연.** 벽시계는 `spawn()` 직전에 시작해 자식의 `exit` 이벤트에서 멈춘다.
   Claude Code 자신의 훅 매칭·payload 직렬화·응답 파싱 비용은 이 창 **밖**이다. 사용자가
   실제로 겪는 멈춤은 위 숫자 **더하기** 측정되지 않은 호스트 비용이다.
2. **실 payload 크기.** 합성 payload 는 작다. 실제 `transcript_path` 는 수 MB 파일을 가리킬
   수 있고 실제 `tool_input.content` 는 큰 문자열을 담는다. `readPayload()` 가 stdin 전체를
   파싱하므로 실 payload 는 엄격히 더 많은 일이다. **편향 방향은 알려져 있다 — 이 표는
   과소보고한다.**
   구체적 증거: `PostToolUse:Write` 의 stdout 이 **네 실행 모두 20/20회 0 바이트**다. 실제
   편집이라면 병합 envelope 가 생성돼 출력이 나온다. 즉 이 슬롯은 **아무것도 출력하지 않는
   경로**를 잰 것이고, 실사용 경로보다 짧다.
3. **동시 세션 경합.** 벤치는 한 번에 한 슬롯씩 돈다. 실제로는 여러 창이 동시에
   SessionStart 나 PostToolUse 를 때리고 같은 온디스크 스토어를 두고 경합한다. 모델링되지
   않았다. run 2 대 run 4 의 p95 격차(SessionEnd 2,461.82 대 915.26, PreCompact 2,729.53 대
   1,179.43)가 이 효과의 **하한 크기**를 보여 준다. run 4 의 `unattributedRows` 는 경합의
   **존재**를 기계 판독 가능하게 남기지만, 그것이 지연에 **얼마나** 기여했는지는 말해 주지
   않는다 — 두 값을 잇는 분석은 하지 않았다.
4. **네트워크 훅이 꺼져 있다.** `ARTIBOT_SWARM_DISABLE`·`ARTIBOT_HTTP_NOTIFY_DISABLE` 이
   모든 런에 설정된다(디스패처 테스트 스위트와 동일). `swarm-sync`(15초 예산)·
   `http-notify`(8초 예산)·`swarm-download`(15초 예산)가 조기 반환한다.
   **따라서 `SessionEnd` 와 `SessionStart` 수치는 하한값이다** — 그 두 슬롯에서 가장 큰
   훅별 예산이 바로 지금 억제된 것들이다.
5. **git-autopilot 훅이 조기 반환 경로만 탔다.** 샌드박스 cwd 는 remote 없는 일회용
   `git init` 이라 `isAutopilotAllowed()` 가 빈 remote URL 로 false 를 돌려주고,
   `isArtibotRepo()` 도 `plugins/artibot/CLAUDE.md` 를 못 찾는다. `git-autopilot-setup.js` 는
   게이트에서 반환하고 `.git/autopilot.json` 을 쓰지 않으며, `git-autopilot-session.js` 도
   설정이 없어 반환한다. 의도된 안전장치지만, **모든 git-autopilot 훅은 작동 경로가 아니라
   조기 반환 경로로 측정됐다.** `PreToolUse:autopilot-guard`(p95 337.43ms)도 마찬가지다.
6. **비-Node 자식은 세지 않는다.** 프로브는 `NODE_OPTIONS=--import` 로 Node 프로세스만
   센다. `git` 으로 셸아웃하는 훅이 띄운 프로세스는 이 계측기에 보이지 않는다.
   따라서 "자식 수 일치"와 "손자 0개"는 **Node 프로세스에 한한 진술**이다.
7. **콜드 캐시.** 슬롯마다 새 샌드박스 HOME 을 받으므로, 오래 산 HOME 이라면 이미 갖고
   있을 캐시가 비어 있다. warmup 2회가 일부를 흡수하지만 전부는 아니다.
8. **나머지 PostToolUse 툴 라우팅은 미측정.** `PostToolUse` 는 Write 와 Bash 두 툴만 쟀다.
   다른 툴 이름으로 라우팅되는 핸들러 집합의 비용은 미측정이다. 또한 대상 파일이 갓
   커밋된 1바이트짜리 `bench.txt` 라, `quality-gate.js` 류의 언어별 게이트가 실제 소스
   편집 때보다 훨씬 적게 일한다.
9. **`hooks.json` 에 등록됐지만 이 러너의 19슬롯에 없는 슬롯들.** `declaredBudgetsMs` 에는
   `team-idle-handler.js`, `clean-state-check.js`, `permission-auto-approve.js`,
   `tool-tracker.js failure`, `memory-tracker.js PostToolUseFailure`,
   `post-tool-failure-advisor.js`, `workflow-status.js notification`, `context-tracker.js`,
   `instructions-loaded.js` 가 있으나 **측정 대상이 아니다.** 19슬롯은 전수가 아니다.
10. **`leak-scan` 은 두 스토어에만 걸려 있다.** 정확-일치 판정은 `<USERPROFILE>/.claude/artibot`
    (leak-scan)과 `<worktree>/.artibot/runtime`(observe)에서만 돈다. `tree` 모드 경로는
    바이트 동일성으로 대신 지키지만, 그건 "벤치가 안 썼다"가 아니라 "아무도 안 썼다"를
    확인하는 것이라 라이브 세션이 쓰면 귀속을 사람이 직접 해야 한다(run 2 가 그 사례).

## HEADROOM_MS 교체 권고

### 대상

`tests/firewall/hook-timeout-budget.test.js:52`(2026-09-11 00:37 KST 기준), 상수
`HEADROOM_MS = 3000`. 그 파일이 직접 선언하듯 **"실측치가 아니다. 보수적 예산치다"** 이고,
같은 주석이 **"실측이 생기면 그 수치로 교체하고 근거를 여기 적어라"** 고 요구한다.
이 절이 그 실측이다.

이 상수는 게이트에서 `max(handler.timeoutMs) + HEADROOM_MS <= 슬롯 예산` 으로 쓰인다
(같은 파일 `:222`, `:259`, `:268`). 즉 **디스패처 자신의 몫** — node 콜드스타트 + dispatch-table
로드 + 자식 팬아웃 + stdout 병합 — 의 상한 추정치다.

### 추정 방법과 그 한계

이 러너는 **자식 하나의 단독 실행 시간을 직접 재지 않는다.** 그래서 다음 대리값을 썼고,
대리값을 썼다는 사실을 여기 명시한다.

> **대리값**: `PreToolUse` 계열의 **직접 훅 p95** 를 "node 콜드스타트 + import 비용"의
> 대리값으로 쓴다. 직접 훅은 디스패처를 거치지 않고 호스트가 바로 띄우는 단일 Node
> 프로세스이므로, 그 지연은 대체로 프로세스 기동 + 모듈 로드 + 작은 작업이다.
> run 3 의 직접 훅 p95 범위는 **196.76 ~ 550.31 ms** 다.

디스패처 자신의 오버헤드 추정 = `디스패처 벽시계 p95 − 대리 자식 비용`.

### run 4(본표) 기준 재계산

run 4 의 `PreToolUse` 직접 훅 p95 범위는 **222.15 ~ 608.36 ms** 다(최소 `pre-write-checkpoint`,
최대 `pre-write-guard`). 전체 직접 훅으로 넓히면 최소가 `PostCompact` 213.07ms 이지만,
대리값 정의를 네 실행에서 일관되게 유지하려고 `PreToolUse` 계열만 썼다.

| 케이스 | 계산 | 추정 오버헤드 | 3000 대비 |
|---|---|---|---|
| run 4 최악 | SessionStart p95 1176.76 − 최소 대리값 222.15 | **954.61 ms** | 31.8% |
| run 4 낙관 | SessionStart p95 1176.76 − 최대 대리값 608.36 | 568.40 ms | 18.9% |
| run 4 Stop | Stop p95 984.75 − 222.15 | 762.60 ms | 25.4% |
| run 4 SessionEnd | SessionEnd p95 915.26 − 222.15 | 693.11 ms | 23.1% |

### 4회 통틀은 최악값

| 케이스 | 계산 | 추정 오버헤드 | 3000 대비 |
|---|---|---|---|
| **전체 최악(run 2, 경합 창)** | SessionEnd p95 2461.82 − 196.25 | **2265.57 ms** | **75.5%** |
| run 1 최악 | SessionStart p95 1657.57 − 196.25 | 1461.32 ms | 48.7% |
| run 3 최악 | SessionStart p95 1414.96 − 196.76 | 1218.20 ms | 40.6% |
| run 4 최악 | SessionStart p95 1176.76 − 222.15 | 954.61 ms | 31.8% |

### 권고: **유지 3000** — run 4 로 재계산해도 결론 변동 없음

run 4(본표)만 보면 추정 오버헤드는 **954.61 ms 로 3000 의 31.8%** 다. 네 실행 중 가장 낮은
값이며, 이 값만 보면 "3000 은 과하니 낮춰도 된다"는 결론이 나올 것 같지만, **그렇지 않다.**
근거:

1. **경합 조건에서 2,265.57 ms(75.5%)까지 올라간다.** run 2 가 그 실측이다. 여유는 734 ms,
   마진 1.3배뿐이다. 경합은 이 시스템의 예외가 아니라 정상 상태다(측정 내내 node 프로세스
   47~54개, Claude 세션 3~4개). **한산할 때 값으로 상수를 잡으면 실사용에서 게이트가 틀린
   안심을 준다.**
2. **이 상수를 낮추면 게이트가 느슨해진다**(부등식 좌변이 작아져 통과가 쉬워진다).
   실측 최악값이 3000 을 여유롭게 밑돌지 않는 이상 낮출 근거가 없고, 지금 최악값은
   밑돌지 않는다.
3. **올릴 근거도 없다.** 어떤 슬롯도 선언 예산에 근접하지 않았다(run 4 에서 가장 빠듯한
   PreCompact 가 예산의 14.7%). 3000 을 올리면 실제 위험이 없는 슬롯 조합을 RED 로 만들 수 있다.
4. 네 실행의 추정치가 **954.61 / 1,218.20 / 1,461.32 / 2,265.57 ms** 로 2.4배 흩어진다.
   같은 머신, 같은 명령, 같은 날 46분 사이에 그렇다. **이 분산 자체가 상수를 실측 최댓값에
   바짝 붙이면 안 되는 이유다.** 3000 이 흡수하는 것이 바로 이 분산이고, 최악값은 그 상한의
   75.5% 까지 이미 와 있다.

즉 **3000 은 실측과 부합한다. 숫자는 그대로 두고, "이제 실측 근거가 있다"는 사실과 그
근거를 상수 주석에 추가하는 것**이 이 권고의 전부다.

### 이 권고가 못 보는 것

- **호스트 IPC 지연이 빠져 있다**(못 보는 것 1번). 실제 디스패처 몫은 여기 추정치보다
  크다. 이것 역시 "낮추지 마라" 쪽으로 작용한다.
- **대리값이 자식 단독 시간이 아니다.** 직접 훅과 디스패처 자식은 하는 일이 다르다.
  `session-readback.mjs` 같은 무거운 자식이 `bash-risk-guard.js` 보다 훨씬 비쌀 수 있고,
  그 경우 디스패처 오버헤드는 위 추정보다 **작다**(= 3000 이 더 여유롭다).
- **네트워크 훅이 꺼진 상태의 SessionStart/SessionEnd 값**이다(못 보는 것 4번).
  켜지면 그 두 슬롯의 벽시계가 늘어나지만, 그건 자식 몫이지 디스패처 몫이 아니다.
- **부하 수준을 통제하지 못했다.** 프로세스 수(47/51/54)와 tail 크기가 단조 관계가 아니었다.
  지배 변수는 개수가 아니라 "그 순간 누가 실제로 쓰고 있었나"로 보이는데, 이건 관측하지 않았다.
- 표본은 슬롯당 20회, 실행 4회다. p95 는 20 샘플에서 사실상 상위 1개 값이라 **해상도가
  낮다**. 이 상수를 정밀하게 조정하려면 더 큰 N 이 필요하다.

### 제안 diff (적용하지 않음 — 소유 밖)

`tests/firewall/hook-timeout-budget.test.js` 의 `HEADROOM_MS` 주석에, 값은 유지한 채
아래 취지를 추가하는 것을 제안한다. **값 `3000` 은 변경하지 않는다.**

- 2026-09-11 KST 실측(`docs/HOOK-LATENCY-2026-09-10.md`)으로 뒷받침됨.
  러너 커밋 `4a7983a6`(본표 run 4) 및 `7c3309f5`(strict 대조군 run 3).
- 본표(run 4) 추정 오버헤드 954.61 ms = 31.8%. 클린 대조군(run 3) 1,218.20 ms = 40.6%.
  **경합 조건(run 2) 2,265.57 ms = 75.5%.**
- 추정법: 디스패처 벽시계 p95 − 직접 훅 p95 최소값(대리값). 자식 단독 시간은 미측정.
- 4회 추정치가 954.61~2,265.57 로 2.4배 흩어진다. 실측 최댓값에 상수를 붙이지 마라.
- 호스트 IPC 는 여전히 미포함이므로 실제 몫은 이보다 크다. **낮추지 마라.**

## 소유 밖 후속 (보고만, 적용하지 않음)

> 2026-09-11 갱신: 아래 **1번(`package.json` bench 스크립트)과 2번(`vitest.config.js`
> `benchmark.include`)은 test-hygiene-bench 줄기에서 적용되어 해소됐다.** 나머지 항목은 그대로 열려 있다.

1. **`package.json` `bench` 스크립트.** 현재 `package.json` 의 `scripts` 에 bench 항목이
   없다(항목 26개). 제안:
   `"bench:hooks": "node scripts/bench/hook-latency.mjs --slot all --n 20 --warmup 2"` 와
   `"bench": "vitest bench --run"`. `ci` 체인에는 **넣지 말 것** — 4분 걸리고 다른 세션이
   실 스토어에 쓰는 동안에는 `tree` guard 가 구조적으로 exit 2 를 낸다.
2. **`vitest.config.js` bench include.** 정본 `plugins/artibot/vitest.config.js` 는 `include` 를
   프로젝트별로 둔다(`:21` 주석, `main` `:96`, `autopilot` `:89`). **어느 프로젝트도
   `benchmark.include` 를 좁히지 않아** `.bench.js` 가 기본 글롭으로 잡히고 **두 프로젝트에서
   각각 한 번씩, 총 두 번 실행된다.** 프로젝트별로
   `benchmark: { include: [...] }` 를 명시하면 이 중복과 기본 글롭 의존이 동시에 사라진다.
   지금도 돌기는 한다(리더 실측 exit 0).
3. **HEADROOM 교체 diff.** 위 절 참조. **값 유지, 주석에 실측 근거 추가**만 제안한다.
4. **디스패처 헤더 인용 줄번호가 5줄 밀렸다.** `scripts/hooks/_dispatcher-utils.js` 의 실제
   `spawn(process.execPath, ...)` 호출은 **`:131`** 인데(2026-09-11 00:26 리더 확인,
   00:37 재확인), 다음 4개 파일의 헤더가 `_dispatcher-utils.js:126` 을 인용한다:

   | 파일 | 인용 위치 |
   |---|---|
   | `tests/dispatcher/posttooluse-dispatcher.test.js` | `:28` |
   | `tests/dispatcher/sessionend-dispatcher.test.js` | `:25` |
   | `tests/dispatcher/sessionstart-dispatcher.test.js` | `:15` |
   | `tests/dispatcher/subagentstop-dispatcher.test.js` | `:25` |

   `tests/dispatcher/*.test.js` 전역 grep 결과 **4건 전부**가 같은 오차를 갖는다.
   줄번호 대신 심볼(`#spawnHook`)로 바꾸면 다시 썩지 않는다.
5. **`user-profile.json` 이 벤치 실행마다 약 3~4 KB 자란다.** 위 informational guard 절 참조.
   **네 실행에서 1,056 → 20,193 B 로 19배**가 됐다. gitignored 라 커밋 영향은 없고, 성장은
   `MAX_STORED_SIGNALS = 200` 링버퍼로 **약 20 KB 에서 멈춘다**(신호 1건당 약 101 B, 2026-09-11
   실측) — 위 구간은 상한 도달 전이다. 쓰는 주체는 `runtime-prompt.js#recordPromptSignals`.
6. **벤치는 strict 모드에서 다른 세션이 유휴일 때만 exit 0 이 된다.** 설계상 그렇다
   (`tree` guard 는 fail-closed 여야 한다). `--writers tolerate` 는 그 제약을 푸는 대신
   판정을 좁힌다. 다만 이 사실이 러너 헤더에는 적혀 있지 않다. "이 도구가 못 보는 것"
   목록 옆에 "이 도구가 언제 실패하는가"를 한 줄 추가하는 것을 제안한다.

## 소유 내 후속 (러너 소유 — 이 문서가 발견한 결함)

1. **`unattributedRows` 가 `decisions/*.events.ndjson` 행을 귀속하지 못한다.** run 4 의
   guard #5 가 남긴 8행 중 6행이 `session_id: null`, `event: null` 이다. 파일명에 세션 UUID 가
   들어 있어 사람은 귀속할 수 있으나 **필드만으로는 귀속되지 않는다.** `ledger.jsonl` 행은
   두 필드가 모두 채워지므로, 파서가 `.events.ndjson` 포맷에서 값을 못 뽑는 것으로 보인다.
   이 필드의 존재 이유가 "누가 썼는지 기계 판독"인데 그 스토어에서는 그 목적을 달성하지
   못한다. **원인 미확인** — 그 포맷에 해당 키가 없는 것인지 파서 한계인지 확인하지 않았다.

## 원시 데이터

리포 밖 스크래치에 있다(리포에는 이 md 하나만 둔다).

| 파일 | 내용 |
|---|---|
| `<scratch>/hook-latency-n20-run4.json` | **run 4 — 본표의 출처.** `4a7983a6`, tolerate, exit 0, `strictWouldFail: true` |
| `<scratch>/hook-latency-n20-run3.json` | **run 3 — strict 대조군.** `7c3309f5`, exit 0, guard 6/6 통과 |
| `<scratch>/hook-latency-n20-run1-guardfail.json` | run 1(= `hook-latency-n20.json` 과 동일 내용) |
| `<scratch>/hook-latency-n20-run2.json` | run 2 |

`<scratch>` 는 이 측정을 돌린 **세션 스크래치 디렉터리**다(리포 밖, OS 임시 영역 아래.
세션마다 달라 절대경로는 여기 적지 않는다). 세션 스크래치라 **영구 보존되지 않는다** —
위 세 JSON 은 이 문서의 근거이지만 나중에 같은 경로에서 다시 찾을 수 있다고 가정하지 마라.
