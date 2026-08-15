---
description: (Artibot) Marketing documentation generation and maintenance with doc-updater agent
argument-hint: '[target] e.g. "캠페인 브리프 자동 생성"'
allowed-tools: [Read, Write, Edit, Bash, Glob, Grep, Agent, TaskCreate]
---

# /document

Generate or update documentation for brands, campaigns, assets, or playbooks. Delegates to the doc-updater agent for professional, audience-appropriate writing.

## Arguments

Parse $ARGUMENTS:
- `target`: Asset, directory, campaign, or `@<path>` reference to document
- `--type [kind]`: Documentation type - `overview` | `spec` | `guide` | `release-notes` | `annotation` (default: auto-detect)
- `--audience [level]`: Target audience - `marketer` | `customer` | `stakeholder` (default: `marketer`)
- `--lang [code]`: Output language override (default: `en`)
- `--update`: Update existing docs to match current campaigns (not create from scratch)

## Type Detection

If `--type` not specified, detect from target:
- Brand root / no target -> `overview`
- Campaign with defined assets -> `spec`
- Directory with multiple campaigns -> `guide`
- Campaign history requested -> `release-notes`
- Single asset -> `annotation`

## Execution Flow

1. **Parse**: Resolve target path, detect documentation type and existing docs
2. **Analyze**: Read target assets to extract:
   - Deliverable surface (assets, channels, formats)
   - Targeting parameters and segments
   - Usage patterns from past campaigns and examples
   - Dependencies and prerequisites
3. **Cross-Reference**: Check existing documentation for:
   - Outdated references (campaigns renamed/retired)
   - Missing new channels or parameters
   - Broken asset links
4. **Delegate**: Route to Agent(doc-updater) with extracted context:
   - Type-specific template selection
   - Audience-appropriate language level
   - Example generation from past campaign assets
5. **Generate**: Write documentation following brand conventions:
   - Overview: Brand positioning, setup, usage, asset index
   - Spec: Channel/asset documentation with examples
   - Guide: Step-by-step playbooks with context
   - Release notes: Grouped by campaign wave, categorized changes
   - Annotation: Inline notes on assets and briefs
6. **Validate**: Verify generated docs are accurate:
   - Examples render correctly
   - Referenced assets and campaigns exist
   - Links are valid
7. **Report**: Output documentation summary

## Documentation Standards

- Examples must be extracted from shipped campaigns
- Specs must include targeting, formats, and rejection/failure cases
- Every public asset/channel must have a description
- No placeholder text (e.g., "TODO: add description")

## Output Format

```
DOCUMENTATION GENERATED
=======================
Target:    [path]
Type:      [overview|spec|guide|release-notes|annotation]
Audience:  [marketer|customer|stakeholder]

FILES
-----
- [file path] ([created|updated])
  Sections: [list of documentation sections]

COVERAGE
--------
Assets Documented:      [n/total]
Examples Included:      [n]
Cross-references Valid: [YES|NO]
```

## Next Steps

작업 완료 후 추천 후속 액션:

| # | 액션 | 커맨드 | 설명 |
|---|------|--------|------|
| 1 | 품질 점검 | `/analyze` | 문서 커버리지 및 품질 분석 |
| 2 | 발표자료 제작 | `/ppt` | 문서 기반 덱 구성 |
| 3 | 배포 | `/email` | 뉴스레터·메일로 배포 |
