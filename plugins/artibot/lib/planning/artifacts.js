/**
 * Planning artifacts layer — pure, non-destructive generators for PRD / ADR /
 * TODO state shared by `/plan`, `/ultraplan`, and (future) `/autopilot`.
 *
 * Design rules:
 *   - Pure & non-destructive: never overwrite an existing file. On collision,
 *     a `-NN` suffix is appended so prior artifacts survive.
 *   - `now` is injectable for deterministic tests. Convention (matches
 *     `lib/handoff/handoff-store.js`): `now` is a function `() => Date`, called
 *     as `now()`. Defaults to `() => new Date()`.
 *   - Korean-path safe (path.join only), atomic writes, auto-created dirs.
 *   - Failure-tolerant: returns `{ ok: false, error }` instead of throwing.
 *
 * @module lib/planning/artifacts
 */

import path from 'node:path';
import { atomicWriteJson, ensureDir, exists, listFiles } from '../core/file.js';
import fs from 'node:fs/promises';
import { PlanTracker } from '../core/plan-tracker.js';

/** @typedef {() => Date} NowFn */

const PRD_SECTION_ORDER = [
  '배경',
  '목표',
  '비목표',
  '시나리오',
  '설계',
  '산출물',
  '실행계획',
  '위험',
  '수락기준',
];

const DEFAULT_NOW = () => new Date();

// ---------------------------------------------------------------------------
// Internal helpers (small, pure)
// ---------------------------------------------------------------------------

/**
 * Resolve a `now` argument into a Date, tolerating both function and Date.
 * @param {NowFn|Date} [now]
 * @returns {Date}
 */
function resolveNow(now) {
  if (typeof now === 'function') return now();
  if (now instanceof Date) return now;
  return DEFAULT_NOW();
}

/**
 * Format a Date as `YYYYMMDD` for filenames.
 * @param {Date} d
 * @returns {string}
 */
