---
context: fork
name: claude-design
description: |
  Claude Design 연동 워크플로우 — 마케팅 에셋(랜딩페이지 프로토타입, 이메일 템플릿,
  소셜 카드, 프레젠테이션) 제작 가이드. claude.ai/design 활용, 디자인 시스템 추출,
  Claude Code 핸드오프 번들 연동, 브랜드 일관성 유지.
  Triggers: claude design, design asset, landing page, email template, social card,
  프로토타입, 랜딩페이지, 디자인 에셋, 마케팅 디자인, 이메일 템플릿, 소셜 카드
platforms: [claude-cowork, claude-code]
level: 2
triggers:
  - "claude design"
  - "design asset"
  - "landing page prototype"
  - "email template"
  - "social card"
  - "프로토타입"
  - "랜딩페이지"
  - "디자인 에셋"
  - "마케팅 디자인"
agents:
  - "presentation-designer"
tokens: "~3K"
category: "design"
---

# Claude Design 연동

## When This Skill Applies
- 마케팅 랜딩페이지 프로토타입 제작
- 이메일 캠페인 템플릿 디자인
- 소셜 미디어 카드 / 배너 에셋 생성
- 프레젠테이션 슬라이드 시각화
- 브랜드 디자인 시스템에서 컴포넌트 추출
- 디자인 결과물을 Claude Code로 핸드오프

## 연관 스킬
- [`presentation-design`](../presentation-design/SKILL.md) — 슬라이드 덱 / 피치덱 내러티브 설계
- [`brand-guidelines`](../brand-guidelines/SKILL.md) — 브랜드 컬러, 폰트, 비주얼 아이덴티티
- [`image-generation`](../image-generation/SKILL.md) — AI 이미지 소스 생성 (디자인 원소 입력용)

---

## Core Guidance

### Claude Design 워크플로우 개요

```
Brand Input → Design Brief → claude.ai/design → Asset Export → Handoff Bundle
     |                                                               |
Brand Guidelines                                          Claude Code / Dev
```

### 1. 디자인 브리프 작성

Claude Design에 전달할 브리프는 다음 요소를 포함해야 합니다:

| 요소 | 내용 | 예시 |
|------|------|------|
| **에셋 타입** | 만들 에셋 종류 | 랜딩페이지 히어로 섹션 |
| **브랜드 컨텍스트** | 컬러, 폰트, 톤 | 메인 컬러 #2D5BFF, Pretendard |
| **목표 메시지** | 핵심 카피 | "전환율 30% 향상" |
| **레이아웃 힌트** | 구조 지시 | 2-column, CTA 우측 배치 |
| **참조 URL** | 벤치마크 레퍼런스 | 유사 브랜드 URL |

**브리프 템플릿:**
```
Design Asset Brief
==================
Type:        [landing-page | email-template | social-card | presentation]
Format:      [1200×630px | 600px-wide | 1920×1080px | 16:9]
Brand:       [primary color, font, logo reference]
Message:     [main headline, subheadline, CTA text]
Tone:        [professional | playful | urgent | minimal]
Reference:   [URL or description of visual direction]
Constraints: [any technical or brand constraints]
```

### 2. 에셋 타입별 가이드

#### 랜딩페이지 프로토타입

**목적**: 전환 최적화 전 시각적 가설 검증

```
Flow:
1. campaign-planning 스킬로 메시지 계층 정의 (Hero → Value Props → CTA)
2. brand-guidelines 스킬로 비주얼 시스템 추출
3. Claude Design에 와이어프레임 + 브리프 전달
4. 생성된 HTML/CSS 프로토타입 수령
5. cro-page 스킬로 전환율 관점 검토
6. Claude Code 핸드오프 (아래 핸드오프 섹션 참조)
```

**연계 스킬 체인**:
`campaign-planning` → `brand-guidelines` → **claude-design** → `cro-page`

#### 이메일 템플릿

**목적**: 재사용 가능한 캠페인 이메일 시각 시스템

```
Flow:
1. email-marketing 스킬로 이메일 구조 정의 (헤더/본문/CTA/푸터)
2. brand-guidelines 스킬로 이메일 브랜드 스펙 추출
3. Claude Design에 모바일-퍼스트 레이아웃 요청
4. 인라인 CSS 버전으로 수령 (이메일 클라이언트 호환)
5. 실제 캠페인 카피 적용 (copywriting 스킬)
```

