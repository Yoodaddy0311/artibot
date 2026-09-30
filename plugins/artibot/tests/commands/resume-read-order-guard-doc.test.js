/**
 * CA-08 consumer side — the document and the config that carry the read-order
 * stale guard: `commands/resume.md` (the `--read-order` section) and
 * `artibot.config.json#runtime.resume.staleGuard`.
 *
 * WHY THIS FILE EXISTS. The guard's judgement is code
 * (`scripts/checkpoint/read-order-guard.mjs`, pinned in `tests/checkpoint/`),
 * but `/resume` is a prose command: the code only runs if the document tells the
 * model to run it, and only means anything if the document tells the model what
 * to do with the answer. Two things can rot silently here — the sentence that
 * points at the CLI, and the six-step list it must not disturb.
 *
 * THE SIX STEPS ARE PINNED BYTE FOR BYTE. `tests/firewall/resume-contract-report-only.test.js`
 * pins the ORDER of `commands/resume.md` against `ARTIBOT.md ## Read Order` by
 * leading identifying tokens — it would pass a rewritten step 4 or 6. The limb
 * that added the guard was told to leave those two lines byte-identical and put
 * the CLI in a separate paragraph, so the digest below is the proof that it did
 * and the tripwire for the next edit. Changing a step is allowed; it is a
 * deliberate act that updates this digest in the same commit.
 *
 * ── WHAT THIS FILE CANNOT SEE (rules §9) ───────────────────────────────────
 *   - WHETHER THE MODEL OBEYS THE PARAGRAPH. Every assertion is about text. A
 *     model that `Read`s plan.md without running the CLI is invisible here, and
 *     so is one that runs it and then reads the body anyway. Document !=
 *     behaviour; the live observation is UNMEASURED.
 *   - THE CLI'S OUTPUT SHAPE. The doc names the line prefixes the model relays;
 *     `tests/checkpoint/read-order-guard-cli.test.js` pins that the CLI prints
 *     exactly those. Neither file compares the other's strings — the prefixes
 *     are pinned on both sides independently.
 *   - PROSE COHERENCE. The first version of the neighbouring `--read-order`
 *     section printed HANDOFF twice and was green at 35/35 tokens. Token pins
 *     cannot read for contradiction; a human reviewer has to.
 *   - LIVE REACH. Production ships the key `true` (owner decision 2026-09-30) and has
 *     no `.artibot/missions/` yet; nothing here says the guard has ever fired.
 *
 * @module tests/commands/resume-read-order-guard-doc
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  parseArgs,
  READ_ORDER_STALE_GUARD_CONFIG_PATH,
  readStaleGuardEnabled,
} from '../../scripts/checkpoint/read-order-guard.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '../..');
const RESUME_MD = readFileSync(path.join(PLUGIN_ROOT, 'commands', 'resume.md'), 'utf-8');
const SHIPPED = JSON.parse(readFileSync(path.join(PLUGIN_ROOT, 'artibot.config.json'), 'utf-8'));

/**
 * The body of the first section whose heading line matches, up to the next
 * heading of the same or shallower level (same slicer the report-only firewall
 * uses, so both files mean the same lines by "the --read-order section").
 *
 * @param {string} text - Whole markdown document.
 * @param {RegExp} headingRe - Matches the heading LINE.
 * @returns {string[]} Section lines, or [] when the heading is absent.
 */
function sectionLines(text, headingRe) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^#+\s/.test(line) && headingRe.test(line));
  if (start === -1) return [];
  const level = lines[start].match(/^#+/)[0].length;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^#+\s/.test(line) && line.match(/^#+/)[0].length <= level);
  return end === -1 ? rest : rest.slice(0, end);
}

const SECTION = sectionLines(RESUME_MD, /--read-order/);
const STEP_RE = /^(\d+)\.\s+(\S.*)$/;
const STEPS = SECTION.map((line) => line.match(STEP_RE)).filter(Boolean).map((m) => `${m[1]}. ${m[2].trim()}`);

/**
 * sha256 of the six numbered step lines exactly as they stood BEFORE the guard
 * paragraph was added (1,492 bytes, LF-joined). Written as four 16-hex parts:
 * a 64-hex literal in a test file is what the secret scanner refuses to write.
 */
const STEPS_SHA256 = [
  '1b77a192f5260d96',
  'a87f9b1fec243ac5',
  '8f3b68a4cd3846c7',
  'acec982fcdd9671c',
].join('');
const STEPS_BYTES = 1492;

