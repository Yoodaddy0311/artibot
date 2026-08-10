#!/usr/bin/env node
/**
 * Stop hook — Turn Recap.
 *
 * After each assistant turn, emits a one-line gray summary to stderr
 * showing what was just done (file edits, commands, reads, uncommitted files).
 *
 * Safety properties (must hold to avoid v4.5.6-class infinite loops):
 *   - Read-only: no file writes, no git mutations
 *   - Output channel: stderr ONLY (never decision/block, never additionalContext
 *     since Stop ignores it per Claude Code schema, see auto-review-trigger.js
 *     header for details)
 *   - Loop guard: skips entirely when stop_hook_active=true
 *   - Bounded scan: only reads transcript tail, capped command timeouts
 *   - Silent failure: any exception is swallowed, never throws
 *
 * Output format:
 *   [artibot:recap] ✏ 3 files · ⚙ 2 cmds · 📖 5 reads · 🌿 4 uncommitted
 *
 * Empty turns (no tool uses, no dirty files) emit nothing.
 *
 * @module scripts/hooks/stop-recap
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { readStdin } from '../utils/index.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK_NAME = 'stop-recap';

// DoS guard: cap transcript read at 4 MB. Long sessions can produce
// multi-MB JSONL files, but we only need the tail since the last user
// message. Reading more wastes time and memory.
const MAX_TRANSCRIPT_BYTES = 4 * 1024 * 1024;

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const CMD_TOOLS = new Set(['Bash', 'PowerShell']);
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob']);

/**
 * Tally a single tool_use block into the running counts.
 *
 * @param {{ name?: string, type?: string }} block
 * @param {{ edits: number, cmds: number, reads: number, agents: number }} counts
 */
function tallyBlock(block, counts) {
  if (block?.type !== 'tool_use') return;
  const name = block.name || '';
  if (EDIT_TOOLS.has(name)) counts.edits++;
  else if (CMD_TOOLS.has(name)) counts.cmds++;
  else if (READ_TOOLS.has(name)) counts.reads++;
  else if (name === 'Agent' || name === 'Task') counts.agents++;
}

/**
 * Parse a JSONL line and extract role + content blocks. Returns null on
 * malformed input.
 *
 * @param {string} line
 * @returns {{ role: string|null, content: any[] }|null}
 */
function parseTranscriptLine(line) {
  try {
    const obj = JSON.parse(line);
    const role = obj.message?.role || obj.role || obj.type || null;
    const content = obj.message?.content ?? obj.content ?? [];
    return { role, content: Array.isArray(content) ? content : [] };
  } catch {
    return null;
  }
}

/**
 * Read the JSONL transcript and count tool uses since the last user message.
 * Returns zeros on any failure.
 *
 * @param {string} transcriptPath
 * @returns {{ edits: number, cmds: number, reads: number, agents: number }}
 */
function countToolUsesSinceLastUser(transcriptPath) {
  const counts = { edits: 0, cmds: 0, reads: 0, agents: 0 };
  try {
    if (!existsSync(transcriptPath)) return counts;

    let raw = readFileSync(transcriptPath, 'utf-8');
    if (raw.length > MAX_TRANSCRIPT_BYTES) {
      raw = raw.slice(-MAX_TRANSCRIPT_BYTES);
    }

    const lines = raw.split('\n').filter(Boolean);
    let lastUserIdx = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      const parsed = parseTranscriptLine(lines[i]);
      if (parsed?.role === 'user') { lastUserIdx = i; break; }
    }
    if (lastUserIdx === -1) return counts;

    for (let i = lastUserIdx + 1; i < lines.length; i++) {
      const parsed = parseTranscriptLine(lines[i]);
      if (!parsed) continue;
      for (const block of parsed.content) tallyBlock(block, counts);
    }
  } catch { /* swallow all transcript errors */ }
  return counts;
}

/**
 * Count uncommitted files in the current repo. 0 on any failure.
 * @returns {number}
 */
function countDirtyFiles() {
  try {
    const out = execSync('git status --porcelain', {
      encoding: 'utf-8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    return out.split('\n').filter((line) => line.trim()).length;
  } catch {
    return 0;
  }
}

/**
 * Build the recap line. Returns empty string when nothing meaningful happened.
 *
 * @param {{ edits: number, cmds: number, reads: number, agents: number }} counts
 * @param {number} dirty
 * @returns {string}
 */
function formatRecap(counts, dirty) {
  const segs = [];
  if (counts.edits) segs.push(`✏ ${counts.edits} file${counts.edits === 1 ? '' : 's'}`);
  if (counts.cmds) segs.push(`⚙ ${counts.cmds} cmd${counts.cmds === 1 ? '' : 's'}`);
  if (counts.agents) segs.push(`🤖 ${counts.agents} agent${counts.agents === 1 ? '' : 's'}`);
  if (counts.reads) segs.push(`📖 ${counts.reads} read${counts.reads === 1 ? '' : 's'}`);
  if (dirty > 0) segs.push(`🌿 ${dirty} uncommitted`);
  return segs.length ? segs.join(' · ') : '';
}

export async function main() {
  let payload = {};
  try {
    const stdin = await readStdin();
    payload = stdin ? JSON.parse(stdin) : {};
  } catch { /* tolerate empty/malformed stdin */ }

  if (payload?.stop_hook_active) return;

  const transcriptPath = payload?.transcript_path;
  if (!transcriptPath) return;

  const counts = countToolUsesSinceLastUser(transcriptPath);
  const dirty = countDirtyFiles();
  const line = formatRecap(counts, dirty);
  if (!line) return;

  process.stderr.write(`[artibot:recap] ${line}\n`);
}

// Direct-run guard: importing this module (tests) must not execute the hook.
// main() blocks on stdin, so an import both hangs the importer and fires the
// hook's side effects. Production is unaffected — the dispatcher (or Claude
// Code) spawns this file as argv[1], so the guard passes there.
const isDirectRun = process.argv[1]
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectRun) {
  main().catch((err) => {
    // Last-resort guard: never let a recap failure surface to Claude Code.
    process.stderr.write(`[artibot:${HOOK_NAME}] ${err?.message || 'failed'}\n`);
  });
}
