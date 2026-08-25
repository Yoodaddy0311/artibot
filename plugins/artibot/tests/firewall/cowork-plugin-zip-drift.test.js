/**
 * 검사 목적: 리포 루트의 배포 아티팩트 `artibot-cowork.plugin`(ZIP) 이
 * `plugins/artibot-cowork/` 트리와 **실제로 일치**하는가.
 *
 * ── 왜 필요했나 (2026-08-16 실측) ────────────────────────────────────────────
 * `plugins/artibot-cowork/README.md:61` 은 이 ZIP 을 채팅에 끌어다 놓는 것을
 * **Option 1 (recommended for Cowork)** 로 광고한다. 그런데 그 파일은 커밋
 * 이력이 **평생 1건**(27bca93f, 2026-04-20)이고, 리포 어디에도 재생성 경로가
 * 없었다 — `RELEASE.md` 7단계에 패키징 단계 0, `Compress-Archive|adm-zip|
 * bestzip|zip -r|zipSync|archiver` 전역 히트 0. **어떤 게이트도 보지 않았다.**
 *
 * 결과(재생성 전 실측): ZIP 179 엔트리 안에 `ai-slop-reviewer`·`kr-marketing`·
 * `ad-compliance`·`schema-generator`·`evolution-loop`·`agents/long-form-writer.md`
 * 가 **전부 0건**. README 9대 특징 중 4개와 30초 데모가 Option 1 설치자에게는
 * 통째로 실패하고 있었고, 이미 삭제된 파일 2건은 여전히 실려 있었다.
 * 트리가 커져도 ZIP 은 조용했다 — 조용한 것이 이 결함의 성질이다.
 *
 * ── 형태 (rules §10) ────────────────────────────────────────────────────────
 * `tests/firewall/` vitest. 파일이 없으면 red = fail-closed.
 * 기대 목록을 **손으로 들고 있지 않고** 패커의 `PACK_ALLOWLIST` 에서 읽는다 —
 * 손 목록은 다음 스킬 추가 때 낡고, 그러면 게이트가 ZIP 과 사이좋게 같이 틀린다.
 * ZIP 은 **중앙 디렉터리만** 읽는다(압축 해제 불필요): 엔트리 이름 + CRC32 +
 * 원본 크기가 거기 다 있고, `zlib.crc32` 로 트리 파일과 직접 대조된다.
 *
 * ── 이 게이트가 못 보는 것 (rules §9) ───────────────────────────────────────
 *
 *  1. **ZIP 이 Cowork 에서 실제로 설치되는지는 못 본다.** 내용물 일치만 본다.
 *     드래그앤드롭 설치 경로는 이 리포에서 실행할 수 없다 — 여전히 미검증이다.
 *  2. **`PACK_ALLOWLIST` 가 옳은지는 못 본다.** allowlist 가 어떤 디렉터리를
 *     빠뜨리면 ZIP 과 게이트가 **함께** 그것을 빠뜨린다. allowlist 자체는 사람이
 *     리뷰해야 하는 판단이다. (그래서 deny-list 가 아니라 allowlist 다 — 새로
 *     생긴 개발용 디렉터리가 조용히 배포에 실리는 방향의 사고는 막는다.)
 *  3. **바이트 동일성은 요구하지 않는다.** 엔트리 집합과 CRC 만 본다. 압축
 *     레벨이나 엔트리 순서가 달라져도 내용이 같으면 통과한다 — 의도적이다.
 *  4. **동시 편집 중에는 red 가 정상이다.** 누군가 cowork 트리를 고치고 ZIP 을
 *     재생성하지 않으면 이 게이트는 red 가 된다. 그것이 이 게이트의 목적이다.
 *  5. **크로스플랫폼 검사는 `HEAD` 에 있는 파일만 본다.** 아직 커밋되지 않은 새
 *     파일은 대조 대상이 없어 건너뛴다(분모로 노출된다). 즉 "새 파일이 CRLF 로
 *     실릴 수 있는가"는 **커밋된 뒤에야** 잡힌다.
 *  6. **`git` 실행에 의존한다.** git 이 없는 환경에서는 5번 테스트의 분모가
 *     0 이 되어 red 가 된다 — fail-closed 쪽이라 의도대로다.
 *
 * ── 2026-08-16 CI 회귀 (이 게이트가 첫 실행에서 잡은 것) ────────────────────
 * Windows 워킹트리(CRLF)에서 패킹한 ZIP 이 Linux 체크아웃(LF)과 CRC 불일치.
 * `missing: []` + CRC 불일치 = **파일 목록은 맞고 바이트가 다름**. 실측: 한
 * 에이전트 파일이 워킹트리 4,816B(CRLF 112개) vs git 오브젝트 4,704B(CRLF 0개)
 * — 차이 112B 가 정확히 CR 개수였다. 같은 커밋에서 패킹한 OS 에 따라 사용자에게
 * 가는 바이트가 달라지고 있었다. 패커가 개행을 정규화하도록 고쳤고, 아래 5번
 * 테스트가 그 성질을 상시 강제한다.
 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';
import {
  collectEntries,
  deriveDirs,
  PACK_ALLOWLIST,
  readPackedBytes,
} from '../../scripts/pack-cowork-plugin.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');
const ZIP_PATH = path.join(REPO_ROOT, 'artibot-cowork.plugin');
const COWORK_DIR = path.join(REPO_ROOT, 'plugins', 'artibot-cowork');

/**
 * Read a ZIP central directory. No decompression — every field this gate needs
 * (name, CRC32, uncompressed size) lives in the central directory record.
 *
 * @param {Buffer} buf - Whole archive.
 * @returns {Array<{name: string, crc: number, size: number}>}
 */
