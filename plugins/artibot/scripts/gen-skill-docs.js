/**
 * Artibot SKILL.md Validation Pipeline
 *
 * Reads all skill directories, parses SKILL.md frontmatter,
 * validates required fields, context values, and detects trigger duplicates.
 *
 * Usage: node scripts/gen-skill-docs.js [--fix] [--json]
 *
 * Flags:
 *   --fix   Suggest fixes (does not auto-modify)
 *   --json  Output report as JSON instead of table
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(__dirname, '..');
const SKILLS_DIR = join(PLUGIN_ROOT, 'skills');

// --- Configuration ---

const REQUIRED_FIELDS = ['name', 'description', 'context', 'triggers'];
const RECOMMENDED_FIELDS = ['platforms', 'level', 'category', 'tokens', 'agents'];
const VALID_CONTEXTS = ['fork', 'forked', 'native', 'shared'];
const VALID_PLATFORMS = ['claude-code', 'gemini-cli', 'codex-cli', 'cursor', 'antigravity'];
const VALID_CATEGORIES = [
  'analysis', 'code-quality', 'debugging', 'devops', 'intent',
  'language', 'learning', 'library', 'marketing', 'onboarding',
  'orchestration', 'persona', 'platform', 'quality', 'security',
  'setup', 'testing', 'tooling', 'workflow',
];

// --- Frontmatter Parser ---

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const raw = match[1];
  const fields = {};
  let currentKey = null;
  let currentValue = '';
  let inArray = false;
  let arrayItems = [];

  for (const line of raw.split('\n')) {
    // Array item
    if (inArray && /^\s+-\s+/.test(line)) {
      arrayItems.push(line.replace(/^\s+-\s+/, '').replace(/^["']|["']$/g, ''));
      continue;
    }

    // End of array — flush
    if (inArray && !/^\s+-\s/.test(line) && !/^\s*$/.test(line)) {
      fields[currentKey] = arrayItems;
      inArray = false;
      arrayItems = [];
    }

    // Top-level key
    const keyMatch = line.match(/^([a-z_-]+):\s*(.*)/);
    if (keyMatch) {
      // Flush previous multiline
      if (currentKey && !fields[currentKey]) {
        fields[currentKey] = currentValue.trim();
      }

      const [, key, val] = keyMatch;
      currentKey = key;
      currentValue = '';

      // Inline array: [a, b, c]
      const inlineArr = val.match(/^\[(.*)\]$/);
      if (inlineArr) {
        fields[key] = inlineArr[1]
          .split(',')
          .map(s => s.trim().replace(/^["']|["']$/g, ''));
        currentKey = null;
        continue;
      }

      // Value starts on same line
      const cleaned = val.replace(/^["']|["']$/g, '').replace(/\|$/, '').trim();
      if (cleaned) {
        fields[key] = cleaned;
        currentKey = null;
      } else if (val.trim() === '' || val.trim() === '|') {
        // Might be multiline or array
        currentValue = '';
      }
      continue;
    }

    // Array start
    if (/^\s+-\s+/.test(line) && currentKey) {
      inArray = true;
      arrayItems = [line.replace(/^\s+-\s+/, '').replace(/^["']|["']$/g, '')];
      continue;
    }

    // Multiline continuation
    if (currentKey) {
      currentValue += ' ' + line.trim();
    }
  }

  // Flush last field
  if (inArray && currentKey) {
    fields[currentKey] = arrayItems;
  } else if (currentKey && !fields[currentKey]) {
    fields[currentKey] = currentValue.trim();
  }

  return fields;
}

// --- Validators ---

function validateSkill(skillName, fields) {
  const issues = [];

  // Required fields
  for (const field of REQUIRED_FIELDS) {
    if (!fields[field]) {
      issues.push({ severity: 'error', field, message: `missing required field: ${field}` });
    }
  }

  // Recommended fields
  for (const field of RECOMMENDED_FIELDS) {
    if (!fields[field]) {
      issues.push({ severity: 'warn', field, message: `missing recommended field: ${field}` });
    }
  }

  // Name must match directory
  if (fields.name && fields.name !== skillName) {
    issues.push({
      severity: 'error',
      field: 'name',
      message: `name "${fields.name}" does not match directory "${skillName}"`,
    });
  }

  // Context validation
  if (fields.context && !VALID_CONTEXTS.includes(fields.context)) {
    issues.push({
      severity: 'error',
      field: 'context',
      message: `invalid context "${fields.context}" — expected: ${VALID_CONTEXTS.join(', ')}`,
    });
  }

  // Triggers must be non-empty array
  if (fields.triggers) {
    if (!Array.isArray(fields.triggers) || fields.triggers.length === 0) {
      issues.push({ severity: 'error', field: 'triggers', message: 'triggers must be a non-empty array' });
    }
  }

  // Platforms validation
  if (fields.platforms && Array.isArray(fields.platforms)) {
    for (const p of fields.platforms) {
      if (!VALID_PLATFORMS.includes(p)) {
        issues.push({ severity: 'warn', field: 'platforms', message: `unknown platform: "${p}"` });
      }
    }
  }

  // Category validation
  if (fields.category && !VALID_CATEGORIES.includes(fields.category)) {
    issues.push({
      severity: 'warn',
      field: 'category',
      message: `unknown category "${fields.category}" — consider adding to VALID_CATEGORIES`,
    });
  }

  // Level should be 1-5
  if (fields.level !== undefined) {
    const lvl = Number(fields.level);
    if (Number.isNaN(lvl) || lvl < 1 || lvl > 5) {
      issues.push({ severity: 'warn', field: 'level', message: `level should be 1-5, got "${fields.level}"` });
    }
  }

  return issues;
}

function detectTriggerDuplicates(skillsMap) {
  const triggerIndex = new Map(); // trigger → [skillName, ...]
  const duplicates = [];

  for (const [skillName, fields] of Object.entries(skillsMap)) {
    const triggers = fields.triggers;
    if (!Array.isArray(triggers)) continue;

    for (const trigger of triggers) {
      const normalized = trigger.toLowerCase().trim();
      if (!triggerIndex.has(normalized)) {
        triggerIndex.set(normalized, []);
      }
      triggerIndex.get(normalized).push(skillName);
    }
  }

  for (const [trigger, skills] of triggerIndex) {
    if (skills.length > 1) {
      duplicates.push({ trigger, skills });
    }
  }

  return duplicates.sort((a, b) => b.skills.length - a.skills.length);
}

// --- Report Generation ---

function formatTableReport(results, duplicates) {
  const lines = [];
  const { errors, warnings, compliant, total } = summarize(results);

  lines.push('## SKILL.md Validation Report');
  lines.push('');
  lines.push(`**${total} skills** · **${errors} errors** · **${warnings} warnings** · **${compliant} fully compliant**`);
  lines.push('');

  // Non-compliant skills table
  const nonCompliant = Object.entries(results).filter(([, r]) => r.issues.length > 0);
  if (nonCompliant.length > 0) {
    lines.push('### Issues');
    lines.push('');
    lines.push('| Skill | Severity | Field | Message |');
    lines.push('|-------|----------|-------|---------|');
    for (const [skill, result] of nonCompliant) {
      for (const issue of result.issues) {
        const sev = issue.severity === 'error' ? '**ERROR**' : 'WARN';
        lines.push(`| ${skill} | ${sev} | ${issue.field} | ${issue.message} |`);
      }
    }
    lines.push('');
  }

  // Trigger duplicates
  if (duplicates.length > 0) {
    lines.push('### Trigger Duplicates');
    lines.push('');
    lines.push('| Trigger | Skills | Count |');
    lines.push('|---------|--------|-------|');
    for (const { trigger, skills } of duplicates) {
      lines.push(`| \`${trigger}\` | ${skills.join(', ')} | ${skills.length} |`);
    }
    lines.push('');
  }

  // Category distribution
  const catMap = {};
  for (const [, result] of Object.entries(results)) {
    const cat = result.fields?.category || 'uncategorized';
    catMap[cat] = (catMap[cat] || 0) + 1;
  }
  lines.push('### Category Distribution');
  lines.push('');
  lines.push('| Category | Count |');
  lines.push('|----------|-------|');
  for (const [cat, count] of Object.entries(catMap).sort((a, b) => b[1] - a[1])) {
    lines.push(`| ${cat} | ${count} |`);
  }

  return lines.join('\n');
}

function summarize(results) {
  let errors = 0;
  let warnings = 0;
  let compliant = 0;
  const total = Object.keys(results).length;

  for (const result of Object.values(results)) {
    const errs = result.issues.filter(i => i.severity === 'error').length;
    const warns = result.issues.filter(i => i.severity === 'warn').length;
    errors += errs;
    warnings += warns;
    if (errs === 0 && warns === 0) compliant++;
  }

  return { errors, warnings, compliant, total };
}

// --- Main ---

async function main() {
  const args = process.argv.slice(2);
  const jsonMode = args.includes('--json');

  const entries = await readdir(SKILLS_DIR);
  const results = {};
  const skillsMap = {};

  for (const entry of entries.sort()) {
    const skillDir = join(SKILLS_DIR, entry);
    const skillStat = await stat(skillDir).catch(() => null);
    if (!skillStat?.isDirectory()) continue;

    const skillFile = join(skillDir, 'SKILL.md');
    const content = await readFile(skillFile, 'utf-8').catch(() => null);
    if (!content) {
      results[entry] = {
        fields: null,
        issues: [{ severity: 'error', field: '-', message: 'SKILL.md not found or unreadable' }],
      };
      continue;
    }

    const fields = parseFrontmatter(content);
    if (!fields) {
      results[entry] = {
        fields: null,
        issues: [{ severity: 'error', field: '-', message: 'no valid frontmatter found' }],
      };
      continue;
    }

    const issues = validateSkill(entry, fields);
    results[entry] = { fields, issues };
    skillsMap[entry] = fields;
  }

  const duplicates = detectTriggerDuplicates(skillsMap);

  if (jsonMode) {
    const { errors, warnings, compliant, total } = summarize(results);
    console.log(JSON.stringify({ summary: { total, errors, warnings, compliant }, results, duplicates }, null, 2));
  } else {
    console.log(formatTableReport(results, duplicates));
  }

  // Exit with error code if any errors found
  const { errors } = summarize(results);
  if (errors > 0 || duplicates.length > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(2);
});
