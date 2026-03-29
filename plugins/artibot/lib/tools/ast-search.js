/**
 * AST-aware code search and replace via ast-grep CLI.
 * Falls back to regex search when ast-grep is not installed.
 *
 * @module lib/tools/ast-search
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { stat } from 'node:fs/promises';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Helpers (pure, no side effects)
// ---------------------------------------------------------------------------

/**
 * Parse ast-grep JSON output into normalized match objects.
 *
 * @param {string} jsonOutput - Raw JSON string from ast-grep --json
 * @returns {Array<{file: string, line: number, column: number, matchedCode: string, metaVariables: object}>}
 */
function parseAstGrepOutput(jsonOutput) {
  if (!jsonOutput || jsonOutput.trim().length === 0) {
    return [];
  }

  const raw = JSON.parse(jsonOutput);
  if (!Array.isArray(raw)) return [];

  return raw.map((match) => ({
    file: match.file || '',
    line: match.range?.start?.line ?? 0,
    column: match.range?.start?.column ?? 0,
    matchedCode: match.text || '',
    metaVariables: match.metaVariables || {},
  }));
}

/**
 * Escape special regex characters in a string.
 *
 * @param {string} str
 * @returns {string}
 */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a regex pattern from an ast-grep-style pattern by replacing
 * meta-variables ($NAME) with capture groups.
 *
 * @param {string} pattern - ast-grep pattern with $VAR placeholders
 * @returns {RegExp}
 */
function patternToRegex(pattern) {
  const parts = pattern.split(/(\$[A-Z_][A-Z0-9_]*)/);
  const regexParts = parts.map((part) => {
    if (/^\$[A-Z_][A-Z0-9_]*$/.test(part)) {
      return '(.+?)';
    }
    return escapeRegex(part);
  });
  return new RegExp(regexParts.join(''), 'g');
}

// ---------------------------------------------------------------------------
// Regex fallback search
// ---------------------------------------------------------------------------

/**
 * Search files with regex when ast-grep is not available.
 *
 * @param {string} pattern - ast-grep-style pattern
 * @param {string} targetPath - File or directory to search
 * @returns {Promise<Array<{file: string, line: number, column: number, matchedCode: string, metaVariables: object}>>}
 */
async function regexFallbackSearch(pattern, targetPath) {
  const absPath = resolve(targetPath);
  const fileStat = await stat(absPath);

  const files = fileStat.isDirectory()
    ? await collectFiles(absPath)
    : [absPath];

  const regex = patternToRegex(pattern);
  const metaVarNames = extractMetaVarNames(pattern);
  const results = [];

  for (const filePath of files) {
    const content = await readFile(filePath, 'utf-8');
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      regex.lastIndex = 0;
      let match;
      while ((match = regex.exec(lines[i])) !== null) {
        const metaVariables = {};
        for (let j = 0; j < metaVarNames.length; j++) {
          metaVariables[metaVarNames[j]] = match[j + 1] || '';
        }
        results.push({
          file: filePath,
          line: i + 1,
          column: match.index + 1,
          matchedCode: match[0],
          metaVariables,
        });
      }
    }
  }

  return results;
}

/**
 * Extract meta-variable names from an ast-grep pattern.
 *
 * @param {string} pattern
 * @returns {string[]}
 */
function extractMetaVarNames(pattern) {
  const names = [];
  const re = /\$([A-Z_][A-Z0-9_]*)/g;
  let m;
  while ((m = re.exec(pattern)) !== null) {
    names.push(`$${m[1]}`);
  }
  return names;
}

/**
 * Recursively collect .js/.ts/.jsx/.tsx files from a directory.
 *
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function collectFiles(dir) {
  const { readdir } = await import('node:fs/promises');
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const sub = await collectFiles(full);
      files.push(...sub);
    } else if (/\.(js|ts|jsx|tsx|py|go|rs|java|c|cpp|rb)$/.test(entry.name)) {
      files.push(full);
    }
  }

  return files;
}

// ---------------------------------------------------------------------------
// AstSearch class
// ---------------------------------------------------------------------------

/**
 * AST-aware code search and replace using ast-grep.
 *
 * When ast-grep CLI is installed, uses structural pattern matching.
 * Falls back to regex-based search when ast-grep is unavailable.
 * Structural replace requires ast-grep (no regex fallback).
 */
export class AstSearch {
  /** @type {boolean|null} Cached availability check result */
  #available = null;

  /** @type {string} Path to ast-grep binary */
  #binaryPath;

  /**
   * @param {object} [options]
   * @param {string} [options.binaryPath='sg'] - Path to ast-grep binary
   */
  constructor(options = {}) {
    this.#binaryPath = options.binaryPath || 'sg';
  }

