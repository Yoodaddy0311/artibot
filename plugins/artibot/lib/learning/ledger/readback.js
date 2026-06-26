/**
 * Cross-session ambient read-back advisory (Roadmap N1 — see
 * docs/ROADMAP-CLAUDE-TAG-CONVERGENCE.md §3·§5; PRD F-05).
 *
 * Surfaces ONE advisory line about the most salient unresolved prior-session
 * signal at the start of a new session. Pure read-back: it reuses already-
 * persisted local artifacts (the `/save` handoff, pending wakeup markers, the
 * ambient ledger) and never issues a forced-execution signal.
 *
 * DATA POLICY: local file reads only · no network · advisory-only. Every public
 * and private function is best-effort and MUST NOT throw — a missing directory
 * or unreadable file is a normal path that simply skips that source.
 *
 * @module lib/learning/ledger/readback
 */

import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { readLatestHandoff } from '../../handoff/handoff-store.js';
import { readPendingWakeups } from '../wakeup-scheduler.js';
import { safeSession, _internals as storeInternals } from './store.js';

const { LEDGER_REL } = storeInternals;
const MAX_HEADLINE = 120;

/**
 * Strip markdown links/emphasis & collapse whitespace, capped at MAX_HEADLINE.
 * @param {string} text
 * @returns {string}
 */
function summarize(text) {
  const cleaned = String(text ?? '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // [label](url) -> label
    .replace(/[*_`>]/g, '') // markdown emphasis / blockquote marks
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > MAX_HEADLINE
    ? `${cleaned.slice(0, MAX_HEADLINE - 1)}…`
    : cleaned;
}

/**
 * Pull the `> 다음 P0:` blockquote summary from the latest handoff. Returns
 * null when there is no handoff or no P0 blockquote.
 * @param {string} projectRoot
 * @returns {Promise<string|null>}
 */
async function handoffHeadline(projectRoot) {
  try {
    const latest = await readLatestHandoff(projectRoot);
    const content = latest?.content;
    if (typeof content !== 'string') return null;
    const line = content
      .split('\n')
      .map((l) => l.trim())
      .find((l) => /^>\s*다음 P0:/.test(l));
    if (!line) return null;
    return summarize(line.replace(/^>\s*다음 P0:\s*/, '')) || null;
  } catch {
    return null;
  }
}

/**
 * One-line reason from a pending wakeup marker, if any. Best-effort: the marker
 * lives under the plugin root; when readback only knows a projectRoot that is
 * not the plugin root, this gracefully yields null.
 * @param {string} projectRoot
 * @returns {Promise<string|null>}
 */
async function wakeupHeadline(projectRoot) {
  try {
    const pending = await readPendingWakeups(projectRoot);
    const reason = pending?.[0]?.reason;
    return (typeof reason === 'string' && summarize(reason)) || null;
  } catch {
    return null;
  }
}

/**
 * Headline when a prior-session ledger (newest by mtime, excluding the current
 * session) exists. Returns null when the ledger dir is absent/empty or only
 * the current session's file is present.
 * @param {string} projectRoot
 * @param {string|undefined} currentSessionId
 * @returns {Promise<string|null>}
 */
async function ledgerHeadline(projectRoot, currentSessionId) {
  try {
    const dir = path.join(projectRoot, LEDGER_REL);
    const selfFile = `${safeSession(currentSessionId)}.jsonl`;
    let newest = null;
    for (const filename of await readdir(dir)) {
      if (!filename.endsWith('.jsonl')) continue;
      if (currentSessionId !== undefined && filename === selfFile) continue;
      try {
        const st = await stat(path.join(dir, filename));
        if (st.isFile() && (newest === null || st.mtimeMs > newest)) newest = st.mtimeMs;
      } catch { /* race-disappear: skip */ }
    }
    return newest === null ? null : '직전 세션 대화 기록 있음 — /resume 으로 복원';
  } catch {
    return null;
  }
}

/**
 * Build the cross-session read-back advisory. Tries handoff → wakeup → ledger;
 * the first non-empty headline becomes the advisory.
 *
 * @param {{ projectRoot: string, currentSessionId?: string }} opts
 * @returns {Promise<{ advisory: string|null, source: 'handoff'|'wakeup'|'ledger'|null, detail?: object }>}
 */
export async function buildReadbackAdvisory(opts) {
  const { projectRoot, currentSessionId } = opts ?? {};
  if (!projectRoot) return { advisory: null, source: null };

  const sources = [
    ['handoff', () => handoffHeadline(projectRoot)],
    ['wakeup', () => wakeupHeadline(projectRoot)],
    ['ledger', () => ledgerHeadline(projectRoot, currentSessionId)],
  ];

  for (const [source, fn] of sources) {
    // Each source fn is best-effort; the .catch is defense-in-depth only.
    const headline = await fn().catch(() => null);
    if (headline) {
      return {
        advisory: `[Artibot] 지난 세션: ${headline} · 자세히 /resume`,
        source,
        detail: { source, headline },
      };
    }
  }
  return { advisory: null, source: null };
}

// Test introspection surface (never relied on outside tests).
export const _internals = Object.freeze({ MAX_HEADLINE, summarize });
