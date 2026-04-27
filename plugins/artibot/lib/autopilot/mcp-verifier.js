/**
 * Autopilot MCP verifier.
 * Restricts MCP tool calls to Artibot's own plugin namespace and inspects
 * responses for outbound data exfiltration patterns.
 *
 * Reference: PRD docs/PRD/autopilot-mode.md sections 5.5 and 13.3 (DATA POLICY).
 *
 * @module lib/autopilot/mcp-verifier
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { getPluginRoot } from '../core/platform.js';

export const ALLOWED_PREFIX = 'plugin:artibot:';
export const DEFAULT_ALLOW_LIST = Object.freeze([
  'plugin:artibot:playwright',
  'plugin:artibot:context7',
]);

const ALLOWED_NAME_RE = /^plugin:artibot:[a-z0-9-]+$/;

const VIOLATION_PATTERNS = Object.freeze([
  {
    id: 'external-http-url',
    re: /https?:\/\/(?!localhost|127\.0\.0\.1|::1|0\.0\.0\.0)[\w.-]+/gi,
  },
  {
    id: 'public-ip',
    re: /\b(?!10\.|127\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|0\.0\.0\.0|169\.254\.)\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,
  },
  {
    id: 'cloud-host',
    re: /\.(s3|amazonaws|googleapis|blob\.core\.windows|firebaseio)\./gi,
  },
  { id: 'outbound-write', re: /\b(POST|PUT|PATCH)\s+https?:/gi },
  { id: 'auth-bearer', re: /Authorization:\s*Bearer/gi },
  { id: 'shell-exfil', re: /\b(curl|wget|nc)\s+(-\w+\s+)*https?:/gi },
]);

/**
 * Load the MCP allow list from artibot.config.json.
 * Falls back to safe defaults on read or parse failure.
 * @returns {{ entries: Set<string>, blockExternal: boolean, enabled: boolean }}
 */
export function loadAllowList() {
  const defaults = {
    entries: new Set(DEFAULT_ALLOW_LIST),
    blockExternal: true,
    enabled: false,
  };
  try {
    const cfgPath = path.join(getPluginRoot(), 'artibot.config.json');
    const raw = readFileSync(cfgPath, 'utf8');
    const cfg = JSON.parse(raw);
    const mcp = cfg && cfg.autopilot && cfg.autopilot.mcp;
    if (!mcp || typeof mcp !== 'object') return defaults;
    const list = Array.isArray(mcp.allowList) ? mcp.allowList : DEFAULT_ALLOW_LIST;
    return {
      entries: new Set(list.filter((v) => typeof v === 'string')),
      blockExternal: mcp.blockExternal !== false,
      enabled: mcp.enabled === true,
    };
  } catch {
    return defaults;
  }
}

/**
 * Check whether a given MCP tool name is allowed.
 * Combines strict prefix + format check with the configured allow list.
 * @param {string} toolName
 * @returns {boolean}
 */
export function isAllowed(toolName) {
  if (typeof toolName !== 'string' || toolName.length === 0) return false;
  if (!toolName.startsWith(ALLOWED_PREFIX)) {
    // R1: prefix spoof guard — only exact prefix match counts.
    return false;
  }
  if (ALLOWED_NAME_RE.test(toolName)) return true;
  // Fallback: explicit allow list match (e.g., for grandfathered names).
  const { entries } = loadAllowList();
  return entries.has(toolName);
}

/**
 * Wrap a planned MCP invocation as an instruction object.
 * No outbound call is performed — the engine routes this to the runner.
 * @param {string} toolName
 * @param {object} args
 * @returns {object}
 */
export function wrapInvocation(toolName, args) {
  const allowed = isAllowed(toolName);
  const instructions = [
    'Artibot 자체 plugin MCP만 호출하세요.',
    '외부 host로 데이터 송신 금지.',
    '응답을 받으면 validateMcpResponse(response)로 검증.',
  ];
  if (!allowed) {
    instructions.push(
      `차단됨: '${String(toolName)}'은(는) ${ALLOWED_PREFIX} 네임스페이스 또는 allow list에 없습니다.`,
    );
  }
  return {
    type: 'mcp-verify',
    toolName: typeof toolName === 'string' ? toolName : String(toolName),
    args: args && typeof args === 'object' ? args : {},
    allowed,
    prefix: ALLOWED_PREFIX,
    instructions,
  };
}

/**
 * Coerce any response shape to a string for pattern scanning.
 * @param {*} response
 * @returns {string}
 */
function toScanText(response) {
  if (response === null || response === undefined) return '';
  if (typeof response === 'string') return response;
  try {
    return JSON.stringify(response);
  } catch {
    return String(response);
  }
}

/**
 * Best-effort single-stage base64 decode of substrings >= 16 chars.
 * Returns concatenated decoded text for re-scanning (R2 obfuscation guard).
 * @param {string} text
 * @returns {string}
 */
function decodeBase64Chunks(text) {
  const matches = text.match(/[A-Za-z0-9+/]{16,}={0,2}/g);
  if (!matches) return '';
  const out = [];
  for (const m of matches) {
    try {
      const buf = Buffer.from(m, 'base64');
      const decoded = buf.toString('utf8');
      // Only keep printable decodes to avoid garbage noise.
      if (decoded && /[\x20-\x7e]/.test(decoded)) out.push(decoded);
    } catch {
      // ignore non-base64 strings
    }
  }
  return out.join('\n');
}

/**
 * Scan an MCP response for data-exfiltration indicators.
 * @param {*} response
 * @returns {{ ok: boolean, violations: Array<{id:string, sample:string}> }}
 */
export function validateMcpResponse(response) {
  const direct = toScanText(response);
  const decoded = decodeBase64Chunks(direct);
  const haystack = decoded ? `${direct}\n${decoded}` : direct;
  const violations = [];
  for (const { id, re } of VIOLATION_PATTERNS) {
    const rx = new RegExp(re.source, re.flags);
    const m = haystack.match(rx);
    if (m && m.length > 0) {
      violations.push({ id, sample: String(m[0]).slice(0, 80) });
    }
  }
  return { ok: violations.length === 0, violations };
}
