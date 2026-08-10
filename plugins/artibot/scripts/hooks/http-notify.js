#!/usr/bin/env node
/**
 * HTTP Webhook Notification Hook.
 *
 * Sends HTTP POST notifications to configured webhook URLs on session events.
 * Supports Slack, Discord, and generic JSON formats.
 * Opt-in only: requires ARTIBOT_WEBHOOK_URL env var or config.
 *
 * Event types: session-complete, session-error, task-complete, team-complete
 *
 * @module scripts/hooks/http-notify
 */

import { parseJSON, readStdin, resolveConfigPath } from '../utils/index.js';
import { createErrorHandler } from '../../lib/core/hook-utils.js';
import {
  assertEgressAllowed,
  EgressBlockedError,
  loadAllowlist,
} from '../../lib/core/data-egress-guard.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** @typedef {'slack' | 'discord' | 'generic'} WebhookFormat */
/** @typedef {'session-complete' | 'session-error' | 'task-complete' | 'team-complete'} EventType */

/**
 * @typedef {object} WebhookConfig
 * @property {string} url - Webhook endpoint URL
 * @property {WebhookFormat} [format='generic'] - Payload format
 * @property {number} [timeoutMs=5000] - Request timeout in milliseconds
 */

/**
 * Detect webhook format from URL hostname.
 * @param {string} url - Webhook URL
 * @returns {WebhookFormat}
 */
export function detectFormat(url) {
  if (!url) return 'generic';
  if (url.includes('hooks.slack.com')) return 'slack';
  if (url.includes('discord.com/api/webhooks')) return 'discord';
  return 'generic';
}

/**
 * Build the webhook payload based on format.
 * @param {WebhookFormat} format - Target format
 * @param {EventType} eventType - Event type identifier
 * @param {object} data - Event data payload
 * @returns {object} Formatted payload
 */
export function buildPayload(format, eventType, data) {
  const summary = `[artibot] ${eventType}: ${data.sessionId || 'unknown'}`;

  if (format === 'slack') {
    return { text: summary };
  }
  if (format === 'discord') {
    return { content: summary };
  }
  return {
    event: eventType,
    timestamp: new Date().toISOString(),
    data: { ...data },
  };
}

/**
 * Load webhook configuration from environment or config file.
 * Returns null if no webhook is configured (opt-in behavior).
 * @returns {WebhookConfig | null}
 */
export function loadWebhookConfig() {
  const envUrl = process.env.ARTIBOT_WEBHOOK_URL;
  const envFormat = process.env.ARTIBOT_WEBHOOK_FORMAT;

  if (envUrl) {
    return {
      url: envUrl,
      format: envFormat || detectFormat(envUrl),
      timeoutMs: 5000,
    };
  }

  // Fallback: check artibot.config.json
  try {
    const configPath = resolveConfigPath('artibot.config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    const webhook = config?.hooks?.webhook;
    if (webhook?.url) {
      return {
        url: webhook.url,
        format: webhook.format || detectFormat(webhook.url),
        timeoutMs: webhook.timeoutMs ?? 5000,
      };
    }
  } catch {
    // Config not available — not an error
  }

  return null;
}

/**
 * Send an HTTP POST to the webhook URL.
 * Never throws — logs warnings on failure for graceful degradation.
 * @param {WebhookConfig} config - Webhook configuration
 * @param {object} payload - JSON payload to send
 * @returns {Promise<boolean>} true if sent successfully
 */
export async function sendWebhook(config, payload) {
  try {
    // DATA POLICY gate: refuse to send to any host outside the allowlist.
    // Webhooks (Slack/Discord) are by definition third-party; users must
    // opt the destination host in via ARTIBOT_ALLOW_EGRESS or allowlist.json.
    try {
      assertEgressAllowed(config.url, {
        allowlist: loadAllowlist(),
        reason: 'http-notify',
      });
    } catch (egressErr) {
      if (egressErr instanceof EgressBlockedError) {
        process.stderr.write(
          `[artibot:http-notify] Webhook blocked by DATA POLICY: ${egressErr.message}\n`,
        );
        return false;
      }
      throw egressErr;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? 5000);

    const response = await fetch(config.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!response.ok) {
      process.stderr.write(
        `[artibot:http-notify] Webhook returned ${response.status}\n`
      );
      return false;
    }

    return true;
  } catch (err) {
    const reason = err.name === 'AbortError' ? 'timeout' : err.message;
    process.stderr.write(`[artibot:http-notify] Webhook failed: ${reason}\n`);
    return false;
  }
}

/**
 * Determine the event type from hook data context.
 * @param {object | null} hookData - Parsed hook input
 * @returns {EventType}
 */
export function resolveEventType(hookData) {
  if (hookData?.errors?.length > 0) return 'session-error';
  if (hookData?.team_config) return 'team-complete';
  if (hookData?.completed_tasks?.length > 0) return 'task-complete';
  return 'session-complete';
}

/**
 * Build event data from hook input.
 * @param {object | null} hookData - Parsed hook input
 * @returns {object} Sanitized event data
 */
export function buildEventData(hookData) {
  return {
    sessionId: hookData?.session_id || `session-${Date.now()}`,
    completedTasks: hookData?.completed_tasks?.length || 0,
    errors: hookData?.errors?.length || 0,
    hasTeam: Boolean(hookData?.team_config),
    endedAt: new Date().toISOString(),
  };
}

export async function main() {
  const webhookConfig = loadWebhookConfig();
  if (!webhookConfig) {
    // Opt-in not configured — silent exit
    return;
  }

  const raw = await readStdin();
  const hookData = parseJSON(raw);

  const eventType = resolveEventType(hookData);
  const eventData = buildEventData(hookData);
  const payload = buildPayload(webhookConfig.format, eventType, eventData);

  const sent = await sendWebhook(webhookConfig, payload);

  if (sent) {
    process.stderr.write(`[artibot:http-notify] ${eventType} sent\n`);
  }
}

// Direct-run guard: importing this module (tests) must not execute the hook.
// main() blocks on stdin, so an import both hangs the importer and fires the
// hook's side effects. Production is unaffected — the dispatcher (or Claude
// Code) spawns this file as argv[1], so the guard passes there.
const isDirectRun = process.argv[1]
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectRun) {
  main().catch(createErrorHandler('http-notify', { exit: true }));
}
