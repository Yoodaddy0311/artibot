/**
 * CSV-as-Config rules loader (zero-dep).
 *
 * Part of Workstream D (WS-D.1): consolidates scattered markdown rules
 * into per-domain CSV files for deterministic loading and diffability.
 *
 * The CSV schema is:
 *   domain,rule_id,severity,context,description,rationale
 *
 * A hand-rolled parser is used deliberately — Artibot forbids new runtime
 * npm deps (see package.json policy). The parser supports:
 *   - Quoted fields that may contain commas or escaped quotes ("")
 *   - CRLF and LF line endings
 *   - Empty rows silently skipped
 *   - Malformed rows logged to stderr and skipped (never thrown)
 *
 * @module lib/core/rules-csv-loader
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * @typedef {Object} Rule
 * @property {string} domain
 * @property {string} rule_id
 * @property {string} severity
 * @property {string} context
 * @property {string} description
 * @property {string} rationale
 */

const EXPECTED_COLUMNS = ['domain', 'rule_id', 'severity', 'context', 'description', 'rationale'];

/**
 * Tokenize a single CSV text block into an array of row arrays.
 * Honors RFC 4180-ish quoting rules: fields wrapped in double quotes may
 * contain commas and escaped quotes (`""` -> `"`).
 *
 * @param {string} text - Raw CSV text.
 * @returns {string[][]} Rows as arrays of string fields.
 */
function tokenize(text) {
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  const src = String(text).replace(/\r\n/g, '\n');

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  // Flush trailing field/row if any pending content exists.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * Parse a CSV string into an array of record objects keyed by header name.
 * Unknown columns are preserved; missing expected columns cause the row to
 * be skipped with a stderr warning.
 *
 * @param {string} text - Raw CSV text (with header row).
 * @returns {Array<Record<string,string>>} Parsed record rows.
 */
export function parseCsv(text) {
  const rows = tokenize(text).filter((r) => !(r.length === 1 && r[0] === ''));
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim());
  const records = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (row.length === 1 && row[0].trim() === '') continue;
    if (row.length !== header.length) {
      process.stderr.write(
        `[rules-csv-loader] skipping malformed row ${i + 1}: expected ${header.length} cols, got ${row.length}\n`
      );
      continue;
    }
    const record = {};
    for (let c = 0; c < header.length; c++) {
      record[header[c]] = row[c];
    }
    records.push(record);
  }
  return records;
}

/**
 * Validate that a parsed record has all expected rule columns.
 * @param {Record<string,string>} record
 * @returns {boolean}
 */
function hasRuleShape(record) {
  return EXPECTED_COLUMNS.every((col) => Object.prototype.hasOwnProperty.call(record, col));
}

/**
 * Load a single rules CSV file from disk and normalize each row into a Rule.
 * Rows missing any expected column are skipped with a stderr warning.
 *
 * @param {string} filePath - Absolute path to a .csv file.
 * @returns {Promise<Rule[]>}
 */
export async function loadRulesCsv(filePath) {
  let text;
  try {
    text = await readFile(filePath, 'utf-8');
  } catch (err) {
    process.stderr.write(`[rules-csv-loader] failed to read ${filePath}: ${err.message}\n`);
    return [];
  }
  const records = parseCsv(text);
  const rules = [];
  for (const record of records) {
    if (!hasRuleShape(record)) {
      process.stderr.write(
        `[rules-csv-loader] skipping row missing required columns in ${path.basename(filePath)}\n`
      );
      continue;
    }
    rules.push({
      domain: record.domain,
      rule_id: record.rule_id,
      severity: record.severity,
      context: record.context,
      description: record.description,
      rationale: record.rationale,
    });
  }
  return rules;
}

/**
 * Load every `.csv` file in a directory and merge their rules into one array.
 * Files whose basename starts with `_` (e.g., `_draft_*.csv`) are skipped —
 * the underscore prefix marks drafts that should not be loaded by default.
 *
 * @param {string} dirPath - Absolute path to a directory containing .csv files.
 * @returns {Promise<Rule[]>}
 */
export async function loadAllRules(dirPath) {
  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch (err) {
    process.stderr.write(`[rules-csv-loader] failed to list ${dirPath}: ${err.message}\n`);
    return [];
  }
  const merged = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.csv')) continue;
    if (entry.name.startsWith('_')) continue;
    const rules = await loadRulesCsv(path.join(dirPath, entry.name));
    merged.push(...rules);
  }
  return merged;
}