  /**
   * Check if ast-grep CLI is installed and available.
   *
   * @returns {Promise<boolean>}
   */
  async isAvailable() {
    if (this.#available !== null) return this.#available;

    try {
      await execFileAsync(this.#binaryPath, ['--version']);
      this.#available = true;
    } catch {
      this.#available = false;
    }

    return this.#available;
  }

  /**
   * Get languages supported by ast-grep.
   *
   * @returns {string[]}
   */
  getSupportedLanguages() {
    return [
      'javascript',
      'typescript',
      'tsx',
      'jsx',
      'python',
      'go',
      'rust',
      'java',
      'c',
      'cpp',
      'ruby',
      'kotlin',
      'swift',
      'css',
      'html',
    ];
  }

  /**
   * Search for AST pattern matches in a file or directory.
   *
   * When ast-grep is available, uses structural pattern matching.
   * Falls back to regex-based search with a warning.
   *
   * @param {string} pattern - ast-grep meta-variable pattern (e.g. `console.log($MSG)`)
   * @param {string} targetPath - File or directory to search
   * @param {string} [language] - Language hint (e.g. 'javascript')
   * @returns {Promise<{results: Array<{file: string, line: number, column: number, matchedCode: string, metaVariables: object}>, fallback: boolean}>}
   */
  async search(pattern, targetPath, language) {
    if (typeof pattern !== 'string' || pattern.length === 0) {
      throw new Error('Pattern must be a non-empty string');
    }
    if (typeof targetPath !== 'string' || targetPath.length === 0) {
      throw new Error('Target path must be a non-empty string');
    }

    const available = await this.isAvailable();

    if (!available) {
      const results = await regexFallbackSearch(pattern, targetPath);
      return {
        results,
        fallback: true,
      };
    }

    return this.#searchWithAstGrep(pattern, targetPath, language);
  }

  /**
   * Replace AST pattern matches in a file or directory.
   * Runs in dry-run mode by default.
   *
   * @param {string} pattern - ast-grep pattern to match
   * @param {string} replacement - Replacement with meta-variable refs (e.g. `logger.info($MSG)`)
   * @param {string} targetPath - File or directory
   * @param {string} [language] - Language hint
   * @param {object} [options]
   * @param {boolean} [options.dryRun=true] - Preview changes without writing
   * @returns {Promise<{filesChanged: number, replacements: Array<{file: string, line: number, original: string, replaced: string}>}>}
   */
  async replace(pattern, replacement, targetPath, language, options = {}) {
    if (typeof pattern !== 'string' || pattern.length === 0) {
      throw new Error('Pattern must be a non-empty string');
    }
    if (typeof replacement !== 'string') {
      throw new Error('Replacement must be a string');
    }
    if (typeof targetPath !== 'string' || targetPath.length === 0) {
      throw new Error('Target path must be a non-empty string');
    }

    const available = await this.isAvailable();

    if (!available) {
      throw new Error(
        'ast-grep is required for structural replace. Install with: npm i -g @ast-grep/cli'
      );
    }

    const dryRun = options.dryRun !== false;

    return this.#replaceWithAstGrep(
      pattern,
      replacement,
      targetPath,
      language,
      dryRun,
    );
  }

  /**
   * Run ast-grep search.
   *
   * @param {string} pattern
   * @param {string} targetPath
   * @param {string} [language]
   * @returns {Promise<{results: Array, fallback: boolean}>}
   */
  async #searchWithAstGrep(pattern, targetPath, language) {
    const args = ['run', '--pattern', pattern, '--json', targetPath];

    if (language) {
      args.splice(1, 0, '--lang', language);
    }

    try {
      const { stdout } = await execFileAsync(this.#binaryPath, args);
      const results = parseAstGrepOutput(stdout);
      return { results, fallback: false };
    } catch (err) {
      if (err.stdout) {
        const results = parseAstGrepOutput(err.stdout);
        return { results, fallback: false };
      }
      throw new Error(`ast-grep search failed: ${err.message}`);
    }
  }

  /**
   * Run ast-grep replace.
   *
   * @param {string} pattern
   * @param {string} replacement
   * @param {string} targetPath
   * @param {string} [language]
   * @param {boolean} dryRun
   * @returns {Promise<{filesChanged: number, replacements: Array}>}
   */
  async #replaceWithAstGrep(pattern, replacement, targetPath, language, dryRun) {
    const args = [
      'run',
      '--pattern',
      pattern,
      '--rewrite',
      replacement,
      '--json',
    ];

    if (language) {
      args.push('--lang', language);
    }

    if (!dryRun) {
      args.push('--update-all');
    }

    args.push(targetPath);

    try {
      const { stdout } = await execFileAsync(this.#binaryPath, args);
      const matches = parseAstGrepOutput(stdout);

      const fileSet = new Set(matches.map((m) => m.file));
      return {
        filesChanged: fileSet.size,
        replacements: matches.map((m) => ({
          file: m.file,
          line: m.line,
          original: m.matchedCode,
          replaced: replacement,
        })),
      };
    } catch (err) {
      if (err.stdout) {
        const matches = parseAstGrepOutput(err.stdout);
        const fileSet = new Set(matches.map((m) => m.file));
        return {
          filesChanged: fileSet.size,
          replacements: matches.map((m) => ({
            file: m.file,
            line: m.line,
            original: m.matchedCode,
            replaced: replacement,
          })),
        };
      }
      throw new Error(`ast-grep replace failed: ${err.message}`);
    }
  }
}

// Export helpers for testing
export { parseAstGrepOutput, escapeRegex, patternToRegex, extractMetaVarNames };
