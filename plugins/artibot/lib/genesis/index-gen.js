/**
 * Genesis docs-index generator — renders a document index / status tracker as a
 * status-legend + tracking table and writes it to `docs/DOCS-INDEX.md`.
 *
 * Inspired by the Ontology Developer Center's `DOCS_INDEX.md` pattern: a single
 * living index that maps every blueprint document to a status so a fresh session
 * can restore context fast and stale docs are surfaced (not silently rotting).
 *
 * Pure & non-destructive (collision → `-NN` suffix), Korean-path safe, atomic,
 * no network (DATA POLICY). The command/model builds the structured `docs`
 * array; this module only transforms it into markdown (IO boundary).
 *
 * @module lib/genesis/index-gen
 */

import path from 'node:path';
import {
  atomicWriteText,
  cell,
  humanStamp,
  nonCollidingPath,
  resolveNow,
} from './_shared.js';

/**
 * @typedef {object} DocEntry
 * @property {string} name - Human-readable document title (e.g. 'PRD').
 * @property {string} path - Relative path under the project (e.g. 'docs/PRD/foo.md').
 * @property {string} [status] - One of 'generated' | 'stub' | 'pending'.
 * @property {string} [description] - Short description of the document's purpose.
 */

/**
 * Status → { emoji, label } mapping. Unknown/missing statuses degrade to
 * `pending` (⚫) so a malformed entry never produces a blank cell.
 */
const STATUS_META = Object.freeze({
  generated: { emoji: '🟢', label: 'generated' },
  stub: { emoji: '🟡', label: 'stub' },
  pending: { emoji: '⚫', label: 'pending' },
});

/**
 * Resolve a raw status string to its `{ emoji, label }`, defaulting to
 * `pending` for anything unrecognized (case-insensitive, trimmed).
 * @param {string} [status]
 * @returns {{ emoji: string, label: string }}
 */
function statusMeta(status) {
  const key = String(status ?? '').trim().toLowerCase();
  return STATUS_META[key] || STATUS_META.pending;
}

/**
 * Render the full DOCS-INDEX markdown from a docs spec. Pure (no IO, no clock).
 *
 * @param {DocEntry[]} docs - Document entries (see {@link DocEntry}).
 * @returns {string} Markdown: status legend + document tracking table.
 */
export function renderDocsIndex(docs) {
  const list = Array.isArray(docs) ? docs : [];

  const legend =
    '## 상태 범례\n\n'
    + '| 라벨 | 의미 |\n|---|---|\n'
    + '| 🟢 **generated** | 생성 완료 — 내용이 채워진 문서 |\n'
    + '| 🟡 **stub** | 골격만 있음 — 내용 보강 필요 |\n'
    + '| ⚫ **pending** | 아직 생성되지 않음 (계획됨) |';

  const tableHead = '| 상태 | 문서 | 경로 | 설명 |\n|:--:|---|---|---|';
  const tableBody = list.length
    ? list
        .map((d) => {
          const meta = statusMeta(d?.status);
          const name = cell(d?.name ?? '(unnamed)') || '(unnamed)';
          const rel = cell(d?.path ?? '');
          const desc = cell(d?.description ?? '');
          const pathCell = rel ? `\`${rel}\`` : '_(없음)_';
          return `| ${meta.emoji} ${meta.label} | ${name} | ${pathCell} | ${desc} |`;
        })
        .join('\n')
    : '| ⚫ pending | _(없음)_ | _(없음)_ | 문서 항목이 제공되지 않음 |';

  return (
    '# DOCS-INDEX\n\n'
    + '> Genesis 청사진 — 문서 인덱스 / 상태 추적. 자동 생성, 비파괴.\n'
    + '> 새 세션에서 컨텍스트 복원 시 가장 먼저 확인하세요. stale 문서를 표면화합니다.\n\n'
    + `${legend}\n\n`
    + '## 문서 목록\n\n'
    + `${tableHead}\n${tableBody}\n`
  );
}

/**
 * Write the rendered docs index to `docs/DOCS-INDEX.md` under `projectRoot`.
 * Non-destructive: collisions get a `-NN` suffix. Failure-tolerant.
 *
 * @param {object} args
 * @param {string} args.projectRoot - Absolute project root.
 * @param {DocEntry[]} args.docs - Document entries (see {@link renderDocsIndex}).
 * @param {(() => Date)|Date} [args.now] - Injectable clock.
 * @returns {Promise<{ ok: boolean, indexPath?: string, error?: string }>}
 */
export async function writeDocsIndex({ projectRoot, docs, now } = {}) {
  try {
    if (!projectRoot) return { ok: false, error: 'projectRoot required' };
    const when = resolveNow(now);
    const dir = path.join(projectRoot, 'docs');
    const indexPath = await nonCollidingPath(dir, 'DOCS-INDEX', '.md');
    const body = renderDocsIndex(docs);
    const content = `${body}\n---\n생성: ${humanStamp(when)}\n`;
    await atomicWriteText(indexPath, content);
    return { ok: true, indexPath };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}
