/**
 * CA-01 — contract gate for the Canary auto-activation of low-risk commands.
 *
 * The behaviour is pinned elsewhere (`tests/cognitive/auto-activate.test.js`,
 * `tests/hooks/runtime-prompt-auto-activate.test.js`). This file pins the
 * FACTS the behaviour rests on, so that changing one of them is a visible
 * decision instead of a drift:
 *
 *  1. The allowlist is the design's A2 list, and each name that can fire has a
 *     real command file whose `allowed-tools` stay inside a fixed set with no
 *     write tool. `why` has no command; the day one appears this goes red.
 *  2. The kill switch ships ON, as a boolean, at the path the reader reads.
 *  3. The confirm-first hint allowlist is untouched, and the hook reaches the
 *     decision module only through the dynamic, fail-closed loader.
 *  4. `CLAUDE.md` and `docs/ORCHESTRATION-ROUTING.md` describe what the code does,
 *     with the allowlist and the switch path character-identical.
 *
 * WHAT THIS GATE CANNOT SEE (rules §9, stated beside the gate so the gate is not
 * mistaken for a safety proof):
 *  - `allowed-tools` is what a command DECLARES. It is not a sandbox; a command
 *    whose prose tells the model to write a file is invisible here. The claim
 *    that these commands are low-risk rests on their documented flow plus the
 *    fact that every tool call still passes the PreToolUse hooks — not on this test.
 *  - Whether the model follows the directive, and whether the trigger table is
 *    precise on real prompts. Both unmeasured.
 *  - The design's own preconditions (A3 "Shadow ledger for one release", the
 *    "freeze 8 all at Observe" entry rule): the owner waived the first for this
 *    feature and the second is not checkable from code.
 *
 * @module tests/firewall/auto-activate-contract
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AUTO_ACTIVATE_ACTIVATABLE,
  AUTO_ACTIVATE_ALLOWLIST,
  AUTO_ACTIVATE_CONFIG_PATH,
  readAutoActivateEnabled,
  renderAutoActivateDirective,
} from '../../lib/cognitive/auto-activate.js';
import { RECOMMENDATION_HINTS } from '../../scripts/hooks/runtime-prompt.js';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REPO_ROOT = path.resolve(PLUGIN_ROOT, '..', '..');

/** Read a file with CRLF folded to LF (a Windows checkout is CRLF, CI is LF). */
function read(...segments) {
  return readFileSync(path.join(...segments), 'utf-8').replace(/\r\n/g, '\n');
}

const config = JSON.parse(read(PLUGIN_ROOT, 'artibot.config.json'));

/** Tools an activatable command may declare. A POSITIVE list: a new tool is a decision. */
const ALLOWED_TOOL_SET = Object.freeze(['Read', 'Glob', 'Grep', 'Bash', 'Agent', 'TaskCreate']);

function declaredTools(commandName) {
  const src = read(PLUGIN_ROOT, 'commands', `${commandName}.md`);
  const m = src.match(/^allowed-tools:\s*\[([^\]]*)\]/m);
  return m === null ? null : m[1].split(',').map((t) => t.trim()).filter(Boolean);
}

describe('allowlist — the design list, and what backs each name', () => {
  it('is the A2 row of the v5 design, name for name', () => {
    const designPath = path.join(REPO_ROOT, '.artibot', 'guides', 'v5-design', 'ARTIBOT-5.0-DESIGN.md');
    expect(existsSync(designPath), 'design file missing — this gate fails closed').toBe(true);
    const a2 = read(designPath).split('\n').find((line) => line.startsWith('| A2 |'));
    expect(a2, 'no `| A2 |` row in the design').toBeDefined();
    const listed = a2.match(/`(\/[a-z]+(?: \/[a-z]+)*)`/);
    expect(listed, 'the A2 row no longer lists slash commands in one span').not.toBeNull();
    expect(listed[1].split(' ').map((s) => s.slice(1))).toEqual([...AUTO_ACTIVATE_ALLOWLIST]);
  });

  it.each([...AUTO_ACTIVATE_ACTIVATABLE])('%s has a command file that declares tools from the fixed set only', (name) => {
    const file = path.join(PLUGIN_ROOT, 'commands', `${name}.md`);
    expect(existsSync(file), `commands/${name}.md`).toBe(true);
    const tools = declaredTools(name);
    expect(tools, `commands/${name}.md has no allowed-tools line`).not.toBeNull();
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(ALLOWED_TOOL_SET, `${name} declares ${tool}`).toContain(tool);
    }
    // Named explicitly as well, so the failure message says WHY the set matters.
    for (const writeTool of ['Write', 'Edit', 'NotebookEdit']) {
      expect(tools, `${name} must not declare ${writeTool}`).not.toContain(writeTool);
    }
  });

  it('`why` has no command file — the design names it, nothing implements it', () => {
    // ARTIBOT-5.0-DESIGN.md:230 "`/why` … 전부 미존재" and :519 (A5: extend `/doctor`
    // and `/scorecard`, do not create). If a `commands/why.md` appears, do NOT just
    // delete this test: decide whether it belongs on the allowlist, add a trigger row
    // and a positive case in tests/cognitive/auto-activate.test.js, and check its
    // `allowed-tools` against ALLOWED_TOOL_SET above.
    expect(AUTO_ACTIVATE_ALLOWLIST).toContain('why');
    expect(AUTO_ACTIVATE_ACTIVATABLE).not.toContain('why');
    expect(existsSync(path.join(PLUGIN_ROOT, 'commands', 'why.md'))).toBe(false);
  });

  it('the runner mechanisms are not on it (Harness Constraint) — pinned as the exact list', () => {
    expect([...AUTO_ACTIVATE_ALLOWLIST]).toEqual(['analyze', 'explain', 'blindspot', 'scorecard', 'why']);
  });
});

