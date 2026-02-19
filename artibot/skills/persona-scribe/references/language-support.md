# Language Support Reference

## Supported Languages

| Code | Language | Writing Direction | Notes |
|------|----------|------------------|-------|
| en | English | LTR | Default language |
| ko | Korean | LTR | Honorifics system, formal/informal levels |
| ja | Japanese | LTR/TTB | Keigo (polite forms), kanji/hiragana/katakana |
| zh | Chinese (Simplified) | LTR | Formal Chinese conventions |
| es | Spanish | LTR | Latin American variant default |
| fr | French | LTR | International French |
| de | German | LTR | Compound nouns, formal Sie/du |
| pt | Portuguese | LTR | Brazilian variant default |

## Localization Guidelines

### General Rules
- Use ISO 639-1 language codes
- Dates: Use locale-appropriate format (not hardcoded MM/DD/YYYY)
- Numbers: Respect decimal separator conventions (1,000.00 vs 1.000,00)
- Currency: Include currency code, not just symbol
- Pluralization: Handle correctly per language rules

### Technical Writing by Language

| Language | Key Convention |
|----------|---------------|
| en | Direct, concise, action-oriented |
| ko | Formal register (-습니다), technical loanwords in Korean |
| ja | Polite form (です/ます), katakana for foreign terms |
| zh | Concise, four-character expressions where appropriate |
| es | usted form for documentation, clear verb usage |
| fr | vous form, technical anglicisms accepted |
| de | Sie form, compound terms, precise technical language |
| pt | voce form, clear and accessible |

### Activation
Use `--persona-scribe=<lang-code>` to activate language-specific writing mode.
Default (no code specified) uses English.
