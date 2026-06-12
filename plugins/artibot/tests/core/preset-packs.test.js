/**
 * 검사 목적: preset-packs 모듈 — 프리셋 팩(in-plugin 스킬/커맨드 묶음)의 조회·해석·
 * 적용이 명세대로 동작하고, 가장 중요하게 artibot.config.json 의 모든 팩 멤버가 디스크에
 * 실재함을 단언한다(드리프트 가드).
 *
 * DATA POLICY: preset-packs 는 100% 로컬 — 네트워크/파일복사 없음. 팩 "적용"은
 * 존재 확인 + 보고이며 부작용이 없어야 한다. 본 테스트도 임시 픽스처 루트만 읽고
 * 실제 디스크를 변경하지 않는다.
 *
 * @module tests/core/preset-packs
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { _internals, applyPack, listPacks, resolvePack } from '../../lib/core/preset-packs.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
/** 플러그인 루트 (`plugins/artibot/`) */
const PLUGIN_ROOT = join(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// 픽스처: 임시 pluginRoot — 스킬 2개 + 커맨드 1개를 실재시키고, 나머지는 누락시킴.
// ---------------------------------------------------------------------------

const fixtureRoot = mkdtempSync(join(tmpdir(), 'preset-packs-'));
mkdirSync(join(fixtureRoot, 'skills', 'present-skill'), { recursive: true });
writeFileSync(join(fixtureRoot, 'skills', 'present-skill', 'SKILL.md'), '---\nname: present-skill\n---\n');
mkdirSync(join(fixtureRoot, 'skills', 'second-skill'), { recursive: true });
writeFileSync(join(fixtureRoot, 'skills', 'second-skill', 'SKILL.md'), '---\nname: second-skill\n---\n');
mkdirSync(join(fixtureRoot, 'commands'), { recursive: true });
writeFileSync(join(fixtureRoot, 'commands', 'present-cmd.md'), '# present-cmd\n');

/** 픽스처 config: 실재 멤버 + 누락 멤버를 섞은 팩 정의. */
const fixtureConfig = {
  packs: {
    _comment: 'skip me',
    demo: {
      description: '데모 팩',
      skills: ['present-skill', 'second-skill', 'ghost-skill'],
      commands: ['present-cmd', 'ghost-cmd'],
    },
    empty: { description: '빈 팩' },
  },
};

afterAll(() => {
  // Windows에서는 OS 임시 디렉토리가 세션 간 잔류할 수 있어 명시적으로 정리한다.
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('listPacks', () => {
  it('packs 정의를 경량 요약으로 나열하고 _comment 는 제외한다', () => {
    const packs = listPacks(fixtureConfig);
    const names = packs.map((p) => p.name);
    expect(names).toEqual(['demo', 'empty']);
    const demo = packs.find((p) => p.name === 'demo');
    expect(demo.skillCount).toBe(3);
    expect(demo.commandCount).toBe(2);
    expect(demo.description).toBe('데모 팩');
  });

  it('packs 섹션이 없는 구버전 config 에서도 빈 배열을 반환한다 (하위호환)', () => {
    expect(listPacks({})).toEqual([]);
    expect(listPacks({ version: '4.0.0' })).toEqual([]);
    expect(listPacks(null)).toEqual([]);
    expect(listPacks(undefined)).toEqual([]);
  });

  it('반환값은 동결(immutable)되어 변형이 차단된다', () => {
    const packs = listPacks(fixtureConfig);
    expect(Object.isFrozen(packs)).toBe(true);
  });
});

describe('resolvePack', () => {
  it('실재 멤버는 exists:true, 누락 멤버는 exists:false 로 태깅한다 (warn-skip 기반 데이터)', () => {
    const resolved = resolvePack('demo', fixtureConfig, { pluginRoot: fixtureRoot });
    expect(resolved).not.toBeNull();
    const skillMap = Object.fromEntries(resolved.skills.map((s) => [s.name, s.exists]));
    expect(skillMap).toEqual({ 'present-skill': true, 'second-skill': true, 'ghost-skill': false });
    const cmdMap = Object.fromEntries(resolved.commands.map((c) => [c.name, c.exists]));
    expect(cmdMap).toEqual({ 'present-cmd': true, 'ghost-cmd': false });
  });

  it('미지(unknown)의 팩 이름은 null 을 반환한다', () => {
    expect(resolvePack('does-not-exist', fixtureConfig, { pluginRoot: fixtureRoot })).toBeNull();
  });

  it('빈/비문자 팩 이름은 null 을 반환한다 (never-throw)', () => {
    expect(resolvePack('', fixtureConfig)).toBeNull();
    expect(resolvePack(null, fixtureConfig)).toBeNull();
    expect(resolvePack(42, fixtureConfig)).toBeNull();
  });

  it('skills/commands 키가 없는 팩은 빈 배열로 정규화한다', () => {
    const resolved = resolvePack('empty', fixtureConfig, { pluginRoot: fixtureRoot });
    expect(resolved.skills).toEqual([]);
    expect(resolved.commands).toEqual([]);
  });
});

describe('applyPack', () => {
  it('dryRun(기본)은 디스크를 변경하지 않고 멤버를 applied/missing 로 분류한다', () => {
    const before = snapshot(fixtureRoot);
    const report = applyPack('demo', fixtureConfig, { pluginRoot: fixtureRoot });
    const after = snapshot(fixtureRoot);

    expect(report.dryRun).toBe(true);
    expect(report.ok).toBe(true);
    expect(report.applied.map((a) => a.name).sort()).toEqual(['present-cmd', 'present-skill', 'second-skill']);
    expect(report.missing.map((m) => m.name).sort()).toEqual(['ghost-cmd', 'ghost-skill']);
    // 누락 멤버마다 warn-skip 메시지가 남는다.
    expect(report.warnings.length).toBe(2);
    // 부작용 0: 픽스처 트리가 호출 전후로 동일.
    expect(after).toEqual(before);
  });

  it('미지의 팩은 ok:false + unknown 경고를 반환한다 (never-throw)', () => {
    const report = applyPack('nope', fixtureConfig, { pluginRoot: fixtureRoot });
    expect(report.ok).toBe(false);
    expect(report.pack).toBe('nope');
    expect(report.warnings[0]).toMatch(/unknown pack/);
    expect(report.applied).toEqual([]);
  });

  it('packs 섹션 부재 config 에서도 throw 없이 ok:false 를 반환한다 (하위호환)', () => {
    const report = applyPack('vibe', {}, { pluginRoot: fixtureRoot });
    expect(report.ok).toBe(false);
  });

  it('반환 리포트는 동결된다', () => {
    const report = applyPack('demo', fixtureConfig, { pluginRoot: fixtureRoot });
    expect(Object.isFrozen(report)).toBe(true);
  });
});

describe('드리프트 가드 — artibot.config.json 의 모든 팩 멤버가 실재해야 한다', () => {
  const realConfig = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'artibot.config.json'), 'utf-8'));
  const packs = listPacks(realConfig);

  it('실제 config 에 packs 섹션이 존재한다', () => {
    expect(packs.length).toBeGreaterThan(0);
  });

  for (const { name } of packs) {
    it(`팩 "${name}" 의 모든 멤버가 디스크에 존재한다 (exists:true)`, () => {
      const resolved = resolvePack(name, realConfig, { pluginRoot: PLUGIN_ROOT });
      const missing = [
        ...resolved.skills.filter((s) => !s.exists).map((s) => `skill:${s.name}`),
        ...resolved.commands.filter((c) => !c.exists).map((c) => `command:${c.name}`),
      ];
      expect(missing, `팩 "${name}" 의 누락 멤버: ${missing.join(', ')}`).toHaveLength(0);
    });
  }
});

describe('_internals.memberPath', () => {
  it('skill 은 skills/<name>/SKILL.md, command 는 commands/<name>.md 경로를 만든다', () => {
    expect(_internals.memberPath('skill', 'foo', fixtureRoot)).toBe(
      join(fixtureRoot, 'skills', 'foo', 'SKILL.md'),
    );
    expect(_internals.memberPath('command', 'bar', fixtureRoot)).toBe(
      join(fixtureRoot, 'commands', 'bar.md'),
    );
  });
});

/**
 * 디렉토리 트리를 정렬된 상대경로 배열로 직렬화 — 부작용 0 비교용 스냅샷.
 *
 * @param {string} root - 스냅샷 대상 절대 경로.
 * @returns {string[]} 정렬된 상대 경로 목록.
 */
function snapshot(root) {
  const out = [];
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      out.push(rel + (entry.isDirectory() ? '/' : ''));
      if (entry.isDirectory()) walk(join(dir, entry.name), rel);
    }
  };
  if (existsSync(root)) walk(root, '');
  return out;
}
