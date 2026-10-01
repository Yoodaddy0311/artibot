/**
 * The reviewer's final answer, read from its subagent transcript — the bounded
 * tail only.
 *
 * Moved VERBATIM out of `scripts/hooks/_review-stop-record.js` on 2026-09-30 so
 * that file has room under the 800-line guidance (it stood at 798); behaviour is
 * unchanged, and so is the hook's contract — the recorder still DECIDES NOTHING.
 * What stayed behind is `reviewerText`, because it reads the hook PAYLOAD
 * (`last_assistant_message`) and the payload is the hook's, not this module's.
 *
 * WHY A TAIL. The wanted line is the LAST assistant turn, so a tail is
 * sufficient and a hook must not grow with a transcript that has no bound.
 * NEVER THROWS: a missing, unreadable, corrupt or empty transcript yields null,
 * which costs the review line and nothing else. The first line of the window is
 * dropped when the read started mid-file, because a byte-offset read almost
 * always lands mid-line and a truncated object that happens to parse is worse
 * than a line not read.
 *
 * L2: node built-ins only.
 *
 * @module lib/review/stop-transcript
 */

import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';

/**
 * How far back a subagent transcript is read, in bytes. The wanted line is the
 * LAST assistant turn, so a tail is sufficient and a hook must not grow with a
 * transcript that has no bound.
 * @type {number}
 */
export const TRANSCRIPT_TAIL_BYTES = 8 * 1024 * 1024;

/**
 * Parse one transcript line, or null. A line that is not a whole JSON object is
 * skipped rather than fatal: a transcript is written by another process and may
 * be mid-append while this hook reads it.
 *
 * @param {unknown} line one raw line
 * @returns {object|null} the parsed entry
 */
function parseTranscriptLine(line) {
  try {
    const trimmed = String(line).trim();
    if (!trimmed.startsWith('{')) return null;
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Scan backwards for the last `type:"assistant"` entry carrying a message.
 *
 * BACKWARDS, not forwards: a reviewer's final answer is its last turn, and a
 * forward scan of a long transcript would both cost more and pick the wrong
 * turn. The LAST line is often not an assistant line (a summary or a tool
 * result follows), which is why this looks for the last of a KIND.
 *
 * @param {string[]} lines transcript lines in file order
 * @returns {object|null} the entry
 */
function findLastAssistantEntry(lines) {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const entry = parseTranscriptLine(lines[i]);
    const message = entry?.message;
    if (entry?.type === 'assistant' && message && typeof message === 'object') return entry;
  }
  return null;
}

/**
 * The last assistant entry of a subagent transcript, read from a bounded tail.
 *
 * NEVER THROWS. A missing, unreadable, corrupt or empty transcript yields null,
 * which costs the review line and nothing else. The first line of the window is
 * dropped when the read started mid-file, because a byte-offset read almost
 * always lands mid-line and a truncated object that happens to parse is worse
 * than a line not read.
 *
 * @param {unknown} transcriptPath `agent_transcript_path` from the payload
 * @returns {object|null} the entry
 */
export function readLastAssistantEntry(transcriptPath) {
  let fd = null;
  try {
    if (typeof transcriptPath !== 'string' || transcriptPath.length === 0) return null;
    if (!existsSync(transcriptPath)) return null;
    const size = statSync(transcriptPath).size;
    const start = size > TRANSCRIPT_TAIL_BYTES ? size - TRANSCRIPT_TAIL_BYTES : 0;
    const length = size - start;
    if (length <= 0) return null;
    const buf = Buffer.alloc(length);
    fd = openSync(transcriptPath, 'r');
    readSync(fd, buf, 0, length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    return findLastAssistantEntry(lines);
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* noop */ }
    }
  }
}

/**
 * The text of an assistant entry: its `content` string, or every text block of
 * its content array joined. Blocks that are not text (tool uses, thinking) are
 * dropped rather than stringified — a JSON blob of a tool call is not an answer.
 *
 * @param {object|null} entry {@link readLastAssistantEntry} output
 * @returns {string|null} the text, or null when there is none
 */
export function assistantEntryText(entry) {
  const content = entry?.message?.content;
  if (typeof content === 'string') return content.trim() === '' ? null : content;
  if (!Array.isArray(content)) return null;
  const parts = [];
  for (const block of content) {
    if (block && typeof block === 'object' && typeof block.text === 'string') parts.push(block.text);
  }
  const joined = parts.join('\n');
  return joined.trim() === '' ? null : joined;
}

/**
 * The model that served the reviewer's final turn, from the transcript only.
 *
 * @param {object|null} entry the already-read transcript entry
 * @returns {string|null} an exact provider model id, or null
 */
export function reviewerModel(entry) {
  const model = entry?.message?.model;
  return typeof model === 'string' && model.trim() !== '' ? model : null;
}
