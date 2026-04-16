#!/usr/bin/env node
/**
 * Advisory migration: rules/*.md -> rules/csv/_draft_<name>.csv
 *
 * Part of Workstream D (WS-D.1). Heuristically extracts rule-like lines
 * from markdown files and emits DRAFT CSVs for human review. Never modifies
 * or deletes the source .md files. The underscore prefix on the output
 * filename ensures `loadAllRules()` ignores them until a human promotes.
 *
 * Usage:
 *   node plugins/artibot/scripts/migrate-rules-to-csv.js
 *
 * Always exits 0 — this is an advisory tool, not an enforcement gate.
 *
 * @module scripts/migrate-rules-to-csv
 */

import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteSync } from './utils/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLUGIN_ROOT = path.resolve(__dirname, '..');
const RULES_DIR = path.join(PLUGIN_ROOT, 'rules');
const OUT_DIR = path.join(RULES_DIR, 'csv');

const HEADER = 'domain,rule_id,severity,context,description,rationale';

/**
 * Escape a field for CSV output. Quotes the field when it contains a
 * comma, quote, or newline; doubles internal quotes per RFC 4180.
 * @param {string} value
 * @returns {string}
 */
function csvField(value) {
  const s = String(value ?? '');
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * Derive a short slug from a header or sentence for use as rule_id.
 * @param {string} text
 * @returns {string}
 */
function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 40) || 'rule';
}

/**
 * Extract rule records from a single markdown file.
 * Headers (`## name`) become context; bullet lines under them become rules.
 * @param {string} domain - Domain name (derived from filename).
 * @param {string} md - Raw markdown text.
 * @returns {Array<{domain:string,rule_id:string,severity:string,context:string,description:string,rationale:string}>}
 */
function extractRules(domain, md) {
  const rules = [];
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  let currentContext = 'general';
  let counter = 0;
  for (const raw of lines) {
    const line = raw.trimEnd();
    const header = line.match(/^#{2,6}\s+(.+)$/);
    if (header) {
      currentContext = header[1].trim();
      continue;
    }
    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    if (!bullet) continue;
    const description = bullet[1].trim();
    if (!description) continue;
    counter += 1;
    const ruleId = `${slugify(currentContext)}-${counter}`;
    rules.push({
      domain,
      rule_id: ruleId,
      severity: 'warn',
      context: currentContext,
      description,
      rationale: '',
    });
  }
  return rules;
}

/**
 * Serialize rule records into a CSV string with the standard header.
 * @param {Array<Record<string,string>>} rules
 * @returns {string}
 */
function toCsv(rules) {
  const body = rules
    .map((r) => [r.domain, r.rule_id, r.severity, r.context, r.description, r.rationale].map(csvField).join(','))
    .join('\n');
  return `${HEADER}\n${body}\n`;
}

/**
 * Write a single example draft CSV when no source rules exist.
 * Ensures the loader interface is exercised even on a blank repo.
 * @returns {{ mdFile: string, domain: string, count: number }}
 */
function writeExampleDraft() {
  const example = [
    {
      domain: 'example',
      rule_id: 'example-1',
      severity: 'info',
      context: 'general',
      description: 'This is a placeholder rule so the loader has something to exercise',
      rationale: 'Populated by migrate-rules-to-csv.js when rules/ was empty',
    },
  ];
  const outFile = path.join(OUT_DIR, '_draft_example.csv');
  atomicWriteSync(outFile, toCsv(example));
  return { mdFile: '(none)', domain: 'example', count: 1 };
}

/**
 * Main entry: scan rules/, emit draft CSVs, print summary table.
 */
function main() {
  if (!existsSync(OUT_DIR)) {
    mkdirSync(OUT_DIR, { recursive: true });
  }
  const summary = [];
  let mdFiles = [];
  if (existsSync(RULES_DIR)) {
    mdFiles = readdirSync(RULES_DIR)
      .filter((name) => name.endsWith('.md'))
      .map((name) => path.join(RULES_DIR, name));
  } else {
    process.stderr.write(`[migrate-rules] rules/ does not exist at ${RULES_DIR}\n`);
  }

  if (mdFiles.length === 0) {
    process.stderr.write('[migrate-rules] no .md rule files found; writing example draft\n');
    summary.push(writeExampleDraft());
  } else {
    for (const mdPath of mdFiles) {
      const basename = path.basename(mdPath, '.md');
      const domain = basename.replace(/-patterns$/, '').replace(/-/g, '_');
      const md = readFileSync(mdPath, 'utf-8');
      const rules = extractRules(domain, md);
      const outFile = path.join(OUT_DIR, `_draft_${basename}.csv`);
      atomicWriteSync(outFile, toCsv(rules));
      summary.push({ mdFile: path.basename(mdPath), domain, count: rules.length });
    }
  }

  process.stdout.write('\n| md file | domain | rules extracted |\n');
  process.stdout.write('|---|---|---|\n');
  for (const row of summary) {
    process.stdout.write(`| ${row.mdFile} | ${row.domain} | ${row.count} |\n`);
  }
  process.exit(0);
}

main();
