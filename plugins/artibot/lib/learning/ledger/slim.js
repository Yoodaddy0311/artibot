/**
 * Conversation slimming (denoise) for the Ambient Conversation Ledger.
 *
 * Ports the claude-code branch of `save_log.py` (the downloaded log-hooks bundle)
 * to Node/ESM. Keeps only real user/assistant conversation lines and drops
 * tool_use / tool_result / thinking / isMeta / skill-listing noise. Kept lines
 * are returned VERBATIM (original JSONL strings, schema intact) so the ledger
 * stays valid JSONL in the source transcript schema.
 *
 * Phase 1 = claude-code only. The codex branch (event_msg / response_item) is
 * F-07 (P2) and intentionally not implemented here.
 *
 * Pure functions, no I/O — trivially testable.
 *
 * @module lib/learning/ledger/slim
 */

/**
 * Reduce a message `content` (string or block list) to its conversation text.
 * Ignores tool_use / tool_result / thinking blocks, so a line carrying only
 * those yields '' (and is dropped by {@link claudeHasText}).
 *
 * @param {unknown} content
 * @returns {string} Conversation text only, trimmed.
 */
export function contentText(content) {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .filter(
        (b) => b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string',
      )
      .map((b) => b.text)
      .join('\n')
      .trim();
  }
  return '';
}

/**
 * True if a claude-code transcript object is a real user/assistant turn that
 * carries conversation text. Skips isMeta lines — claude-code injects
 * slash-command output (e.g. /context), local-command stdout, and system
 * reminders as user messages flagged isMeta=true; these are not conversation
 * and can be huge.
 *
 * @param {unknown} obj - Parsed JSONL object.
 * @returns {boolean}
 */
export function claudeHasText(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (obj.type !== 'user' && obj.type !== 'assistant') return false;
  if (obj.isMeta) return false;
  const message = obj.message;
  return Boolean(message && typeof message === 'object' && contentText(message.content));
}

/**
 * Keep only conversation lines from an array of raw JSONL lines, verbatim.
 * Unparseable / blank lines are skipped. Returns the kept ORIGINAL line
 * strings (unchanged) — never a verbatim copy of the whole transcript: when no
 * conversation line is found the result is an empty array (caller persists
 * nothing), satisfying F-02 R3 (no full-transcript fallback).
 *
 * @param {string[]} lines - Raw JSONL line strings.
 * @returns {string[]} Kept conversation lines (subset of input, same order).
 */
export function slimLines(lines) {
  if (!Array.isArray(lines)) return [];
  const kept = [];
  for (const line of lines) {
    if (typeof line !== 'string') continue;
    const s = line.trim();
    if (!s) continue;
    let obj;
    try {
      obj = JSON.parse(s);
    } catch {
      continue;
    }
    if (claudeHasText(obj)) kept.push(line);
  }
  return kept;
}

/**
 * Convenience: slim a raw transcript string by splitting on newlines first.
 *
 * @param {string} raw - Full transcript text.
 * @returns {string[]} Kept conversation lines.
 */
export function slimRaw(raw) {
  if (typeof raw !== 'string' || !raw) return [];
  return slimLines(raw.split('\n'));
}
