/**
 * Genesis post-generation verifier — coherence.js checks the in-memory SPEC
 * objects for internal contradictions; THIS module checks the *files actually
 * written to disk* by the blueprint (session 1) and `.claude/` scaffold
 * (session 2). It answers a different question: "did the generation produce a
 * valid, loadable, Windows-safe set of artifacts on the filesystem?"
 *
 * Local filesystem only — IO is allowed (we read generated files), but there is
 * ZERO network egress (DATA POLICY): no fetch, no http(s), no external import.
 * The only dynamic import is of a freshly-generated local `.mjs` hook stub, by
 * absolute `file://` URL, to confirm it parses/loads. Korean-path safe.
 *
 * Graceful by construction: a missing directory or unreadable file degrades to
 * a failing check, never an exception. `verifyGenerated` never throws.
 *
 * Verdict model mirrors coherence.js: each check carries a `severity`
 * (`'error'` | `'warn'`), and `ok` is true iff every `error`-severity check
 * passes. `warn` checks are advisory and never block `ok`.
 *
 * @module lib/genesis/verify-gen
 */

import path from 'node:path';
import fs from 'node:fs/promises';

/**
 * @typedef {object} VerifyCheck
 * @property {string} name - Stable machine-readable check identifier.
 * @property {boolean} pass - Whether this check passed.
 * @property {'error'|'warn'} severity - `error` gates `ok`; `warn` is advisory.
 * @property {string} detail - Human-readable explanation (Korean).
 */

/**
 * @typedef {object} VerifyResult
 * @property {boolean} ok - True iff every `error`-severity check passes.
 * @property {VerifyCheck[]} checks - All checks run, in execution order.
 */

/** Korean-path-safe `file://` URL builder (avoids pathToFileURL percent-encoding). */
function toFileUrl(p) {
  const f = String(p).replace(/\\/g, '/');
  return /^[A-Z]:/i.test(f) ? `file:///${f}` : `file://${f}`;
}

/**
 * Check whether a path exists, tolerating any access error as "absent".
 * @param {string} filePath
 * @returns {Promise<boolean>}
 */
async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read a file as UTF-8 text, returning `null` on any error (absent/unreadable).
 * @param {string} filePath
 * @returns {Promise<string|null>}
 */
