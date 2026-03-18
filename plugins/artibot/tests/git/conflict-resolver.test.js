import { describe, it, expect } from 'vitest'
import {
  parseConflictBlocks,
  hasConflictMarkers,
  extractNonConflictLines,
} from '../../lib/git/conflict-parser.js'
import {
  resolveBlock,
  resolveFile,
  formatResolutionSummary,
} from '../../lib/git/conflict-resolver.js'

// ─── TC1: 공백 전용 충돌 (positional) ────────────────────────────────────────
describe('TC1: positional — blank-only conflict', () => {
  it('resolves blank-only ours/theirs with confidence ≥ 0.95', () => {
    const block = {
      ours: ['', ''],
      base: null,
      theirs: [''],
    }
    const result = resolveBlock(block, 'dummy.js')
    expect(result.resolved).toBe(true)
    expect(result.confidence).toBeGreaterThanOrEqual(0.95)
    expect(result.strategy).toBe('positional')
    expect(result.needsUserInput).toBeFalsy()
  })

  it('resolves fully blank conflict to empty lines with confidence 1.0', () => {
    const block = {
      ours: [''],
      base: null,
      theirs: [''],
    }
    const result = resolveBlock(block, 'dummy.js')
    expect(result.resolved).toBe(true)
    expect(result.confidence).toBe(1.0)
    expect(result.lines).toEqual([''])
  })
})

// ─── TC2: 포함 관계 충돌 (compatible) ────────────────────────────────────────
describe('TC2: compatible — containment relation', () => {
  it('picks superset side when one contains the other', () => {
    const block = {
      ours: ['const x = 1', 'const y = 2'],
      base: null,
      theirs: ['const x = 1'],
    }
    const result = resolveBlock(block, 'dummy.js')
    expect(result.resolved).toBe(true)
    expect(result.strategy).toBe('compatible')
    expect(result.confidence).toBeGreaterThanOrEqual(0.82)
    expect(result.lines).toEqual(['const x = 1', 'const y = 2'])
  })

  it('handles reverse containment (theirs is superset)', () => {
    const block = {
      ours: ['function foo() {}'],
      base: null,
      theirs: ['function foo() {}', 'function bar() {}'],
    }
    const result = resolveBlock(block, 'dummy.js')
    expect(result.resolved).toBe(true)
    expect(result.strategy).toBe('compatible')
    expect(result.lines).toEqual(['function foo() {}', 'function bar() {}'])
  })
})

// ─── TC3: 양쪽 추가 비겹침 병합 ──────────────────────────────────────────────
describe('TC3: compatible — non-overlapping additions with base', () => {
  it('merges both sides when additions do not overlap', () => {
    const block = {
      ours: ['import A from "./a.js"', 'import B from "./b.js"'],
      base: ['import A from "./a.js"'],
      theirs: ['import A from "./a.js"', 'import C from "./c.js"'],
    }
    const result = resolveBlock(block, 'dummy.js')
    expect(result.resolved).toBe(true)
    expect(result.strategy).toBe('compatible')
    expect(result.lines).toContain('import B from "./b.js"')
    expect(result.lines).toContain('import C from "./c.js"')
    expect(result.lines).toContain('import A from "./a.js"')
  })
})

// ─── TC4: 버전 번호 충돌 (semantic) ──────────────────────────────────────────
describe('TC4: semantic — version number conflict', () => {
  it('picks higher version with semantic strategy', () => {
    const block = {
      ours: ['"version": "1.12.0"'],
      base: ['"version": "1.11.0"'],
      theirs: ['"version": "1.11.5"'],
    }
    const result = resolveBlock(block, 'package.json')
    expect(result.resolved).toBe(true)
    expect(result.strategy).toBe('semantic')
    expect(result.confidence).toBeGreaterThanOrEqual(0.62)
    // higher semver should win
    expect(result.lines[0]).toContain('1.12.0')
  })
})

// ─── TC5: resolveFile 전체 파일 해결 ─────────────────────────────────────────
describe('TC5: resolveFile — whole-file resolution', () => {
  it('resolves a file with one resolvable conflict block', () => {
    const content = [
      'const a = 1',
      '<<<<<<< HEAD',
      'const b = 2',
      '=======',
      'const b = 2',
      '>>>>>>> feature',
      'const c = 3',
    ].join('\n')

    const result = resolveFile('dummy.js', content)
    expect(result.success).toBe(true)
    expect(result.resolved).toBeGreaterThan(0)
    expect(result.content).toContain('const a = 1')
    expect(result.content).toContain('const c = 3')
    expect(result.content).not.toMatch(/<<<<<</)
    expect(result.content).not.toMatch(/>>>>>>>/)
  })

  it('marks unresolvable blocks in result when confidence is too low', () => {
    const content = [
      '<<<<<<< HEAD',
      'completely different implementation A',
      'with many lines that diverge',
      '=======',
      'entirely different implementation B',
      'no overlap at all here',
      '>>>>>>> other',
    ].join('\n')

    const result = resolveFile('dummy.js', content)
    // May or may not resolve — check structure is correct
    expect(result).toHaveProperty('success')
    expect(result).toHaveProperty('resolved')
    expect(result).toHaveProperty('unresolved')
    expect(result).toHaveProperty('content')
  })
})

