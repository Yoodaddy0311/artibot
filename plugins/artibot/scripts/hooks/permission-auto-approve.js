#!/usr/bin/env node
/**
 * PermissionRequest auto-approve hook.
 *
 * Reads `artibot.config.json.permissions` (an allowlist of `{tool, command?}`
 * patterns) and silently auto-approves matching tool calls so non-developer
 * users don't see permission dialogs for routine, safe operations.
 *
 * Defaults are conservative: ONLY the user-defined allowlist auto-approves.
 * All other requests fall through (no decision emitted), preserving the
 * default Claude Code permission flow.
 *
 * ── DANGER FILTER CONTRACT ──────────────────────────────────────────────────
 *  An allowlist match is NECESSARY but NOT SUFFICIENT. A `{tool:'*'}` entry
 *  used to auto-approve a force push; it no longer can. After a match, a Bash
 *  call is put to the UNION of the two judges that actually block Bash at
 *  PreToolUse, and any hit withholds the approval:
 *    - `lib/core/guard-registry.js#executeChain` ('pre' phase, built-in guards
 *      incl. the `dangerous-command` guard over
 *      `lib/core/blocked-patterns.js#BLOCKED_PATTERNS`), and
 *    - `lib/autopilot/safety.js#classifyRisk` (`danger` level).
 *  The union is load-bearing because the two lists genuinely differ (measured
 *  2026-09-11): a bare `TRUNCATE users;` and a naked `sk-…` key literal pass the
 *  guard and are `danger` to classifyRisk, while a file-to-file
 *  `dd if=a.img of=b.img` is blocked by the guard and `safe` to classifyRisk.
 *
 *  The verdict is a function of the COMMAND STRING ALONE — no cwd is read or
 *  passed. Both judges are synchronous regex matchers, so there is no timeout
 *  axis. All three pre/Bash guards are `security-critical`, which is exactly
 *  why cwd cannot change the answer: they run everywhere.
 *
 *  Bash 인데 command 가 문자열이 아니면 판정 불가로 보류한다.
 *
 *  Withholding means NO DECISION — this hook never emits `deny`. It only
 *  declines to spend its one privilege, handing the call back to the normal
 *  permission flow (and to the PreToolUse hooks that will block it anyway).
 *  A judge that throws withholds too (fail-closed).
 *
 * ── 이 필터가 못 보는 것 ─────────────────────────────────────────────────────
 *  Write/Edit 는 allowlist 매치 시 필터 없이 allow — cwd 비의존 파괴 판정 정본 부재, 후속 결정
 *
 *  두 목록 밖 파괴 명령은 통과한다. 합집합은 어느 한쪽만 쓸 때보다 넓을 뿐이고,
 *  충분하다는 뜻이 아니다 — 이 필터의 상한은 두 정본 목록의 상한이다.
 *
 *  통과(allow)는 안전 증명이 아니라 "이 훅이 아는 두 목록에 안 걸렸다"일 뿐이다.
 *  실제 차단은 PreToolUse 가 한다. 이 훅은 승인을 아낄 뿐 거부하지 않는다.
 *
 * Hook attachment (hooks.json): PermissionRequest
 * Stdin: { tool_name, tool_input, permission_suggestions, ... }
 * Stdout: optional { hookSpecificOutput: { hookEventName, decision: { behavior } } }
 * Stderr: one line per withheld approval; nothing otherwise.
 */

import { readFileSync } from 'node:fs';
import { parseJSON, readStdin, resolveConfigPath, writeStdout } from '../utils/index.js';
import { classifyRisk } from '../../lib/autopilot/safety.js';
import { executeChain, registerBuiltinGuards, resetGuards } from '../../lib/core/guard-registry.js';
import { isMainEntry } from './_main-entry.js';

/** Max chars of a judge reason echoed to stderr (keep the line readable). */
const REASON_ECHO_MAX = 200;

