# Language Support Guide

## Supported Languages

| Code | Language | Default Formality | Writing Direction |
|------|----------|-------------------|-------------------|
| en | English | Professional | LTR |
| ko | Korean | Formal polite (-습니다체) | LTR |
| ja | Japanese | Keigo (standard polite) | LTR (technical) |

## Language-Specific Conventions

### English (en)
- Active voice preferred: "The function returns" not "The value is returned by"
- Second person for instructions: "You can configure..."
- Oxford comma in lists
- Sentence case for headings

### Korean (ko)
- Formal polite register (-습니다/합니다체) for documentation
- Technical terms: original English in parentheses on first use
  - Example: "의존성 주입(Dependency Injection)은..."
- Honorifics: standard formal, avoid excessive honorifics in technical docs
- Number formatting: 1,000 (comma separator)
- Date format: YYYY년 MM월 DD일
- Spacing: 조사 attached to preceding word, standard Korean spacing rules

### Japanese (ja)
- Desu/masu (です/ます) form for technical documentation
- Katakana for foreign technical terms: コンポーネント, デプロイ
- Mixed script: kanji + hiragana for readability
- Date format: YYYY年MM月DD日
- Avoid excessive keigo in technical context

## Localization Checklist

- [ ] Cultural context adapted (not just translated)
- [ ] Technical terms use accepted local conventions
- [ ] Date, number, currency formats localized
- [ ] Examples use culturally appropriate references
- [ ] Formality level consistent throughout document
- [ ] Code comments remain in English
- [ ] Variable/function names remain in English
- [ ] UI strings separated from logic for i18n
