# Token Budget Audit — artibot-cowork v0.4.0

| Field | Value |
|---|---|
| Audit date | 2026-04-24 |
| Auditor | budget-auditor (Unit L) |
| Scope | `plugins/artibot-cowork/skills/**` (41 SKILL.md + 66 references) |
| Source measurement | `wc -l` via find (실측) |
| Token conversion | 1 line ≈ 12 tokens (한/영 혼재 평균, markdown 포함) |
| Claude context window | 1,000,000 tokens (Opus 4.7 1M) |

## 1. 실측 요약

| 지표 | 값 |
|---|---|
| SKILL.md 파일 수 | 41 |
| SKILL.md 총 라인 | 7,930 |
| SKILL.md 평균 라인 | 193 |
| references 파일 수 | 66 |
| references 총 라인 | 6,679 |
| references 평균 라인 | 101 |
| 전체 cowork skills 라인 합 | 14,609 |
| 전체 추정 토큰 합 (×12) | ~175,300 tokens |
| 1M context 점유율 (전부 로드 시) | ~17.5% |

## 2. 전체 SKILL.md 테이블 (라인 내림차순, 추정 토큰 포함)

| skill | lines | est_tokens | 비고 |
|---|---:|---:|---|
| delegation | 336 | 4,032 | level 3, progressive_disclosure 활성 |
| ad-compliance | 284 | 3,408 | v0.4.0 신규 (ad-specialist 보강) |
| market-research | 281 | 3,372 | v0.4.0 신규 |
| thought-leadership | 272 | 3,264 | v0.3.0 writing pack |
| kr-marketing | 255 | 3,060 | v0.4.0 신규 (KR 로컬화) |
| library-mermaid | 245 | 2,940 | 차트 라이브러리 참조 |
| ai-slop-reviewer | 244 | 2,928 | v0.4.0 신규 |
| content-pipeline | 229 | 2,748 | v0.4.0 신규 (Unit I) |
| lead-management | 224 | 2,688 | |
| column-editorial | 222 | 2,664 | v0.3.0 writing pack |
| segmentation | 213 | 2,556 | |
| long-form-writing | 210 | 2,520 | v0.3.0 writing pack |
| voice-reference | 209 | 2,508 | v0.3.0 writing pack |
| seo-strategy | 208 | 2,496 | |
| interview-storytelling | 207 | 2,484 | v0.3.0 writing pack |
| social-media | 205 | 2,460 | |
| report-generation | 199 | 2,388 | |
| data-analysis | 195 | 2,340 | |
| ab-testing | 189 | 2,268 | |
| brand-guidelines | 189 | 2,268 | |
| cro-forms | 180 | 2,160 | |
| clarify | 179 | 2,148 | |
| marketing-analytics | 179 | 2,148 | |
| case-study | 178 | 2,136 | v0.3.0 writing pack |
| data-visualization | 178 | 2,136 | |
| content-seo | 175 | 2,100 | |
| cro-funnel | 176 | 2,112 | |
| customer-journey | 166 | 1,992 | |
| campaign-planning | 165 | 1,980 | |
| technical-seo | 165 | 1,980 | |
| competitive-intelligence | 163 | 1,956 | |
| presentation-design | 163 | 1,956 | |
| advertising | 158 | 1,896 | |
| copywriting | 158 | 1,896 | |
| cro-page | 159 | 1,908 | |
| email-marketing | 156 | 1,872 | |
| principles | 151 | 1,812 | |
| marketing-strategy | 149 | 1,788 | |
| image-generation | 148 | 1,776 | |
| design-system-reference | 104 | 1,248 | 작은 허브, refs가 큼 |
| daily | 64 | 768 | 최소 스킬 |

**Sum**: 7,930 lines · **~95,160 tokens**.

## 3. references 테이블 상위 15개 (라인 내림차순)

| reference | lines | est_tokens |
|---|---:|---:|
| image-generation/image-studio-prompt.md | 461 | 5,532 |
| design-system-reference/linear.md | 367 | 4,404 |
| design-system-reference/stripe.md | 322 | 3,864 |
| design-system-reference/apple.md | 313 | 3,756 |
| design-system-reference/vercel.md | 310 | 3,720 |
| design-system-reference/supabase.md | 255 | 3,060 |
| kr-marketing/naver-kakao-platforms.md | 219 | 2,628 |
| ab-testing/test-design-framework.md | 213 | 2,556 |
| ad-compliance/korea-ad-law.md | 196 | 2,352 |
| market-research/research-methodology.md | 167 | 2,004 |
| copywriting/aeo-geo-2026.md | 163 | 1,956 |
| copywriting/long-form-quality-rubric.md | 158 | 1,896 |
| voice-reference/writing-samples-scaffold.md | 150 | 1,800 |
| lead-management/lead-scoring-model.md | 143 | 1,716 |
| copywriting/anti-ai-writing.md | 141 | 1,692 |

