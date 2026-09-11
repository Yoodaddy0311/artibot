/**
 * Unit tests for lib/autopilot/safety.js
 * Covers classifyRisk, parseDuration, shouldPause.
 */
import { describe, expect, it } from 'vitest';
import {
  classifyRisk,
  parseDuration,
  pauseReason,
  shouldPause,
} from '../../lib/autopilot/safety.js';

describe('classifyRisk', () => {
  it('flags git push --force as danger', () => {
    const r = classifyRisk('git push --force origin main');
    expect(r.level).toBe('danger');
    expect(r.matchedId).toBe('git-force-push');
  });

  it('flags SQL DROP TABLE as danger', () => {
    const r = classifyRisk({ command: 'DROP TABLE users;' });
    expect(r.level).toBe('danger');
    expect(r.matchedId).toBe('sql-drop-table');
  });

  it('returns safe for benign ls command', () => {
    const r = classifyRisk('ls -la /tmp');
    expect(r.level).toBe('safe');
  });

  it('flags curl http external as caution', () => {
    const r = classifyRisk('curl https://api.example.com/data');
    expect(r.level).toBe('caution');
    expect(r.matchedId).toBe('curl-external');
  });

  it('flags rm -rf with broad glob as danger', () => {
    const r = classifyRisk('rm -rf *');
    expect(r.level).toBe('danger');
    expect(r.matchedId).toBe('rm-rf-broad');
  });
});

describe('classifyRisk — L1 parity for discard-class git commands', () => {
  it.each([
    ['git checkout .', 'git-checkout-discard'],
    ['git checkout -- .', 'git-checkout-discard'],
    ['git checkout . && npm test', 'git-checkout-discard'],
    ['git restore .', 'git-restore-discard'],
    ['git restore -- .', 'git-restore-discard'],
    ['git stash drop', 'git-stash-drop'],
    ['git stash drop stash@{0}', 'git-stash-drop'],
    ['git stash clear', 'git-stash-drop'],
  ])('grades %s as danger via %s', (command, matchedId) => {
    const r = classifyRisk(command);
    expect(r.level).toBe('danger');
    expect(r.matchedId).toBe(matchedId);
  });

  it.each([
    'git checkout main',
    'git checkout -b feat/x',
    'git checkout ./src/file.js',
    'git restore --staged file.js',
    'git restore src/file.js',
    'git stash list',
    'git stash pop',
  ])('leaves %s safe', (command) => {
    expect(classifyRisk(command).level).toBe('safe');
  });
});

describe('classifyRisk — scoped recursive delete is caution', () => {
  it.each([
    'rm -rf ./build',
    'rm -rf build',
    'rm -fr dist',
    'rm -rf node_modules/.cache',
    'rm -rfv dist',
    'rm -r -f dist',
    'rm -f -r dist',
    'rm --recursive --force dist',
    'rm -rf -- build',
  ])('grades %s as caution via rm-rf-path', (command) => {
    const r = classifyRisk(command);
    expect(r.level).toBe('caution');
    expect(r.matchedId).toBe('rm-rf-path');
  });

  it.each([
    'rm -f file.txt',
    'rm -r dir',
    'rm -rv dir',
    'rm --recursive dir',
    'rm --force file.txt',
    'rm -f /',
    'rm /tmp/file.txt',
    'ls -la /tmp',
  ])('leaves %s safe', (command) => {
    expect(classifyRisk(command).level).toBe('safe');
  });

  it.each([
    ['rm -rf /', 'rm-rf-root'],
    ['rm -rf ~/x', 'rm-rf-root'],
    ['rm -rf $HOME/x', 'rm-rf-root'],
    ['rm -fr /', 'rm-rf-root'],
    ['rm -r /', 'rm-rf-root'],
    ['rm -rfv /', 'rm-rf-root'],
    ['rm -r -f /', 'rm-rf-root'],
    ['rm -f -r /', 'rm-rf-root'],
    ['rm --recursive --force /', 'rm-rf-root'],
    ['rm -rf -- /', 'rm-rf-root'],
    ['rm -rv /', 'rm-rf-root'],
    ['rm -rfv ~/x', 'rm-rf-root'],
    ['rm -r -f $HOME', 'rm-rf-root'],
    ['rm -rf *', 'rm-rf-broad'],
    ['rm -fr *', 'rm-rf-broad'],
    ['rm -rfv *', 'rm-rf-broad'],
    ['rm -r -f *', 'rm-rf-broad'],
    ['rm --recursive --force *', 'rm-rf-broad'],
  ])('keeps %s at danger via %s (root/glob rules win over rm-rf-path)', (command, matchedId) => {
    const r = classifyRisk(command);
    expect(r.level).toBe('danger');
    expect(r.matchedId).toBe(matchedId);
  });
});