function ymd(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

/**
 * Format a Date as `YYYY-MM-DD HH:MM` for human-readable headers.
 * @param {Date} d
 * @returns {string}
 */
function humanStamp(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Slugify a title into a filesystem-safe, lowercase token. Keeps unicode
 * letters/numbers (so Korean titles stay meaningful), collapses everything
 * else to single hyphens.
 * @param {string} title
 * @returns {string}
 */
function slugify(title) {
  const base = String(title || '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return base || 'untitled';
}

/**
 * Return a non-colliding absolute path. Tries `<dir>/<base><ext>` first, then
 * `<base>-2`, `<base>-3`, ... so existing files are never overwritten.
 * @param {string} dir
 * @param {string} base - Filename without extension.
 * @param {string} ext - Extension including leading dot (e.g. `.md`).
 * @returns {Promise<string>}
 */
async function nonCollidingPath(dir, base, ext) {
  const first = path.join(dir, `${base}${ext}`);
  if (!(await exists(first))) return first;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = path.join(dir, `${base}-${i}${ext}`);
    if (!(await exists(candidate))) return candidate;
  }
  // Astronomically unlikely fallback.
  return path.join(dir, `${base}-${Date.now()}${ext}`);
}

/**
 * Atomic text write via a tmp sibling + rename. Mirrors atomicWriteJson but
 * for raw markdown so readers never observe a partial file.
 * @param {string} filePath
 * @param {string} content
 * @returns {Promise<void>}
 */
async function atomicWriteText(filePath, content) {
  await ensureDir(path.dirname(filePath));
  const rand = Math.random().toString(36).slice(2, 8);
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}.${rand}`;
  try {
    await fs.writeFile(tmp, content, 'utf-8');
    await fs.rename(tmp, filePath);
  } catch (err) {
    try { await fs.unlink(tmp); } catch { /* best-effort */ }
    throw err;
  }
}

/**
 * Scan a `docs/adr/` directory for the highest `ADR-NNN-` number.
 * @param {string} adrDir
 * @returns {Promise<number>} Highest number found, or 0 if none.
 */
async function highestAdrNumber(adrDir) {
  const files = await listFiles(adrDir, '.md');
  let max = 0;
  for (const file of files) {
    const m = /ADR-(\d+)/i.exec(path.basename(file));
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  return max;
}

// ---------------------------------------------------------------------------
// PRD
// ---------------------------------------------------------------------------

/**
 * Render PRD markdown body from sections in canonical order.
 * @param {Record<string, string>} sections
 * @returns {string}
 */
function renderPrdSections(sections) {
  const src = sections && typeof sections === 'object' ? sections : {};
  return PRD_SECTION_ORDER
    .map((name) => `## ${name}\n\n${(src[name] ?? '').toString().trim()}\n`)
    .join('\n');
}

/**
 * Write a PRD (Product Requirements Document) under `docs/PRD/`.
 * Non-destructive: collisions get a `-NN` suffix.
 *
 * @param {object} args
 * @param {string} args.projectRoot - Absolute repo root.
 * @param {string} args.slug - Filename slug (raw; will be slugified).
 * @param {string} args.title - Human title for the H1 header.
 * @param {Record<string, string>} args.sections - { 배경, 목표, 비목표,
 *   시나리오, 설계, 산출물, 실행계획, 위험, 수락기준 }. Empty values allowed.
 * @param {string[]} [args.linkedAdrs=[]] - ADR ids/paths to link in header.
 * @param {NowFn|Date} [args.now] - Injectable clock.
 * @returns {Promise<{ ok: boolean, prdPath?: string, error?: string }>}
 */
export async function writePRD({ projectRoot, slug, title, sections, linkedAdrs = [], now }) {
  try {
    if (!projectRoot) return { ok: false, error: 'projectRoot required' };
    const when = resolveNow(now);
    const dir = path.join(projectRoot, 'docs', 'PRD');
    const base = `${slugify(slug || title)}-${ymd(when)}`;
    const prdPath = await nonCollidingPath(dir, base, '.md');

    const links = Array.isArray(linkedAdrs) ? linkedAdrs.filter(Boolean) : [];
    const linkLine = links.length
      ? `**연관 ADR**: ${links.map((a) => `\`${a}\``).join(', ')}\n`
      : '';
    const content =
      `# PRD: ${(title || slug || 'Untitled').toString().trim()}\n\n`
      + `생성: ${humanStamp(when)}\n`
      + linkLine
      + '\n---\n\n'
      + renderPrdSections(sections);

    await atomicWriteText(prdPath, content);
    return { ok: true, prdPath };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

// ---------------------------------------------------------------------------
// ADR
// ---------------------------------------------------------------------------

/**
 * Render the 7-section ADR skeleton (per skills/adr-format).
 * @param {object} a
 * @param {number} a.number
 * @param {string} a.title
 * @param {string[]} a.options
 * @param {string} a.decision
 * @param {string} a.rationale
 * @param {Date} a.when
 * @returns {string}
 */
function renderAdr({ number, title, options, decision, rationale, when }) {
  const pad = String(number).padStart(3, '0');
  const pad2 = (n) => String(n).padStart(2, '0');
  const date = `${when.getFullYear()}-${pad2(when.getMonth() + 1)}-${pad2(when.getDate())}`;
  const alt = options
    .map((opt) => `### 선택지: ${opt}\n- **장점**: 조사 필요\n- **단점**: 조사 필요`)
    .join('\n\n');
  return (
    `# ADR-${pad}: ${title}\n\n`
    + `## 추천 결론 (TL;DR)\n> **${decision}을(를) 채택한다.** ${rationale}\n\n`
    + `## Status\nAccepted\n\n작성일: ${date}\n\n---\n\n`
    + `## 1. Context (컨텍스트와 제약사항)\n조사 필요\n\n---\n\n`
    + `## 2. Alternatives Considered (검토한 선택지)\n${alt}\n\n---\n\n`
    + `## 3. 확장성 관점 평가\n조사 필요\n\n---\n\n`
    + `## 4. 숨겨진 비용\n조사 필요\n\n---\n\n`
    + `## 5. Decision (추천안)\n> ## ✓ **추천: ${decision}**\n\n**선택 근거**: ${rationale}\n\n---\n\n`
    + `## 6. Consequences (의사결정의 결과)\n조사 필요\n\n---\n\n`
    + `## 7. 2년 뒤 기술 부채 예상 포인트\n조사 필요\n`
  );
}

/**
 * Create the next ADR under `docs/adr/` with auto-incremented number.
 * Caller decides *whether* a real decision exists; this only generates.
 *
 * @param {object} args
 * @param {string} args.projectRoot - Absolute repo root.
 * @param {string} args.title - ADR title (used for slug + H1).
 * @param {string[]} args.options - Compared options (>= 2).
 * @param {string} args.decision - Adopted option.
 * @param {string} [args.rationale=''] - Why this decision.
 * @param {NowFn|Date} [args.now] - Injectable clock.
 * @returns {Promise<{ ok: boolean, adrPath?: string, number?: number, error?: string }>}
 */
export async function ensureADR({ projectRoot, title, options, decision, rationale = '', now }) {
  try {
    if (!projectRoot) return { ok: false, error: 'projectRoot required' };
    if (!Array.isArray(options) || options.length < 2) {
      return { ok: false, error: 'options must have >= 2 entries' };
    }
    if (!decision) return { ok: false, error: 'decision required' };

    const when = resolveNow(now);
    const dir = path.join(projectRoot, 'docs', 'adr');
    const number = (await highestAdrNumber(dir)) + 1;
    const pad = String(number).padStart(3, '0');
    const base = `ADR-${pad}-${slugify(title)}`;
    const adrPath = await nonCollidingPath(dir, base, '.md');

    const content = renderAdr({
      number, title: title || 'Untitled', options, decision, rationale, when,
    });
    await atomicWriteText(adrPath, content);
    return { ok: true, adrPath, number };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

// ---------------------------------------------------------------------------
// TODO / plan state
// ---------------------------------------------------------------------------

/**
 * Parse a plan markdown into checkbox tasks and persist `.plan-state.json`
 * alongside the resolved plan file. Merges with any existing state.
 *
 * @param {object} args
 * @param {string} args.projectRoot - Absolute repo root.
 * @param {string} args.planMarkdown - Markdown containing `- [ ]` / `- [x]`.
 * @param {string} [args.planFile='PLAN.md'] - Plan file path (relative to
 *   projectRoot or absolute) recorded in state; state lands beside it.
 * @param {string} [args.sessionId] - Optional session to register.
 * @param {NowFn|Date} [args.now] - Injectable clock (reserved/consistency).
 * @returns {Promise<{ ok: boolean, stateFile?: string,
 *   progress?: { total: number, completed: number, percentage: number },
 *   error?: string }>}
 */
export async function syncTodo({ projectRoot, planMarkdown, planFile = 'PLAN.md', sessionId, now }) {
  try {
    if (!projectRoot) return { ok: false, error: 'projectRoot required' };
    resolveNow(now); // validate clock arg for call-site consistency
    const resolvedPlan = path.isAbsolute(planFile)
      ? planFile
      : path.join(projectRoot, planFile);
    const stateFile = path.join(path.dirname(resolvedPlan), '.plan-state.json');

    const tracker = new PlanTracker();
    const prior = await readState(stateFile);
    if (prior) tracker.fromState(prior);
    tracker.parsePlan(typeof planMarkdown === 'string' ? planMarkdown : '');
    if (sessionId) tracker.addSession(sessionId);

    const state = tracker.toState(resolvedPlan);
    await atomicWriteJson(stateFile, state);

    return { ok: true, stateFile, progress: tracker.getProgress() };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

/**
 * Read a previously saved plan-state JSON, tolerating absence.
 * @param {string} stateFile
 * @returns {Promise<object|null>}
 */
async function readState(stateFile) {
  try {
    const raw = await fs.readFile(stateFile, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
