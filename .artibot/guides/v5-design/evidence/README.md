# v5 설계 증거 보관 (evidence)

설계 정본(`../ARTIBOT-5.0-DESIGN.md`)과 백로그(`../V5-BACKLOG.md`)가 인용하는 **재생성 비용이 큰 실측 산출물**을 둔다.
`reports/` 는 `.gitignore:73`(`reports/*`, `!reports/SPLIT/` 만 재포함)로 추적되지 않으므로
git 에 남아야 하는 증거는 이곳에 둔다.

| 파일 | 무엇인가 | 출처 |
|---|---|---|
| `citation-census-20260903.json` | T-53 2차 sweep 의 코드→코드 `file:line` 인용 전수 조사(POST-EDIT 상태 rows 349 = 잔여 occurrence 수(`postEditTotal`), 물리 줄수는 4,927, `byStatus` NO-FILE 66 / IN-RANGE 230 / AMBIGUOUS 18 / BLANK-LINE 13 / OUT-OF-RANGE 22). `citation-resolution` 게이트가 못 보는 blindspot(범위 안이지만 엉뚱한 곳을 가리키는 인용)의 분모다. **rows 349 / 4,927 lines** / 133,693 B | 2026-09-03 세션 스크래치패드에서 복사(오너 결정 2026-09-03 "재스캔 비용 > 보관 비용"). 원본 유지 |
| `ca04-host-ask-probe.md` | CA-04 L0 호스트 PreToolUse `ask` 처리 프로브 — 중첩 `claude -p` 60셀(모드 5 × 호출자 2 × 훅 결정 6): **59셀 결론 + 1셀 미확인**(`byp-sub-d3`), 양성 대조(① deny)와 음성 대조(⑥ 훅 없음)가 10그룹 전부에서 유효했다. 별건 보안 발견 F1(구식 `{"decision":"approve"}` 단독이 10/10 그룹에서 실행)의 근거. 대화형 3셀(A1)은 오너 부재로 미수행 | W1-6 `ca04-host-ask-probe`(fold `19efb959`, 커밋 `6094ed98`) — 호스트 `claude` 2.1.284, 측정 2026-09-29T04:20~04:35Z |
| `ca05-save-roundtrip.md` | CA-05 `/save` 체크포인트 왕복 — §4-b `saveOnSave` 플립 조건 d(임시 리포에서 실 writer 로 `mission.checkpointed` 정확히 1행, 140/140 사전 선언 검사)와 c(설치본 `commands/save.md`·`lib/checkpoint/save-checkpoint.js` = HEAD blob 445파일, 산문의 실제 호출은 미확인) + 실규모 재생(활성 미션 32개 → 32행) | R3 `ca05-save-roundtrip`(fold `97b83806`, 커밋 `ee84129e`) — 측정 2026-09-29T04:36~05:12Z, 기준 `eae2cf09` |
| `sh08-seeded-defect-run-20260929.md` | SH-08 seeded-defect 첫 측정 — 현행 정책 리뷰어(opus) 단일 arm, N=30: catch 30/30 · FP 0/30 finding · 위치 29/30(러너 출력 그대로). 본 실행 30회 + 대조·ablation·진단·연결 시험을 합쳐 중첩 `claude -p` 44회 | W1-7 `sh08-seeded-defect-run`(fold `f3d22a75`, 커밋 `784917ed`) — 측정 2026-09-29T04:29:19Z, 기준 `eae2cf09` |
| `sh09-question-rate-20260929.md` | SH-09 질문 빈도 첫 측정 — AskUserQuestion 호출 / 100 타이핑 프롬프트, 창별(B-1 이전 · B-1·B-3 · B-2 · 4.68.0 뒤) 분자·분모 3종·95% 구간·교란·유효성 대조·재현 명령. 메인 transcript 68파일에서 호출 44건, 감소 여부는 판정 불가 | W2-1 `sh09-question-census`(fold `aa93ecdc`, 커밋 `fdb10f2f`) — 측정 2026-09-29T05:43:44Z, 기준 `eae2cf09` |