describe('classifyRisk — force push: lease is caution, blind force stays danger', () => {
  // 오너 결정 2026-09-11 ①. L1(blocked-patterns.js:66-77) 은 --force-with-lease /
  // --force-if-includes 를 safeOverrides 로 면제한다. L2 가 같은 명령을 danger 로
  // 부르면 두 층이 정반대를 말한다 → L2 는 caution 으로 내린다.
  it.each([
    'git push --force origin main',
    'git push origin main --force',
    'git push --force',
    'git push --force-with-lease origin main --force',
  ])('grades %s as danger via git-force-push', (command) => {
    const r = classifyRisk(command);
    expect(r.level).toBe('danger');
    expect(r.matchedId).toBe('git-force-push');
  });

  it.each([
    'git push -f origin main',
    'git push origin main -f',
  ])('grades %s as danger via git-force-push-short', (command) => {
    const r = classifyRisk(command);
    expect(r.level).toBe('danger');
    expect(r.matchedId).toBe('git-force-push-short');
  });

  it.each([
    'git push --force-with-lease origin main',
    'git push --force-with-lease',
    'git push --force-with-lease=main:abc123 origin main',
    'git push --force-if-includes origin main',
    'git push --force-with-lease --force-if-includes origin main',
  ])('grades %s as caution via git-force-push-lease', (command) => {
    const r = classifyRisk(command);
    expect(r.level).toBe('caution');
    expect(r.matchedId).toBe('git-force-push-lease');
  });

  it.each([
    'git push origin main',
    'git push --tags',
    'git pull --force',
  ])('leaves %s safe', (command) => {
    expect(classifyRisk(command).level).toBe('safe');
  });
});

/** 백슬래시. 리터럴로 쓰면 이스케이프 단계에서 사고가 난다. */
const BACKSLASH = String.fromCharCode(92);

