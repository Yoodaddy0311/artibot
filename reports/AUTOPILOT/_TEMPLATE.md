# Autopilot 완료 보고서

> 이 파일은 템플릿입니다. `report-generator.js`가 실행 시 아래 placeholder를 실제 값으로 채웁니다.
> placeholder 형식: `{{변수명}}`

---

## 1. 요약

| 항목 | 값 |
|------|----|
| 세션 ID | `{{sessionId}}` |
| 작업 | {{task}} |
| 모드 | {{mode}} |
| 시작 시각 | {{startedAt}} |
| 종료 시각 | {{endedAt}} |
| 소요 시간 | {{durationHuman}} |
| 최종 상태 | {{finalStatus}} |
| 토큰 사용량 | {{tokenUsage}} |

---

## 2. PRD 링크

- PRD 파일: [{{prdPath}}](../../{{prdPath}})

---

## 3. Phase별 결과

| Phase | 이름 | 상태 | 소요 시간 | 변경 파일 수 | 통과한 검증 |
|-------|------|------|-----------|-------------|-------------|
| 0 | INTAKE | {{phase0Status}} | {{phase0Duration}} | {{phase0FilesChanged}} | {{phase0Checks}} |
| 1 | PLAN | {{phase1Status}} | {{phase1Duration}} | {{phase1FilesChanged}} | {{phase1Checks}} |
| 2 | PARALLEL EXECUTE | {{phase2Status}} | {{phase2Duration}} | {{phase2FilesChanged}} | {{phase2Checks}} |
| 3 | CROSS-CHECK | {{phase3Status}} | {{phase3Duration}} | {{phase3FilesChanged}} | {{phase3Checks}} |
| 4 | VERIFY | {{phase4Status}} | {{phase4Duration}} | {{phase4FilesChanged}} | {{phase4Checks}} |
| 5 | IMPROVE | {{phase5Status}} | {{phase5Duration}} | {{phase5FilesChanged}} | {{phase5Checks}} |
| 6 | REPORT | {{phase6Status}} | {{phase6Duration}} | — | — |

---

## 4. 변경 사항 (커밋 SHA)

| 커밋 SHA | 시각 | Phase | 메시지 |
|----------|------|-------|--------|
{{#each checkpoints}}
| `{{this.sha}}` | {{this.ts}} | {{this.phase}} | {{this.message}} |
{{/each}}

---

## 5. Cross-check 결과

| 검토자 (에이전트) | 대상 | 결과 | 주요 발견 |
|-----------------|------|------|-----------|
{{#each crossCheckResults}}
| {{this.reviewer}} | {{this.target}} | {{this.result}} | {{this.findings}} |
{{/each}}

---

## 6. 검증 결과

| 항목 | 상태 | 세부 내용 |
|------|------|-----------|
| lint | {{lintStatus}} | {{lintDetail}} |
| typecheck | {{typecheckStatus}} | {{typecheckDetail}} |
| test | {{testStatus}} | {{testDetail}} (커버리지: {{testCoverage}}%) |
| build | {{buildStatus}} | {{buildDetail}} |

---

## 7. 개선 제안 (Phase 5 산출)

{{#each improvements}}
- **{{this.category}}**: {{this.description}}
{{/each}}

개선 제안이 없으면: `(없음)`

---

## 8. 미래 발전 방안 (Phase 5 산출)

{{#each futureIdeas}}
- **{{this.title}}**: {{this.description}}
{{/each}}

---

## 9. 큐된 질문 / 결정 필요 사항

야간 모드 또는 자동 pause 중 사용자 확인이 필요했던 항목 목록입니다.

| # | 질문/결정 | 발생 Phase | 발생 시각 | 상태 |
|---|-----------|-----------|-----------|------|
{{#each queuedQuestions}}
| {{@index_1}} | {{this.question}} | {{this.phase}} | {{this.ts}} | {{this.status}} |
{{/each}}

큐된 질문이 없으면: `(없음)`

---

## 10. Next Action

{{#if nextActions}}
{{#each nextActions}}
- [ ] {{this}}
{{/each}}
{{else}}
- [ ] 보고서 내용 검토
- [ ] 큐된 질문 답변 (위 섹션 9 참조)
- [ ] 개선 제안 중 우선순위 결정
{{/if}}

---

*생성 시각: {{reportGeneratedAt}} | Artibot Autopilot v{{artibotVersion}}*
