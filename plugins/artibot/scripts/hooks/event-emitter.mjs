#!/usr/bin/env node
/**
 * Hook Event Emitter — local observability fan-out.
 *
 * Reads a Claude Code hook payload from stdin, normalizes it into the
 * Artibot envelope schema (see skills/hook-event-emitter/references/dashboard-schema.md),
 * redacts sensitive fields, and appends it to a daily JSONL queue in
 * runtime/events/. Emits stdout {"continue": true} to keep the hook
 * pipeline unblocked even on failure.
 *
 * Data policy: localhost only. Never transmit to external services.
 *
 * @module scripts/hooks/event-emitter
 */

import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJSON, readStdin, writeStdout } from '../utils/index.js';
import { redactObject } from '../../lib/core/redaction.js';

const ENVELOPE_VERSION = 1;
const EMITTER_NAME = 'artibot';
const EMITTER_VERSION = '0.5.0';
const MAX_PAYLOAD_BYTES = 16 * 1024;

const REDACT_EVENTS = new Set([
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'SubagentStop',
  'ErrorRaised',
]);

const KNOWN_EVENTS = new Set([
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SubagentStop',
  'PreCompact',
  'Notification',
  'TaskCreated',
  'TaskCompleted',
  'ErrorRaised',
]);

/**
 * Resolve plugin root from this script's location.
 * @returns {string}
 */
function resolvePluginRoot() {
  const here = dirname(fileURLToPath(import.meta.url));
  // scripts/hooks → scripts → plugin root
  return resolve(here, '..', '..');
}

/**
 * Resolve the daily JSONL path.
 * @param {Date} now
 * @returns {string}
 */
export function resolveEventFile(now = new Date()) {
  const root = resolvePluginRoot();
  const day = now.toISOString().slice(0, 10);
  return join(root, 'runtime', 'events', `${day}.jsonl`);
}

/**
 * Map raw Claude Code hook input to a canonical event name.
 * Falls back to "Unknown" when the hook payload is unrecognized.
 * @param {object | null} raw
 * @returns {string}
 */
export function detectEventName(raw) {
  if (!raw || typeof raw !== 'object') return 'Unknown';
  const candidate = raw.hook_event_name || raw.event || raw.type;
  if (typeof candidate === 'string' && KNOWN_EVENTS.has(candidate)) {
    return candidate;
  }
  // Heuristic fallbacks
  if (raw.tool_name && raw.tool_response !== undefined) return 'PostToolUse';
  if (raw.tool_name) return 'PreToolUse';
  if (raw.prompt) return 'UserPromptSubmit';
  return typeof candidate === 'string' ? candidate : 'Unknown';
}

/**
 * Shape the payload for a given event type.
 * @param {string} eventName
 * @param {object} raw
 * @returns {object}
 */
export function buildPayload(eventName, raw) {
  switch (eventName) {
    case 'PreToolUse':
      return { input: raw.tool_input ?? raw.input ?? {} };
    case 'PostToolUse':
      return {
        ok: raw.ok ?? raw.success ?? true,
        durationMs: raw.duration_ms ?? raw.durationMs ?? 0,
        output: raw.tool_response ?? raw.output ?? null,
        errorMessage: raw.error_message ?? raw.errorMessage,
      };
    case 'UserPromptSubmit':
      return {
        prompt: raw.prompt ?? '',
        chars: typeof raw.prompt === 'string' ? raw.prompt.length : 0,
      };
    case 'SessionStart':
      return { cwd: raw.cwd ?? '', model: raw.model ?? '', source: raw.source };
    case 'SessionEnd':
      return {
        durationMs: raw.duration_ms ?? 0,
        endedBy: raw.ended_by ?? 'stop',
        toolCallCount: raw.tool_call_count,
      };
    case 'ErrorRaised':
      return {
        scope: raw.scope ?? 'hook',
        message: raw.message ?? 'unknown error',
        stack: raw.stack,
      };
    default:
      return raw.payload ?? {};
  }
}

/**
 * Truncate oversized payloads to protect dashboard parsers.
 * @param {object} payload
 * @returns {{ payload: object, truncated: boolean }}
 */
export function clampPayload(payload) {
  const serialized = JSON.stringify(payload);
  if (serialized.length <= MAX_PAYLOAD_BYTES) {
    return { payload, truncated: false };
  }
  return {
    payload: { truncatedPreview: serialized.slice(0, MAX_PAYLOAD_BYTES) },
    truncated: true,
  };
}

/**
 * Compose the full envelope.
 * @param {object | null} raw
 * @returns {object}
 */
export function buildEnvelope(raw) {
  const eventName = detectEventName(raw);
  const rawPayload = buildPayload(eventName, raw ?? {});
  const maybeRedacted = REDACT_EVENTS.has(eventName)
    ? redactObject(rawPayload)
    : rawPayload;
  const { payload, truncated } = clampPayload(maybeRedacted);

  const envelope = {
    v: ENVELOPE_VERSION,
    timestamp: new Date().toISOString(),
    event: eventName,
    sessionId: raw?.session_id ?? raw?.sessionId ?? 'system',
    payload,
    meta: {
      emitter: EMITTER_NAME,
      emitterVersion: EMITTER_VERSION,
      host: 'local',
      pid: process.pid,
      ...(truncated ? { truncated: true } : {}),
    },
  };

  if (eventName === 'PreToolUse' || eventName === 'PostToolUse') {
    envelope.tool = raw?.tool_name ?? raw?.tool ?? 'unknown';
  }
  return envelope;
}

/**
 * Append an envelope line to today's JSONL file.
 * Creates the events directory on first use.
 * @param {object} envelope
 */
export function appendEnvelope(envelope) {
  const file = resolveEventFile();
  const dir = dirname(file);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  appendFileSync(file, JSON.stringify(envelope) + '\n', 'utf8');
}

/**
 * TODO: WebSocket broadcast to a localhost-only server.
 * The emitter hook is a short-lived process, so the broadcaster must be
 * a separate long-running localhost service. When wired, send the envelope
 * as NDJSON over a TCP connect to 127.0.0.1:ARTIBOT_EMITTER_PORT with a
 * 50ms timeout, fire-and-forget. Never bind to 0.0.0.0.
 *
 * @param {object} _envelope
 */
export function broadcastEnvelope(_envelope) {
  // Intentionally left as a stub — see SKILL.md Step 4.
}

async function main() {
  const raw = await readStdin();
  const hookInput = parseJSON(raw);

  try {
    const envelope = buildEnvelope(hookInput);
    appendEnvelope(envelope);
    broadcastEnvelope(envelope);
  } catch (err) {
    process.stderr.write(
      `[artibot:event-emitter] failed: ${err?.message ?? String(err)}\n`
    );
  }

  // Claude Code hook contract: stdout controls the pipeline.
  writeStdout({ continue: true });
}

main().catch((err) => {
  process.stderr.write(
    `[artibot:event-emitter] fatal: ${err?.message ?? String(err)}\n`
  );
  // Still keep the hook pipeline unblocked.
  writeStdout({ continue: true });
});
