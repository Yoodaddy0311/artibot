/**
 * Rehydration bundle builder — PostCompact context re-injection (vNext
 * PR-CX01, design §04 "A. Native compact path" + "Minimal Rehydration Bundle").
 *
 * Pure. Takes what the hook already read (the PreCompact snapshot, the
 * harness's `compact_summary`, the latest HANDOFF pointer, `/split` run
 * files and lane briefs, and the current git identity) and folds them into
 * ONE text block of at most `maxBytes` (default 10 KiB — design §04 "fresh
 * context 의 초기 payload 를 10KB 이하로 유지"). No I/O, no clock, no
 * randomness: the same input yields the same bytes.
 *
 * ── Identity gate (ACCEPTANCE P2 "wrong branch/worktree restore refused") ──
 * The snapshot was written by `scripts/hooks/pre-compact.js` in SOME cwd on
 * SOME branch. If that is not the cwd/branch the hook now runs in, the
 * snapshot describes another worktree's work and injecting it would steer
 * the model wrong. So `compareIdentity` decides, and when it is not `ok`
 * every snapshot-derived section is withheld (status `refused`) and a
 * warning line replaces it. Unknown identity (no `gitState` in the snapshot,
 * or no current branch) is treated as a mismatch — fail-closed, invariant 7.
 * Sections that come from the CURRENT tree (split lane brief, run.json,
 * HANDOFF pointer, compact summary) are unaffected by the gate.
 *
 * ── Budget (design §04 bundle sizes) ────────────────────────────────────────
 * Sections are appended in {@link SECTION_ORDER} priority. A section that
 * does not fit is truncated when it is prose (brief, handoff, compact
 * summary — a marker says how many bytes were cut) and dropped when it is a
 * list. Whatever happened is recorded in `sections[]` and repeated in the
 * footer, so a reader can tell "there was nothing" from "it was cut".
 *
 * @module lib/context/rehydration
 */

/** Design §04: initial payload of a fresh context ≤ 10 KB. */
export const DEFAULT_MAX_BYTES = 10240;

/** Per-section soft caps before the global budget applies (design §04 sizes). */
export const SECTION_CAPS = Object.freeze({
  brief: 2048, // "1~2KB lane brief"
  handoff: 1536,
  compactSummary: 1024,
  keyFiles: 8,
  pending: 5,
  decisions: 5,
});

/** Assembly priority — earlier survives a tight budget. */
export const SECTION_ORDER = Object.freeze([
  'identity',
  'resume',
  'snapshot-work',
  'split-lane',
  'handoff',
  'compact-summary',
]);

const TRUNCATION_MARKER_RESERVE = 48;
const FOOTER_RESERVE = 320;

/**
 * @param {string} s
 * @returns {number}
 */
export function byteLength(s) {
  return Buffer.byteLength(String(s ?? ''), 'utf8');
}

/**
 * Cut `text` to at most `max` UTF-8 bytes without splitting a code point.
 * Returns `{ text, cut }` where `cut` is the number of bytes removed.
 *
 * @param {string} text
 * @param {number} max
 * @returns {{ text: string, cut: number }}
 */
export function truncateToBytes(text, max) {
  const s = String(text ?? '');
  const total = byteLength(s);
  if (max <= 0) return { text: '', cut: total };
  if (total <= max) return { text: s, cut: 0 };
  let out = Buffer.from(s, 'utf8').subarray(0, max).toString('utf8');
  out = out.replace(/�+$/u, '');
  return { text: out, cut: total - byteLength(out) };
}

/**
 * @param {unknown} p
 * @param {boolean} caseInsensitive
 * @returns {string}
 */
function normPath(p, caseInsensitive) {
  if (typeof p !== 'string' || !p) return '';
  let s = p.replace(/\\/g, '/').replace(/\/+$/, '');
  if (caseInsensitive) s = s.toLowerCase();
  return s;
}

/**
 * @param {unknown} v
 * @returns {string|null}
 */
