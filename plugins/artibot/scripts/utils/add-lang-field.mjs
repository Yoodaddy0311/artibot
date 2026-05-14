#!/usr/bin/env node
/**
 * Idempotent batch utility: ensure every skills/<name>/SKILL.md has a `lang:`
 * field in its YAML frontmatter. Detection rule:
 *
 *   - description contains a Hangul codepoint  →  lang: [en, ko]
 *   - otherwise                                →  lang: [en]
 *
 * If `lang:` already exists in the frontmatter the file is left untouched.
 * Run from anywhere; resolves the plugin root relative to this file.
 *
 * Usage:
 *   node scripts/utils/add-lang-field.mjs            # apply
 *   node scripts/utils/add-lang-field.mjs --dry-run  # report only
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(__dirname, '..', '..');
const SKILLS_DIR = join(PLUGIN_ROOT, 'skills');

const HANGUL_RE = /[ᄀ-ᇿ㄰-㆏가-힯]/;
const dryRun = process.argv.includes('--dry-run');

function listSkillDirs() {
  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(SKILLS_DIR, e.name))
    .filter((p) => {
      try { return statSync(join(p, 'SKILL.md')).isFile(); } catch { return false; }
    });
}

function splitFrontmatter(content) {
  const m = content.match(/^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n?)([\s\S]*)$/);
  if (!m) return null;
  return { open: m[1], body: m[2], close: m[3], rest: m[4], eol: m[1].endsWith('\r\n') ? '\r\n' : '\n' };
}

function frontmatterHasLang(fmBody) {
  return /^lang\s*:/m.test(fmBody);
}

/**
 * Locate the `description:` field in frontmatter body and return its full text
 * range plus the description value content. Handles two YAML shapes:
 *
 *   1) Single-line scalar: `description: "..."` or `description: ...`
 *   2) Block scalar:        `description: |` followed by indented lines
 *
 * Returns null when no description field is present.
 * @param {string} fmBody
 * @returns {{ endIndex: number, content: string } | null}
 *   endIndex = byte index in fmBody just past the description block; insertion
 *   point for the new `lang:` line. content = description text used for
 *   Hangul detection.
 */
/**
 * For a line index, return the byte offset of the START of its line terminator
 * (\r in CRLF files, \n in LF files). Insertion at this index keeps the
 * original terminator intact in the `after` slice.
 */
function lineTerminatorOffset(rawLines, lineIdx, lineStartChar) {
  const raw = rawLines[lineIdx];
  const crlf = raw.endsWith('\r');
  // raw.length already includes the trailing \r when present.
  return lineStartChar + raw.length - (crlf ? 1 : 0);
}

function gatherBlockScalar(lines, rawLines, startLineIdx, startCharIdx) {
  // Block continues while line is indented (space/tab) or blank.
  const contentLines = [];
  let lastInBlock = startLineIdx;
  let charCursor = startCharIdx + rawLines[startLineIdx].length + 1;
  for (let j = startLineIdx + 1; j < lines.length; j++) {
    const next = lines[j];
    if (!/^(\s+|$)/.test(next)) break;
    contentLines.push(next);
    lastInBlock = j;
    charCursor += rawLines[j].length + 1;
  }
  // charCursor points to the start of the line AFTER the block.
  // Back up past that line's preceding \n and (if CRLF) the \r,
  // by reusing lineTerminatorOffset against the last in-block line.
  const lineStart = charCursor - rawLines[lastInBlock].length - 1;
  const endIndex = lineTerminatorOffset(rawLines, lastInBlock, lineStart);
  return { endIndex, content: contentLines.join('\n') };
}

function locateDescription(fmBody) {
  // Split on \n but strip trailing \r per line (frontmatter may be CRLF on Windows).
  const rawLines = fmBody.split('\n');
  const lines = rawLines.map((l) => l.replace(/\r$/, ''));
  let charIdx = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const rawLineLen = rawLines[i].length + 1; // +1 for the '\n' join (preserves \r byte)
    const m = line.match(/^description\s*:\s*(.*)$/);
    if (!m) {
      charIdx += rawLineLen;
      continue;
    }
    const after = m[1].trim();
    // Block scalar: `description: |` / `description: |-` / `description: >`
    if (/^[|>][-+]?\s*$/.test(after)) {
      return gatherBlockScalar(lines, rawLines, i, charIdx);
    }
    // Single-line scalar — strip surrounding quotes for Hangul scan.
    let v = after;
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    return { endIndex: lineTerminatorOffset(rawLines, i, charIdx), content: v };
  }
  return null;
}

function decideLang(description) {
  return HANGUL_RE.test(description) ? ['en', 'ko'] : ['en'];
}

function insertLangField(fm, langArr, eol) {
  const langLine = `lang: [${langArr.join(', ')}]`;
  const loc = locateDescription(fm.body);
  if (loc) {
    const before = fm.body.slice(0, loc.endIndex);
    const after = fm.body.slice(loc.endIndex);
    return { fm: { ...fm, body: `${before}${eol}${langLine}${after}` }, content: loc.content };
  }
  // Fallback: append at end of frontmatter body
  const trailingEol = fm.body.endsWith('\n') ? '' : eol;
  return { fm: { ...fm, body: `${fm.body}${trailingEol}${langLine}` }, content: '' };
}

function processFile(filePath) {
  const original = readFileSync(filePath, 'utf-8');
  const fm = splitFrontmatter(original);
  if (!fm) return { filePath, status: 'no-frontmatter' };
  if (frontmatterHasLang(fm.body)) return { filePath, status: 'skip-has-lang' };

  const loc = locateDescription(fm.body);
  const description = loc?.content ?? '';
  const langArr = decideLang(description);
  const { fm: nextFm } = insertLangField(fm, langArr, fm.eol);
  const out = `${nextFm.open}${nextFm.body}${nextFm.close}${nextFm.rest}`;

  if (!dryRun) writeFileSync(filePath, out, 'utf-8');
  return { filePath, status: dryRun ? 'would-update' : 'updated', lang: langArr };
}

function main() {
  const dirs = listSkillDirs();
  const results = dirs.map((d) => processFile(join(d, 'SKILL.md')));
  const counts = results.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});
  const en = results.filter((r) => r.lang && r.lang.length === 1).length;
  const enKo = results.filter((r) => r.lang && r.lang.length === 2).length;

  console.log(`add-lang-field${dryRun ? ' (dry-run)' : ''}: scanned ${results.length} skills`);
  for (const [k, v] of Object.entries(counts)) console.log(`  ${k}: ${v}`);
  if (en || enKo) console.log(`  lang distribution → en: ${en}, en+ko: ${enKo}`);

  const noFm = results.filter((r) => r.status === 'no-frontmatter');
  if (noFm.length > 0) {
    console.log('\nWARN: files with no frontmatter:');
    for (const r of noFm) console.log(`  - ${r.filePath}`);
    process.exit(1);
  }
}

main();