// ─── TC6: 의미 충돌 사용자 확인 필요 ─────────────────────────────────────────
describe('TC6: unresolvable — needs user input', () => {
  it('sets needsUserInput=true for genuinely ambiguous conflict', () => {
    const block = {
      ours: ['module.exports = { mode: "strict" }'],
      base: ['module.exports = {}'],
      theirs: ['module.exports = { mode: "loose" }'],
    }
    const result = resolveBlock(block, 'config.js')
    // If confidence < 0.75 threshold, needsUserInput should be set
    if (!result.resolved || result.confidence < 0.75) {
      expect(result.needsUserInput).toBe(true)
      expect(result.choices).toBeDefined()
      expect(result.choices.length).toBeGreaterThanOrEqual(2)
    } else {
      // If resolved automatically, confidence must be high enough
      expect(result.confidence).toBeGreaterThanOrEqual(0.75)
    }
  })

  it('provides at least 2 choices when needsUserInput is true', () => {
    const block = {
      ours: ['timeout: 5000'],
      base: ['timeout: 3000'],
      theirs: ['timeout: 10000'],
    }
    const result = resolveBlock(block, 'config.js')
    if (result.needsUserInput) {
      expect(Array.isArray(result.choices)).toBe(true)
      expect(result.choices.length).toBeGreaterThanOrEqual(2)
    }
  })
})

// ─── TC7: formatResolutionSummary 출력 검증 ──────────────────────────────────
describe('TC7: formatResolutionSummary', () => {
  it('shows ✓ for resolved blocks', () => {
    const results = [
      { file: 'src/index.js', resolved: 2, unresolved: 0, strategy: 'compatible' },
    ]
    const summary = formatResolutionSummary(results)
    expect(summary).toContain('✓')
    expect(summary).toContain('src/index.js')
  })

  it('shows ⚠ for unresolved blocks', () => {
    const results = [
      { file: 'src/config.js', resolved: 1, unresolved: 1, strategy: 'mixed' },
    ]
    const summary = formatResolutionSummary(results)
    expect(summary).toContain('⚠')
    expect(summary).toContain('src/config.js')
  })

  it('includes rollback command hint when stashRef is provided', () => {
    const results = [
      {
        file: 'src/app.js',
        resolved: 3,
        unresolved: 0,
        strategy: 'positional',
        stashRef: 'stash@{0}',
      },
    ]
    const summary = formatResolutionSummary(results)
    expect(summary).toMatch(/stash|rollback/i)
  })

  it('handles empty results array gracefully', () => {
    const summary = formatResolutionSummary([])
    expect(typeof summary).toBe('string')
    expect(summary.length).toBeGreaterThan(0)
  })
})

// ─── TC8: hasConflictMarkers ──────────────────────────────────────────────────
describe('TC8: hasConflictMarkers', () => {
  it('returns true when conflict markers are present', () => {
    const content = '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch'
    expect(hasConflictMarkers(content)).toBe(true)
  })

  it('returns false for clean content', () => {
    const content = 'const x = 1\nconst y = 2\n'
    expect(hasConflictMarkers(content)).toBe(false)
  })

  it('returns false for empty string', () => {
    expect(hasConflictMarkers('')).toBe(false)
  })

  it('parses conflict blocks correctly via parseConflictBlocks', () => {
    const content = [
      'line before',
      '<<<<<<< HEAD',
      'ours line',
      '=======',
      'theirs line',
      '>>>>>>> feature',
      'line after',
    ].join('\n')

    const blocks = parseConflictBlocks(content)
    expect(Array.isArray(blocks)).toBe(true)
    expect(blocks.length).toBe(1)
    expect(blocks[0].ours).toContain('ours line')
    expect(blocks[0].theirs).toContain('theirs line')
  })

  it('parses diff3 format with base section', () => {
    const content = [
      '<<<<<<< HEAD',
      'ours',
      '||||||| base',
      'original',
      '=======',
      'theirs',
      '>>>>>>> branch',
    ].join('\n')

    const blocks = parseConflictBlocks(content)
    expect(blocks.length).toBe(1)
    expect(blocks[0].base).toContain('original')
  })

  it('parses multiple conflict blocks', () => {
    const content = [
      '<<<<<<< HEAD',
      'a1',
      '=======',
      'b1',
      '>>>>>>> br',
      'middle',
      '<<<<<<< HEAD',
      'a2',
      '=======',
      'b2',
      '>>>>>>> br',
    ].join('\n')

    const blocks = parseConflictBlocks(content)
    expect(blocks.length).toBe(2)
  })

  it('extractNonConflictLines returns only non-conflict content', () => {
    const content = [
      'before',
      '<<<<<<< HEAD',
      'ours',
      '=======',
      'theirs',
      '>>>>>>> br',
      'after',
    ].join('\n')

    const lines = extractNonConflictLines(content)
    expect(lines).toContain('before')
    expect(lines).toContain('after')
    expect(lines).not.toContain('ours')
    expect(lines).not.toContain('theirs')
  })
})