function str(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/**
 * @param {unknown} v
 * @returns {string[]}
 */
function strList(v) {
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : [];
}

/**
 * @typedef {object} Identity
 * @property {boolean} ok - snapshot may be injected
 * @property {boolean|null} cwdMatch - null when either side is unknown
 * @property {boolean|null} branchMatch
 * @property {boolean|null} headMatch - informational only (a commit between PreCompact and PostCompact is normal)
 * @property {string[]} reasons - why `ok` is false
 * @property {{ cwd: string|null, branch: string|null, head: string|null }} snapshot
 * @property {{ cwd: string|null, branch: string|null, head: string|null }} current
 */

/**
 * Decide whether the snapshot belongs to the tree the hook is running in.
 * `ok` requires cwd AND branch to be known on both sides and equal. Head is
 * compared but never blocks (the worker may have committed since PreCompact).
 *
 * @param {object|null|undefined} snapshotGit - `snapshot.gitState` (`{ cwd, branch, head? }`)
 * @param {{ cwd?: string, branch?: string, head?: string }|null|undefined} current
 * @param {{ caseInsensitivePaths?: boolean }} [opts] - default `process.platform === 'win32'`
 * @returns {Identity}
 */
export function compareIdentity(snapshotGit, current, opts = {}) {
  const ci = typeof opts.caseInsensitivePaths === 'boolean' ? opts.caseInsensitivePaths : process.platform === 'win32';
  const s = snapshotGit && typeof snapshotGit === 'object' ? snapshotGit : {};
  const c = current && typeof current === 'object' ? current : {};
  const snap = { cwd: str(s.cwd), branch: str(s.branch) && s.branch !== 'unknown' ? s.branch : null, head: str(s.head) };
  const cur = { cwd: str(c.cwd), branch: str(c.branch) && c.branch !== 'unknown' ? c.branch : null, head: str(c.head) };
  const cwdMatch = snap.cwd && cur.cwd ? normPath(snap.cwd, ci) === normPath(cur.cwd, ci) : null;
  const branchMatch = snap.branch && cur.branch ? snap.branch === cur.branch : null;
  const headMatch = snap.head && cur.head ? snap.head.startsWith(cur.head) || cur.head.startsWith(snap.head) : null;
  const reasons = [];
  if (cwdMatch === null) reasons.push('cwd unknown on one side');
  else if (!cwdMatch) reasons.push(`cwd mismatch: snapshot ${snap.cwd} ≠ current ${cur.cwd}`);
  if (branchMatch === null) reasons.push('branch unknown on one side');
  else if (!branchMatch) reasons.push(`branch mismatch: snapshot ${snap.branch} ≠ current ${cur.branch}`);
  return { ok: reasons.length === 0, cwdMatch, branchMatch, headMatch, reasons, snapshot: snap, current: cur };
}

/**
 * @typedef {object} Section
 * @property {string} name
 * @property {string} text - rendered body (no trailing newline required)
 * @property {boolean} shrinkable - may be cut with a marker instead of dropped
 */

/**
 * @param {Identity} id
 * @param {object} snapshot
 * @returns {Section}
 */
function renderIdentity(id, snapshot) {
  const savedAt = str(snapshot?.savedAt) ?? 'unknown';
  const lines = [
    '[artibot:post-compact] Rehydration bundle — informational only, no automation (vNext PR-CX01, S0).',
    `snapshot: savedAt=${savedAt} cwd=${id.snapshot.cwd ?? '?'} branch=${id.snapshot.branch ?? '?'}${id.snapshot.head ? `@${id.snapshot.head.slice(0, 8)}` : ''}`,
    `current:  cwd=${id.current.cwd ?? '?'} branch=${id.current.branch ?? '?'}${id.current.head ? `@${id.current.head.slice(0, 8)}` : ''}`,
  ];
  if (id.ok) {
    lines.push(`identity: OK${id.headMatch === false ? ' (head moved since PreCompact — commits happened, expected)' : ''}`);
  } else {
    lines.push(`identity: REFUSED — ${id.reasons.join('; ')}. Snapshot-derived sections withheld and the snapshot files are NOT listed below; trust git, not memory of the other tree.`);
  }
  return { name: 'identity', text: lines.join('\n'), shrinkable: false };
}

/**
 * Snapshot-derived file pointers are listed ONLY when the identity gate
 * passed: pointing the model at another worktree's snapshot is the same
 * leak as injecting its content (review finding 2026-09-02).
 *
 * @param {{ bundlePath?: string|null, snapshotPath?: string|null, stateFilePath?: string|null }} paths
 * @param {Identity} id
 * @returns {Section}
 */
function renderResume(paths, id) {
  const lines = [
    'Resume protocol (design §04 rehydrate 8-9): before acting, restate the next action in ONE line; verify branch/worktree with git, not with this text.',
  ];
  const files = [paths?.bundlePath ? `bundle: ${paths.bundlePath}` : null];
  if (id.ok) {
    files.push(
      paths?.snapshotPath ? `pre-compact snapshot: ${paths.snapshotPath}` : null,
      paths?.stateFilePath ? `pre-compact state: ${paths.stateFilePath}` : null,
    );
  } else if (paths?.snapshotPath || paths?.stateFilePath) {
    lines.push('Do NOT read the pre-compact snapshot/state files: they belong to another cwd/branch (see identity).');
  }
  const present = files.filter(Boolean);
  if (present.length) lines.push(`files: ${present.join(' · ')}`);
  return { name: 'resume', text: lines.join('\n'), shrinkable: false };
}

/**
 * @param {object} summary - `snapshot.summary` from pre-compact.js
 * @returns {Section|null}
 */
function renderSnapshotWork(summary) {
  const s = summary && typeof summary === 'object' ? summary : null;
  if (!s) return null;
  const lines = ['## Work before compaction (pre-compact snapshot)'];
  const current = str(s.current_work);
  if (current) lines.push(`current: ${current}`);
  const pending = strList(s.pending_work).slice(0, SECTION_CAPS.pending);
  if (pending.length) {
    lines.push('pending:');
    for (const p of pending) lines.push(`  - ${p}`);
  }
  const decisions = strList(s.decisions).slice(0, SECTION_CAPS.decisions);
  if (decisions.length) {
    lines.push('decisions:');
    for (const d of decisions) lines.push(`  - ${d}`);
  }
  const files = strList(s.key_files).slice(0, SECTION_CAPS.keyFiles);
  if (files.length) lines.push(`key files: ${files.join(', ')}`);
  const requests = strList(s.recent_requests);
  if (requests.length) lines.push(`last request: ${requests[requests.length - 1]}`);
  if (lines.length === 1) return null;
  return { name: 'snapshot-work', text: lines.join('\n'), shrinkable: false };
}

/**
 * @param {{ runJson?: object|null, planJson?: object|null, briefs?: Array<{ limb: string, path?: string, text: string }> }|null} split
 * @returns {Section|null}
 */
function renderSplitLane(split) {
  if (!split || typeof split !== 'object') return null;
  const lines = [];
  const run = split.runJson && typeof split.runJson === 'object' ? split.runJson : null;
  const plan = split.planJson && typeof split.planJson === 'object' ? split.planJson : null;
  const runId = str(run?.runId) ?? str(plan?.runId);
  if (runId) {
    const limbs = Array.isArray(run?.limbs) ? run.limbs.filter((l) => typeof l === 'string') : [];
    lines.push(`## /split run ${runId}${str(run?.stage) ? ` stage=${run.stage}` : ''}${limbs.length ? ` limbs=${limbs.join(',')}` : ''}`);
  }
  const briefs = Array.isArray(split.briefs) ? split.briefs.filter((b) => b && typeof b.text === 'string' && b.text.trim()) : [];
  for (const b of briefs.slice(0, 2)) {
    const { text, cut } = truncateToBytes(b.text.trim(), SECTION_CAPS.brief);
    lines.push(`### lane brief${str(b.limb) ? ` ${b.limb}` : ''}${str(b.path) ? ` (${b.path})` : ''}`);
    lines.push(text + (cut > 0 ? `\n…[brief truncated, ${cut} bytes omitted — read the file]` : ''));
  }
  if (!lines.length) return null;
  return { name: 'split-lane', text: lines.join('\n'), shrinkable: true };
}

/**
 * @param {{ path?: string, content?: string, mtime?: number }|null} handoff
 * @returns {Section|null}
 */
function renderHandoff(handoff) {
  const content = str(handoff?.content);
  if (!content) return null;
  const { text, cut } = truncateToBytes(content, SECTION_CAPS.handoff);
  const head = `## Latest HANDOFF${str(handoff.path) ? ` (${handoff.path})` : ''}`;
  return {
    name: 'handoff',
    text: `${head}\n${text}${cut > 0 ? `\n…[handoff truncated, ${cut} bytes omitted — read the file]` : ''}`,
    shrinkable: true,
  };
}

/**
 * @param {string|null|undefined} compactSummary
 * @returns {Section|null}
 */
function renderCompactSummary(compactSummary) {
  const s = str(compactSummary);
  if (!s) return null;
  const { text, cut } = truncateToBytes(s, SECTION_CAPS.compactSummary);
  return {
    name: 'compact-summary',
    text: `## Harness compact_summary (excerpt)\n${text}${cut > 0 ? `\n…[${cut} bytes omitted — full text saved with the bundle]` : ''}`,
    shrinkable: true,
  };
}

/**
 * @typedef {object} BundleInput
 * @property {object|null} [snapshot] - parsed `~/.claude/artibot-pre-compact.json`
 * @property {{ cwd?: string, branch?: string, head?: string }} [current] - identity of the tree the hook runs in
 * @property {string|null} [compactSummary] - PostCompact stdin `compact_summary`
 * @property {{ path?: string, content?: string, mtime?: number }|null} [handoff] - `readLatestHandoff` result
 * @property {{ runJson?: object|null, planJson?: object|null, briefs?: Array<{ limb: string, path?: string, text: string }> }|null} [split]
 * @property {{ bundlePath?: string|null, snapshotPath?: string|null, stateFilePath?: string|null }} [paths]
 * @property {number} [maxBytes]
 * @property {boolean} [caseInsensitivePaths]
 */

/**
 * @typedef {object} Bundle
 * @property {string} text - the block to inject / save
 * @property {number} bytes - UTF-8 size of `text`
 * @property {number} maxBytes
 * @property {boolean} truncated - any section cut or dropped for budget
 * @property {Array<{ name: string, status: 'included'|'truncated'|'dropped'|'refused'|'empty', bytes: number }>} sections
 * @property {Identity} identity
 * @property {string[]} warnings
 */

/**
 * Build the bundle. Pure.
 *
 * @param {BundleInput} input
 * @returns {Bundle}
 */
export function buildRehydrationBundle(input = {}) {
  const maxBytes = Number.isInteger(input.maxBytes) && input.maxBytes > 0 ? input.maxBytes : DEFAULT_MAX_BYTES;
  const snapshot = input.snapshot && typeof input.snapshot === 'object' ? input.snapshot : null;
  const identity = compareIdentity(snapshot?.gitState, input.current, { caseInsensitivePaths: input.caseInsensitivePaths });
  const warnings = [];
  if (!snapshot) warnings.push('no pre-compact snapshot found');
  if (snapshot && !identity.ok) warnings.push(`snapshot refused: ${identity.reasons.join('; ')}`);

  /** @type {Array<Section & { refused?: boolean }>} */
  const candidates = [];
  const push = (sec, refused = false) => {
    if (sec) candidates.push({ ...sec, refused });
  };
  push(renderIdentity(identity, snapshot));
  push(renderResume(input.paths ?? {}, identity));
  const work = snapshot ? renderSnapshotWork(snapshot.summary) : null;
  push(work, Boolean(work) && !identity.ok);
  push(renderSplitLane(input.split));
  push(renderHandoff(input.handoff));
  push(renderCompactSummary(input.compactSummary));

  const byName = new Map(candidates.map((c) => [c.name, c]));
  /** @type {Bundle['sections']} */
  const sections = [];
  const parts = [];
  let used = 0;
  const budget = maxBytes - FOOTER_RESERVE;
  let truncated = false;

  for (const name of SECTION_ORDER) {
    const sec = byName.get(name);
    if (!sec) {
      sections.push({ name, status: 'empty', bytes: 0 });
      continue;
    }
    if (sec.refused) {
      sections.push({ name, status: 'refused', bytes: 0 });
      continue;
    }
    const body = sec.text;
    const need = byteLength(body) + (parts.length ? 2 : 0);
    // identity is never dropped: at a degenerate cap it is hard-cut below
    // rather than replaced by an empty bundle.
    if (name === 'identity' || used + need <= budget) {
      parts.push(body);
      used += need;
      sections.push({ name, status: 'included', bytes: byteLength(body) });
      continue;
    }
    const room = budget - used - (parts.length ? 2 : 0) - TRUNCATION_MARKER_RESERVE;
    if (sec.shrinkable && room > 120) {
      const { text, cut } = truncateToBytes(body, room);
      const marked = `${text}\n…[${name} truncated for budget, ${cut} bytes omitted]`;
      parts.push(marked);
      used += byteLength(marked) + (parts.length > 1 ? 2 : 0);
      sections.push({ name, status: 'truncated', bytes: byteLength(marked) });
    } else {
      sections.push({ name, status: 'dropped', bytes: 0 });
    }
    truncated = true;
  }

  const describe = sections
    .filter((s) => s.status !== 'empty')
    .map((s) => (s.status === 'included' ? s.name : `${s.name}(${s.status})`))
    .join(', ');
  const bodyText = parts.join('\n\n');
  const footer = (withWarningText) => `\n\n[rehydrate] ${byteLength(bodyText)} bytes of ${maxBytes} · sections: ${describe}${truncated ? ' · TRUNCATED' : ''}`
    + (warnings.length ? (withWarningText ? ` · warnings: ${warnings.join(' | ')}` : ` · warnings: ${warnings.length} (text omitted for budget)`) : '');

  // The cap is a promise about the FINAL string. The section budget above
  // reserved a fixed FOOTER_RESERVE, but the footer carries identity reasons
  // (two cwd paths, two branches) whose length is data-driven, and the
  // identity section itself is never dropped — so re-measure and shrink in
  // three steps: (1) drop the warning text from the footer, (2) hard-cut the
  // body, (3) as a last net, hard-cut the whole string. Each step keeps a
  // marker so a reader can tell the text was cut (review finding 2026-09-02:
  // 10594B against a 10240 cap with deep worktree paths; 621B against 200).
  let text = `${bodyText}${footer(true)}`;
  if (byteLength(text) > maxBytes) text = `${bodyText}${footer(false)}`;
  if (byteLength(text) > maxBytes) {
    truncated = true;
    const marker = '\n…[hard-truncated to cap]';
    const foot = footer(false);
    const room = maxBytes - byteLength(foot) - byteLength(marker);
    text = room > 0
      ? `${truncateToBytes(bodyText, room).text}${marker}${foot}`
      : `${truncateToBytes(bodyText, maxBytes - byteLength(marker)).text}${marker}`;
  }
  if (byteLength(text) > maxBytes) {
    const marker = '…[cap]';
    text = `${truncateToBytes(text, Math.max(0, maxBytes - byteLength(marker))).text}${marker}`;
    if (byteLength(text) > maxBytes) text = truncateToBytes(text, maxBytes).text;
  }
  return { text, bytes: byteLength(text), maxBytes, truncated, sections, identity, warnings };
}
