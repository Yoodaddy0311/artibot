# v5 설계 증거 보관 (evidence)

설계 정본(`../ARTIBOT-5.0-DESIGN.md`)이 인용하는 **재생성 비용이 큰 실측 산출물**을 둔다.
`reports/` 는 `.gitignore:73`(`reports/*`, `!reports/SPLIT/` 만 재포함)로 추적되지 않으므로
git 에 남아야 하는 증거는 이곳에 둔다.

| 파일 | 무엇인가 | 출처 |
|---|---|---|
| `citation-census-20260903.json` | T-53 2차 sweep 의 코드→코드 `file:line` 인용 전수 조사(POST-EDIT 상태 rows 349 = 잔여 occurrence 수(`postEditTotal`), 물리 줄수는 4,927, `byStatus` NO-FILE 66 / IN-RANGE 230 / AMBIGUOUS 18 / BLANK-LINE 13 / OUT-OF-RANGE 22). `citation-resolution` 게이트가 못 보는 blindspot(범위 안이지만 엉뚱한 곳을 가리키는 인용)의 분모다. **rows 349 / 4,927 lines** / 133,693 B | 2026-09-03 세션 스크래치패드에서 복사(오너 결정 2026-09-03 "재스캔 비용 > 보관 비용"). 원본 유지 |
