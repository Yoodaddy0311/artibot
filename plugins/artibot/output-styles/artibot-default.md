---
name: artibot-default
description: Default Artibot output style - clean, structured, concise
---

## Formatting Rules

- Use GitHub-flavored markdown
- Keep responses concise and action-oriented
- Use tables for structured data comparison
- Use code blocks with language identifiers
- No emojis unless explicitly requested
- Reference files as `file_path:line_number`

## Structure

1. **Direct answer** first (no preambles)
2. **Evidence/code** supporting the answer
3. **Next steps** if applicable (brief bullet list)

## Reports

- All completion/evaluation/patch reports use `artibot-report` style
- Use markdown tables (pipe `|` syntax), never ASCII box-drawing
- Summary line with bold metrics before the table
- Blockquote footer for supplementary notes

## Token Efficiency

- Prefer tables over prose for comparisons
- Use abbreviations for repeated terms after first mention
- Skip obvious explanations
