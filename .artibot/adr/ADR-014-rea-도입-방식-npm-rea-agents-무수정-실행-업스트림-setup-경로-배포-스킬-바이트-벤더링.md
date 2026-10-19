---
status: active
created: 2026-10-19
number: 14
---

# ADR-014: /rea 도입 방식 — npm rea-agents 무수정 실행 + 업스트림 setup 경로 + 배포 스킬 바이트 벤더링

## 추천 결론 (TL;DR)
> **엔진은 npm rea-agents@6.7.0 를 수정 없이 실행한다. MCP 등록은 업스트림 스킬의 절차(setup --dry-run → 승인 → --yes, user-level)를 /rea 가 그대로 수행한다. npm tarball 의 skills/reverse-engineer-anything/** 를 바이트 그대로 plugins/artibot/vendor/rea/ 에 두고 버전 핀 3자(rea.md · UPSTREAM.json · SKILL.md specifier)를 테스트로 묶는다. 오너 선택 2026-10-19.을(를) 채택한다.** 엔진 벤더링은 거의 매일 릴리스되는 4,395파일을 따라갈 수 없다. .mcp.json 등록은 Artibot 전 사용자 세션에 MCP 툴 207개(tarball SKILL.md tool_count)와 서버 기동을 붙인다. local scope 는 업스트림 doctor 가 user-level 항목만 읽어(installation.md:294-297) 스킬의 진단·복구 단계(SKILL.md:43-56)와 모순되고 디렉터리마다 재등록이 필요하며 ~/.claude.json 에도 쓴다(installation.md:291). 업스트림 setup 경로는 doctor·자동 발화 스킬·백업까지 업스트림과 같아 100% 동일 요구를 충족한다. 적대 검증 plan-critic H1 반영.

## Status
Accepted

작성일: 2026-10-19

---

## 1. Context (컨텍스트와 제약사항)
조사 필요

---

## 2. Alternatives Considered (검토한 선택지)
### 선택지: 엔진 소스 전체 벤더링(4,395파일/66MB, turbo 빌드, 네이티브 브리지)
- **장점**: 조사 필요
- **단점**: 조사 필요

### 선택지: 플러그인 .mcp.json 에 npx -y rea-agents@6.7.0 mcp 핀 등록
- **장점**: 조사 필요
- **단점**: 조사 필요

### 선택지: 프로젝트 단위 claude mcp add --scope local 등록
- **장점**: 조사 필요
- **단점**: 조사 필요

### 선택지: 업스트림 스킬 3단계 그대로: setup --client claude_code --dry-run → 사용자 승인 → --yes (user-level)
- **장점**: 조사 필요
- **단점**: 조사 필요

---

## 3. 확장성 관점 평가
조사 필요

---

## 4. 숨겨진 비용
조사 필요

---

## 5. Decision (추천안)
> ## ✓ **추천: 엔진은 npm rea-agents@6.7.0 를 수정 없이 실행한다. MCP 등록은 업스트림 스킬의 절차(setup --dry-run → 승인 → --yes, user-level)를 /rea 가 그대로 수행한다. npm tarball 의 skills/reverse-engineer-anything/** 를 바이트 그대로 plugins/artibot/vendor/rea/ 에 두고 버전 핀 3자(rea.md · UPSTREAM.json · SKILL.md specifier)를 테스트로 묶는다. 오너 선택 2026-10-19.**

**선택 근거**: 엔진 벤더링은 거의 매일 릴리스되는 4,395파일을 따라갈 수 없다. .mcp.json 등록은 Artibot 전 사용자 세션에 MCP 툴 207개(tarball SKILL.md tool_count)와 서버 기동을 붙인다. local scope 는 업스트림 doctor 가 user-level 항목만 읽어(installation.md:294-297) 스킬의 진단·복구 단계(SKILL.md:43-56)와 모순되고 디렉터리마다 재등록이 필요하며 ~/.claude.json 에도 쓴다(installation.md:291). 업스트림 setup 경로는 doctor·자동 발화 스킬·백업까지 업스트림과 같아 100% 동일 요구를 충족한다. 적대 검증 plan-critic H1 반영.

---

## 6. Consequences (의사결정의 결과)
조사 필요

---

## 7. 2년 뒤 기술 부채 예상 포인트
조사 필요
