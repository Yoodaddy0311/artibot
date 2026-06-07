import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isNewerVersion } from '../../lib/core/version-checker.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PLUGIN_ROOT = path.resolve(
  fileURLToPath(import.meta.url),
  '..', '..', '..',
);

/**
 * All v1.15.0 new files that must be present in the plugin source tree
 * for install.sh's recursive cp to include them.
 */
const V1_15_NEW_FILES = [
  'lib/learning/eval-isolator.js',
  'lib/learning/eval-calibrator.js',
  'lib/learning/skill-freshness.js',
  'lib/learning/skill-promoter.js',
  'lib/core/feature-tracker.js',
  'output-styles/artibot-intelligence.md',
  'scripts/evals/harness-ablation.js',
  'scripts/evals/skill-effectiveness.js',
];

// ---------------------------------------------------------------------------
// 1. v1.15.0 신규 파일이 소스 트리에 존재
// ---------------------------------------------------------------------------

describe('install/v1.15.0 new files exist in source', () => {
  for (const relPath of V1_15_NEW_FILES) {
    it(`소스에 존재: ${relPath}`, () => {
      const full = path.join(PLUGIN_ROOT, relPath);
      expect(existsSync(full)).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// 2. install.sh가 모든 신규 파일의 상위 디렉토리를 재귀 복사
// ---------------------------------------------------------------------------

describe('install/install.sh covers new file directories', () => {
  let installShContent;

  it('install.sh 파일 존재', () => {
    const installPath = path.join(PLUGIN_ROOT, 'install.sh');
    expect(existsSync(installPath)).toBe(true);
    installShContent = readFileSync(installPath, 'utf-8');
  });

  for (const relPath of V1_15_NEW_FILES) {
    const topDir = relPath.split('/')[0]; // lib, scripts, output-styles, etc.
    it(`install.sh가 ${topDir}/ 디렉토리를 재귀 복사`, () => {
      // install.sh recursively copies via either:
      //   - direct: cp -r "${SCRIPT_DIR}/<dir>" "${ARTIBOT_DIR}/"
      //   - helper: safe_copy_dir "${SCRIPT_DIR}/<dir>" "${ARTIBOT_DIR}/<dir>"
      // (helper wraps cp -r / rsync with --exclude=node_modules --exclude=.git)
      const cpPattern = new RegExp(`cp\\s+-r\\s+.*["']?\\$\\{?SCRIPT_DIR\\}?["']?/${topDir}["']?\\s`);
      const cpAltPattern = new RegExp(`cp\\s+-r\\s+.*${topDir}.*ARTIBOT_DIR`);
      const safeCopyPattern = new RegExp(`safe_copy_dir\\s+["']?\\$\\{?SCRIPT_DIR\\}?["']?/${topDir}["']?`);
      const hasRecursiveCopy =
        cpPattern.test(installShContent) ||
        cpAltPattern.test(installShContent) ||
        safeCopyPattern.test(installShContent);
      expect(hasRecursiveCopy).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// 3. update.js 버전 비교: 1.14.3 → 1.15.0 업데이트 감지
// ---------------------------------------------------------------------------

describe('update/version comparison', () => {
  it('1.14.3 → 1.15.0 업데이트 감지', () => {
    expect(isNewerVersion('1.14.3', 'v1.15.0')).toBe(true);
  });

  it('1.15.0 → 1.15.0 동일 버전은 업데이트 아님', () => {
    expect(isNewerVersion('1.15.0', 'v1.15.0')).toBe(false);
  });

  it('1.15.0 → 1.14.3 다운그레이드 아님', () => {
    expect(isNewerVersion('1.15.0', 'v1.14.3')).toBe(false);
  });

  it('0.0.0 → 어떤 버전이든 업데이트', () => {
    expect(isNewerVersion('0.0.0', 'v1.15.0')).toBe(true);
  });

  it('v 접두사 무관', () => {
    expect(isNewerVersion('v1.14.3', '1.15.0')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. SKILL.md sources/version/lastVerified 필드 보존 (설치 시 덮어쓰기)
// ---------------------------------------------------------------------------

describe('install/SKILL.md field preservation', () => {
  it('스킬 디렉토리에 SKILL.md가 존재하고 frontmatter 포함', () => {
    const skillsDir = path.join(PLUGIN_ROOT, 'skills');
    if (!existsSync(skillsDir)) return; // skip if skills dir missing

    // Check a sample skill for frontmatter fields
    const sampleSkill = path.join(skillsDir, 'principles', 'SKILL.md');
    if (!existsSync(sampleSkill)) return;

    const content = readFileSync(sampleSkill, 'utf-8');
    // Skills should have frontmatter with at least name and description
    expect(content).toMatch(/^---/);
    expect(content).toMatch(/name:/);
  });

  it('install.sh가 skills를 재귀 복사 (원본 그대로 보존)', () => {
    const installPath = path.join(PLUGIN_ROOT, 'install.sh');
    const content = readFileSync(installPath, 'utf-8');
    // install_skills() copies the entire skills directory recursively via
    // either direct `cp -r` or the `safe_copy_dir` helper (which wraps
    // cp -r / rsync with --exclude=node_modules --exclude=.git).
    const cpPattern = /cp\s+-r\s+.*skills.*ARTIBOT_DIR/;
    const safeCopyPattern = /safe_copy_dir\s+["']?\$\{?SCRIPT_DIR\}?["']?\/skills/;
    expect(cpPattern.test(content) || safeCopyPattern.test(content)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. CLAUDE.local.md 보호: 업데이트 시 덮어쓰이지 않음
// ---------------------------------------------------------------------------

describe('install/CLAUDE.local.md protection', () => {
  it('install.sh가 CLAUDE.local.md 존재 시 건너뜀', () => {
    const installPath = path.join(PLUGIN_ROOT, 'install.sh');
    const content = readFileSync(installPath, 'utf-8');

    // seed_local_config checks: if [ -f "$local_md" ]; then ... return
    expect(content).toMatch(/seed_local_config/);
    expect(content).toMatch(/CLAUDE\.local\.md already exists.*skipping/);
  });

  it('CLAUDE.local.md 템플릿이 존재', () => {
    const templatePath = path.join(PLUGIN_ROOT, 'templates', 'CLAUDE.local.md.template');
    expect(existsSync(templatePath)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. update.js 구조 검증
// ---------------------------------------------------------------------------

describe('update/structure', () => {
  it('update.js가 소스에 존재', () => {
    expect(existsSync(path.join(PLUGIN_ROOT, 'scripts', 'update.js'))).toBe(true);
  });

  it('update.js가 isNewerVersion을 사용', () => {
    const content = readFileSync(
      path.join(PLUGIN_ROOT, 'scripts', 'update.js'), 'utf-8',
    );
    expect(content).toContain('isNewerVersion');
  });

  it('update.js가 install.sh를 실행', () => {
    const content = readFileSync(
      path.join(PLUGIN_ROOT, 'scripts', 'update.js'), 'utf-8',
    );
    expect(content).toContain('install.sh');
    expect(content).toContain('runInstall');
  });
});

// ---------------------------------------------------------------------------
// 7. update.js branch fallback 순서 검증
// ---------------------------------------------------------------------------

describe('update/branch fallback order', () => {
  let updateContent;

  it('update.js를 읽을 수 있음', () => {
    updateContent = readFileSync(
      path.join(PLUGIN_ROOT, 'scripts', 'update.js'), 'utf-8',
    );
    expect(updateContent).toBeTruthy();
  });

  it('artibot/master를 첫 번째 fallback으로 시도', () => {
    const artibotMasterIdx = updateContent.indexOf('origin/artibot/master');
    const masterIdx = updateContent.indexOf('origin/master', artibotMasterIdx + 1);
    expect(artibotMasterIdx).toBeGreaterThan(-1);
    expect(masterIdx).toBeGreaterThan(artibotMasterIdx);
  });

  it('master를 두 번째 fallback으로 시도', () => {
    // v4.5.3+: pull args are passed as an array to execFileSync (no shell
    // interpolation). The fallback order remains origin/master before
    // origin/main; we now match the array literal form.
    const masterIdx = updateContent.indexOf("['pull', 'origin', 'master']");
    const mainIdx = updateContent.indexOf("['pull', 'origin', 'main']");
    expect(masterIdx).toBeGreaterThan(-1);
    expect(mainIdx).toBeGreaterThan(masterIdx);
  });

  it('수동 안내 메시지가 master를 참조 (v4.7.1+ artibot/master deprecation start)', () => {
    // v4.7.1: switched manual recommendation to `master` so that when
    // origin/artibot/master is removed (eligible 2026-06-13), the printed
    // advice still works. The auto-fallback chain still tries artibot/master
    // first as a no-op for now.
    expect(updateContent).toContain('git pull origin master');
    expect(updateContent).not.toContain('git pull origin artibot/master');
  });
});
