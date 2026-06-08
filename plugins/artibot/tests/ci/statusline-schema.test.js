/**
 * Tripwire: statusline.sh must read the OFFICIAL Claude Code statusLine stdin
 * schema, not the fields an early version assumed.
 *
 * Why: the script silently read `.context_window.current_tokens` /
 * `.max_tokens` / `.cost.total_cost` / `.cost.elapsed_seconds` / `.model`
 * (as a string) — none of which exist in the real statusLine payload. The
 * context-usage % bar therefore never rendered. This test fails CI if the
 * correct field names ever regress out of the script.
 *
 * Official schema (per Claude Code docs):
 *   context_window.used_percentage | .total_input_tokens | .context_window_size
 *   cost.total_cost_usd | cost.total_duration_ms
 *   model.display_name | model.id
 *
 * @module tests/ci/statusline-schema
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PLUGIN_ROOT = join(__dirname, '..', '..');
const statusline = readFileSync(join(PLUGIN_ROOT, 'scripts', 'hooks', 'statusline.sh'), 'utf8');

describe('statusline.sh reads the official Claude Code statusLine schema', () => {
  it('reads context_window.used_percentage (the pre-computed %)', () => {
    expect(statusline).toMatch(/\.context_window\.used_percentage/);
  });

  it('reads context_window.context_window_size (not max_tokens as primary)', () => {
    expect(statusline).toMatch(/\.context_window\.context_window_size/);
  });

  it('reads context_window.total_input_tokens as the token fallback', () => {
    expect(statusline).toMatch(/\.context_window\.total_input_tokens/);
  });

  it('reads cost.total_cost_usd', () => {
    expect(statusline).toMatch(/\.cost\.total_cost_usd/);
  });

  it('reads cost.total_duration_ms', () => {
    expect(statusline).toMatch(/\.cost\.total_duration_ms/);
  });

  it('reads model.display_name / model.id (model is an object, not a string)', () => {
    expect(statusline).toMatch(/\.model\.display_name/);
    expect(statusline).toMatch(/\.model\.id/);
  });
});
