# Artibot — Marketplace Submission Checklist

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