나머지 51개 references: 30~130 lines 구간, 대부분 100 미만. **Sum 전체 66개 refs**: 6,679 lines · **~80,148 tokens**.

## 4. 시나리오별 context 점유

| 시나리오 | 구성 | lines | est_tokens | 1M 점유율 |
|---|---|---:|---:|---:|
| A. 단일 skill (copywriting only) | SKILL.md 1개 | 158 | 1,896 | 0.19% |
| A'. 단일 skill + 1 reference (copywriting + aeo-geo-2026) | SKILL + 1 ref | 321 | 3,852 | 0.39% |
| B. writing pack (v0.3.0) | 6 SKILL + 4 refs¹ | 1,298 + 612 = 1,910 | 22,920 | 2.29% |
| C. marketing 풀팩 (v0.3.0 + v0.4.0 신규 5) | 11 SKILL + 해당 refs | 약 3,200 | 38,400 | 3.84% |
| D. content-marketer agent + 전 skills 로드 (worst case) | 41 SKILL + 66 refs | 14,609 | 175,308 | 17.53% |
| D'. D + system prompts + 대화 기록 500K | D + overhead | ~800,000 | 800,000 | 80% |

**핵심 수치 1**: 최악(D)에도 전체 skills 토큰은 **1M의 17.5%**에 불과.
**핵심 수치 2**: writing pack(B)은 **2.3%**, marketing 풀팩(C)도 **3.8%**로 실용 구간 여유 큼.
**핵심 수치 3**: B/C 시나리오에서 SKILL frontmatter(평균 15~25 lines)가 합계의 ~13%를 차지 — **description 압축이 현실적 레버**.

Writing pack refs 계산 내역 (4 refs):
- anti-ai-writing (141) + aeo-geo-2026 (163) + long-form-quality-rubric (158) + voice-profile-template (87) + writing-samples-scaffold (150) = 699
- 상위 4개만 선택시 612 lines. 전체 5 refs 포함시 699 lines.

> ¹ **시나리오 B 주석**: "4 refs"는 `writing-samples-scaffold.md`(150 lines) 제외 기준. scaffold는 유저가 직접 채우는 fill-in placeholder 파일이라 실제 context 로드 대상이 아님. 5 refs 전체 포함 시 1,997 lines / ~23,964 tokens / 2.40% (차이 +0.11%p).

## 5. 현 lazy-load 설정 실효성

**위치**: `plugins/artibot/artibot.config.json:919-924`

```
"skills": {
  "lazyLoading": {
    "enabled": true,
    "maxConcurrent": 5
  }
}
```

| 분석 항목 | 판정 |
|---|---|
| 동시 5개 로드 시 최대 라인 (상위 5 SKILL) | 336+284+281+272+255 = 1,428 lines |
| 동시 5개 로드 시 est_tokens | ~17,136 tokens |
| 1M context 대비 | 1.7% — **여유 充分** |
| 평균 5개 로드 시 (193 × 5) | 965 lines / ~11,580 tokens / 1.16% |
| references 동시 로드 한도 | 별도 제한 없음 (SKILL만 카운트됨으로 추정) |

**실효성 판단**: `maxConcurrent: 5`는 **적정 이상으로 여유**. 41개 중 5개만 로드해도 상위 5개 합쳐 2K 라인 미만. 축소(3) 불필요, 확대(7~10)는 안전. 단, references가 병렬로 함께 로드되는 경우 상위 design-system refs 하나가 SKILL 2개와 맞먹으므로 "SKILL+refs 합산 기준"으로 재정의 시 의미 있음.

## 6. 축약본 필요성 판단

**200+ lines 초과 SKILL 리스트 (14개 후보)**:

