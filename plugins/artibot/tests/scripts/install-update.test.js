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
// 5b. P0 new-user UX: read-only permission seed + Windows installer
// ---------------------------------------------------------------------------

describe('install/permission seed (read-only allowlist)', () => {
  it('install.sh seeds Read/Glob/Grep into permissions.allow', () => {
    const content = readFileSync(path.join(PLUGIN_ROOT, 'install.sh'), 'utf-8');
    // Conservative safe set declared and merge helper present.
    expect(content).toMatch(/ARTIBOT_SAFE_ALLOW=\(Read Glob Grep\)/);
    expect(content).toMatch(/_seed_permission_allow/);
    // Fresh settings.json template includes the allow list.
    expect(content).toMatch(/"permissions":/);
    expect(content).toMatch(/"allow":/);
  });

  it('install.sh does NOT auto-approve Bash/Write/Edit', () => {
    const content = readFileSync(path.join(PLUGIN_ROOT, 'install.sh'), 'utf-8');
    // Safety: write/exec tools must not appear in the seeded allow set.
    expect(content).not.toMatch(/ARTIBOT_SAFE_ALLOW=\([^)]*\bBash\b/);
    expect(content).not.toMatch(/ARTIBOT_SAFE_ALLOW=\([^)]*\bWrite\b/);
    expect(content).not.toMatch(/ARTIBOT_SAFE_ALLOW=\([^)]*\bEdit\b/);
  });

  it('install.sh merges (does not overwrite) existing permissions', () => {
    const content = readFileSync(path.join(PLUGIN_ROOT, 'install.sh'), 'utf-8');
    // jq path unions + uniques; node path appends only missing entries.
    expect(content).toMatch(/permissions\.allow.*unique/s);
    expect(content).toMatch(/if \(!merged\.includes\(entry\)\) merged\.push\(entry\)/);
  });
});

describe('install/windows PowerShell installer', () => {
  it('plugins/artibot/install.ps1 exists', () => {
    expect(existsSync(path.join(PLUGIN_ROOT, 'install.ps1'))).toBe(true);
  });

  it('install.ps1 flat-copies commands/agents into ~/.claude (no prefix)', () => {
    const content = readFileSync(path.join(PLUGIN_ROOT, 'install.ps1'), 'utf-8');
    // Flat-copy contract (lockstep with install.sh): commands/agents land in
    // ~/.claude/{commands,agents} so slash commands have NO `artibot:` prefix.
    expect(content).toMatch(/Copy-MdFiles/);
    expect(content).toMatch(/'commands'/);
    expect(content).toMatch(/'agents'/);
    // Same read-only permission seed as install.sh.
    expect(content).toMatch(/\$SafeAllow\s*=\s*@\('Read',\s*'Glob',\s*'Grep'\)/);
  });

  it('install.ps1 does NOT clone or use marketplace `/plugins load` (prefix-regression guard)', () => {
    const content = readFileSync(path.join(PLUGIN_ROOT, 'install.ps1'), 'utf-8');
    // The git-clone + `/plugins load` path produces namespaced `/artibot:save`
    // commands — the exact UX bug new users reported. Guard against its return.
    expect(content).not.toMatch(/git clone/);
    expect(content).not.toMatch(/plugins load/);
    expect(content).not.toMatch(/Install-MarketplaceMirror/);
    expect(content).not.toMatch(/Install-PluginCache/);
  });

  it('install.ps1 supports -DryRun / -NoColor and dynamic version (no hardcode)', () => {
    const content = readFileSync(path.join(PLUGIN_ROOT, 'install.ps1'), 'utf-8');
    expect(content).toMatch(/\[switch\]\$DryRun/);
    expect(content).toMatch(/\[switch\]\$NoColor/);
    expect(content).not.toMatch(/\$ARTIBOT_VERSION\s*=\s*"[\d.]+"/);
    expect(content).toMatch(/\$MIN_NODE_MAJOR\s*=\s*20\b/);
  });

  it('scripts/install.ps1 is a thin shim forwarding all args to the canonical installer', () => {
    const shim = readFileSync(path.join(PLUGIN_ROOT, 'scripts', 'install.ps1'), 'utf-8');
    expect(shim).toMatch(/&\s*\$Canonical\s*@args/);
    expect(shim).toMatch(/install\.ps1/);
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
  // B4 (2026-06-20): the git pull/branch resolution machinery was extracted from
  // update.js into scripts/update-git.js (update.js re-exports it to keep the
  // public import surface unchanged). The B1 structural invariants below now live
  // in update-git.js, so this block reads that module for them; the manual-
  // recovery message test still asserts against update.js (printManualInstructions
  // stayed there).
  let gitContent;

  it('update.js를 읽을 수 있음', () => {
    updateContent = readFileSync(
      path.join(PLUGIN_ROOT, 'scripts', 'update.js'), 'utf-8',
    );
    expect(updateContent).toBeTruthy();
    gitContent = readFileSync(
      path.join(PLUGIN_ROOT, 'scripts', 'update-git.js'), 'utf-8',
    );
    expect(gitContent).toBeTruthy();
  });

  it('원격 실제 default 브랜치(origin/HEAD)를 우선 해석', () => {
    // B1 (2026-06-20): resolveDefaultBranchPull now prefers the remote's actual
    // default branch via resolveRemoteDefaultBranch(origin/HEAD) BEFORE any
    // hardcoded guess. The dead artibot/master->master rename is exactly why a
    // guess list goes stale; origin/HEAD follows the rename.
    expect(gitContent).toContain('resolveRemoteDefaultBranch');
    expect(gitContent).toMatch(/const defaultBranch = resolveRemoteDefaultBranch\(gitRoot\)/);
  });

  it('죽은 artibot/master 추측을 fallback 리스트에서 제거', () => {
    // B1 (2026-06-20): the guess list previously led with 'artibot/master',
    // which made /update pull a deleted remote ref and silently no-op. The guess
    // list is now minimal (master, main) and is only reached when origin/HEAD is
    // undeterminable (offline).
    const fallbackArr = gitContent.match(/for \(const ref of \[([^\]]+)\]\)/);
    expect(fallbackArr, 'resolveDefaultBranchPull fallback array missing').not.toBeNull();
    const refs = fallbackArr[1].split(',').map((s) => s.trim().replace(/['"]/g, ''));
    expect(refs).not.toContain('artibot/master');
    expect(refs[0]).toBe('master');
  });

  it('master를 main보다 먼저 시도 (guess list 순서)', () => {
    // master must appear before main in the offline guess list.
    const fallbackArr = gitContent.match(/for \(const ref of \[([^\]]+)\]\)/);
    expect(fallbackArr).not.toBeNull();
    const refs = fallbackArr[1].split(',').map((s) => s.trim().replace(/['"]/g, ''));
    const masterIdx = refs.indexOf('master');
    const mainIdx = refs.indexOf('main');
    expect(masterIdx).toBeGreaterThan(-1);
    expect(mainIdx).toBeGreaterThan(masterIdx);
  });

  it('수동 안내 메시지가 master를 참조 (artibot/master 하드코딩 없음)', () => {
    // Manual recovery advice points at `master`; no path pulls the dead
    // artibot/master branch anymore.
    expect(updateContent).toContain('git pull origin master');
    expect(updateContent).not.toContain('git pull origin artibot/master');
  });
});
