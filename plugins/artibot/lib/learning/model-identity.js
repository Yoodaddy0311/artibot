/**
 * Model identity resolution for learning records.
 *
 * The learning store (evaluations.json, daily-experiences.json) historically
 * recorded *what* happened but never *which model* produced it, so questions
 * like "does model X score worse than model Y" were unanswerable after the
 * fact. Claude Code transcripts are the only authoritative source of the
 * **effective** model: `settings.json#model` is a declaration (it can be
 * overridden per-session, per-subagent, or by the model picker), whereas each
 * assistant entry in the transcript JSONL carries the model id the API
 * actually served.
 *
 * This module reads that transcript and produces a compact attribution record
 * that callers attach to learning rows.
 *
 * @module lib/learning/model-identity
 */

import { createReadStream, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';

/**
 * Placeholder model id emitted by the harness for locally synthesized
 * assistant entries (interrupts, injected notices). Not a served model, so it
 * is counted separately and never chosen as the primary.
 */
const SYNTHETIC_MODEL = '<synthetic>';

/**
 * Empty attribution, returned whenever no transcript is readable. Callers can
 * persist this as-is: `source: 'none'` marks the row as unattributed rather
 * than silently mislabeling it.
 * @returns {object}
 */
export function emptyAttribution() {
  return {
    source: 'none',
    primary: null,
    turns: 0,
    sidechainTurns: 0,
    mix: {},
    sidechainMix: {},
    effortMix: {},
    syntheticTurns: 0,
  };
}

/**
 * Pick the most frequently served model from a count map.
 * Ties break on the lexicographically smaller id so the result is stable.
 *
 * @param {Record<string, number>} mix - Model id -> turn count
 * @returns {string | null} Dominant model id, or null when the map is empty
 */
export function pickPrimary(mix) {
  const entries = Object.entries(mix ?? {});
  if (entries.length === 0) return null;
  const sorted = [...entries].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
  return sorted[0][0];
}

/**
 * Increment a key in a count map, returning a new map (immutable pattern).
 * @param {Record<string, number>} mix
 * @param {string} key
 * @returns {Record<string, number>}
 */
function bump(mix, key) {
  return { ...mix, [key]: (mix[key] ?? 0) + 1 };
}

/**
 * Fold one parsed transcript entry into the running accumulator.
 * Non-assistant entries and entries without a model id are ignored.
 *
 * @param {object} acc - Accumulator
 * @param {object} entry - Parsed JSONL entry
 * @returns {object} New accumulator
 */
function foldEntry(acc, entry, forceSidechain = false) {
  if (entry?.type !== 'assistant') return acc;
  const model = entry.message?.model;
  if (typeof model !== 'string' || model.length === 0) return acc;

  if (model === SYNTHETIC_MODEL) {
    return { ...acc, syntheticTurns: acc.syntheticTurns + 1 };
  }

  const effort = typeof entry.effort === 'string' && entry.effort.length > 0
    ? entry.effort
    : 'unspecified';

  const isSidechain = forceSidechain || entry.isSidechain === true;

  return {
    ...acc,
    turns: acc.turns + 1,
    effortMix: bump(acc.effortMix, effort),
    ...(isSidechain
      ? { sidechainTurns: acc.sidechainTurns + 1, sidechainMix: bump(acc.sidechainMix, model) }
      : { mix: bump(acc.mix, model) }),
  };
}

/**
 * Stream one JSONL file into the accumulator. Malformed lines are skipped and
 * a truncated or locked file keeps whatever was already folded — a partial
 * read is better attribution than none.
 *
 * @param {object} acc - Accumulator
 * @param {string} filePath
 * @param {boolean} asSidechain - Count every turn as subagent work
 * @returns {Promise<object>} New accumulator
 */
async function foldFile(acc, filePath, asSidechain) {
  let next = acc;
  try {
    const stream = createReadStream(filePath, { encoding: 'utf-8' });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of lines) {
      if (line.length === 0) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      next = foldEntry(next, entry, asSidechain);
    }
  } catch {
    return next;
  }
  return next;
}

/**
 * List the subagent transcripts belonging to a session.
 *
 * Claude Code stores them as siblings of the main file, not inline:
 *   `<project>/<session-id>.jsonl`            <- main thread
 *   `<project>/<session-id>/subagents/*.jsonl` <- one file per subagent
 *
 * Reading only the main file would make `sidechainMix` permanently empty
 * (in-line `isSidechain` entries do not occur in this layout), so delegated
 * work would be invisible to attribution.
 *
 * @param {string} transcriptPath - Path to the main session .jsonl
 * @returns {string[]} Absolute subagent transcript paths (empty if none)
 */
function listSubagentTranscripts(transcriptPath) {
  const dir = transcriptPath.replace(/\.jsonl$/i, '');
  const subagentsDir = path.join(dir, 'subagents');
  try {
    return readdirSync(subagentsDir)
      .filter(name => name.endsWith('.jsonl'))
      .map(name => path.join(subagentsDir, name));
  } catch {
    return [];
  }
}

/**
 * Read a Claude Code session and summarize which models served it.
 *
 * Covers the main thread AND every subagent transcript of the same session.
 * The two are counted separately on purpose: the agent model policy can differ
 * from the session model, and in a delegation-heavy setup most turns are
 * subagent turns — collapsing them would attribute all work to the leader.
 *
 * Never throws: an unreadable, missing, or malformed transcript yields
 * `emptyAttribution()` so a learning hook can never fail the session on it.
 *
 * @param {string} transcriptPath - Absolute path to the session .jsonl
 * @returns {Promise<{
 *   source: 'transcript' | 'none',
 *   primary: string | null,
 *   turns: number,
 *   sidechainTurns: number,
 *   mix: Record<string, number>,
 *   sidechainMix: Record<string, number>,
 *   effortMix: Record<string, number>,
 *   syntheticTurns: number
 * }>}
 */
export async function resolveTranscriptModels(transcriptPath) {
  if (typeof transcriptPath !== 'string' || transcriptPath.length === 0) {
    return emptyAttribution();
  }

  let acc = { ...emptyAttribution(), source: 'transcript' };
  acc = await foldFile(acc, transcriptPath, false);
  for (const file of listSubagentTranscripts(transcriptPath)) {
    acc = await foldFile(acc, file, true);
  }

  if (acc.turns === 0 && acc.syntheticTurns === 0) return emptyAttribution();

  return { ...acc, primary: pickPrimary(acc.mix) };
}

/**
 * Reduce a full attribution to the shape stored on learning rows.
 *
 * `model` is the **session leader** model (main thread). `subagentMix` is kept
 * alongside it rather than dropped: with 28 agents on one tier the two agree,
 * but the moment tiers diverge a session's score belongs partly to whichever
 * models did the delegated work — and a record that only named the leader
 * would silently misattribute it.
 *
 * @param {object} attribution - Result of {@link resolveTranscriptModels}
 * @returns {{
 *   model: string | null,
 *   modelMix: Record<string, number>,
 *   subagentMix: Record<string, number>,
 *   modelSource: string
 * }}
 */
export function toRecordFields(attribution) {
  const a = attribution ?? emptyAttribution();
  return {
    model: a.primary ?? null,
    modelMix: a.mix ?? {},
    subagentMix: a.sidechainMix ?? {},
    modelSource: a.source ?? 'none',
  };
}
