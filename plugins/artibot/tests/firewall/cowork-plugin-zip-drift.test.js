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
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';
import {
  collectEntries,
  deriveDirs,
  PACK_ALLOWLIST,
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
      const raw = readFileSync(path.join(COWORK_DIR, rel));
      if (entry.crc !== crc32(raw) || entry.size !== raw.length) corrupt.push(rel);
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