function readCentralDirectory(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('End Of Central Directory not found — not a ZIP?');

  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) {
      throw new Error(`bad central-directory header at byte ${off}`);
    }
    const crc = buf.readUInt32LE(off + 16);
    const size = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const cmtLen = buf.readUInt16LE(off + 32);
    out.push({ name: buf.toString('utf8', off + 46, off + 46 + nameLen), crc, size });
    off += 46 + nameLen + extraLen + cmtLen;
  }
  return out;
}

/**
 * Read many `HEAD:<path>` blobs out of git in ONE process.
 *
 * WHY THIS IS BATCHED. The obvious spelling is `git show HEAD:<path>` per file,
 * and that is what this gate shipped with. It made the byte-equality test below
 * a process-spawn benchmark: measured 2026-08-25 on this tree, 158 files at
 * 37.1 ms/spawn = 5,869 ms, of which the actual file reading
 * (`readPackedBytes`) was 43 ms. 99.3% of the test was spawn overhead.
 *
 * THE NUMBER THAT MATTERS IS NOT THE 33x SPEEDUP — IT IS THE MARGIN. Do not
 * read the old state as 'a test that was sometimes slow'. Spawn cost is the
 * thing that degrades under parallelism: measured the same day, one worker per
 * concurrent spawner, k=1 36.2 ms, k=8 41.9 ms, k=16 71.0 ms, k=32 149.8 ms —
 * a 4.13x regression at the ~31 workers vitest opens on a 32-core box. So in a
 * real full-suite run this test spent 25,377 ms of a 30,000 ms budget. EVERY
 * run. A 1.18x margin is not flakiness, it is a test that fails the moment
 * anything else touches the machine — coverage instrumentation, a second suite,
 * one more teammate. It had already timed out four times, and the runs that
 * 'passed' were just as broken. Raising the timeout would have moved the cliff,
 * not removed it; the only real fix was to stop spawning 158 processes.
 *
 * One `git cat-file --batch` does the same work in 178 ms — a 33x reduction in
 * the resource that was actually scarce. Verified byte-for-byte against the
 * per-file `git show` output for all 158 files before the swap: 158 identical,
 * 0 content mismatches, 0 presence mismatches.
 *
 * This changes NOTHING about what the gate detects. Same paths, same bytes,
 * same denominator, same missing-file handling — a file absent from HEAD still
 * comes back as a skip rather than a pass. The only thing that shrank is the
 * process count.
 *
 * Fails closed: an unparseable header or a short read throws rather than
 * silently yielding fewer blobs, which would quietly shrink the denominator
 * the assertion below relies on.
 *
 * @param {string[]} relPaths - Cowork-relative POSIX paths.
 * @returns {Map<string, Buffer|null>} Blob bytes, or null when absent from HEAD.
 */
