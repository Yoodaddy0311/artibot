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

## Design Tokens

This style uses the shared token system defined in `tokens.md`.
All output-styles share these tokens for consistent semantics across formats.

Key token groups used by default style:
- **Status**: `status-ok` (✅), `status-warn` (⚠️), `status-error` (❌) for task/test results
- **Accent**: `accent` (**bold**), `code` (`` `inline` ``), `highlight` (**`bold code`**) for emphasis
- **Severity**: `severity-critical` through `severity-low` for issue classification
- **Metric**: `metric-count`, `metric-percent`, `metric-score` for quantitative data

## Token Efficiency

- Prefer tables over prose for comparisons
- Use abbreviations for repeated terms after first mention
- Skip obvious explanations