async function readTextOrNull(filePath) {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * List directory entries (filenames) under `dir`, returning `[]` if the
 * directory is absent or unreadable. Never throws.
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function listDir(dir) {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

/**
 * Find the first existing file under `dir` matching `predicate` (by name), or
 * return `null`. Used for glob-ish required artifacts (e.g. any file in PRD/).
 * @param {string} dir
 * @param {(name: string) => boolean} predicate
 * @returns {Promise<string|null>}
 */
async function findFile(dir, predicate) {
  for (const name of await listDir(dir)) {
    if (predicate(name)) return path.join(dir, name);
  }
  return null;
}

/** Build a check record. */
function check(name, pass, severity, detail) {
  return { name, pass: Boolean(pass), severity, detail };
}

/** Strip a leading UTF-8 BOM (U+FEFF) so frontmatter on line 1 is detectable. */
function stripBom(text) {
  return typeof text === 'string' && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** True iff `text` begins with a YAML frontmatter block (`---` on line 1). */
function hasFrontmatter(text) {
  if (typeof text !== 'string') return false;
  return /^---\r?\n/.test(stripBom(text));
}

/** Extract the raw frontmatter body (between the first two `---` fences). */
function frontmatterBody(text) {
  if (!hasFrontmatter(text)) return '';
  const m = stripBom(text).match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return m ? m[1] : '';
}

/** True iff the frontmatter body declares a top-level `key:` field. */
function frontmatterHasField(text, key) {
  const body = frontmatterBody(text);
  if (!body) return false;
  const re = new RegExp(`^\\s*${key}\\s*:`, 'm');
  return re.test(body);
}

/**
 * Check 1 — required artifacts exist on disk. CLAUDE.md, a PRD doc under
 * docs/PRD/, FILE-TREE/WORKFLOW/DATASETS docs, and `.claude/settings.json`.
 * Severity: error (a missing core artifact means generation did not complete).
 * @param {string} root
 * @param {VerifyCheck[]} checks - mutated.
 * @returns {Promise<void>}
 */
async function checkRequiredArtifacts(root, checks) {
  const docs = path.join(root, 'docs');
  const missing = [];

  if (!(await exists(path.join(root, 'CLAUDE.md')))) missing.push('CLAUDE.md');

  const prdHit = await findFile(path.join(docs, 'PRD'), (n) => n.toLowerCase().endsWith('.md'));
  if (!prdHit) missing.push('docs/PRD/*');

  for (const rel of ['FILE-TREE.md', 'WORKFLOW.md', 'DATASETS.md']) {
    if (!(await exists(path.join(docs, rel)))) missing.push(`docs/${rel}`);
  }

  if (!(await exists(path.join(root, '.claude', 'settings.json')))) {
    missing.push('.claude/settings.json');
  }

  checks.push(check(
    'required-artifacts',
    missing.length === 0,
    'error',
    missing.length === 0
      ? '필수 산출물 모두 존재 (CLAUDE.md, PRD, FILE-TREE, WORKFLOW, DATASETS, settings.json)'
      : `필수 산출물 누락: ${missing.join(', ')}`,
  ));
}

/**
 * Check 2 — `.claude/settings.json` is valid JSON. Severity: error.
 * Skipped-as-fail only if the file is absent (already flagged by check 1); here
 * we focus on parseability when the file exists.
 * @param {string} root
 * @param {VerifyCheck[]} checks - mutated.
 * @returns {Promise<void>}
 */
async function checkSettingsJson(root, checks) {
  const settingsPath = path.join(root, '.claude', 'settings.json');
  const raw = await readTextOrNull(settingsPath);
  if (raw === null) {
    checks.push(check('settings-json-valid', false, 'error', '.claude/settings.json 부재 또는 읽기 불가'));
    return;
  }
  try {
    JSON.parse(raw);
    checks.push(check('settings-json-valid', true, 'error', '.claude/settings.json 유효한 JSON'));
  } catch (err) {
    checks.push(check(
      'settings-json-valid',
      false,
      'error',
      `.claude/settings.json JSON 파싱 실패: ${err?.message || String(err)}`,
    ));
  }
}

/**
 * Check 3 — every `.claude/skills/{star}/SKILL.md` starts with frontmatter and
 * declares both `name` and `description`. Severity: warn (skill auto-invoke
 * degrades, but the project is still usable). No skills ⇒ vacuously pass.
 * @param {string} root
 * @param {VerifyCheck[]} checks - mutated.
 * @returns {Promise<void>}
 */
async function checkSkillFrontmatter(root, checks) {
  const skillsDir = path.join(root, '.claude', 'skills');
  const entries = await listDir(skillsDir);
  const offenders = [];

  for (const entry of entries) {
    const skillMd = path.join(skillsDir, entry, 'SKILL.md');
    const text = await readTextOrNull(skillMd);
    if (text === null) continue; // not a skill dir (no SKILL.md) — ignore
    const ok = hasFrontmatter(text)
      && frontmatterHasField(text, 'name')
      && frontmatterHasField(text, 'description');
    if (!ok) offenders.push(entry);
  }

  checks.push(check(
    'skill-frontmatter',
    offenders.length === 0,
    'warn',
    offenders.length === 0
      ? 'SKILL.md frontmatter 정상 (name/description 보유 또는 스킬 없음)'
      : `SKILL.md frontmatter 불량(name/description 누락): ${offenders.join(', ')}`,
  ));
}

/**
 * Check 4 — `.claude/hooks/{star}` files use the `.mjs` extension. A `.sh` hook
 * is Windows-incompatible. Severity: warn. No hooks ⇒ vacuously pass.
 * @param {string} root
 * @param {VerifyCheck[]} checks - mutated.
 * @returns {Promise<void>}
 */
async function checkHookExtensions(root, checks) {
  const hooksDir = path.join(root, '.claude', 'hooks');
  const entries = await listDir(hooksDir);
  const offenders = [];

  for (const name of entries) {
    const ext = path.extname(name).toLowerCase();
    // Directories and dotfiles are ignored; only flag script-like non-.mjs.
    if (ext === '.sh' || ext === '.bash' || ext === '.bat' || ext === '.cmd' || ext === '.ps1') {
      offenders.push(name);
    }
  }

  checks.push(check(
    'hook-mjs-extension',
    offenders.length === 0,
    'warn',
    offenders.length === 0
      ? '훅 확장자 정상 (.mjs 또는 훅 없음)'
      : `Windows 비호환 훅 확장자 발견(.mjs 권장): ${offenders.join(', ')}`,
  ));
}

/**
 * Check 5 — `.claude/agents/{star}.md` and `.claude/commands/{star}.md` carry
 * frontmatter. Severity: warn. Absent dirs / no markdown ⇒ vacuously pass.
 * @param {string} root
 * @param {VerifyCheck[]} checks - mutated.
 * @returns {Promise<void>}
 */
async function checkAgentCommandFrontmatter(root, checks) {
  const offenders = [];

  for (const sub of ['agents', 'commands']) {
    const dir = path.join(root, '.claude', sub);
    for (const name of await listDir(dir)) {
      if (!name.toLowerCase().endsWith('.md')) continue;
      const text = await readTextOrNull(path.join(dir, name));
      if (!hasFrontmatter(text)) offenders.push(`${sub}/${name}`);
    }
  }

  checks.push(check(
    'agent-command-frontmatter',
    offenders.length === 0,
    'warn',
    offenders.length === 0
      ? 'agents/commands frontmatter 정상 (또는 해당 파일 없음)'
      : `frontmatter 누락: ${offenders.join(', ')}`,
  ));
}

/**
 * Check 6 — every `.claude/hooks/{star}.mjs` hook stub is dynamically loadable
 * (parses + imports without throwing). A syntax error in a generated hook would
 * break the project at runtime, so this is severity: error. Local import only
 * (absolute `file://` URL); the generated stubs make no external calls, so
 * importing them is side-effect-free and safe. No `.mjs` hooks ⇒ vacuous pass.
 * @param {string} root
 * @param {VerifyCheck[]} checks - mutated.
 * @returns {Promise<void>}
 */
async function checkHooksLoadable(root, checks) {
  const hooksDir = path.join(root, '.claude', 'hooks');
  const mjs = (await listDir(hooksDir)).filter((n) => n.toLowerCase().endsWith('.mjs'));
  const failures = [];

  for (const name of mjs) {
    const abs = path.join(hooksDir, name);
    try {
      await import(toFileUrl(abs));
    } catch (err) {
      failures.push(`${name} (${err?.message || String(err)})`);
    }
  }

  checks.push(check(
    'hooks-loadable',
    failures.length === 0,
    'error',
    failures.length === 0
      ? '훅 .mjs 동적 로드 성공 (또는 .mjs 훅 없음)'
      : `훅 .mjs 로드 실패: ${failures.join('; ')}`,
  ));
}

/**
 * Verify the files actually written by `/go` (blueprint + `.claude/` scaffold).
 *
 * Local-filesystem verification only — IO allowed, ZERO network (DATA POLICY).
 * Graceful: missing directories/files degrade to failing checks; never throws.
 *
 * Checks:
 *  1. `required-artifacts` (error) — core blueprint + settings.json present.
 *  2. `settings-json-valid` (error) — `.claude/settings.json` parses as JSON.
 *  3. `skill-frontmatter` (warn) — every SKILL.md has name/description.
 *  4. `hook-mjs-extension` (warn) — no Windows-incompatible `.sh`/`.bat` hooks.
 *  5. `agent-command-frontmatter` (warn) — agents/commands docs have frontmatter.
 *  6. `hooks-loadable` (error) — every `.mjs` hook stub imports cleanly.
 *
 * @param {object} args
 * @param {string} args.projectRoot - Absolute path to the generated project root.
 * @returns {Promise<VerifyResult>} `{ ok, checks }` — `ok` iff all error checks pass.
 */
export async function verifyGenerated({ projectRoot } = {}) {
  /** @type {VerifyCheck[]} */
  const checks = [];

  if (!projectRoot) {
    checks.push(check('project-root', false, 'error', 'projectRoot 인자가 필요함'));
    return { ok: false, checks };
  }

  try {
    await checkRequiredArtifacts(projectRoot, checks);
    await checkSettingsJson(projectRoot, checks);
    await checkSkillFrontmatter(projectRoot, checks);
    await checkHookExtensions(projectRoot, checks);
    await checkAgentCommandFrontmatter(projectRoot, checks);
    await checkHooksLoadable(projectRoot, checks);
  } catch (err) {
    // Defensive: no check above should throw, but never let one escape.
    checks.push(check(
      'verify-internal',
      false,
      'error',
      `검증 중 예기치 못한 오류: ${err?.message || String(err)}`,
    ));
  }

  const ok = checks.every((c) => c.severity !== 'error' || c.pass);
  return { ok, checks };
}