describe('classifyRisk — git branch delete is case-sensitive on -D', () => {
  // 오너 결정 2026-09-11 ④. /i 플래그 때문에 안전한 `git branch -d` 가
  // danger 로 등록됐다. -D(강제)만 danger, -d/--delete 는 safe.
  it.each([
    'git branch -D topic',
    'git branch -D feat/x',
    'git branch -q -D topic',
    'git branch -Dv topic',
    'git branch --delete --force topic',
    'git branch --force --delete topic',
    'git branch -fd topic',
    'git branch -df topic',
    'git branch -f -d topic',
    // 인수 뒤에 붙은 플래그도 git 은 그대로 받는다 — 옵션 런이 대시 없는
    // 인수를 건너뛰지 못하면 이 네 형태가 전부 샌다(검수 2026-09-11 실측).
    'git branch -d topic -f',
    'git branch --delete topic --force',
    'git branch -f topic -d',
    'git branch topic -D',
    // 명령어 `git` 만 대소문자 무시 — 셸은 GIT 을 그대로 실행한다.
    'Git branch -D x',
    'GIT branch -D x',
    // 백슬래시 줄 연속은 한 명령이다 — 런이 끊기면 안 된다. 백슬래시는
    // String.fromCharCode(92) 로 조립해 리터럴 이스케이프 사고를 피한다.
    `git branch -d topic ${BACKSLASH}\n -f`,
    `git branch ${BACKSLASH}\n -D topic`,
    `git branch${BACKSLASH}\n -d topic -f`,
    `git branch -d topic ${BACKSLASH}\r\n -f`,
  ])('grades %j as danger via git-branch-delete', (command) => {
    const r = classifyRisk(command);
    expect(r.level).toBe('danger');
    expect(r.matchedId).toBe('git-branch-delete');
  });

  it.each([
    'git branch -d topic',
    'git branch -d feat/x',
    'git branch --delete topic',
    'git branch -q -d topic',
    'git branch',
    'git branch -a',
    'git branch -r',
    'git branch -vv',
    'git branch --list',
    'git branch -m old new',
    'git branch --sort=-committerdate',
    // 셸 구분자에서 옵션 런이 끝난다 — 뒤 명령의 -f 를 빌려오면 안 된다.
    'git branch -d topic && echo -f',
    'git branch -d topic | grep -f',
    'git branch -d topic; rm -f x',
    // 줄바꿈도 런을 끝낸다. 이 경계가 없으면 안전한 2줄 스크립트가
    // 뒷줄의 -f 때문에 danger 가 된다(검수 정규식 실측 오탐 2건).
    // 둘째 줄은 그 자체로 safe 한 명령이어야 이 경계만 검증한다.
    'git branch -d old\nnpm run build -- --force',
    'git branch -d topic\necho -f done',
    // -f 는 있지만 삭제 플래그가 없다.
    'git branch -m Dev -f',
    'git branch -v -f',
    'git branch --format=%(refname) -f',
    // git 이 대문자 서브커맨드를 거부한다 — 실행되지 않는 형태는 잡지 않는다.
    'git BRANCH -D x',
    // 줄 연속 뒤라도 셸 구분자는 여전히 런을 끝낸다.
    `git branch -d topic ${BACKSLASH}\n && ls -f`,
    `git branch -d topic ${BACKSLASH}\n | grep -f`,
  ])('leaves %j safe', (command) => {
    expect(classifyRisk(command).level).toBe('safe');
  });

  // 검수 정규식이 실제로 낸 오탐 그대로. 둘째 줄은 rm-rf-path 로 caution 이
  // 되므로 level 로는 못 잡는다 — 어느 규칙이 잡았는지를 봐야 한다.
  // 브랜치 삭제 규칙이 다음 줄의 -rf 를 강제 플래그로 빌려오면 안 된다.
  it.each([
    'git branch -d old\nrm -rf build',
    'git branch -d topic\ngit push -f origin main',
  ])('does not let git-branch-delete claim %j across a newline', (command) => {
    expect(classifyRisk(command).matchedId).not.toBe('git-branch-delete');
  });
});

describe('classifyRisk — TRUNCATE needs SQL statement shape', () => {
  // 오너 결정 2026-09-11 ②. /\bTRUNCATE\b/i 는 단어가 스치기만 해도 발화해
  // `grep -n -i "truncate\|force-with-lease" file` 을 차단했다(2026-09-11 실측).
  it.each([
    'TRUNCATE users;',
    'TRUNCATE TABLE users',
    'truncate table users;',
    'TRUNCATE ONLY users CASCADE',
    'psql -c "TRUNCATE users RESTART IDENTITY"',
    'TRUNCATE DATABASE foo',
    'TRUNCATE TABLE public.users RESTART IDENTITY CASCADE',
    'TRUNCATE users, orders;',
    'TRUNCATE users RESTRICT;',
  ])('grades %s as danger via sql-truncate', (command) => {
    const r = classifyRisk(command);
    expect(r.level).toBe('danger');
    expect(r.matchedId).toBe('sql-truncate');
  });

  it.each([
    'grep -n -i "truncate\\|force" file.js',
    'grep -n -B2 -A3 "force-with-lease\\|TRUNCATE\\|dd if" some.test.js',
    'git log --grep=truncate',
    'echo truncate',
    'node -e "fs.truncateSync(p)"',
    'truncate -s 0 file.log',
    'git commit -m "truncate long branch names"',
    'rg --files-with-matches TRUNCATE lib/',
  ])('leaves %s safe', (command) => {
    expect(classifyRisk(command).level).toBe('safe');
  });
});

describe('classifyRisk — dd writing to a raw device is danger', () => {
  // 오너 결정 2026-09-11 ③. L1(blocked-patterns.js:54 `dd\s+if=`) 은 차단하는데
  // L2 는 safe 였다 — "L1 block ⇒ L2 >= caution" 방향 규칙 위반.
  it.each([
    'dd if=/dev/zero of=/dev/sda',
    'dd if=/dev/zero of=/dev/sdb bs=1M',
    'sudo dd if=disk.img of=/dev/disk2 bs=4m',
    'dd of=/dev/sda if=/dev/zero',
  ])('grades %s as danger via dd-device-write', (command) => {
    const r = classifyRisk(command);
    expect(r.level).toBe('danger');
    expect(r.matchedId).toBe('dd-device-write');
  });

  it.each([
    'dd if=a.img of=b.img',
    'echo dd',
    'node scripts/dd-report.js',
    'ls /dev/sda',
  ])('leaves %s safe', (command) => {
    expect(classifyRisk(command).level).toBe('safe');
  });
});

