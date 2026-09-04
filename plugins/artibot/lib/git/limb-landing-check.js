/**
 * Mechanical landing checklist for one `/split` limb — `split land <limb>`.
 *
 * Every landing in the 2026-09 live run was re-measured by hand: trailer,
 * ownership diff against the brief's allowlist, binary count, forbidden
 * citations, merge dry-run, PR body. Six commands, typed N times per limb,
 * with the same three slips each time (stale base, forgotten `--numstat`,
 * a citation grep that missed the second pattern). This module runs those
 * six measurements and returns them as rows; the leader reads rows.
 *
 * ── What this decides and what it does not ─────────────────────────────────
 * `status: 'PASS'` means "the six mechanical checks are green". It is NOT
 * approval. APPROVE / REQUEST_CHANGES is a human (검수자) judgement recorded
 * in the PR body's `## 검수` section, and nothing here fills it in — the
 * skeleton leaves that slot empty on purpose. Likewise the `## 게이트` numbers
 * (tsc / vitest / lint / build) are placeholders: this module does not run
 * the test suite, and a PASS here says nothing about test results.
 *
 * ── Checks ─────────────────────────────────────────────────────────────────
 *   1. trailer        — `limb-completion.js#readLimbCompletion` says `done`
 *                       (first-parent, newest trailer decides).
 *   2. ownership      — every path in `git diff --name-only -z <base>...<branch>`
 *                       matches `allowlist` ∪ `alwaysAllowed`
 *                       (exact path · directory prefix · `*` / `**` glob).
 *                       `-z` is load-bearing (measured 2026-09-04): without it
 *                       `core.quotepath` C-quotes every non-ASCII path
 *                       (`"src/\355\225\234…"`), so Korean paths matched no
 *                       allowlist entry and ownership failed for a reason
 *                       nobody could read. NUL separation also keeps paths
 *                       containing spaces whole, which is why the split does
 *                       not trim each field.
 *   3. binary         — `git diff --numstat` rows reading `-\t-` → fail.
 *   4. citations      — added (`+`) lines of non-binary files matching any
 *                       `forbiddenPatterns` (defaults: `.artibot/split/` paths
 *                       and Windows `X:\Users\` paths) → fail, first 10 listed.
 *   5. merge-dry-run  — `merge-preflight.js` (`probeMergeTreeSupport` +
 *                       `mergeTreePair(base, branch)`). git < 2.38 cannot run
 *                       `merge-tree --write-tree`: the row is `ok:false` with
 *                       detail `UNSUPPORTED …` and the overall status is
 *                       `UNSUPPORTED` — never PASS on an unmeasured merge.
 *   6. behind-base    — `git rev-list --count <branch>..<base>`. Informational,
 *                       never fails; `ok` is always true.
 *
 * Status rule: any of checks 1–4 red, or a merge conflict / merge error →
 * `FAIL`; checks 1–4 green but merge-tree unavailable → `UNSUPPORTED`;
 * everything green → `PASS`. Bad input never throws — it is a `FAIL` with a
 * single `input` row.
 *
 * ── Base choice matters (measured) ─────────────────────────────────────────
 * `plan.json#base` is the SHA at plan time. After a limb merges an advanced
 * main, `<planBase>...<branch>` includes the merged-in commits of OTHER limbs,
 * and the ownership check will list their files as offenders. That is the
 * diff telling the truth about the range, not a bug — pass the live
 * integration ref (`--base master` / `origin/main`) once a limb has merged
 * it. The trailer check is immune (first-parent); the diff is not.
 *
 * ── Process boundary ───────────────────────────────────────────────────────
 * All diff / merge-tree / rev-list calls go through one injectable `exec`
 * with the `merge-preflight.js#runGit` shape; the default is shell-free
 * `spawnSync` with `windowsHide` and a timeout. The trailer check (1) reads
 * through `limb-completion.js`, which owns its own guarded git call and is
 * not routed through `exec` — tests that want a fake trailer result build a
 * real temp repo instead.
 *
 * @module lib/git/limb-landing-check
 */