**연계 스킬 체인**:
`email-marketing` → `brand-guidelines` → **claude-design** → `copywriting`

#### 소셜 카드 / 배너

**목적**: SNS 플랫폼별 최적화된 비주얼 에셋

| 플랫폼 | 권장 크기 | 특이사항 |
|--------|----------|---------|
| LinkedIn | 1200×627px | 텍스트 비율 20% 이하 |
| Instagram | 1080×1080px (정방형) / 1080×1350px (세로) | 스토리용 별도 |
| X (Twitter) | 1600×900px | 카드 요약 포함 |
| Facebook | 1200×630px | OG 메타 연동 |

```
Flow:
1. social-media 스킬로 플랫폼별 비주얼 톤 확인
2. image-generation 스킬로 배경/일러스트 소스 생성
3. Claude Design으로 텍스트 + 레이아웃 조합
4. 플랫폼별 포맷 내보내기
```

#### 프레젠테이션 슬라이드

**목적**: 피치덱 / 전략 보고서 시각화

```
Flow:
1. presentation-design 스킬로 내러티브 구조 설계
2. data-visualization 스킬로 차트/그래프 명세 정의
3. Claude Design으로 슬라이드 레이아웃 시각화
4. 개별 슬라이드 PNG/SVG 내보내기
5. PowerPoint/Keynote로 어셈블
```

**연계 스킬 체인**:
`presentation-design` → `data-visualization` → **claude-design**

### 3. 디자인 시스템 추출

기존 브랜드에서 Claude Design용 토큰을 추출하는 방법:

```
브랜드 시스템 추출 요청 예시:
"현재 웹사이트 [URL]에서 디자인 토큰을 추출해줘:
- Primary / Secondary / Accent 컬러 (hex)
- 헤딩 / 본문 폰트 및 크기 스케일
- 간격(spacing) 스케일
- 버튼 스타일 (모서리 반경, 패딩)
- 아이콘 스타일 (outlined / filled)
출력: Claude Design 브리프에 직접 사용할 수 있는 JSON 형태"
```

**추출 결과 예시:**
```json
{
  "colors": {
    "primary": "#2D5BFF",
    "secondary": "#F5F7FF",
    "accent": "#FF6B35",
    "text": "#1A1A2E"
  },
  "typography": {
    "heading": "Pretendard 700, 32/40/48px",
    "body": "Pretendard 400, 16px/1.6"
  },
  "spacing": [4, 8, 16, 24, 32, 48, 64],
  "borderRadius": "8px",
  "shadows": "0 2px 8px rgba(0,0,0,0.08)"
}
```

### 4. Claude Code 핸드오프 번들

디자인 완성 후 개발팀에 전달하는 핸드오프 패키지:

```
핸드오프 번들 요청 예시:
"완성된 [에셋명] 디자인을 Claude Code 핸드오프 번들로 패키징해줘:
1. 컴포넌트 스펙 (크기, 간격, 컬러 토큰)
2. 구현 힌트 (CSS 프레임워크: Tailwind / CSS-in-JS)
3. 반응형 브레이크포인트 명세
4. 인터랙션 상태 (hover, focus, active)
5. 접근성 메모 (ARIA, 컬러 대비)"
```

**핸드오프 체크리스트:**
- [ ] 컴포넌트별 치수 및 간격 명세
- [ ] 컬러 토큰 (디자인 → 코드 변수명 매핑)
- [ ] 타이포그래피 스케일 정의
- [ ] 반응형 동작 명세 (모바일/태블릿/데스크톱)
- [ ] 에셋 파일 (SVG, 최적화된 이미지)
- [ ] 인터랙션 상태 설명

## Output Format

```
CLAUDE DESIGN WORKFLOW
======================
Asset Type:     [type]
Brand System:   [extracted tokens summary]
Brief:          [1-2 line design brief]

DESIGN BRIEF
------------
[Structured brief for Claude Design input]

HANDOFF BUNDLE
--------------
[Component specs, tokens, responsive notes]

NEXT STEPS
----------
1. [Next action with linked skill]
2. [Downstream workflow]
```

## Quick Reference

**claude.ai/design**: 마케팅 에셋 시각화 플랫폼
**핵심 플로우**: 브리프 작성 → Claude Design → 검토 → 핸드오프
**연계 스킬**: `brand-guidelines`, `presentation-design`, `image-generation`, `cro-page`, `email-marketing`
