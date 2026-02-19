#!/usr/bin/env node
/**
 * PreToolUse hook for Write/Edit.
 * Warns if the target file is a sensitive file (.env, credentials, keys, etc.).
 */

import { readStdin, writeStdout, parseJSON } from '../utils/index.js';
import path from 'node:path';

const SENSITIVE_PATTERNS = [
  /\.env($|\.)/i,
  /credentials/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /secrets?\./i,
  /\.secret$/i,
  /id_rsa/i,
  /id_ed25519/i,
  /token\.json$/i,
  /service.account\.json$/i,
  /\.npmrc$/i,
  /\.netrc$/i,
  /_netrc$/i,
  /\.htpasswd$/i,
  /\.jks$/i,
  /kubeconfig/i,
  /\.docker\/config\.json$/i,
  /wp-config\.php$/i,
  /database\.yml$/i,
];

const SENSITIVE_FILENAMES = new Set([
  '.env',
  '.env.local',
  '.env.production',
  '.env.development',
  'credentials.json',
  'secrets.json',
  'serviceAccountKey.json',
  '.npmrc',
  '.netrc',
  '_netrc',
  '.htpasswd',
  'kubeconfig',
]);

const SECRET_CONTENT_PATTERNS = [
  /(?:api[_-]?key|secret[_-]?key|auth[_-]?token|access[_-]?token|private[_-]?key|password|passwd)\s*[=:]\s*["'][^"']{8,}["']/gi,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bghp_[A-Za-z0-9]{36}\b/g,
  /\bsk-ant-[A-Za-z0-9\-]{20,}\b/g,
  /\bsk-[A-Za-z0-9]{20,}\b/g,
];

async function main() {
  const raw = await readStdin();
  const hookData = parseJSON(raw);

  const filePath = hookData?.tool_input?.file_path || hookData?.tool_input?.path || '';
  if (!filePath) {
    writeStdout({ decision: 'approve' });
    return;
  }

  const basename = path.basename(filePath);
  const isSensitive =
    SENSITIVE_FILENAMES.has(basename) ||
    SENSITIVE_PATTERNS.some((pattern) => pattern.test(basename));

  if (isSensitive) {
    writeStdout({
      decision: 'block',
      reason: `SECURITY WARNING: "${basename}" appears to be a sensitive file. Writing to credential or secret files is blocked by default. If intentional, remove this hook temporarily.`,
    });
    return;
  }

  // Check content for hardcoded secrets (H3)
  const content = hookData?.tool_input?.content || hookData?.tool_input?.new_string || '';
  if (content) {
    const nonCommentLines = content
      .split('\n')
      .filter((line) => !/^\s*(\/\/|#|\/\*)/.test(line))
      .join('\n');
    for (const secretPattern of SECRET_CONTENT_PATTERNS) {
      secretPattern.lastIndex = 0;
      if (secretPattern.test(nonCommentLines)) {
        writeStdout({
          decision: 'block',
          reason: `SECURITY WARNING: The content being written appears to contain a hardcoded secret or credential. Writing hardcoded secrets is blocked by default. Remove the secret and use environment variables or a secrets manager instead.`,
        });
        return;
      }
    }
  }

  writeStdout({ decision: 'approve' });
}

main().catch((err) => {
  process.stderr.write(`[artibot:pre-write] ${err.message}\n`);
  writeStdout({ decision: 'block', reason: 'Safety check failed due to hook error. Blocking by default.' });
});