import { spawnSync } from 'node:child_process';
import { readLimbCompletion } from './limb-completion.js';
import { mergeTreePair, probeMergeTreeSupport } from './merge-preflight.js';

/** Added-line patterns that must not land: split-run scratch paths and Windows user paths. */
export const DEFAULT_FORBIDDEN_PATTERNS = Object.freeze([
  /\.artibot[\\/]split[\\/]/,
  /[A-Za-z]:[\\/]+Users[\\/]/,
]);

/** Paths a limb may always touch; `<limb>` is templated with the limb slug. */
export const DEFAULT_ALWAYS_ALLOWED = Object.freeze(['.artibot/split/<limb>/**']);

/** Max citation hits listed in the check detail. */
const CITATION_DETAIL_LIMIT = 10;

const GIT_TIMEOUT_MS = 30_000;

/**
 * Default git runner: shell-free, hidden window, bounded. Same result shape
 * as `merge-preflight.js#runGit` so the merge-tree helpers accept it.
 *
 * @param {string[]} args
 * @param {{cwd?: string}} [opts]
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
export function defaultExec(args, opts = {}) {
  const r = spawnSync('git', args, {
    cwd: opts.cwd,
    encoding: 'utf-8',
    windowsHide: true,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) return { status: -1, stdout: '', stderr: String(r.error.message ?? r.error) };
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/**
 * Normalise a repo-relative path for matching: forward slashes, no leading
 * `./`, no trailing slash.
 * @param {string} p
 * @returns {string}
 */
