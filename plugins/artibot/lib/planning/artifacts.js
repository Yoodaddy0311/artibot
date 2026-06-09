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

const KIND_DIRS = { prd: 'PRD', adr: 'adr' };
const ARCHIVE_DIRNAME = '_archive';
const STALE_DAYS = 90;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

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
// Frontmatter (zero-dep line parser — mirrors handoff / skill-hash convention)
// ---------------------------------------------------------------------------

/**
 * Parse a leading `---` YAML-ish frontmatter block into a flat string map.
 * Only top-level `key: value` lines are recognized (no nesting). Returns
 * `{ data: null }` when no frontmatter block is present.
 *
 * @param {string} text
 * @returns {{ data: Record<string,string>|null, body: string }}
 */
function parseFrontmatter(text) {
  const src = typeof text === 'string' ? text : '';
  if (!src.startsWith('---')) return { data: null, body: src };
  const end = src.indexOf('\n---', 3);
  if (end === -1) return { data: null, body: src };
  const block = src.slice(src.indexOf('\n') + 1, end);
  const data = {};
  for (const line of block.split('\n')) {
    const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (m) data[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  const after = src.slice(end + 4);
  return { data, body: after.replace(/^\s*\n/, '') };
}

/**
 * Resolve the on-disk directory for an artifact kind.
 * @param {string} projectRoot
 * @param {string} kind - 'prd' | 'adr'
 * @returns {string}
 */
function kindDir(projectRoot, kind) {
  const sub = KIND_DIRS[kind] || KIND_DIRS.prd;
  return path.join(projectRoot, 'docs', sub);
}

/**
 * Format a Date as `YYYY-MM-DD`.
 * @param {Date} d
 * @returns {string}
 */
function isoDate(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Read one artifact file into a normalized record. `null` on read failure.
 * @param {string} filePath
 * @param {Date} nowDate
 * @returns {Promise<object|null>}
 */
async function readArtifact(filePath, nowDate) {
  let raw;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
  const { data } = parseFrontmatter(raw);
  const slug = path.basename(filePath, '.md');
  let mtimeMs = nowDate.getTime();
  try { mtimeMs = (await fs.stat(filePath)).mtimeMs; } catch { /* keep now */ }

  const isLegacy = !data || !data.status;
  const status = isLegacy ? 'legacy' : data.status;
  const fmDate = data && (data.created || data.date);
  // Autopilot PRDs embed their real date in the filename (ap-YYYYMMDD). mtime is
  // unreliable here — it gets reset by clone/sync — so when there is no
  // frontmatter date, prefer the filename-embedded date over mtime for age.
  const nameMatch = slug.match(/ap-(\d{4})(\d{2})(\d{2})/);
  const nameMs = nameMatch
    ? Date.parse(`${nameMatch[1]}-${nameMatch[2]}-${nameMatch[3]}T00:00:00Z`)
    : NaN;
  const dateIso = fmDate
    || (Number.isFinite(nameMs) ? isoDate(new Date(nameMs)) : isoDate(new Date(mtimeMs)));
  const refMs = fmDate
    ? new Date(dateIso).getTime()
    : (Number.isFinite(nameMs) ? nameMs : mtimeMs);
  const ageDays = Math.max(0, Math.floor((nowDate.getTime() - refMs) / MS_PER_DAY));
  const rec = { slug, status, dateIso, path: filePath, ageDays };
  if (data && data.progress !== undefined) rec.progress = data.progress;
  return rec;
}

/**
 * Decide whether a record matches the requested filter.
 * @param {object} rec
 * @param {string} filter - active | done | stale | all
 * @returns {boolean}
 */
function matchesFilter(rec, filter) {
  if (filter === 'all') return true;
  if (filter === 'stale') {
    return (rec.status === 'active' || rec.status === 'legacy') && rec.ageDays > STALE_DAYS;
  }
  if (filter === 'active') return rec.status === 'active' || rec.status === 'legacy';
  return rec.status === filter; // 'done' (or any explicit status)
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
 * @returns {Promise<{ ok: boolean, prdPath?: string, deduped?: boolean,
 *   error?: string }>}
 */
export async function writePRD({ projectRoot, slug, title, sections, linkedAdrs = [], now }) {
  try {
    if (!projectRoot) return { ok: false, error: 'projectRoot required' };
    const when = resolveNow(now);
    const dir = path.join(projectRoot, 'docs', 'PRD');
    const wantSlug = slugify(slug || title);

    // Dedup guard: if an active PRD with the same base slug already exists, do
    // not create a new file — return the existing path with deduped:true.
    const existing = await findActiveBySlug(dir, wantSlug);
    if (existing) return { ok: true, prdPath: existing, deduped: true };

    const base = `${wantSlug}-${ymd(when)}`;
    const prdPath = await nonCollidingPath(dir, base, '.md');

    const links = Array.isArray(linkedAdrs) ? linkedAdrs.filter(Boolean) : [];
    const linkLine = links.length
      ? `linked_adrs: ${links.join(', ')}\n`
      : '';
    const content =
      '---\n'
      + 'status: active\n'
      + `created: ${isoDate(when)}\n`
      + `slug: ${wantSlug}\n`
      + linkLine
      + '---\n\n'
      + `# PRD: ${(title || slug || 'Untitled').toString().trim()}\n\n`
      + `생성: ${humanStamp(when)}\n`
      + (links.length ? `**연관 ADR**: ${links.map((a) => `\`${a}\``).join(', ')}\n` : '')
      + '\n---\n\n'
      + renderPrdSections(sections);

    await atomicWriteText(prdPath, content);
    return { ok: true, prdPath };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

/**
 * Find an existing PRD whose frontmatter `slug` (or filename slug-prefix)
 * matches `wantSlug` AND whose status is `active`. Scans the top-level dir
 * only (not `_archive`). Returns the first match's path, or `null`.
 *
 * @param {string} dir
 * @param {string} wantSlug
 * @returns {Promise<string|null>}
 */
async function findActiveBySlug(dir, wantSlug) {
  const files = await listFiles(dir, '.md');
  for (const file of files) {
    if (path.basename(file).toUpperCase() === 'INDEX.MD') continue;
    let raw;
    try { raw = await fs.readFile(file, 'utf-8'); } catch { continue; }
    const { data } = parseFrontmatter(raw);
    if (!data || data.status !== 'active') continue;
    const fileSlug = data.slug || path.basename(file, '.md').replace(/-\d{8}(-\d+)?$/, '');
    if (fileSlug === wantSlug) return file;
  }
  return null;
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

// ---------------------------------------------------------------------------
// Document lifecycle: list / index / archive / supersede
// ---------------------------------------------------------------------------

/**
 * List artifacts under `docs/<KIND>/` (excluding `_archive/`) as normalized
 * records, filtered by lifecycle status. Frontmatter-less legacy docs are
 * surfaced with `status: 'legacy'` and mtime-based `ageDays`.
 *
 * @param {object} args
 * @param {string} args.projectRoot - Absolute repo root.
 * @param {'prd'|'adr'} [args.kind='prd']
 * @param {'active'|'done'|'stale'|'all'} [args.filter='all']
 * @param {NowFn|Date} [args.now] - Injectable clock.
 * @returns {Promise<{ ok: boolean, items?: Array<object>, error?: string }>}
 */
export async function listArtifacts({ projectRoot, kind = 'prd', filter = 'all', now }) {
  try {
    if (!projectRoot) return { ok: false, error: 'projectRoot required' };
    const nowDate = resolveNow(now);
    const dir = kindDir(projectRoot, kind);
    const files = await listFiles(dir, '.md');
    const items = [];
    for (const file of files) {
      if (path.basename(file).toUpperCase() === 'INDEX.MD') continue;
      const rec = await readArtifact(file, nowDate);
      if (rec && matchesFilter(rec, filter)) items.push(rec);
    }
    items.sort((a, b) => (a.dateIso < b.dateIso ? 1 : -1));
    return { ok: true, items };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

/**
 * Render an INDEX.md table from records (full regeneration, not incremental).
 * @param {string} kind
 * @param {Array<object>} items
 * @param {Date} nowDate
 * @returns {string}
 */
function renderIndex(kind, items, nowDate) {
  const head = `# ${KIND_DIRS[kind] || kind} Index\n\n`
    + `생성: ${humanStamp(nowDate)} · ${items.length}건\n\n`
    + '| slug | status | date | ageDays | link |\n'
    + '|------|--------|------|---------|------|\n';
  const rows = items
    .map((r) => `| ${r.slug} | ${r.status} | ${r.dateIso} | ${r.ageDays} | [${r.slug}](./${path.basename(r.path)}) |`)
    .join('\n');
  return head + rows + (rows ? '\n' : '');
}

/**
 * Regenerate `docs/<KIND>/INDEX.md` (active + recent, excluding `_archive`)
 * plus, when present, `docs/<KIND>/_archive/INDEX.md` for archived docs.
 *
 * @param {object} args
 * @param {string} args.projectRoot - Absolute repo root.
 * @param {'prd'|'adr'} [args.kind='prd']
 * @param {NowFn|Date} [args.now] - Injectable clock.
 * @returns {Promise<{ ok: boolean, indexPath?: string, count?: number, error?: string }>}
 */
export async function indexArtifacts({ projectRoot, kind = 'prd', now }) {
  try {
    if (!projectRoot) return { ok: false, error: 'projectRoot required' };
    const nowDate = resolveNow(now);
    const dir = kindDir(projectRoot, kind);

    // Main index: active records only (excludes done/superseded/archive).
    const active = await listArtifacts({ projectRoot, kind, filter: 'active', now });
    const items = active.ok ? active.items : [];
    const indexPath = path.join(dir, 'INDEX.md');
    await atomicWriteText(indexPath, renderIndex(kind, items, nowDate));

    // Archive index (only when an _archive dir exists).
    const archiveDir = path.join(dir, ARCHIVE_DIRNAME);
    if (await exists(archiveDir)) {
      const archFiles = await listFiles(archiveDir, '.md');
      const archItems = [];
      for (const file of archFiles) {
        if (path.basename(file).toUpperCase() === 'INDEX.MD') continue;
        const rec = await readArtifact(file, nowDate);
        if (rec) archItems.push(rec);
      }
      archItems.sort((a, b) => (a.dateIso < b.dateIso ? 1 : -1));
      await atomicWriteText(
        path.join(archiveDir, 'INDEX.md'),
        renderIndex(kind, archItems, nowDate),
      );
    }

    return { ok: true, indexPath, count: items.length };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

/**
 * Move (rename) stale/done/legacy artifacts into `docs/<KIND>/_archive/`.
 * Strictly non-destructive: files are renamed, never deleted. `dryRun` (the
 * default) reports the would-move list without touching disk.
 *
 * @param {object} args
 * @param {string} args.projectRoot - Absolute repo root.
 * @param {'prd'|'adr'} [args.kind='prd']
 * @param {number} [args.olderThanDays=90] - Min age for legacy/active sweep.
 * @param {string[]} [args.statuses=['done','superseded','legacy']]
 * @param {boolean} [args.dryRun=true]
 * @param {NowFn|Date} [args.now] - Injectable clock.
 * @returns {Promise<{ ok: boolean, moved?: Array<object>, dryRun: boolean, error?: string }>}
 */
export async function archiveStale({
  projectRoot, kind = 'prd', olderThanDays = STALE_DAYS,
  statuses = ['done', 'superseded', 'legacy'], dryRun = true, now,
}) {
  try {
    if (!projectRoot) return { ok: false, error: 'projectRoot required', dryRun };
    const nowDate = resolveNow(now);
    const dir = kindDir(projectRoot, kind);
    const archiveDir = path.join(dir, ARCHIVE_DIRNAME);
    const wanted = new Set(statuses);
    const files = await listFiles(dir, '.md');

    const moved = [];
    for (const file of files) {
      if (path.basename(file).toUpperCase() === 'INDEX.MD') continue;
      const rec = await readArtifact(file, nowDate);
      if (!rec) continue;
      const reason = archiveReason(rec, wanted, olderThanDays);
      if (!reason) continue;
      const to = path.join(archiveDir, path.basename(file));
      moved.push({ from: file, to, reason });
    }

    if (!dryRun && moved.length) {
      await ensureDir(archiveDir);
      for (const m of moved) {
        const dest = await nonCollidingPath(
          archiveDir, path.basename(m.to, '.md'), '.md',
        );
        m.to = dest;
        await fs.rename(m.from, dest);
      }
      await indexArtifacts({ projectRoot, kind, now });
    }

    return { ok: true, moved, dryRun };
  } catch (err) {
    return { ok: false, error: err?.message || String(err), dryRun };
  }
}

/**
 * Decide if/why a record should be archived. Status-match wins immediately;
 * active/legacy docs also qualify once older than `olderThanDays`.
 * @param {object} rec
 * @param {Set<string>} wanted
 * @param {number} olderThanDays
 * @returns {string|null}
 */
function archiveReason(rec, wanted, olderThanDays) {
  if (wanted.has(rec.status)) {
    if ((rec.status === 'legacy' || rec.status === 'active') && rec.ageDays <= olderThanDays) {
      return null;
    }
    return `status=${rec.status}`;
  }
  if ((rec.status === 'active' || rec.status === 'legacy') && rec.ageDays > olderThanDays) {
    return `stale ${rec.ageDays}d`;
  }
  return null;
}

/**
 * Mark `oldSlug` as superseded by `newPath`. Non-destructively rewrites the
 * doc: sets frontmatter `status: superseded` (adding a block if absent) and
 * appends a `Superseded by: <newPath>` note to the body.
 *
 * @param {object} args
 * @param {string} args.projectRoot - Absolute repo root.
 * @param {'prd'|'adr'} [args.kind='prd']
 * @param {string} args.oldSlug - Filename slug (no extension) of the old doc.
 * @param {string} args.newPath - Path/ref of the superseding doc.
 * @param {NowFn|Date} [args.now] - Injectable clock.
 * @returns {Promise<{ ok: boolean, oldPath?: string, error?: string }>}
 */
export async function supersede({ projectRoot, kind = 'prd', oldSlug, newPath, now }) {
  try {
    if (!projectRoot) return { ok: false, error: 'projectRoot required' };
    if (!oldSlug) return { ok: false, error: 'oldSlug required' };
    if (!newPath) return { ok: false, error: 'newPath required' };
    resolveNow(now); // validate clock arg for call-site consistency
    const dir = kindDir(projectRoot, kind);
    const oldPath = path.join(dir, `${oldSlug}.md`);
    let raw;
    try { raw = await fs.readFile(oldPath, 'utf-8'); } catch {
      return { ok: false, error: `not found: ${oldSlug}` };
    }

    const updated = applySupersede(raw, newPath);
    await atomicWriteText(oldPath, updated);
    return { ok: true, oldPath };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

/**
 * Pure transform: set `status: superseded` in frontmatter (creating the block
 * if missing) and append a body note. Idempotent on status.
 * @param {string} raw
 * @param {string} newPath
 * @returns {string}
 */
function applySupersede(raw, newPath) {
  const note = `\n\n> Superseded by: ${newPath}\n`;
  if (raw.startsWith('---') && raw.indexOf('\n---', 3) !== -1) {
    const end = raw.indexOf('\n---', 3);
    let block = raw.slice(0, end);
    if (/\nstatus\s*:/i.test(block)) {
      block = block.replace(/\nstatus\s*:.*/i, '\nstatus: superseded');
    } else {
      block += '\nstatus: superseded';
    }
    block += `\nsuperseded_by: ${newPath}`;
    return block + raw.slice(end) + note;
  }
  // No frontmatter — prepend a fresh block.
  return `---\nstatus: superseded\nsuperseded_by: ${newPath}\n---\n\n${raw}${note}`;
}