describe('classifyRisk — option-run scanning is linear', () => {
  /** @param {string} command @returns {number} elapsed ms */
  function timeClassify(command) {
    const started = performance.now();
    classifyRisk(command);
    return performance.now() - started;
  }

  // The rm rules scan an option run before the target. If a run of long
  // options can be split more than one way, a non-matching tail costs 2^n.
  // bash-risk-guard.js runs inside a 5s PreToolUse hook, so a blow-up here
  // silently deletes the L2 verdict instead of failing loudly.
  it('stays linear on long option runs', () => {
    // 26 first: it is the largest size the exponential form still finishes
    // fast enough to report a failure rather than hang the suite.
    expect(timeClassify(`rm ${'--opt '.repeat(26)}x`)).toBeLessThan(50);
    expect(timeClassify(`rm ${'--opt '.repeat(40)}x`)).toBeLessThan(50);
    expect(timeClassify(`rm ${'--opt '.repeat(2000)}/`)).toBeLessThan(50);
  });

  // Same hazard for the 2026-09-11 rules: sql-truncate scans an identifier
  // list and git-branch-delete scans an option run, both on near-miss input
  // where a backtracking form would keep retrying.
  it('stays linear on near-miss TRUNCATE and git branch payloads', () => {
    expect(timeClassify(`TRUNCATE ${'a'.repeat(5000)}`)).toBeLessThan(50);
    expect(timeClassify(`TRUNCATE ${'a,'.repeat(2000)}b`)).toBeLessThan(50);
    expect(timeClassify(`TRUNCATE TABLE ${'x'.repeat(5000)}`)).toBeLessThan(50);
    expect(timeClassify(`git branch ${'--opt '.repeat(2000)}x`)).toBeLessThan(50);
    expect(timeClassify(`git branch ${'-abc '.repeat(2000)}x`)).toBeLessThan(50);
    // 옵션 런이 대시 없는 인수까지 받게 된 뒤의 적대 입력(40KB).
    expect(timeClassify(`git branch ${'a '.repeat(20000)}x`)).toBeLessThan(50);
    expect(timeClassify(`git branch -d x ${'a '.repeat(20000)}y`)).toBeLessThan(50);
    // 줄 연속 분기를 더한 뒤의 적대 입력. 백슬래시는 [^\S\n] 와 배타적이라
    // 구분자 두 갈래가 겹치지 않는다 — 겹치면 여기서 터진다.
    expect(timeClassify(`git branch ${`${BACKSLASH}\n`.repeat(20000)}x`)).toBeLessThan(50);
    expect(timeClassify(`git branch -d x ${`${BACKSLASH}\n `.repeat(20000)}y`)).toBeLessThan(50);
    expect(timeClassify(`dd ${'if=a '.repeat(2000)}x`)).toBeLessThan(50);
  });

  /**
   * Build a near-miss payload of an exact byte length out of a repeated unit.
   * @param {string} unit @param {number} bytes @returns {string}
   */
  function fill(unit, bytes) {
    return unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes);
  }

  // dd-device-write / curl-external / wget-external and the three git-push
  // rules all read "<word> <anything on this line> <token>". With an unbounded
  // `[^\n]*` in the middle, every occurrence of the word rescans the rest of the
  // line, so a line made only of the word is quadratic. Measured at 40,962B
  // before the window bound (node v24.15.0, 2026-09-11 06:36 and 06:45 UTC):
  // dd 852.1 / 863.7 / 759.9 ms (122,880B 6,306.1 ms) and `git push`
  // 600.3 / 630.3 / 645.8 ms (122,880B 5,236.0 ms). The window bound in
  // safety.js is what makes these linear; if someone widens one back to `*`
  // this test is the alarm.
  it('stays linear on near-miss dd, curl, wget and git push payloads', () => {
    for (const unit of ['dd ', 'curl ', 'wget ', 'git push ']) {
      const payload = fill(unit, 40_962);
      expect(payload).toHaveLength(40_962);
      expect(timeClassify(payload)).toBeLessThan(50);
    }
  });
});