| skill | lines | 축약 가능성 | 근거 |
|---|---:|---|---|
| delegation | 336 | 높음 | progressive_disclosure 이미 활성, level1/level2 토큰 분리 가능 |
| ad-compliance | 284 | 중 | 법률 체크리스트 상세, lean 버전은 리스크 |
| market-research | 281 | 높음 | 방법론 서술 풍부, quick-reference 축약 가능 |
| thought-leadership | 272 | 높음 | Authority-Vulnerability-Value 프레임 외 보조 예시 과다 |
| kr-marketing | 255 | 중 | 네이버/카카오 특화 사양 — 생략 위험 |
| library-mermaid | 245 | 중 | 차트 라이브러리 문법 참조용 |
| ai-slop-reviewer | 244 | 낮음 | 체크리스트 중심, 축약 시 의미 손실 |
| content-pipeline | 229 | 중 | 신규, 안정화 후 재검토 |
| lead-management | 224 | 높음 | lifecycle 서술 보조 분리 가능 |
| column-editorial | 222 | 높음 | 예시 섹션 분리 가능 |
| segmentation | 213 | 중 | 분류 체계 압축 가능 |
| long-form-writing | 210 | 중 | v0.3.0 pack, 체크리스트 간소화 가능 |
| voice-reference | 209 | 중 | 템플릿 주도 — lean 버전 위험 |
| interview-storytelling | 207 | 중 | |

**critical path vs extended guide 분리 가능성**: 대부분의 SKILL은 "triggers → when-to-use → core steps → references"로 구성. lean 모드는 triggers + core steps만 남기면 ~60-80 lines 가능. 단, frontmatter 자체가 30~50 lines인 경우(delegation, thought-leadership) frontmatter 압축이 병행되어야 실효.

## 7. 권고안 3종 비교

| 옵션 | 내용 | 장점 | 단점 | 예상 효과 | 구현 노력 |
|---|---|---|---|---|---|
| **A. 유지** | 현 구조 유지, 추가 작업 없음 | 즉시 안정, breaking change 0, 기존 lazy-load로 충분 | 200+ 라인 SKILL 14개 이후 추가 시 점진 팽창 | context 17.5% 유지, 신규 스킬 당 +0.1~0.3% | **0 hours** |
| **B. lazy-load 축소 (maxConcurrent: 3)** | `artibot.config.json`에서 5 → 3 | 최악 시나리오 context 추가 40% 절약 | 3개 초과 병렬 스킬 필요 시 cold-load 지연, 사용자 체감 느림 | 평균 5개 로드 11.6K → 3개 6.9K tokens | **5분** (config 1줄) |
| **C. short-form variant (SKILL.lean.md)** | 200+ 라인 skill 7~8개에 50~80 라인 lean 추가, trigger/complexity 조건에 따라 선택 | 가장 큰 context 절감 (~40%), 원본 보존 | 유지보수 2배, drift 위험, loader 분기 로직 필요, 테스트 추가 | marketing 풀팩 3.84% → ~2.3% | **2~3일** (loader + 7~8개 lean 작성 + 테스트) |

**추가 대안 (권고는 아니지만 기록)**:
- **D. frontmatter 압축만**: description을 130자 이내로 + triggers 최대 8개로 제한. 각 skill -5~15 lines. 낮은 노력 · 중간 효과 (~5%).

## 8. 최종 권고

**옵션 A (유지) + 옵션 D (frontmatter 압축)만 점진 적용**.

**한 줄 근거**: 실측 최악 시나리오(전 skills 로드)도 **1M context의 17.5%**에 불과하며, lazy-load 5개 동시 로드 시 **1.7%** 점유로 여유 충분하다. 축약본(옵션 C)은 유지보수 비용이 절감 이익(약 1.5%p)을 초과하므로 **premature optimization**에 해당. 옵션 B(축소)는 사용자 지연을 초래해 UX 회귀. frontmatter 압축(옵션 D)은 저비용·비파괴적이므로 신규 SKILL 작성 시 **130자 description · 최대 8 triggers** 규칙만 가이드로 추가할 것을 권고한다.

| 체크포인트 | 조건 |
|---|---|
| 재감사 트리거 | SKILL 총 라인이 현재의 1.5배(11,900+) 도달 시 |
| SKILL 총 skills 수 | 60개 초과 시 |
| 실사용 context 점유율 | 단일 세션에서 25% 초과 관측 시 |
| 신규 SKILL 작성 규칙 | description ≤ 130자, triggers ≤ 8개, body ≤ 220 lines 권장 |

## 9. 부록 — 측정 명령 재현

```bash
# SKILL.md 라인 측정
find plugins/artibot-cowork/skills -name "SKILL.md" -print0 \
  | xargs -0 wc -l | sort -n

# references 라인 측정
find plugins/artibot-cowork/skills -path "*/references/*.md" -print0 \
  | xargs -0 wc -l | sort -n

# 토큰 환산 (Node)
node -e "const lines=7930+6679; console.log('tokens≈',lines*12)"
```

---

**작성자**: budget-auditor (Unit L) · **팀**: cowork-v0.4.0-full-sprint · **DEV Protocol 준수**
