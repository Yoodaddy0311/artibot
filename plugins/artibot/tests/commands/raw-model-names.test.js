/**
 * Raw model name gate for core command files.
 *
 * WHY: Commands that hardcode raw model identifiers (e.g., `model="opus"`,
 * "opus 4.8", "claude-sonnet-4-5") must be updated whenever a new model
 * generation ships — causing widespread manual churn. The authoritative
 * routing lives in `lib/core/model-catalog.js` (role aliases: frontier,
 * deep-async, balanced, fast) and `lib/core/model-policy.js`. Commands must
 * reference role aliases, not raw model strings.
 *
 * WHAT this test blocks:
 *   - `model="opus"` / `model="sonnet"` / `model="haiku"` / `model="fable"` in
 *     Task() call examples
 *   - Prose references like "opus 4.8", "sonnet 4.6", "haiku 3.5"
 *   - Full model IDs like "claude-opus-4-5", "claude-sonnet-4-6-20261101"
 *
 * ALLOWED (must NOT be flagged):
 *   - Role aliases: frontier, deep-async, balanced, fast
 *   - The words "opus", "sonnet", "haiku" inside code comments that explain
 *     the policy (those comments will not match the numeric suffix pattern)
 *   - This test file itself (not in scope)
 *
 * Scope: the 5 command files most likely to drift —
 *   plan.md, ultraplan.md, team.md, repo.md, autopilot.md
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMMANDS_DIR = path.resolve(__dirname, '../../commands');

/**
 * Matches raw model name patterns that should not appear in command files:
 *   model="opus"   model="sonnet"   model="haiku"   model="fable"
 *   opus 4.8       sonnet 4.6       haiku 3.5  (word + space + digit.digit)
 *   claude-opus-4-5-...  claude-sonnet-...  (full model IDs)
 *
 * The pattern is intentionally case-insensitive to catch "Opus 4.8" in prose.
 */
const RAW_MODEL_PATTERN =
  /model="(opus|sonnet|haiku|fable)"|(?:opus|sonnet|haiku)\s+4\.\d|(?:opus|sonnet|haiku)\s+3\.\d|claude-(?:opus|sonnet|haiku|fable)-[\w.-]+/i;

const TARGET_FILES = ['plan.md', 'ultraplan.md', 'team.md', 'repo.md', 'autopilot.md'];

describe('command files must not contain raw model names', () => {
  for (const filename of TARGET_FILES) {
    it(`${filename} has 0 raw model name matches`, async () => {
      const filepath = path.join(COMMANDS_DIR, filename);
      const content = await readFile(filepath, 'utf-8');

      // Collect all matching lines for a useful failure message
      const matchingLines = content
        .split('\n')
        .map((line, idx) => ({ line, lineNo: idx + 1 }))
        .filter(({ line }) => RAW_MODEL_PATTERN.test(line));

      if (matchingLines.length > 0) {
        const detail = matchingLines
          .map(({ lineNo, line }) => `  line ${lineNo}: ${line.trim()}`)
          .join('\n');
        expect.fail(
          `${filename} contains ${matchingLines.length} raw model name reference(s).\n` +
            `Replace with role aliases (frontier / deep-async / balanced / fast) via model-policy.\n\n` +
            `Matches:\n${detail}`,
        );
      }

      expect(matchingLines).toHaveLength(0);
    });
  }
});
