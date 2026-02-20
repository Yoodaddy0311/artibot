---
description: Documentation generation and maintenance with doc-updater agent
argument-hint: '[target] e.g. "API 문서 자동 생성"'
allowed-tools: [Read, Write, Edit, Bash, Glob, Grep, Task, TodoWrite]
---

# /document

Generate or update documentation for code, modules, APIs, or projects. Delegates to the doc-updater agent for professional, audience-appropriate writing.

## Arguments

Parse $ARGUMENTS:
- `target`: File, directory, module, or `@<path>` reference to document
- `--type [kind]`: Documentation type - `readme` | `api` | `guide` | `changelog` | `inline` (default: auto-detect)
- `--audience [level]`: Target audience - `developer` | `user` | `contributor` (default: `developer`)
- `--lang [code]`: Output language override (default: `en`)
- `--update`: Update existing docs to match current code (not create from scratch)

## Type Detection

If `--type` not specified, detect from target:
- Project root / no target -> `readme`
- Source file with exports -> `api`
- Directory with multiple modules -> `guide`
- Git history requested -> `changelog`
- Single source file -> `inline`

## Execution Flow

1. **Parse**: Resolve target path, detect documentation type and existing docs
2. **Analyze**: Read target code to extract:
   - Public API surface (exports, types, interfaces)
   - Function signatures and parameters
   - Usage patterns from tests and examples
   - Dependencies and prerequisites
3. **Cross-Reference**: Check existing documentation for:
   - Outdated references (functions renamed/removed)
   - Missing new features or parameters
   - Broken code examples
4. **Delegate**: Route to Task(doc-updater) with extracted context:
   - Type-specific template selection
   - Audience-appropriate language level
   - Code example generation from test files
5. **Generate**: Write documentation following project conventions:
   - README: Project overview, setup, usage, API reference
   - API: Endpoint/function documentation with examples
   - Guide: Step-by-step tutorials with context
   - Changelog: Grouped by version, categorized changes
   - Inline: JSDoc/TSDoc/docstring comments
6. **Validate**: Verify generated docs are accurate:
   - Code examples compile/parse correctly
   - Referenced files and functions exist
   - Links are valid
7. **Report**: Output documentation summary

## Documentation Standards

- Code examples must be tested or extracted from working tests
- API docs must include parameter types, return types, and error cases
- Every public function/class must have a description
- No placeholder text (e.g., "TODO: add description")

## Output Format

```
DOCUMENTATION GENERATED
=======================
Target:    [path]
Type:      [readme|api|guide|changelog|inline]
Audience:  [developer|user|contributor]

FILES
-----
- [file path] ([created|updated])
  Sections: [list of documentation sections]

COVERAGE
--------
Public APIs Documented: [n/total]
Code Examples Included: [n]
Cross-references Valid: [YES|NO]
```