function normalizePath(p) {
  return String(p ?? '').replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

/**
 * Compile one allowlist entry. Entries without `*` match the exact path or
 * anything under it as a directory; `**` spans directories, `*` stays within
 * one segment. Small on purpose — `lib/autopilot/fast-profile.js` has an
 * overlap heuristic for globs, not a matcher, so nothing there was reusable.
 *
 * @param {string} entry
 * @returns {RegExp}
 */
export function allowlistEntryToRegExp(entry) {
  const norm = normalizePath(entry);
  if (!norm.includes('*') && !norm.includes('?')) {
    const lit = norm.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^${lit}(?:/.*)?$`);
  }
  let re = '';
  for (let i = 0; i < norm.length; i += 1) {
    const ch = norm[i];
    if (ch === '*') {
      if (norm[i + 1] === '*') {
        const slashAfter = norm[i + 2] === '/';
        re += slashAfter ? '(?:.*/)?' : '.*';
        i += slashAfter ? 2 : 1;
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

/**
 * Does `file` fall under any allowlist entry?
 * @param {string} file - repo-relative path as git prints it
 * @param {ReadonlyArray<string>} allowlist
 * @returns {boolean}
 */
export function matchesAllowlist(file, allowlist) {
  const target = normalizePath(file);
  if (!target) return false;
  return (Array.isArray(allowlist) ? allowlist : [])
    .filter((e) => typeof e === 'string' && e.trim())
    .some((e) => allowlistEntryToRegExp(e).test(target));
}

/**
 * Walk a unified diff and report added lines matching any pattern.
 * Binary files ("Binary files … differ" / "GIT binary patch") are skipped.
 *
 * @param {string} diffText - output of `git diff <base>...<branch>`
 * @param {ReadonlyArray<RegExp>} patterns
 * @returns {Array<{ file: string, line: number, text: string }>}
 */
export function findForbiddenCitations(diffText, patterns) {
  const hits = [];
  let file = '';
  let binary = false;
  let newLine = 0;
  for (const raw of String(diffText ?? '').split(/\r?\n/)) {
    if (raw.startsWith('diff --git ')) {
      file = '';
      binary = false;
      continue;
    }
    if (raw.startsWith('+++ ')) {
      file = raw.slice(4).replace(/^b\//, '').trim();
      continue;
    }
    if (raw.startsWith('Binary files ') || raw.startsWith('GIT binary patch')) {
      binary = true;
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (binary || !file) continue;
    if (raw.startsWith('+')) {
      const text = raw.slice(1);
      if (patterns.some((p) => p.test(text))) hits.push({ file, line: newLine, text });
      newLine += 1;
    } else if (!raw.startsWith('-') && !raw.startsWith('\\')) {
      newLine += 1;
    }
  }
  return hits;
}

/**
 * Parse `git diff --numstat` into rows; binary rows carry `-` counts.
 * @param {string} out
 * @returns {Array<{ added: string, deleted: string, file: string, binary: boolean }>}
 */
function parseNumstat(out) {
  return String(out ?? '')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [added = '', deleted = '', ...rest] = line.split('\t');
      return { added, deleted, file: rest.join('\t'), binary: added === '-' && deleted === '-' };
    });
}

/**
 * @param {string} id
 * @param {string} name
 * @param {boolean} ok
 * @param {string} detail
 * @returns {Readonly<{ id: string, name: string, ok: boolean, detail: string }>}
 */
function row(id, name, ok, detail) {
  return Object.freeze({ id, name, ok, detail });
}

/**
 * Build the PR body skeleton. Approval is NOT filled in — `## 검수` is a slot
 * for a human verdict; `## 게이트` numbers are placeholders for measurements
 * the leader takes and pastes with a timestamp.
 *
 * @param {{ limb: string, branch: string, base: string, completion: ReturnType<typeof readLimbCompletion>, changedFiles: ReadonlyArray<string> }} p
 * @returns {string}
 */
export function buildPrBody({ limb, branch, base, completion, changedFiles }) {
  const title = completion?.doneCommit?.subject || `split(${limb}): <제목 — done 커밋 없음>`;
  const trailerLine = completion?.complete
    ? `Split-Limb: done @ ${completion.doneCommit.sha}`
    : `Split-Limb: ${completion?.reason ?? 'unknown'} (done 아님 — 랜딩 불가)`;
  const files = changedFiles.length ? changedFiles.map((f) => `- \`${f}\``).join('\n') : '- (없음)';
  return [
    `# ${title}`,
    '',
    `limb \`${limb}\` · branch \`${branch}\` · base \`${base}\``,
    '',
    '## 게이트',
    '',
    '| 게이트 | 수치 | 측정시각 |',
    '|---|---|---|',
    '| tsc --noEmit | <errors> | <YYYY-MM-DD HH:mm> |',
    '| vitest | <passed>/<total> | <YYYY-MM-DD HH:mm> |',
    '| eslint --max-warnings=0 | <errors>/<warnings> | <YYYY-MM-DD HH:mm> |',
    '| build | <ok/fail> | <YYYY-MM-DD HH:mm> |',
    '',
    '## 검수',
    '',
    '- 검수자: <이름>',
    '- 판정: <APPROVE | REQUEST_CHANGES> — 코드가 정하지 않는다. 사람이 쓴다.',
    '',
    '## 이월',
    '',
    '- (없음)',
    '',
    '## 변경 파일',
    '',
    files,
    '',
    trailerLine,
    '',
  ].join('\n');
}

/**
 * @param {ReturnType<typeof readLimbCompletion>} completion
 * @returns {ReturnType<typeof row>}
 */
function trailerCheck(completion) {
  if (completion.complete) {
    return row('trailer', 'Split-Limb 트레일러', true,
      `done @ ${completion.doneCommit.sha.slice(0, 12)} "${completion.doneCommit.subject}"`);
  }
  const suffix = completion.lastTrailer ? ` (lastTrailer=${completion.lastTrailer})` : '';
  return row('trailer', 'Split-Limb 트레일러', false, `${completion.reason}${suffix}`);
}

/**
 * @param {{ status: number, stdout: string, stderr: string }} names - `git diff --name-only -z` result
 * @param {ReadonlyArray<string>} changedFiles
 * @param {ReadonlyArray<string>} effectiveAllow
 * @returns {ReturnType<typeof row>}
 */
function ownershipCheck(names, changedFiles, effectiveAllow) {
  if (names.status !== 0) {
    return row('ownership', '소유권 (allowlist)', false, `git diff --name-only failed: ${names.stderr.trim() || names.status}`);
  }
  if (changedFiles.length === 0) {
    // Nothing to land is not a passing landing (review finding 2026-09-02):
    // a `done` trailer on an empty diff would otherwise reach PASS.
    return row('ownership', '소유권 (allowlist)', false, '변경 파일 0 — 랜딩할 것이 없다 (base 가 잘못됐거나 빈 줄기)');
  }
  const offenders = changedFiles.filter((f) => !matchesAllowlist(f, effectiveAllow));
  return row('ownership', '소유권 (allowlist)', offenders.length === 0,
    offenders.length === 0
      ? `${changedFiles.length} file(s), all inside allowlist`
      : `${offenders.length} outside allowlist: ${offenders.join(', ')}`);
}

/**
 * @param {{ status: number, stdout: string, stderr: string }} numstat - `git diff --numstat` result
 * @returns {ReturnType<typeof row>}
 */
function binaryCheck(numstat) {
  if (numstat.status !== 0) {
    return row('binary', '바이너리 0', false, `git diff --numstat failed: ${numstat.stderr.trim() || numstat.status}`);
  }
  const bins = parseNumstat(numstat.stdout).filter((r) => r.binary).map((r) => r.file);
  return row('binary', '바이너리 0', bins.length === 0,
    bins.length === 0 ? 'no binary rows' : `${bins.length} binary: ${bins.join(', ')}`);
}

/**
 * @param {{ status: number, stdout: string, stderr: string }} diff - `git diff` result
 * @param {ReadonlyArray<RegExp>} patterns
 * @returns {ReturnType<typeof row>}
 */
function citationCheck(diff, patterns) {
  if (diff.status !== 0) {
    return row('citations', '금지 인용', false, `git diff failed: ${diff.stderr.trim() || diff.status}`);
  }
  const hits = findForbiddenCitations(diff.stdout, patterns);
  if (hits.length === 0) return row('citations', '금지 인용', true, 'no forbidden citations in added lines');
  const shown = hits.slice(0, CITATION_DETAIL_LIMIT).map((h) => `${h.file}:${h.line}: ${h.text.trim().slice(0, 80)}`);
  const capped = hits.length > CITATION_DETAIL_LIMIT ? ` (first ${CITATION_DETAIL_LIMIT})` : '';
  return row('citations', '금지 인용', false, `${hits.length} hit(s)${capped}: ${shown.join(' | ')}`);
}

/**
 * merge-tree dry run. `unsupported` is true when the local git cannot run
 * `--write-tree` — the row is red and the caller must not report PASS.
 *
 * @param {{ cwd: string, base: string, branch: string, exec: typeof defaultExec }} p
 * @returns {{ check: ReturnType<typeof row>, unsupported: boolean }}
 */
function mergeCheck({ cwd, base, branch, exec }) {
  const probe = probeMergeTreeSupport({ cwd, exec });
  if (!probe.supported) {
    return {
      unsupported: true,
      check: row('merge-dry-run', '머지 드라이런 (merge-tree)', false,
        `UNSUPPORTED: ${probe.reason} — 직렬 랜딩으로 강등, 충돌 없음으로 읽지 말 것`),
    };
  }
  const pair = mergeTreePair(base, branch, { cwd, exec });
  let detail;
  if (pair.kind === 'clean') detail = `clean (tree ${String(pair.tree).slice(0, 12)})`;
  else if (pair.kind === 'conflict') detail = `conflict: ${pair.conflictFiles.join(', ')}`;
  else detail = `error: ${(pair.stderr || pair.messages.join('; ')).trim()}`;
  return { unsupported: false, check: row('merge-dry-run', '머지 드라이런 (merge-tree)', pair.kind === 'clean', detail) };
}

/**
 * @param {{ status: number, stdout: string }} behind - `git rev-list --count` result
 * @param {string} base
 * @returns {ReturnType<typeof row>}
 */
function behindCheck(behind, base) {
  return row('behind-base', 'base 대비 뒤처짐 (정보)', true,
    behind.status === 0 ? `${behind.stdout.trim()} commit(s) behind ${base}` : 'unmeasured');
}

/**
 * @param {ReadonlyArray<ReturnType<typeof row>>} checks
 * @param {boolean} unsupported
 * @returns {'PASS'|'FAIL'|'UNSUPPORTED'}
 */
function overallStatus(checks, unsupported) {
  const hardFail = checks.some((c) => c.id !== 'behind-base' && c.id !== 'merge-dry-run' && !c.ok);
  const mergeRed = !unsupported && checks.some((c) => c.id === 'merge-dry-run' && !c.ok);
  if (hardFail || mergeRed) return 'FAIL';
  return unsupported ? 'UNSUPPORTED' : 'PASS';
}

/**
 * Run the six landing checks for one limb. Never throws; never writes, pushes
 * or merges (merge-tree writes loose objects only — see merge-preflight.js).
 *
 * @param {object} p
 * @param {string} p.cwd - Any directory inside the repository.
 * @param {string} p.limb - Limb slug (templated into `alwaysAllowed`).
 * @param {string} p.branch - Limb branch.
 * @param {string} p.base - Integration base ref or SHA (see module header on which to pass).
 * @param {ReadonlyArray<string>} [p.allowlist=[]] - Owned paths from the plan (`affectedPaths`).
 * @param {ReadonlyArray<RegExp>} [p.forbiddenPatterns=DEFAULT_FORBIDDEN_PATTERNS]
 * @param {ReadonlyArray<string>} [p.alwaysAllowed=DEFAULT_ALWAYS_ALLOWED]
 * @param {typeof defaultExec} [p.exec=defaultExec]
 * @returns {Readonly<{
 *   status: 'PASS'|'FAIL'|'UNSUPPORTED',
 *   checks: ReadonlyArray<{ id: string, name: string, ok: boolean, detail: string }>,
 *   prBody: string,
 *   changedFiles: ReadonlyArray<string>,
 * }>}
 */
export function checkLimbLanding(p = {}) {
  const {
    cwd, limb, branch, base,
    allowlist = [],
    forbiddenPatterns = DEFAULT_FORBIDDEN_PATTERNS,
    alwaysAllowed = DEFAULT_ALWAYS_ALLOWED,
    exec = defaultExec,
  } = p;
  const bad = [['cwd', cwd], ['limb', limb], ['branch', branch], ['base', base]]
    .filter(([, v]) => typeof v !== 'string' || !v.trim())
    .map(([k]) => k);
  if (bad.length) {
    return Object.freeze({
      status: 'FAIL',
      checks: Object.freeze([row('input', '입력', false, `missing or empty: ${bad.join(', ')}`)]),
      prBody: '',
      changedFiles: Object.freeze([]),
    });
  }
  const git = (args) => exec(args, { cwd });
  const range = `${base}...${branch}`;

  const completion = readLimbCompletion({ cwd, branch, base });
  const names = git(['diff', '--name-only', '-z', range, '--']);
  const changedFiles = names.status === 0
    ? names.stdout.split('\0').filter(Boolean)
    : [];
  const effectiveAllow = [
    ...(Array.isArray(allowlist) ? allowlist : []),
    ...(Array.isArray(alwaysAllowed) ? alwaysAllowed : []).map((e) => String(e).replaceAll('<limb>', limb)),
  ];
  const merge = mergeCheck({ cwd, base, branch, exec });
  const checks = Object.freeze([
    trailerCheck(completion),
    ownershipCheck(names, changedFiles, effectiveAllow),
    binaryCheck(git(['diff', '--numstat', range, '--'])),
    citationCheck(git(['diff', range, '--']), forbiddenPatterns),
    merge.check,
    behindCheck(git(['rev-list', '--count', `${branch}..${base}`]), base),
  ]);

  return Object.freeze({
    status: overallStatus(checks, merge.unsupported),
    checks,
    prBody: buildPrBody({ limb, branch, base, completion, changedFiles }),
    changedFiles: Object.freeze(changedFiles),
  });
}
