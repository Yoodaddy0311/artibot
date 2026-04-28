# Artibot — Marketplace Submission Checklist

- **Plugin:** `artibot` v3.9.0 + sibling `artibot-cowork` v0.4.0
- **License:** MIT (both)
- **Target marketplace:** Claude Code Plugin Marketplace
- **Last updated:** 2026-04-24
- **Owner sign-off:** B-RD (docs) + B-MK (marketplace package) + C-RM (roadmap) + DevOps (CI/release)

Run this checklist top-to-bottom before clicking Submit. All items must be
checked or have a tracked exception.

## 0. Pre-flight (automated)

- [ ] `node scripts/marketplace-validate.mjs` passes with zero failures
- [ ] `npm run ci` passes (`validate` + `validate-bin` + `skill:check` + `lint` + `test` + `eval:runtime:check`)
- [ ] `npm run release:check` passes (3-file version sync)

## 1. Manifest

- [ ] `marketplace.json` `version` matches `.claude-plugin/plugin.json` and `package.json`
- [ ] `description` ≤ 240 chars and renders cleanly in the marketplace preview
- [ ] `categories` ⊆ marketplace's accepted vocabulary (re-check on submit)
- [ ] `keywords` includes: `ai`, `llm`, `agent`, `claude-code`, `mcp`
- [ ] `license` is `MIT` and `LICENSE` file exists at `../../LICENSE`
- [ ] `repository.url` resolves (200 OK)
- [ ] `entryPoints` counts match actual directory contents

## 2. Documentation

- [ ] `README.md` has sections: Quickstart, Installation, Features, Usage, Testing, License
- [ ] `CHANGELOG.md` has entry for the listed `version` with `Added / Changed / Fixed`
- [ ] `SECURITY.md` exists and lists vulnerability disclosure process
- [ ] `CONTRIBUTING.md` exists at repo root
- [ ] `docs/ARCHITECTURE.md` reachable from README

## 3. Media

- [ ] `_marketplace/screenshots/` populated with 5 PNGs (specs in `screenshots/README.md`)
- [ ] Icon (256×256, ≤ 100 KB, transparent PNG) at `_marketplace/screenshots/icon-256.png`
- [ ] Banner (1280×640) at `_marketplace/screenshots/banner-1280x640.png`
- [ ] Demo video uploaded; URL pasted into `marketplace.json` `media.demoUrl` and `media.demoVideo`
- [ ] Each screenshot caption is meaningful (no "screenshot 1")

## 4. Content quality

- [ ] `elevator-pitch.md` 100-word version proofread
- [ ] `feature-matrix.md` competitor data reviewed in last 30 days
- [ ] No placeholder text (`TODO`, `FIXME`, `lorem ipsum`) anywhere in submission package

## 5. Safety / compliance

- [ ] `safetyCompliance.dataPolicy` = `local-only` (matches Artibot CRITICAL rule)
- [ ] OTEL exporter clearly marked opt-in in README
- [ ] No secrets in committed files (run `git diff --cached` before submit)
- [ ] No `${ENV_VAR}` placeholders left as raw values

## 6. Testing receipts

- [ ] Test count in `marketplace.json` `qualityMetrics.tests` matches latest `npm test` output
- [ ] Coverage numbers in manifest match the latest `npm run test:coverage` summary
- [ ] `qualityMetrics.lintErrors` = 0

## 7. Cross-tool

- [ ] `scripts/export-to-tool.mjs --tool=cursor --dry-run` succeeds
- [ ] `scripts/export-to-tool.mjs --tool=codex --dry-run` succeeds
- [ ] `scripts/export-to-tool.mjs --tool=opencode --dry-run` succeeds
- [ ] Platform notes in `marketplace.json` reflect latest export status

## 8. Release artefacts

- [ ] `release.releasedAt` matches CHANGELOG date for current version
- [ ] `release.channel` is `stable` (not `beta` / `preview`)
- [ ] `preview`, `experimental`, `deprecated` all `false`

## 9. Submission

- [ ] PR template filled (title, description, screenshots in PR body)
- [ ] PR targets the official marketplace repo's intake branch
- [ ] Maintainer email reachable for review queries
- [ ] Backup contact noted in submission notes

## 10. Post-submission

- [ ] Tag the release in git (`git tag v3.9.0 && git push --tags`) — only with user approval
- [ ] Watch the listing PR for review feedback for 7 days
- [ ] Schedule follow-up to update screenshots / matrix every quarter

## 11. README polish (B-RD verification)