function readCommittedBlobs(relPaths) {
  for (const rel of relPaths) {
    // `--batch` is newline-delimited, so a newline in a path would desync the
    // whole stream and misattribute every blob after it. Windows cannot create
    // such a name; assert rather than assume.
    if (/[\n\r]/.test(rel)) {
      throw new Error(`path contains a newline, unsafe for --batch: ${JSON.stringify(rel)}`);
    }
  }
  const paths = relPaths.map((r) => `HEAD:plugins/artibot-cowork/${r}`);
  const out = execFileSync('git', ['cat-file', '--batch'], {
    cwd: REPO_ROOT,
    input: `${paths.join('\n')}\n`,
    maxBuffer: 1 << 28,
    stdio: ['pipe', 'pipe', 'ignore'],
  });

  const blobs = new Map();
  let off = 0;
  for (const rel of relPaths) {
    const nl = out.indexOf(0x0a, off);
    if (nl < 0) throw new Error(`git cat-file --batch output ended early at ${rel}`);
    const header = out.toString('utf8', off, nl);
    off = nl + 1;
    if (/ (missing|ambiguous)$/.test(header)) {
      blobs.set(rel, null);
      continue;
    }
    const m = /^[0-9a-f]+ blob (\d+)$/.exec(header);
    if (!m) throw new Error(`unparseable --batch header for ${rel}: ${JSON.stringify(header)}`);
    const size = Number(m[1]);
    blobs.set(rel, out.subarray(off, off + size));
    off += size + 1; // content, then the LF git appends after it
  }
  if (off !== out.length) {
    throw new Error(`git cat-file --batch output not fully consumed: ${off} of ${out.length} bytes`);
  }
  if (blobs.size !== relPaths.length) {
    throw new Error(`--batch accounted for ${blobs.size} of ${relPaths.length} paths`);
  }
  return blobs;
}