function loadAllowlist() {
  try {
    const cfgPath = resolveConfigPath('artibot.config.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    const list = cfg?.permissions?.autoApprove;
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/**
 * Test whether a tool call matches an allowlist entry.
 * @param {object} entry - { tool: string, commandPattern?: string (regex) }
 * @param {string} toolName
 * @param {object} toolInput
 * @returns {boolean}
 */
export function matchesAllowEntry(entry, toolName, toolInput) {
  if (!entry || typeof entry !== 'object') return false;
  if (entry.tool && entry.tool !== '*' && entry.tool !== toolName) return false;
  if (entry.commandPattern) {
    try {
      const re = new RegExp(entry.commandPattern);
      const cmd = toolInput?.command ?? toolInput?.file_path ?? '';
      if (typeof cmd !== 'string' || !re.test(cmd)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Collapse a judge reason to a single stderr-safe line.
 * @param {string} reason
 * @returns {string}
 */
function oneLine(reason) {
  const s = String(reason ?? '').replace(/\s+/g, ' ').trim();
  return s.length > REASON_ECHO_MAX ? `${s.slice(0, REASON_ECHO_MAX)}…` : s;
}

/**
 * The production judge: the union of the two canonical PreToolUse blockers.
 * Returns `null` when the call is clean, or the reason to withhold approval.
 *
 * Bash only. The pre/Write guards (`sensitive-file`, `content-secret`) are
 * `artibot-policy`, so `executeChain` skips them outside the plugin repo — a
 * cwd-dependent verdict is not a verdict, and this filter takes no cwd.
 *
 * @param {{toolName: string, toolInput: object}} call
 * @returns {{kind: 'destructive'|'guard-block'|'unjudgeable', reason: string}|null}
 */
export function defaultJudge({ toolName, toolInput }) {
  if (toolName !== 'Bash') return null;

  // A Bash call whose command we cannot read is not a call we cleared. Neither
  // judge can see a non-string, so "no match" here would mean "not looked at".
  const command = toolInput?.command;
  if (typeof command !== 'string' || !command) {
    return { kind: 'unjudgeable', reason: 'command is not a non-empty string' };
  }

  // Fresh registry each call — registerBuiltinGuards() appends, so reusing a
  // dirty registry would run every guard N times (pattern: pre-bash.js#main).
  resetGuards();
  registerBuiltinGuards();

  // No `cwd` option: all three pre/Bash guards are security-critical and run
  // under any cwd, so omitting it changes nothing except the dependency.
  const verdict = executeChain('pre', 'Bash', { tool_name: 'Bash', tool_input: toolInput });
  if (verdict?.decision === 'block') {
    const guardName = verdict.guardName || 'guard';
    // `guard-block` 은 도달 불가 — 가드 throw 시 executeChain 이 block+guardName 을 내는 경로 전용.
    return {
      kind: guardName === 'dangerous-command' ? 'destructive' : 'guard-block',
      reason: `${guardName}: ${verdict.reason}`,
    };
  }

  const risk = classifyRisk({ command });
  if (risk?.level === 'danger') {
    return { kind: 'destructive', reason: `${risk.matchedId}: ${risk.reason}` };
  }

  return null;
}

/**
 * Decide whether this hook spends its auto-approval on a tool call.
 * Pure: no I/O, no stdout — the caller owns both.
 *
 * @param {{toolName: string, toolInput: object, allowlist: object[]}} call
 * @param {{judge?: Function}} [deps] - `judge` is injected by tests.
 * @returns {{decision: 'allow'|null, withheld?: {kind: string, reason: string}}}
 */
export function evaluatePermission({ toolName, toolInput, allowlist }, deps = {}) {
  const judge = deps.judge || defaultJudge;
  const list = Array.isArray(allowlist) ? allowlist : [];
  if (list.length === 0) return { decision: null };

  const matched = list.find((e) => matchesAllowEntry(e, toolName, toolInput));
  if (!matched) return { decision: null };

  let withheld;
  try {
    withheld = judge({ toolName, toolInput });
  } catch (err) {
    // Fail-closed: a judge we cannot run is not a judge that cleared the call.
    return {
      decision: null,
      withheld: { kind: 'judge-error', reason: err?.message || String(err) },
    };
  }

  if (withheld) return { decision: null, withheld };
  return { decision: 'allow' };
}

export async function main() {
  const raw = await readStdin();
  let payload;
  try {
    payload = parseJSON(raw);
  } catch {
    return; // No decision — fall through
  }

  const toolName = payload?.tool_name;
  const toolInput = payload?.tool_input ?? {};
  if (!toolName) return;

  const { decision, withheld } = evaluatePermission({
    toolName,
    toolInput,
    allowlist: loadAllowlist(),
  });

  if (decision === 'allow') {
    writeStdout({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: {
          behavior: 'allow',
        },
      },
    });
    return;
  }

  // Withheld: stdout stays at zero bytes so the host sees no decision at all.
  if (withheld) {
    process.stderr.write(
      `[artibot] auto-approve withheld: ${withheld.kind} (${oneLine(withheld.reason)})\n`,
    );
  }
}

// Direct-run guard: importing this module (tests) must not execute the hook.
// main() blocks on stdin, so an import both hangs the importer and fires the
// hook's side effects. Production is unaffected — the dispatcher (or Claude
// Code) spawns this file as argv[1], so the guard passes there.
if (isMainEntry(import.meta.url)) {
  main().catch(() => {
    // Silent — never block on hook failure.
  });
}