describe('kill switch — one key, shipped ON, strict boolean', () => {
  it('lives at the path the reader reads', () => {
    expect(AUTO_ACTIVATE_CONFIG_PATH).toBe('automation.autoActivate.commands');
    expect(typeof config.automation.autoActivate.commands).toBe('boolean');
  });

  it('ships true (owner instruction 2026-09-30) and the reader agrees', () => {
    expect(config.automation.autoActivate.commands).toBe(true);
    expect(readAutoActivateEnabled(config)).toBe(true);
  });

  it('adds only the key and its comment under automation.autoActivate', () => {
    expect(Object.keys(config.automation.autoActivate).sort()).toEqual(['commands', 'comment']);
    expect(config.automation.autoActivate.comment).toMatch(/CA-01/);
    expect(config.automation.autoActivate.comment).toMatch(/kill switch/i);
  });

  it('leaves the neighbouring automation keys as they were', () => {
    expect(config.automation.intentDetection).toBe(true);
    expect(config.automation.ambiguityThreshold).toBe(50);
    expect(config.automation.supportedLanguages).toEqual(['en', 'ko', 'ja', 'zh']);
  });
});

describe('hook wiring — confirm-first surface untouched, decision module reached fail-closed', () => {
  const hookSrc = read(PLUGIN_ROOT, 'scripts', 'hooks', 'runtime-prompt.js');

  it('the confirm-first hint allowlist is still the trio', () => {
    expect([...RECOMMENDATION_HINTS]).toEqual(['workflow', 'split', 'autopilot']);
  });

  it('loads the decision module through the dynamic loader, never a static import', () => {
    // A static import of a NEW lib module from the hook crashes the whole
    // UserPromptSubmit hook on an older installed tree (ERR_MODULE_NOT_FOUND).
    expect(hookSrc).toMatch(/loadLibModule\(pluginRoot, 'cognitive', 'auto-activate\.js'\)/);
    expect(hookSrc).not.toMatch(/^import[^;]*auto-activate[^;]*;/m);
  });

  it('the decision module has no static imports (the gate catalogs load lazily)', () => {
    const libSrc = read(PLUGIN_ROOT, 'lib', 'cognitive', 'auto-activate.js');
    expect(libSrc).not.toMatch(/^import\s/m);
    expect(libSrc).toMatch(/import\('\.\.\/security\/human-gates\.js'\)/);
    expect(libSrc).toMatch(/import\('\.\.\/autopilot\/safety\.js'\)/);
  });

  it('the shipped directive stays one line and names its command', () => {
    for (const name of AUTO_ACTIVATE_ACTIVATABLE) {
      const line = renderAutoActivateDirective(name);
      expect(line).toMatch(new RegExp(`^\\[artibot:auto-activate command=${name}\\] [^\\n]+$`));
    }
  });
});