describe('artibot-cowork.plugin ZIP mirrors the cowork tree', () => {
  it('the release artifact exists (fail-closed)', () => {
    expect(
      existsSync(ZIP_PATH),
      'artibot-cowork.plugin is missing — README.md:61 advertises it as the Option 1 install path. ' +
        'Regenerate: node plugins/artibot/scripts/pack-cowork-plugin.mjs',
    ).toBe(true);
  });

  it('every allowlisted tree file is present in the ZIP with a matching CRC32', () => {
    const entries = readCentralDirectory(readFileSync(ZIP_PATH));
    const byName = new Map(entries.map((e) => [e.name, e]));
    const files = collectEntries();

    // Denominator assertion: distinguishes "0 mismatches" from "0 files checked".
    expect(files.length, 'allowlist resolved to zero files — packer or tree is broken').toBeGreaterThan(100);
    expect(entries.length, 'ZIP central directory is empty').toBeGreaterThan(files.length);

    const missing = [];
    const corrupt = [];
    for (const rel of files) {
      const entry = byName.get(rel);
      if (!entry) {
        missing.push(rel);
        continue;
      }
      // readPackedBytes, not readFileSync — the comparison must use exactly the
      // bytes the packer ships, or the gate validates something that never shipped.
      const packed = readPackedBytes(rel);
      if (entry.crc !== crc32(packed) || entry.size !== packed.length) corrupt.push(rel);
    }

    expect(
      { checked: files.length, missing, corrupt },
      'ZIP is stale. Regenerate: node plugins/artibot/scripts/pack-cowork-plugin.mjs',
    ).toEqual({ checked: files.length, missing: [], corrupt: [] });
  });

  it('the ZIP carries nothing the tree no longer has', () => {
    const entries = readCentralDirectory(readFileSync(ZIP_PATH));
    const expected = new Set([...collectEntries(), ...deriveDirs(collectEntries())]);

    expect(expected.size, 'expected-entry set is empty').toBeGreaterThan(100);

    const stale = entries.map((e) => e.name).filter((n) => !expected.has(n));
    expect(
      stale,
      'ZIP contains entries absent from the tree (deleted files still shipping). ' +
        'Regenerate: node plugins/artibot/scripts/pack-cowork-plugin.mjs',
    ).toEqual([]);
  });

  it('development-only paths never ship', () => {
    const entries = readCentralDirectory(readFileSync(ZIP_PATH));
    const allowedTops = new Set(PACK_ALLOWLIST.map((a) => a.path));

    expect(allowedTops.size, 'allowlist is empty').toBeGreaterThan(0);

    const leaked = entries
      .map((e) => e.name)
      .filter((n) => {
        const top = n.split('/')[0];
        return !allowedTops.has(top) && !allowedTops.has(n);
      });
    expect(leaked, 'entries outside PACK_ALLOWLIST leaked into the release archive').toEqual([]);
  });

  it('packed bytes equal the committed (LF) bytes — the archive is a function of the commit, not of the OS', () => {
    // The 2026-08-16 CI failure in one line: the archive was packed from a
    // Windows working tree (CRLF) and compared against a Linux checkout (LF),
    // so the same commit yielded two different archives. `git show HEAD:<path>`
    // hands back the stored object — LF — which is exactly what a Linux
    // checkout materializes. If packed bytes equal those, the packer's output
    // no longer depends on which machine ran it.
    const files = collectEntries();
    // One git process for every path — see readCommittedBlobs above for why the
    // per-file spelling made this test time out under parallel load.
    const committedBlobs = readCommittedBlobs(files);
    let compared = 0;
    const skipped = [];
    const mismatched = [];

    for (const rel of files) {
      const committed = committedBlobs.get(rel);
      if (committed === null) {
        // Not in HEAD yet (new file in the working tree) — nothing to compare against.
        skipped.push(rel);
        continue;
      }
      compared++;
      const packed = readPackedBytes(rel);
      if (!committed.equals(packed)) {
        mismatched.push({ path: rel, committed: committed.length, packed: packed.length });
      }
    }

    // Denominator, and the reason it is an EXACT count rather than a floor.
    //
    // `> 100` was the old spelling, and against 158 files it tolerated 57
    // silently-skipped ones. That is the fail-open this gate has to be immune
    // to, because a skip is not an error here: a file legitimately absent from
    // HEAD (new, uncommitted) is skipped BY DESIGN — see note 5 in the header.
    // So "count the skips" cannot separate the legitimate case from a parser
    // that lost entries; both land in the same bucket and both stay green.
    //
    // What separates them is asking git which files are actually in HEAD. Every
    // file that IS committed must have been compared; only genuinely-absent
    // ones may be skipped. One extra process for the whole list (~37 ms), which
    // is the entire point of batching in the first place.
    const HEAD_PREFIX = 'plugins/artibot-cowork/';
    const inHead = new Set(
      execFileSync('git', ['ls-tree', '-r', '--name-only', 'HEAD', '--', 'plugins/artibot-cowork'], {
        cwd: REPO_ROOT,
        maxBuffer: 1 << 28,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .toString('utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => (line.startsWith(HEAD_PREFIX) ? line.slice(HEAD_PREFIX.length) : line)),
    );

    expect(inHead.size, 'git ls-tree returned nothing — the cross-check would be vacuous').toBeGreaterThan(100);
    expect(compared, `compared ${compared} files but HEAD holds ${files.filter((f) => inHead.has(f)).length} of them`)
      .toBe(files.filter((f) => inHead.has(f)).length);
    expect(skipped, 'a file present in HEAD was skipped — the batch parser lost it')
      .toEqual(files.filter((f) => !inHead.has(f)));
    expect(compared + skipped.length, 'files were neither compared nor skipped').toBe(files.length);

    // ...and every assertion above is anchored to `files`, so none of them can see
    // `files` ITSELF shrinking: a collectEntries() that quietly returns 157 of 158
    // shrinks the expectation with it and stays green. Not hypothetical — measured
    // 2026-08-25 by mutation: `collectEntries().slice(0, -1)` passed every check
    // above, and passed the older `> 100` floor too. So the last assertion anchors
    // to HEAD instead: anything committed, allowlisted, and still on disk MUST have
    // been collected. Requiring it to still be on disk is what keeps a genuine
    // deletion from false-alarming here — that case is test 3's job, not this one's.
    const allowedTops = new Set(PACK_ALLOWLIST.map((a) => a.path));
    const collected = new Set(files);
    const lost = [...inHead]
      .filter((n) => allowedTops.has(n.split('/')[0]) || allowedTops.has(n))
      .filter((n) => !collected.has(n) && existsSync(path.join(COWORK_DIR, n)))
      .sort();
    expect(lost, 'committed, allowlisted, still on disk — but collectEntries() no longer returns it')
      .toEqual([]);

    expect(
      mismatched,
      'packed bytes differ from the committed bytes — the archive depends on the packing machine. ' +
        'Usually a line-ending issue: check NORMALIZE_EXTENSIONS covers this file type.',
    ).toEqual([]);
  });

  it('every allowlist entry still exists in the tree with the declared kind', () => {
    expect(PACK_ALLOWLIST.length).toBeGreaterThan(0);
    for (const item of PACK_ALLOWLIST) {
      const abs = path.join(COWORK_DIR, item.path);
      expect(existsSync(abs), `allowlist names ${item.path} but the tree has no such path`).toBe(true);
      expect(
        statSync(abs).isDirectory(),
        `allowlist declares ${item.path} as ${item.kind}`,
      ).toBe(item.kind === 'dir');
    }
  });
});
