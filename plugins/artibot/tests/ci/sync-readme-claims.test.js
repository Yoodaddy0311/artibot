/**
 * Tests for the README count auto-fixer's WRITE path
 * (scripts/ci/sync-readme-claims.js#syncFile).
 *
 * Why this file exists: the sync script is the only component that MUTATES
 * documentation, and its riskiest behaviour — reassembling a file from frozen
 * and live segments — had no permanent coverage. A one-off manual check proved
 * it once; nothing stopped the next edit from silently breaking it. The failure
 * would be quiet and destructive: release notes rewritten to today's counts,
 * i.e. falsified history, in a file nobody re-reads after a green run.
 *
 * Everything here runs against fixtures in a temp directory. The live READMEs
 * are never written — a test that mutates the repo to prove a writer works is
 * the same class of hazard it is meant to guard.
 *
 * What these tests do NOT cover: main()'s CLI surface (argv parsing, exit
 * codes, console output) and the hardcoded SCAN target list. Only syncFile is
 * exercised; the CLI is verified by running the script, not by import.
 *
 * @module tests/ci/sync-readme-claims
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { collectActuals } from '../../scripts/ci/readme-claims-registry.js';
import { syncFile } from '../../scripts/ci/sync-readme-claims.js';

const actuals = collectActuals();

// A release-note block whose counts are correct FOR THAT VERSION and must never
// be rewritten. Kept as its own constant so tests can assert on it byte-exactly.
const FROZEN_BLOCK = [
  '## v1.14.0 주요 변경사항',
  '',
  '- `scripts/gen-skill-docs.js`: 117개 스킬 SKILL.md 유효성 검증',
  '- 39개 훅 등록, 15개 이벤트 타입',
  '',
].join('\n');

describe('syncFile write path', () => {
  let dir;
  const write = (name, text) => {
    const p = path.join(dir, name);
    writeFileSync(p, text, 'utf-8');
    return p;
  };
  const read = (p) => readFileSync(p, 'utf-8');

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'artibot-sync-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('(a) heals a drifting live claim and leaves the frozen block byte-identical', () => {
    const wrong = actuals.skills + 9;
    const file = write(
      'drift.md',
      `# T\n\n서문에 ${wrong}개 도메인 스킬이 있다.\n\n${FROZEN_BLOCK}`
    );

    const { changed, edits } = syncFile(file, actuals, { write: true });
    expect(changed).toBe(true);
    expect(edits.length).toBeGreaterThan(0);

    const after = read(file);
    // Live half healed.
    expect(after).toContain(`${actuals.skills}개 도메인 스킬`);
    expect(after).not.toContain(`${wrong}개 도메인 스킬`);
    // Frozen half untouched — the whole point. Compared byte-exactly, not by
    // "does it still contain 117", so a partial rewrite cannot slip through.
    expect(after.endsWith(FROZEN_BLOCK), 'frozen block must survive verbatim').toBe(true);
  });

  it('(b) is byte-identical round-trip when there is no drift', () => {
    const clean = `# T\n\n${actuals.skills}개 도메인 스킬, ${actuals.commands}개 슬래시 커맨드\n\n${FROZEN_BLOCK}`;
    const file = write('clean.md', clean);

    const { changed, edits } = syncFile(file, actuals, { write: true });
    expect(changed, 'an in-sync file is not a change').toBe(false);
    expect(edits).toEqual([]);
    expect(read(file), 'no-op must not perturb a single byte').toBe(clean);
  });

  it('(c) never rewrites a wrong count that lives only in the frozen block', () => {
    // 117 != actuals.skills and 39 != actuals.hookRegistrations, yet both are
    // correct history. A writer that "fixes" them is the destructive failure.
    const doc = `# T\n\n${actuals.skills}개 도메인 스킬\n\n${FROZEN_BLOCK}`;
    const file = write('frozen-only.md', doc);

    const { changed, edits } = syncFile(file, actuals, { write: true });
    expect(changed, 'frozen-only drift is not drift').toBe(false);
    expect(edits).toEqual([]);
    expect(read(file)).toBe(doc);
    expect(read(file)).toContain('117개 스킬');
    expect(read(file)).toContain('39개 훅 등록');
  });

  it('(d) heals a section that FOLLOWS the release notes (termination boundary)', () => {
    // The tail hole: an earlier design froze everything from the first version
    // heading to EOF, so `## 기여하기` / `## 라이선스` were never healed OR
    // checked. Per-section freezing must reach them while still skipping the
    // release notes that precede them.
    const wrong = actuals.skills + 4;
    const doc = `# T\n\n${FROZEN_BLOCK}\n## 기여하기\n\n꼬리 절에 ${wrong}개 도메인 스킬.\n`;
    const file = write('tail.md', doc);

    const { changed } = syncFile(file, actuals, { write: true });
    expect(changed).toBe(true);

    const after = read(file);
    expect(after, 'tail section healed').toContain(`${actuals.skills}개 도메인 스킬`);
    expect(after).not.toContain(`${wrong}개 도메인 스킬`);
    expect(after, 'release notes still frozen').toContain('117개 스킬 SKILL.md');
    expect(after).toContain('39개 훅 등록');
  });

  it('(e) rewrites every live section when drift appears on both sides of the notes', () => {
    // Guards segment reassembly order: head + frozen + tail must come back in
    // that order, with both live halves healed and the middle preserved.
    const wrong = actuals.commands + 5;
    const doc = `# T\n\n머리 ${wrong}개 슬래시 커맨드\n\n${FROZEN_BLOCK}\n## 라이선스\n\n꼬리 ${wrong}개 슬래시 커맨드\n`;
    const file = write('both.md', doc);

    syncFile(file, actuals, { write: true });
    const after = read(file);

    expect(after.match(new RegExp(`${actuals.commands}개 슬래시 커맨드`, 'g')), 'both halves healed')
      .toHaveLength(2);
    expect(after).not.toContain(`${wrong}개 슬래시 커맨드`);
    expect(after.indexOf('머리')).toBeLessThan(after.indexOf('## v1.14.0'));
    expect(after.indexOf('## v1.14.0')).toBeLessThan(after.indexOf('## 라이선스'));
  });

  it('(f) reports the change but writes nothing when write:false (--check contract)', () => {
    const wrong = actuals.skills + 3;
    const doc = `# T\n\n${wrong}개 도메인 스킬\n`;
    const file = write('checkonly.md', doc);

    const { changed, edits } = syncFile(file, actuals, { write: false });
    expect(changed, '--check must still detect drift').toBe(true);
    expect(edits[0]).toEqual({
      from: `${wrong}개 도메인 스킬`,
      to: `${actuals.skills}개 도메인 스킬`,
    });
    expect(read(file), '--check must not touch the file').toBe(doc);
  });

  it('(g) is idempotent: a second run over healed output changes nothing', () => {
    const file = write('idem.md', `# T\n\n${actuals.skills + 2}개 도메인 스킬\n\n${FROZEN_BLOCK}`);
    syncFile(file, actuals, { write: true });
    const afterFirst = read(file);

    const { changed } = syncFile(file, actuals, { write: true });
    expect(changed, 'second pass must be a no-op').toBe(false);
    expect(read(file)).toBe(afterFirst);
  });

  it('(h) treats a missing file as a no-op rather than throwing', () => {
    const { changed, edits } = syncFile(path.join(dir, '__absent__.md'), actuals, { write: true });
    expect(changed).toBe(false);
    expect(edits).toEqual([]);
  });
});

describe('importing the sync module does not run the CLI', () => {
  it('does not rewrite the real READMEs on import (invokedDirectly guard)', () => {
    // If the guard regressed, importing this module at the top of the file
    // would have rewritten the live READMEs and called process.exit — the test
    // run would not have reached this assertion at all.
    expect(typeof syncFile).toBe('function');
  });
});