describe('docs — say what the code does, character-identical where it names things', () => {
  const claude = read(PLUGIN_ROOT, 'CLAUDE.md');
  const routing = read(PLUGIN_ROOT, 'docs', 'ORCHESTRATION-ROUTING.md');

  /** The body of the `## Auto-activate rule` section, up to the next `## ` heading. */
  function autoActivateParagraph() {
    const start = claude.indexOf('## Auto-activate rule');
    expect(start, 'CLAUDE.md has no "Auto-activate rule" section').toBeGreaterThanOrEqual(0);
    const end = claude.indexOf('\n## ', start + 1);
    return claude.slice(start, end === -1 ? undefined : end);
  }

  it('CLAUDE.md puts the section AFTER the Existence Audit block, so no pinned line number moves', () => {
    // `tests/replay/existence-audit.test.js` reads the 면제 sentence of CLAUDE.md by
    // LINE NUMBER (88). A first draft placed this paragraph next to the hint rule
    // (line 75), moved that sentence to 90, and turned two of its cases red
    // (measured 2026-09-30). Lines above the Existence Audit block are frozen by
    // that pin; new sections go below it.
    const at = claude.indexOf('## Auto-activate rule');
    expect(claude.indexOf('## Existence Audit')).toBeGreaterThanOrEqual(0);
    expect(at).toBeGreaterThan(claude.indexOf('## Existence Audit'));
  });

  it('CLAUDE.md points from the hint rule to the new section', () => {
    expect(claude).toContain('Low-risk command auto-activation is a separate tag with its own rule: "Auto-activate rule" below.');
  });

  it('CLAUDE.md names the tag, the switch path and the allowlist exactly', () => {
    const p = autoActivateParagraph();
    expect(p).toContain('`[artibot:auto-activate command=X]`');
    expect(p).toContain(`\`${AUTO_ACTIVATE_CONFIG_PATH}\``);
    // The activatable names, in allowlist order, joined the way the paragraph joins them.
    expect(p).toContain(AUTO_ACTIVATE_ACTIVATABLE.map((n) => `\`${n}\``).join(' · '));
    // `why` is named as the design's, with the reason it never fires.
    expect(p).toMatch(/names `why`, which has no command and never fires/);
  });

  it('CLAUDE.md keeps the runners advisory and says the model is instructed, not driven', () => {
    const p = autoActivateParagraph();
    expect(p).toMatch(/never covers `\/orchestrate`, `\/autopilot` or `\/split`, which stay advisory/);
    expect(p).toMatch(/instruction to the model, not a dispatcher/);
    expect(p).toMatch(/unmeasured/);
  });

  it('CLAUDE.md, the config comment and the module header say trigger precision is the safety line', () => {
    // A 2026-09-30 review found the earlier claim — "every tool call still passes the
    // host permission system, so no human gate is bypassed" — unsupported: the
    // PreToolUse hooks do run, but a command's own `allowed-tools` may waive the host
    // prompt, and whether it does for a directive-started run is unverified. The three
    // places that carried it now say so; this pin keeps the old sentence from returning.
    const p = autoActivateParagraph();
    expect(p).toMatch(/PreToolUse hooks still run for every tool call the command makes/);
    expect(p).toMatch(/host permission prompt may be waived by the command's own `allowed-tools` \(unverified\)/);
    expect(p).toMatch(/trigger precision, not the permission system, is the safety line/);
    expect(p).not.toMatch(/tool permission still applies/);

    const comment = config.automation.autoActivate.comment;
    expect(comment).toMatch(/host permission prompt may be waived by the command's own allowed-tools \(unverified\)/);
    expect(comment).not.toMatch(/tool permission still applies/);

    const libSrc = read(PLUGIN_ROOT, 'lib', 'cognitive', 'auto-activate.js');
    expect(libSrc).toMatch(/TRIGGER PRECISION is the safety line/);
    expect(libSrc).toMatch(/UNVERIFIED here/);
    expect(libSrc).not.toMatch(/no human gate is bypassed/);
  });

  it('every activatable command declares Bash, as the module header says', () => {
    // The header ("WHAT LIMITS THE BLAST RADIUS") states "all four activatable commands
    // list Bash". If one stops, reword that caveat — do not just delete this test.
    expect(AUTO_ACTIVATE_ACTIVATABLE).toHaveLength(4);
    expect(read(PLUGIN_ROOT, 'lib', 'cognitive', 'auto-activate.js')).toMatch(/all four activatable commands list Bash/);
    for (const name of AUTO_ACTIVATE_ACTIVATABLE) {
      expect(declaredTools(name), `commands/${name}.md`).toContain('Bash');
    }
  });

  it('CLAUDE.md leaves the confirm-first hint rule as it was', () => {
    expect(claude).toContain('**Recommend-hint surfacing rule**');
    expect(claude).toContain('wait for confirmation before acting');
    expect(claude).toContain('the hint never auto-fires `/orchestrate` or `/autopilot`');
  });

  it('ORCHESTRATION-ROUTING.md documents it as command-level and leaves the Harness Constraint alone', () => {
    expect(routing).toContain('**Low-risk command auto-activation (Canary, CA-01)**');
    expect(routing).toContain(`\`${AUTO_ACTIVATE_CONFIG_PATH}\``);
    expect(routing).toContain('`[artibot:auto-activate command=X]`');
    expect(routing).toContain(AUTO_ACTIVATE_ACTIVATABLE.map((n) => `\`${n}\``).join(', '));
    expect(routing).toContain('`orchestrate` (classifier label `workflow`) and `autopilot` MUST NEVER auto-fire');
    expect(routing).toContain('Only `inline` and `team` auto-fire.');
  });
});
