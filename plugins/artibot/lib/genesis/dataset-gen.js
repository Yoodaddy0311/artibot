/**
 * Genesis dataset generator — renders entity/field/relation SCHEMAS as markdown
 * tables and writes `docs/DATASETS.md`. SCHEMA-ONLY by construction.
 *
 * ★ DATA POLICY (code-enforced): this renderer reads ONLY schema metadata —
 *   `entity`, each field's `{ name, type, constraints, desc }`, and `relations`.
 *   Any actual data (e.g. a `rows` array, sample values, fixtures) present on
 *   the input is IGNORED and NEVER emitted. There is no code path that reads a
 *   `rows` key or arbitrary value fields, so real data cannot leak into output.
 *   See `tests/genesis/dataset-gen.test.js` schema-only gate for the assertion.
 *
 * Pure & non-destructive (collision → `-NN` suffix), Korean-path safe, atomic,
 * no network. The command/model builds the structured `schemas`; this module
 * only transforms the schema fields into markdown (IO boundary).
 *
 * @module lib/genesis/dataset-gen
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
 * @typedef {object} FieldSpec
 * @property {string} name - Field name.
 * @property {string} [type] - Declared type.
 * @property {string|string[]} [constraints] - Constraints (PK, NOT NULL, ...).
 * @property {string} [desc] - Human description.
 */

/**
 * @typedef {object} RelationSpec
 * @property {string} [type] - e.g. '1:N', 'N:M', '1:1'.
 * @property {string} [target] - Related entity name.
 * @property {string} [via] - Join field / FK.
 * @property {string} [desc] - Description.
 */

/**
 * @typedef {object} SchemaSpec
 * @property {string} entity - Entity name.
 * @property {FieldSpec[]} fields - Field definitions (metadata only).
 * @property {RelationSpec[]|string[]} [relations] - Relationship definitions.
 *   NOTE: any `rows`/data on this object is intentionally never read.
 */

/** Normalize constraints into a single display string. */
function fmtConstraints(constraints) {
  if (Array.isArray(constraints)) return constraints.map((c) => String(c)).join(', ');
  if (constraints === null || constraints === undefined) return '';
  return String(constraints);
}

/**
 * Render one entity's field table. Reads ONLY schema metadata per field —
 * never any data value.
 * @param {FieldSpec[]} fields
 * @returns {string}
 */
function renderFields(fields) {
  const list = Array.isArray(fields) ? fields : [];
  const head = '| 필드 | 타입 | 제약 | 설명 |\n|---|---|---|---|';
  if (!list.length) return `${head}\n| _(없음)_ | | | 필드 정의가 제공되지 않음 |`;
  const body = list
    .map((f) => `| ${cell(f?.name ?? '')} | ${cell(f?.type ?? '')} | `
      + `${cell(fmtConstraints(f?.constraints))} | ${cell(f?.desc ?? '')} |`)
    .join('\n');
  return `${head}\n${body}`;
}

/**
 * Render an entity's relations as a bullet list. Tolerates string or object
 * relation entries.
 * @param {RelationSpec[]|string[]} relations
 * @returns {string}
 */
function renderRelations(relations) {
  const list = Array.isArray(relations) ? relations : [];
  if (!list.length) return '_(관계 없음)_';
  return list
    .map((r) => {
      if (typeof r === 'string') return `- ${cell(r)}`;
      const type = r?.type ? `**${cell(r.type)}** ` : '';
      const target = r?.target ? `→ \`${cell(r.target)}\`` : '';
      const via = r?.via ? ` (via \`${cell(r.via)}\`)` : '';
      const desc = r?.desc ? ` — ${cell(r.desc)}` : '';
      return `- ${type}${target}${via}${desc}`.trim();
    })
    .join('\n');
}

/**
 * Render the full DATASETS markdown from schema specs. Pure (no IO, no clock).
 * SCHEMA-ONLY: only entity/field/relation metadata is read — never data values.
 *
 * @param {SchemaSpec[]} schemas
 * @returns {string}
 */
export function renderDatasets(schemas) {
  const list = Array.isArray(schemas) ? schemas : [];

  const summaryHead = '| 엔티티 | 필드 수 | 관계 수 |\n|---|---|---|';
  const summaryBody = list.length
    ? list
      .map((s) => {
        const fieldCount = Array.isArray(s?.fields) ? s.fields.length : 0;
        const relCount = Array.isArray(s?.relations) ? s.relations.length : 0;
        return `| \`${cell(s?.entity ?? '')}\` | ${fieldCount} | ${relCount} |`;
      })
      .join('\n')
    : '| _(없음)_ | 0 | 0 |';

  const entities = list.length
    ? list
      .map((s) => (
        `### \`${cell(s?.entity ?? '엔티티')}\`\n\n`
        + `${renderFields(s?.fields)}\n\n`
        + `**관계**\n\n${renderRelations(s?.relations)}`
      ))
      .join('\n\n')
    : '_(스키마가 제공되지 않음)_';

  return (
    '# DATASETS\n\n'
    + '> Genesis 청사진 — 데이터셋 스키마/계약 설계. '
    + '**스키마 정의만 (실데이터 0건, DATA POLICY).**\n\n'
    + '## 엔티티 요약\n\n'
    + `${summaryHead}\n${summaryBody}\n\n`
    + '## 엔티티 상세\n\n'
    + `${entities}\n`
  );
}

/**
 * Write the rendered datasets to `docs/DATASETS.md` under `projectRoot`.
 * Non-destructive: collisions get a `-NN` suffix. Failure-tolerant.
 * SCHEMA-ONLY: any data values on input are never read or written.
 *
 * @param {object} args
 * @param {string} args.projectRoot - Absolute project root.
 * @param {SchemaSpec[]} args.schemas - Schema specs (see {@link renderDatasets}).
 * @param {(() => Date)|Date} [args.now] - Injectable clock.
 * @returns {Promise<{ ok: boolean, datasetsPath?: string, error?: string }>}
 */
export async function writeDatasets({ projectRoot, schemas, now } = {}) {
  try {
    if (!projectRoot) return { ok: false, error: 'projectRoot required' };
    const when = resolveNow(now);
    const dir = path.join(projectRoot, 'docs');
    const datasetsPath = await nonCollidingPath(dir, 'DATASETS', '.md');
    const body = renderDatasets(schemas);
    const content = `${body}\n---\n생성: ${humanStamp(when)}\n`;
    await atomicWriteText(datasetsPath, content);
    return { ok: true, datasetsPath };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}
