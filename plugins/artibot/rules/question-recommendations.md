# AskUserQuestion — 권장 옵션 표기 규칙 (always-on)

`AskUserQuestion` 으로 선택지를 제시할 때, 합리적 기본/추천안이 있는 거의 모든 결정 질문에서:

1. **권장 옵션을 `options` 배열의 첫 번째에 둔다.**
2. **그 옵션 label 끝에 ` (권장)` (영문 맥락이면 ` (Recommended)`) 접미사를 반드시 붙인다.**
3. 모든 옵션이 진짜 동등한 trade-off 일 때만 권장 표기를 생략한다.

**왜:** "(권장)"은 플러그인이 그려주는 기능이 아니라 **모델이 label 문자열에 직접 써야만** 표시된다. 본문에 "2번 추천"이라 적어도 선택 UI 에는 그 맥락이 사라진다. 권장 표기가 label 안에 있어야 사용자가 선택 화면만 보고 즉시 의도를 안다.

**주의:** 이 규칙은 메모리(`feedback-question-recommendations`)에도 있으나 메모리는 point-in-time background context 라 매 호출에 강제되지 않는다 → 드리프트 방지를 위해 항상 로드되는 이 rules 파일에 고정. AskUserQuestion 호출 직전 이 규칙을 체크리스트로 적용할 것.