- [x] Root `README.md` has v3.9.0 badge, MIT license badge, dual-plugin guidance table at top
- [x] Root `README.md` has Quick Links table pointing to plugin READMEs, CHANGELOG, ARCHITECTURE, _reports, _marketplace
- [x] Root `README.md` "When to use which" decision diagram present
- [x] `plugins/artibot/README.md` has v3.9.0 hero badges (version / license / node / tests / lint / coverage / Claude Code)
- [x] `plugins/artibot/README.md` has 1-line tagline (English + Korean)
- [x] `plugins/artibot/README.md` has Quick Demo (30-Second First Win) section with copy-paste install command
- [x] `plugins/artibot/README.md` has "Why Artibot?" 7-differentiator table with file-level evidence
- [x] `plugins/artibot/README.md` has competitive scoring table (vs LangGraph / AutoGen / CrewAI / everything-cc / etc.)
- [x] `plugins/artibot/README.md` has Architecture Overview with Mermaid `flowchart TD` diagram
- [x] `plugins/artibot/README.md` has 5-layer architecture table
- [x] `plugins/artibot/README.md` has Key Features marketplace summary table
- [x] `plugins/artibot/README.md` has Installation section (Claude Code + Manual + Other Platforms)
- [x] `plugins/artibot/README.md` has Usage Patterns (top 5) table
- [x] `plugins/artibot/README.md` has Configuration table with v3.9.0 config fields
- [x] `plugins/artibot/README.md` has Roadmap section linking to `_reports/horizon-2-3-roadmap.md`
- [x] `plugins/artibot/README.md` has Contributing section with DEV protocol summary
- [x] `plugins/artibot/README.md` has License section (MIT)
- [x] `plugins/artibot/README.md` PRESERVES all existing Korean content below the prelude
- [x] `plugins/artibot-cowork/README.md` has v0.4.0 hero badges (version / license / skills / agents / cowork / tests)
- [x] `plugins/artibot-cowork/README.md` has 1-line tagline (English + Korean)
- [x] `plugins/artibot-cowork/README.md` has "Why artibot-cowork?" 7-differentiator table
- [x] `plugins/artibot-cowork/README.md` has Quick Demo section
- [x] `plugins/artibot-cowork/README.md` has Quickstart Installation
- [x] `plugins/artibot-cowork/README.md` PRESERVES all existing v0.4.0 content
- [x] All 3 README badges use shields.io (no other badge providers)
- [x] All external URLs are trusted domains only (shields.io, github.com, anthropic.com, claude.com)

## 12. Roadmap & design doc cross-references (C-RM verification)

- [ ] `_reports/horizon-2-3-roadmap.md` exists (referenced from `plugins/artibot/README.md` Roadmap section)
- [ ] `docs/ARCHITECTURE.md` exists (referenced from `plugins/artibot/README.md` 5-layer table + root README Quick Links)
- [ ] `docs/mcp-server-usage.md` exists (referenced from CHANGELOG v3.8.0 + root README Quick Links)
- [ ] `_reports/market-competitive-eval-2026-04-24.md` referenced from plugin README "Why Artibot?" section — VERIFIED file exists
- [ ] `_reports/ai-ecosystem-research-2026-04-24.md` referenced from plugin README Roadmap section — VERIFIED file exists
- [ ] CONTRIBUTING.md exists at repo root (referenced from plugin README Contributing section)
- [ ] LICENSE file exists at repo root (referenced from all 3 README badges)
- [ ] RELEASE_NOTES_3.9_KO.md exists (Korean release notes for non-developer users) — optional but recommended

## 13. Submission package summary

| Section | Items | Owner | Status |
|---|---|---|---|
| 0. Pre-flight | 3 | DevOps | TODO |
| 1. Manifest | 7 | B-MK | TODO |
| 2. Documentation | 5 | B-RD | partial PASS (README done; SECURITY/CONTRIBUTING/ARCHITECTURE pending) |
| 3. Media | 5 | B-MK | TODO |
| 4. Content quality | 3 | B-MK | TODO |
| 5. Safety / compliance | 4 | Security | TODO |
| 6. Testing receipts | 3 | DevOps | TODO |
| 7. Cross-tool | 4 | DevOps | TODO |
| 8. Release artefacts | 3 | DevOps | TODO |
| 9. Submission | 4 | Lead | TODO |
| 10. Post-submission | 3 | Lead | TODO |
| 11. README polish | 26 | B-RD | PASS (all 26) |
| 12. Roadmap & design doc cross-refs | 8 | C-RM | TODO (2 of 8 verified, 6 pending file creation) |

**Total items: 78** (up from B-MK's original 50; B-RD added 26 README rows + 8 cross-ref rows in Sections 11 + 12).

**Final approval:** flip this header to `READY FOR SUBMISSION` only when all sections show PASS or have a documented tracked exception in a follow-up issue.
