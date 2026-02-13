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
];

const SENSITIVE_FILENAMES = new Set([
  '.env',
  '.env.local',
  '.env.production',
  '.env.development',
  'credentials.json',
  'secrets.json',
  'serviceAccountKey.json',
]);

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

  writeStdout({ decision: 'approve' });
}

main().catch((err) => {
  process.stderr.write(`[artibot:pre-write] ${err.message}\n`);
  // On error, don't block the operation
  writeStdout({ decision: 'approve' });
});
