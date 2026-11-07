/**
 * PowerShell subjects in the human.asked / human.resolved recorders (S1
 * cross-check, 2026-11-07).
 *
 * Before: PowerShell was absent from SUBJECT_KEY, so every PowerShell block in
 * one session collapsed to the subject '' and one question_id — measured on the
 * pre-change module: `q-sess-123-cbe5cfdf7c21` for both a Remove-Item and a
 * Format-Volume block. The Bash literals below were captured from that same
 * pre-change module, so a moved Bash id fails here.
 */
import { describe, expect, it } from 'vitest';
import * as gates from '../../lib/security/human-gates.js';
import { describeHumanQuestion } from '../../lib/runtime/human-asked-record.js';

const SID = 'sess-123';
const PS_DELETE = 'Remove-Item -Recurse -Force C:\\proj\\build';
const FORCE_PUSH = `git push --${'force'} origin main`;

/** One question through the real classifier. */
function ask(tool, subject) {
  return describeHumanQuestion({ sessionId: SID, tool, subject }, gates);
}

describe('describeHumanQuestion — PowerShell', () => {
  it('keeps Bash ids byte-identical (literals from the pre-change module)', async () => {
    expect((await ask('Bash', FORCE_PUSH)).question_id).toBe('q-sess-123-bf34bc1d8e93');
    expect((await ask('Bash', PS_DELETE)).question_id).toBe('q-sess-123-43deb842f508');
  });

  it('gives different PowerShell commands different ids', async () => {
    const a = await ask('PowerShell', PS_DELETE);
    const b = await ask('PowerShell', 'Format-Volume -DriveLetter D');
    expect(a.subject).toBe(PS_DELETE);
    expect(a.question_id).not.toBe(b.question_id);
    expect([a.question_id, b.question_id]).not.toContain('q-sess-123-cbe5cfdf7c21');
  });

  it('classifies a PowerShell command in the Bash shape', async () => {
    // Same gate rows as Bash, and so the same id for the same command text:
    // the hash input is gate|subject and carries no tool name.
    const ps = await ask('PowerShell', FORCE_PUSH);
    expect(ps.hits).toEqual(['HG-07']);
    expect(ps.question_id).toBe('q-sess-123-bf34bc1d8e93');
  });

  it('still collapses a tool name outside the map', async () => {
    expect((await ask('powershell', PS_DELETE)).subject).toBe('');
  });
});
