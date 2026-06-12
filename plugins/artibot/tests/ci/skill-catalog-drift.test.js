/**
 * 검사 목적: 스킬 카탈로그 드리프트 가드 — skills/ 디렉토리명 ↔ SKILL.md frontmatter
 * `name` 일치 + 스킬명 중복 0건을 단언한다.
 *
 * 디렉토리명과 frontmatter `name`이 어긋나면 스킬 로더(디렉토리 기준)와 매칭/문서
 * (name 기준)가 다른 스킬을 가리켜 조용한 미스라우팅이 발생한다. 또한 두 디렉토리가
 * 동일한 frontmatter `name`을 선언하면 마지막에 로드된 쪽이 앞쪽을 덮어써 트리거가
 * 사라진다. 두 클래스 모두 정적 스캔으로 차단한다.
 *
 * data-policy-outbound-guard.test.js 패턴 미러: skills/ 부재 시 스위트 fail(설정 오류
 * 조기 감지), 개별 SKILL.md 파싱 실패는 해당 항목 fail로 가시화한다.
 *
 * @module tests/ci/skill-catalog-drift
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** 플러그인 루트 (`plugins/artibot/`) */
const PLUGIN_ROOT = join(__dirname, '..', '..');
/** 스킬 카탈로그 루트. */
const SKILLS_DIR = join(PLUGIN_ROOT, 'skills');

/**
 * SKILL.md frontmatter에서 `name` 값을 추출한다. inline 형태만 지원하며
 * (`name: foo` 또는 `name: "foo"`), 따옴표를 제거해 반환한다.
 *
 * @param {string} content - SKILL.md 원본 내용.
 * @returns {string|null} name 값, 없으면 null.
 */
function extractName(content) {
  const text = String(content).replace(/\r\n/g, '\n');
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return null;
  for (const line of fm[1].split('\n')) {
    const m = line.match(/^name:\s*(.+)$/);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  }
  return null;
}

/**
 * skills/ 하위의 모든 `<dir>/SKILL.md` 쌍을 수집한다.
 *
 * @returns {Array<{dir:string, file:string}>} 디렉토리명 + 절대 경로 쌍.
 */
function gatherSkillDirs() {
  if (!existsSync(SKILLS_DIR)) return [];
  const out = [];
  for (const entry of readdirSync(SKILLS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(SKILLS_DIR, entry.name, 'SKILL.md');
    if (existsSync(file)) out.push({ dir: entry.name, file });
  }
  return out.sort((a, b) => a.dir.localeCompare(b.dir));
}

const skillDirs = gatherSkillDirs();

describe('Skill catalog drift guard (dir ↔ frontmatter name)', () => {
  it('skills/ 디렉토리에 SKILL.md가 1개 이상 존재해야 한다 (설정 오류 감지)', () => {
    if (!existsSync(SKILLS_DIR)) {
      throw new Error(`스킬 카탈로그 가드: skills/ 디렉토리 부재 — ${SKILLS_DIR}`);
    }
    expect(skillDirs.length).toBeGreaterThan(0);
  });

  describe('디렉토리명 ↔ frontmatter name 일치', () => {
    for (const { dir, file } of skillDirs) {
      it(`${dir} — name === 디렉토리명`, () => {
        const name = extractName(readFileSync(file, 'utf-8'));
        expect(name, `${dir}/SKILL.md 에 frontmatter name 키가 없습니다`).not.toBeNull();
        expect(name, `드리프트: 디렉토리 "${dir}" vs frontmatter name "${name}"`).toBe(dir);
      });
    }
  });

  it('중복 스킬명 0건', () => {
    const seen = new Map();
    const dupes = [];
    for (const { dir, file } of skillDirs) {
      const name = extractName(readFileSync(file, 'utf-8'));
      if (name === null) continue;
      if (seen.has(name)) {
        dupes.push(`"${name}": ${seen.get(name)} & ${dir}`);
      } else {
        seen.set(name, dir);
      }
    }
    expect(dupes, `중복 스킬명 발견: ${dupes.join(', ')}`).toHaveLength(0);
  });
});
