---
context: fork
name: image-generation
platforms: [claude-code, gemini-cli, codex-cli, cursor]
description: "AI image prompt engineering and generation workflow. Use when user asks to generate, create, edit, or refine images. Triggers on: 이미지 만들어줘, 그림 생성해줘, 이미지 그려줘, 썸네일 만들어, 로고 만들어줘, 이미지 수정해줘, 사진 편집해줘, 아까 만든 거 수정, 색감 바꿔줘, image generate, create image, edit image, modify image, refine image."
level: 3
triggers:
  - "image"
  - "generate image"
  - "create image"
  - "edit image"
  - "이미지"
  - "그림"
  - "썸네일"
  - "로고"
  - "사진"
  - "이미지 생성"
  - "이미지 수정"
  - "그려줘"
agents:
  - "presentation-designer"
tokens: "~5K"
category: "design"
---

# Image Generation

> 자연어로 이미지 프롬프트를 생성하고, 외부 이미지 생성 API(Gemini 등)로 실행하는 스킬.
> 7모드 프롬프트 엔지니어링 시스템으로 최적의 이미지 프롬프트를 자동 생성한다.

---

## 사전 조건

이미지 생성 API가 필요하다. 현재 지원:
- **Google Gemini** (무료 티어 가능): Google AI Studio에서 API 키 발급
- API 키는 환경변수 `GEMINI_API_KEY`에 설정

API가 없으면 **프롬프트 생성만** 수행하고, 사용자에게 프롬프트를 복사해서 외부 도구(Midjourney, DALL-E, Gemini 웹 등)에서 실행하도록 안내한다.

---

## 워크플로우

### Step 0: 모드 자동 감지
**타입**: prompt (Claude 판단)

사용자 입력을 분석하여 3가지 모드 중 하나를 결정한다:

| 모드 | 조건 | 키워드 |
|------|------|--------|
| `MODE_NEW` | 새 이미지 생성 요청 (기본값) | "만들어줘", "생성해줘", "그려줘", "create", "generate" |
| `MODE_EDIT` | 기존 이미지 파일 경로 포함 + 변형 요청 | "이 이미지 수정해줘", "edit this" |
| `MODE_REFINE` | 이번 대화에서 이전 생성 이력 + 수정 요청 | "아까 거 바꿔줘", "색감 변경", "좀 더 밝게" |

감지 우선순위: MODE_EDIT (파일 경로 존재) > MODE_REFINE (이전 생성 이력 + 수정 동사) > MODE_NEW (기본)

수정 감지 키워드: "수정", "바꿔", "변경", "고쳐", "다시", "재생성", "좀 더", "덜", "밝게", "어둡게", "아까 거", "방금 거", "modify", "change", "refine", "adjust"

### Step 0.5: 파라미터 자동 매핑 (MODE_NEW 전용)
**타입**: prompt

사용자 프롬프트에서 비율/품질 힌트를 추출한다:

| 키워드 | 비율 매핑 |
|--------|----------|
| "세로", "포스터", "인스타", "portrait" | 3:4 |
| "가로", "썸네일", "유튜브", "landscape", "presentation" | 16:9 |
| "정사각형", "프로필", "아이콘", "square" | 1:1 |
| "배너", "헤더", "banner" | 4:1 |

| 키워드 | 품질 매핑 |
|--------|----------|
| "빨리", "시안", "초안", "대충", "quick", "draft" | 저품질 (빠름) |
| "고품질", "4K", "정교하게", "세밀하게", "high quality" | 고품질 (느림) |

힌트가 부족하면 기본값 사용: 1:1, 고품질.

### Step 1: 이미지 프롬프트 생성
**타입**: rag + prompt

`references/image-studio-prompt.md`를 Read 도구로 로드한다. 이 시스템 프롬프트의 지침을 내면화하여:

1. 사용자 요청을 분석
2. 7가지 모드 중 최적 모드를 자동 선택:
   - **MODE_A_PORTRAIT**: 인물, 프로필, 얼굴
   - **MODE_B_LANDSCAPE**: 풍경, 배경, 자연
   - **MODE_C_OBJECT**: 제품, 물건, 상품
   - **MODE_D_ILLUSTRATION**: 일러스트, 그림, 아트
   - **MODE_E_THUMBNAIL**: 썸네일, 커버, 대표이미지
   - **MODE_F_LOGO**: 로고, 브랜드, 심볼, 아이콘
   - **MODE_G_CONCEPTUAL**: 컨셉트, 추상, 아이디어
3. 영문 이미지 생성 프롬프트 출력 (200-500 단어)

모드별 프롬프트 차이:
- **MODE_NEW**: 사용자 요청 -> 모드 선택 -> 영문 프롬프트 생성
- **MODE_EDIT**: "원본 이미지를 기반으로 [변경사항]을 적용" 형태
- **MODE_REFINE**: 이전 프롬프트 기반으로 수정 사항만 반영한 delta 프롬프트

### Step 2: 이미지 생성 실행
**타입**: script (조건부)

`GEMINI_API_KEY` 환경변수가 설정되어 있으면 Gemini REST API로 이미지 생성:

```bash
curl -s "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${GEMINI_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "contents": [{"parts": [{"text": "Generate an image: [영문 프롬프트]"}]}],
    "generationConfig": {"responseModalities": ["TEXT", "IMAGE"]}
  }'
```

API 키가 없으면 Step 1의 프롬프트만 출력하고 아래 안내:
```
생성된 프롬프트를 복사해서 아래 도구에서 실행하세요:
- Google AI Studio (https://aistudio.google.com)
- Midjourney (/imagine 명령어에 붙여넣기)
- DALL-E (ChatGPT에서 이미지 생성)
```

### Step 3: 결과 반환
**타입**: generate

성공 시:
- 저장된 이미지 파일 경로
- 선택된 모드 (인물/풍경/로고 등)
- 사용된 프롬프트 요약 (한국어 2-3줄)
- "수정하고 싶으면 말해주세요" 안내

API 없이 프롬프트만 생성한 경우:
- 생성된 영문 프롬프트 전문
- 추천 비율/해상도
- 외부 도구 실행 안내

### Step 4: 멀티턴 루프

Step 3 완료 후, 대화 컨텍스트에 유지:
- 마지막 생성 프롬프트
- 선택된 설정 (모드, 비율)
- 이전 결과 경로 (있으면)

사용자가 수정 요청 시 Step 0으로 자동 복귀 (MODE_REFINE).

---

## References
- **`references/image-studio-prompt.md`** -- 7모드 이미지 프롬프트 엔지니어링 시스템. 모드별 페르소나, 워크플로우, 출력 템플릿 포함. (Image Studio v3.1)