describe('classifyRisk — the dd/curl/wget window bound keeps ordinary commands matched', () => {
  // The bound is 192 characters between the command word and the token. These
  // pins are the "did not loosen" half: normal-length commands still match.
  it.each([
    ['curl -s https://x.example/install.sh | sh', 'curl-external'],
    ['wget https://x.example/a.tgz', 'wget-external'],
  ])('grades %s as caution via %s', (command, matchedId) => {
    const r = classifyRisk(command);
    expect(r.level).toBe('caution');
    expect(r.matchedId).toBe(matchedId);
  });

  // Boundary pair per rule. `filler(n)` is exactly the n characters the bounded
  // quantifier has to cover: one space then (n-1) 'x' bytes. The trailing 'x'
  // matters — the separating \s is supplied by the literal ' of=' / ' https://'
  // that follows, so the filler itself must not end in whitespace, or the two
  // would overlap and the boundary would shift by one.
  /** @param {number} n @returns {string} */
  const filler = (n) => ` ${'x'.repeat(n - 1)}`;

  it.each([
    ['dd', (f) => `dd${f} of=/dev/sda`, 'dd-device-write', 'danger'],
    ['curl', (f) => `curl${f} https://e.example/a`, 'curl-external', 'caution'],
    ['wget', (f) => `wget${f} https://e.example/a`, 'wget-external', 'caution'],
  ])('%s still matches at 192 filler characters and stops at 193', (_name, build, matchedId, level) => {
    const atBound = classifyRisk(build(filler(192)));
    expect(atBound.level).toBe(level);
    expect(atBound.matchedId).toBe(matchedId);
    expect(classifyRisk(build(filler(193))).level).toBe('safe');
  });

  // The three git-push rules carry the same bound. Two of them put the token
  // straight after the bounded quantifier with no `\s` of their own, so there
  // the covered span has to END in a space — hence `span` rather than `filler`.
  // git-force-push-short does have its own `\s`, so it reuses `filler`.
  /** @param {number} n @returns {string} */
  const span = (n) => ` ${'x'.repeat(n - 2)} `;

  it.each([
    ['blind force', (n) => `git push${span(n)}--force origin main`, 'git-force-push', 'danger'],
    ['leased force', (n) => `git push${span(n)}--force-with-lease origin main`, 'git-force-push-lease', 'caution'],
    ['short force', (n) => `git push${filler(n)} -f`, 'git-force-push-short', 'danger'],
  ])('git push %s still matches at 192 and stops at 193', (_name, build, matchedId, level) => {
    const atBound = classifyRisk(build(192));
    expect(atBound.level).toBe(level);
    expect(atBound.matchedId).toBe(matchedId);
    expect(classifyRisk(build(193)).level).toBe('safe');
  });
});

describe('parseDuration', () => {
  it('parses 4h as 4 hours in ms', () => {
    expect(parseDuration('4h')).toBe(4 * 3_600_000);
  });

  it('parses 30m as 30 minutes in ms', () => {
    expect(parseDuration('30m')).toBe(30 * 60_000);
  });

  it('parses 2h as 2 hours in ms', () => {
    expect(parseDuration('2h')).toBe(2 * 3_600_000);
  });

  it('returns null for unparseable input', () => {
    expect(parseDuration('hello')).toBeNull();
  });
});

describe('shouldPause', () => {
  it('triggers when buildFailures >= 3', () => {
    const state = { counters: { buildFailures: 3, testFailures: 0 } };
    expect(shouldPause(state)).toBe(true);
    expect(pauseReason(state)).toBe('build-failures-threshold');
  });

  it('does not trigger at buildFailures 2', () => {
    const state = { counters: { buildFailures: 2, testFailures: 0 } };
    expect(shouldPause(state)).toBe(false);
  });

  it('triggers when testFailures >= 5', () => {
    const state = { counters: { buildFailures: 0, testFailures: 5 } };
    expect(shouldPause(state)).toBe(true);
    expect(pauseReason(state)).toBe('test-failures-threshold');
  });

  it('does not trigger at testFailures 4', () => {
    const state = { counters: { buildFailures: 0, testFailures: 4 } };
    expect(shouldPause(state)).toBe(false);
  });
});
