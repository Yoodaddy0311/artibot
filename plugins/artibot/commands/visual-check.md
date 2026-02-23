---
description: Visual regression testing via SSIM screenshot comparison with CSS fix suggestions
argument-hint: '[url] e.g. "https://example.com --baseline ./baselines/home.png"'
allowed-tools: [Read, Write, Bash, Glob, Task, TodoWrite]
---

# /visual-check

Compare a live URL or component screenshot against a stored baseline using SSIM-based pixel comparison. Generates CSS fix suggestions when differences are detected.

## Arguments

Parse $ARGUMENTS:
- `url`: Target URL to validate (required unless `--baseline-only`)
- `--baseline <path>`: Path to baseline image file (PNG/JPEG). If absent, capture and save a new baseline.
- `--threshold <0-1>`: Similarity threshold to pass (default: `0.95`)
- `--iterations <n>`: Max fix-attempt iterations (default: `3`)
- `--selector <css>`: CSS selector to scope screenshot (default: full page)
- `--exclude <css-list>`: Comma-separated selectors to hide before capture

## Execution Flow

1. **Parse Arguments**: Extract URL, baseline path, threshold, selector, exclude list
2. **Baseline Check**:
   - If `--baseline` path exists → load baseline image
   - If path missing → run `createBaseline()` to get Playwright capture instructions, save result as new baseline, and exit with success
3. **Capture Actual Screenshot**:
   - Call `validateComponent()` from `lib/visual/visual-validator.js` to get Playwright MCP instructions
   - Dispatch `playwright_navigate` → `playwright_evaluate` (disable animations) → optional hide selectors → `playwright_screenshot`
4. **Compare**:
   - Feed baseline + actual pixel data to `compareScreenshots()` from `lib/visual/screenshot-differ.js`
   - Calculate SSIM similarity score
5. **Analyze Failures** (if similarity < threshold):
   - Call `analyzeDiffRegions()` from `lib/visual/style-fixer.js`
   - Call `generateFixTasks()` to produce prioritized task list
6. **Iterate** (up to `--iterations`):
   - If agent applies CSS fixes between iterations, re-capture and re-compare
   - Stop at first pass or max iterations
7. **Report**: Output structured results

## Output Format

```
VISUAL VALIDATION REPORT
=========================
URL:        [url]
Selector:   [css selector or "full page"]
Baseline:   [path]
Threshold:  [0.95]
Iterations: [n / max]
Result:     [PASS ✅ | FAIL ❌]

SIMILARITY
----------
Score:      [0.00 - 1.00]
Threshold:  [0.95]
Status:     [PASS | FAIL]

DIFF REGIONS (if FAIL)
----------------------
[n] region(s) detected:
  1. [severity] at ([x],[y]) — [w]×[h]px  ([pixelCount] pixels)
  2. ...

FIX SUGGESTIONS (if FAIL)
--------------------------
Priority 1 [HIGH]:
  Selector:    [css]
  Category:    [spacing|color|typography|alignment|size|visibility]
  Description: [human-readable explanation]
  Region:      ([x],[y]) [w]×[h]px

Priority 2 [MEDIUM]:
  ...

NEXT STEPS (if FAIL)
--------------------
1. Review fix suggestions above
2. Apply CSS changes to the component
3. Re-run: /visual-check [url] --baseline [path]
```

## Examples

```bash
# Validate full page against stored baseline
/visual-check https://example.com --baseline ./baselines/home.png

# Validate component with strict threshold
/visual-check https://example.com/docs --selector ".sidebar-nav" --threshold 0.98

# Capture new baseline (first run)
/visual-check https://example.com --baseline ./baselines/home.png

# Validate dynamic page with lower threshold, excluding ads
/visual-check https://example.com/news --baseline ./baselines/news.png --threshold 0.85 --exclude ".ad-unit, #cookie-banner"

# Run with retry iterations for flaky renders
/visual-check https://example.com --baseline ./baselines/home.png --iterations 3
```