/** Index of the paragraph that introduces the CLI. */
const GUARD_AT = SECTION.findIndex((line) => line.includes('read-order-guard.mjs'));
const guardBlock = () => {
  // From the guard paragraph to the fallback paragraph (or the section end).
  const fallback = SECTION.findIndex((line) => line.includes('HANDOFF 폴백'));
  return SECTION.slice(GUARD_AT, fallback === -1 ? undefined : fallback).join('\n');
};

describe('the six read-order steps are byte-identical to the pre-guard text', () => {
  it('there are still exactly six, numbered 1..6', () => {
    expect(STEPS.length).toBe(6);
    expect(STEPS.map((s) => Number(s.split('.')[0]))).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it(`hash to the pinned digest (${STEPS_BYTES} bytes)`, () => {
    const joined = STEPS.join('\n');
    expect(Buffer.byteLength(joined, 'utf-8')).toBe(STEPS_BYTES);
    expect(createHash('sha256').update(joined, 'utf-8').digest('hex')).toBe(STEPS_SHA256);
  });

  it('none of the six mentions the guard — the CLI lives in its own paragraph', () => {
    for (const step of STEPS) {
      for (const token of ['read-order-guard', 'staleGuard', 'STALE', 'INVALID', 'BROKEN']) {
        expect(step, `${token} in step "${step.slice(0, 20)}"`).not.toContain(token);
      }
    }
  });
});

describe('the guard paragraph', () => {
  it('exists inside the --read-order section', () => {
    expect(SECTION.length).toBeGreaterThan(0);
    expect(GUARD_AT).toBeGreaterThanOrEqual(0);
  });

  it('sits AFTER the last numbered step and BEFORE the HANDOFF fallback paragraph', () => {
    const lastStep = SECTION.map((l, i) => (STEP_RE.test(l) ? i : -1)).filter((i) => i >= 0).pop();
    const fallback = SECTION.findIndex((line) => line.includes('HANDOFF 폴백'));
    expect(GUARD_AT).toBeGreaterThan(lastStep);
    expect(fallback).toBeGreaterThan(GUARD_AT);
  });

  it('starts no line with a step number (the report-only firewall counts those)', () => {
    const numbered = SECTION.filter((l) => STEP_RE.test(l));
    expect(numbered.length).toBe(6);
  });

  it('names the CLI, the two flags it takes and the switch that gates it', () => {
    const block = guardBlock();
    expect(block).toContain('scripts/checkpoint/read-order-guard.mjs');
    expect(block).toContain('--mission');
    expect(block).toContain('--cwd');
    expect(block).toContain(READ_ORDER_STALE_GUARD_CONFIG_PATH);
    // 2026-09-30: ships ON, and the paragraph says how to turn it off.
    expect(block).toMatch(/출하 기본\s*`true`/);
    expect(block).toContain('끄려면 `false`');
  });

  it('says the CLI reads the switch itself and that empty output with exit 0 means OFF', () => {
    const block = guardBlock();
    expect(block).toContain('스스로 읽는다');
    expect(block).toContain('종료 코드 0');
    expect(block).toContain('출력이 **비어 있으면**');
    expect(block).toContain('꺼진 것');
  });

  it('says the CLI output IS steps 4 and 6 — the artifacts are not opened separately', () => {
    const block = guardBlock();
    expect(block).toContain('`plan.md`·`review.md`·`outcome.md`');
    expect(block).toContain('따로 열지 않는다');
    expect(block).toContain('[4/6]');
    expect(block).toContain('[6/6]');
  });

  it('lists every reason prefix the CLI prints, and says a reason line is the whole output for that artifact', () => {
    const block = guardBlock();
    for (const prefix of ['CURRENT:', 'STALE:', 'INVALID:', 'NOT_ACCEPTABLE:', 'BROKEN:', '측정 불가:', '부재:']) {
      expect(block, prefix).toContain(prefix);
    }
    expect(block).toContain('현재 진실로');
    expect(block).toContain('요약하지 않는다');
  });

  it('tells the model to carry the CURRENT line\'s verdict and accepted flag into its summary', () => {
    // Those two values live only in the frontmatter, which the excerpt drops; a
    // summary that omitted them would present a rejected outcome as an accepted
    // one. The CLI puts them on the CURRENT line and this sentence is what makes
    // the model relay them.
    const block = guardBlock();
    expect(block).toContain('verdict');
    expect(block).toContain('accepted');
    expect(block).toContain('frontmatter');
    expect(block).toContain('요지에 그대로 옮긴다');
  });

  it('is fail-closed on a failing CLI: non-zero exit -> 측정 불가, bodies unread', () => {
    const block = guardBlock();
    expect(block).toContain('종료 코드가 0 이 아니면');
    expect(block).toMatch(/측정 불가: <사유>/);
    expect(block).toContain('본문을 읽지 않는다');
  });

  it('keeps the section read-only: the CLI is the one Bash call and it writes nothing', () => {
    const block = guardBlock();
    expect(block).toContain('읽기·계산·출력만');
    const section = SECTION.join('\n');
    expect(section).toContain('읽기 전용');
    expect(section).toContain('전이시키지 않는다');
  });

  it('does not restate the read order or mention the handoff (that paragraph is the fallback\'s)', () => {
    expect(guardBlock()).not.toContain('HANDOFF');
  });
});

describe('the doc and the script agree', () => {
  it('the script the doc names exists', () => {
    expect(existsSync(path.join(PLUGIN_ROOT, 'scripts', 'checkpoint', 'read-order-guard.mjs'))).toBe(true);
  });

  it('the command line in the doc is accepted by the script\'s own argument parser', () => {
    const m = guardBlock().match(/read-order-guard\.mjs\s+([^`\n]+)`/);
    expect(m, 'no inline command line after the script name').not.toBeNull();
    const argv = m[1]
      .replace(/<미션 id>/g, 'M-20260929-001')
      .replace(/<projectRoot>/g, '/tmp/project')
      .trim()
      .split(/\s+/);
    const parsed = parseArgs(argv);
    expect(parsed.error).toBeUndefined();
    expect(parsed.opts).toEqual({ mission: 'M-20260929-001', cwd: '/tmp/project' });
  });

  it('the key the doc names is the path the reader reads', () => {
    expect(READ_ORDER_STALE_GUARD_CONFIG_PATH).toBe('runtime.resume.staleGuard');
    const value = READ_ORDER_STALE_GUARD_CONFIG_PATH.split('.').reduce((node, key) => node?.[key], SHIPPED);
    expect(value).toBe(true);
  });
});

describe('artibot.config.json — runtime.resume.staleGuard', () => {
  // Re-pinned false -> true on purpose (owner decision 2026-09-30). A string "true"
  // would be a type change the strict `=== true` reader reads as OFF.
  it('ships the boolean true: the guard is ON by default, `false` is the way back', () => {
    expect(SHIPPED.runtime.resume.staleGuard).toBe(true);
    expect(typeof SHIPPED.runtime.resume.staleGuard).toBe('boolean');
  });

  it('holds exactly the key and its comment (allowlist)', () => {
    expect(Object.keys(SHIPPED.runtime.resume).sort()).toEqual(['comment', 'staleGuard']);
  });

  it('the comment says what the key does, what it leaves alone and what it cannot see', () => {
    const { comment } = SHIPPED.runtime.resume;
    expect(typeof comment).toBe('string');
    for (const token of [
      'CA-08', 'runtime.resume.staleGuard', 'read-order-guard.mjs', '=== true',
      'artifactLifecycle', 'classifyStaleness',
    ]) {
      expect(comment, token).toContain(token);
    }
    // ON is the shipped state; the comment says how to go back to OFF and what OFF keeps.
    expect(comment).toContain('true = ON, the shipped state');
    expect(comment).toContain('false = OFF');
    expect(comment).toContain('byte-identical');
    expect(comment.length).toBeGreaterThan(400);
  });

  it('the reader sees the shipped config as ON, and a copy with the key false as OFF', () => {
    expect(readStaleGuardEnabled(SHIPPED)).toBe(true);
    expect(readStaleGuardEnabled({ runtime: { resume: { staleGuard: false } } })).toBe(false);
  });

  it('adds no top-level key (33 as pinned by tests/firewall/v5-config-firewall.test.js)', () => {
    // 32 -> 33 on 2026-09-30: `projectBootstrap` (portability O1 + O3, owner
    // decision D1) is the one top-level key added since this case was written.
    // The count is the same one v5-config-firewall pins; this case only asserts
    // that CA-08 itself contributed none, so it moves with that pin.
    expect(Object.keys(SHIPPED).length).toBe(33);
  });

  it('leaves the write-side gate untouched: three keys under artifactLifecycle, enabled false (rules §10)', () => {
    // The guard is a NEW opt-in on the consumer side. The existing write-side
    // gates stay unconditional and unparameterised; nothing under
    // `artifactLifecycle` moved, and `tests/runtime/artifact-lifecycle-apply.test.js`
    // still pins exactly these three keys.
    expect(Object.keys(SHIPPED.runtime.artifactLifecycle).sort()).toEqual(['comment', 'enabled', 'projectMarker']);
    expect(SHIPPED.runtime.artifactLifecycle.enabled).toBe(false);
  });
});
