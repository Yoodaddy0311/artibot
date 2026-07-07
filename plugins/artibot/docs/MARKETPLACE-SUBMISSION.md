# Marketplace Submission — Artibot

**Status:** SUBMITTED — the owner completed the in-app review form on 2026-07-07
(Claude Code platform only; artibot-cowork to be submitted separately after
approval). Awaiting Anthropic community-marketplace review; notices go to the
owner email below.
**Owner:** ad-display@artience.com
**Last verified against Claude Code docs:** 2026-07-03
**Manifest source of truth:** repo-root [`.claude-plugin/marketplace.json`](../.claude-plugin/marketplace.json)

This document is the current, schema-accurate submission guide. It **supersedes**
the older assumptions in [`plugins/artibot/_marketplace/`](../_marketplace/)
(dated 2026-04, pinned to v3.9.0), which still describes a PR-to-`claude-plugins-official`
flow that no longer applies (see §6 below).

---

## 1. Current distribution state (already live)

Artibot is **already installable today** as a self-hosted marketplace — no
Anthropic gatekeeping is required for distribution:

```text
/plugin marketplace add Yoodaddy0311/artibot
/plugin install artibot@artibot
```

This works because the repo root ships a valid `.claude-plugin/marketplace.json`
listing two plugins (`artibot`, `artibot-cowork`) with `./`-relative sources.
Submission to an Anthropic marketplace is **optional** and only buys additional
discovery (the community catalog + a possible Anthropic-Verified badge).

### Known limitations of native install (disclose in listing copy)

Native marketplace install loads only what Claude Code's plugin schema supports.
Two gaps must be disclosed honestly so listing copy does not overclaim parity:

1. **The 8 auto-activating rules are NOT delivered.** `plugin.json` declares a
   `rules[]` array (DEV Protocol, Quality Gates, agent-coordination, config-safety,
   clean-state, frontend/backend/test patterns), but `rules` is **outside the
   official plugin manifest schema** — `claude plugin validate` reports it as an
   ignored field. These rules are placed only by `install.sh` (`install_rules()`
   → `~/.claude/rules/artibot/`, install.sh:295-306, count verified at :927). So a
   purely native install does not get automatic DEV-protocol / quality-gate
   enforcement; only the full `install.sh` path does.
2. **A few convenience commands assume the flat layout.** `/theme`, `/update`, and
   the themed statusline hardcode `~/.claude/artibot/...` paths and currently
   malfunction under native install (tracked for a separate path-resolver refactor).

Commands, agents, skills, and hooks themselves load identically on both paths.

## 2. The two Anthropic marketplaces

| Marketplace | Repo / name | How it is populated | Applies to us |
|---|---|---|---|
| **Official** | `claude-plugins-official` | Curated by Anthropic at its sole discretion. **No application process.** The submission forms do **not** add here. | Not actionable — Anthropic-internal selection only. A prior PR to `anthropics/claude-plugins-official` was auto-rejected (recorded in `_marketplace/NEXT_ACTIONS.md`). |
| **Community** | `anthropics/claude-plugins-community` (installed as `@claude-community`) | Third-party submissions land here **after review + automated safety screening**. Approved plugins are pinned to a commit SHA; CI bumps the pin as you push; the public catalog syncs nightly. | **This is our target.** |

There is **no `external_plugins` field** to author. The community catalog is a
normal `marketplace.json` whose `plugins[]` entries are written by Anthropic's
review CI (name + source + SHA pin). Our job is only to make our own repo/manifest
pass validation and submit through the form — Anthropic's pipeline produces the
catalog entry.

## 3. How to submit (in-app form, not a PR)

Submission is via one of two in-app forms — **not** a pull request:

- **claude.ai** (Team/Enterprise orgs; org Owners have access by default):
  `claude.ai/admin-settings/directory/submissions/plugins/new`
- **Console** (individual authors not in a Team/Enterprise org):
  `platform.claude.com/plugins/submit`

Both require **user login** — an agent cannot complete them. The review pipeline
runs `claude plugin validate` plus automated safety screening on the submitted repo.

## 4. Pre-submission checklist

Run top-to-bottom. All must pass before the user submits.

- [ ] `claude plugin validate .` from the repo root — zero errors (this is the
      exact check the review pipeline runs).
- [ ] `.claude-plugin/marketplace.json` parses, has required `name` / `owner` /
      `plugins[]`, and each `source` starts with `./` (verified 2026-07-03: PASS).
- [ ] Marketplace `name` (`artibot`) is not on the reserved/impersonation list
      (verified: not reserved).
- [ ] Plugin names are kebab-case (`artibot`, `artibot-cowork`) — claude.ai sync
      rejects non-kebab-case names (PASS).
- [ ] Version lockstep: `plugins[].version` == each `plugin.json` `version`
      (artibot 4.29.0, artibot-cowork 3.1.0). Note the docs warn against declaring
      `version` in *both* places; our `release-check.js` keeps them synced so this
      is safe, but the marketplace-entry `version` is redundant with `plugin.json`.
- [ ] `cd plugins/artibot && npm run release:check && npm run ci` pass. (These
      scripts live in `plugins/artibot/package.json`; the repo-root `package.json`
      has an empty `scripts` block, so running them from the repo root fails.)
- [ ] `LICENSE` (Business Source License 1.1, SPDX `BUSL-1.1`) present at repo
      root, and `plugin.json`/`marketplace.json` `license` fields match it;
      `repository`/`homepage` URLs resolve.
- [ ] No secrets in tracked files (`git diff` review). DATA POLICY: local-only,
      OTEL opt-in — reflect this in listing copy.
- [ ] README leads with the native install path (done — root + plugin READMEs).

## 4a. Pre-submission check results (2026-07-07)

Ran the §4 checklist top-to-bottom this session. Per-item PASS/FAIL with evidence:

| # | Item | Result | Evidence |
|---|---|---|---|
| 1 | `claude plugin validate .` | **PASS** | 0 errors. 4 pre-existing warnings only (`$comment`, `categories`, `compatibility`, `rules` — all previously documented as intentionally-kept or a known, disclosed gap; none newly introduced). |
| 2 | `marketplace.json` parses, required fields | **PASS** | `name: "artibot"`, `owner: {name: "Artience", email: "ad-display@artience.com"}`, `plugins[]` length 2, both `source` values start with `./`. |
| 3 | Marketplace name not reserved/impersonation | **CARRIED FORWARD** | Requires an external lookup against Anthropic's reserved-name list; not re-verified this session (no external checks were made — see constraints). Last verified 2026-07-03 per header. |
| 4 | Plugin names kebab-case | **PASS** | `artibot`, `artibot-cowork` — both already lowercase-hyphenated. |
| 5 | Version lockstep | **PASS** | `plugins[].version` == `plugin.json.version` for both: artibot `4.29.0` == `4.29.0`; artibot-cowork `3.1.0` == `3.1.0`. |
| 6 | `npm run release:check` + `npm run ci` | **PARTIAL** | `cd plugins/artibot && npm run release:check` run live this session → `✓ All checks passed`. `npm run ci` **skipped** (10+ min runtime, out of session budget) — citing the most recent green CI run instead: commit `bd7eac4` (2026-07-07, "docs(changelog): backfill [Unreleased] — risk guard, redact fix, native install, install-mode, theme resolver, ledger re-scrub"). This is a substitution, not an independent re-run — flagging so it isn't mistaken for a fresh pass. |
| 7 | `LICENSE` (BUSL-1.1) present; declared `license` fields match; repo/homepage resolve | **RESOLVED (2026-07-07)** | The repo owner confirmed **Business Source License 1.1 is the intended license** — the `LICENSE` file itself was correct all along and was **not modified**. Every place that had declared `"license": "MIT"` was corrected to `"BUSL-1.1"` (the SPDX identifier): `plugins/artibot/.claude-plugin/plugin.json`, `plugins/artibot-cowork/.claude-plugin/plugin.json`, both `.claude-plugin/marketplace.json` plugin entries, the legacy `plugins/artibot/marketplace.json` (both its top-level `license`/`licenseFile` and its `pricing.license` field), `plugins/artibot/.well-known/mcp-server.json`, `plugins/artibot/server/package.json` (`@artibot/swarm-server`, `private: true` — found on a follow-up cross-check, missed by the initial grep pass), and both READMEs' badges + License section prose (root `README.md:4,1045`; `plugins/artibot/README.md:4,348,1733`; `plugins/artibot-cowork/README.md:4,325`). Prose now states the actual terms (non-production use, production use short of a Commercial Competing Product, Apache-2.0 conversion on 2030-02-20) instead of a bare "MIT" claim. **Not touched, flagged for a separate decision**: `plugins/artibot/marketplace.json`'s `pricing.tier: "open-source"` and `pricing.commercialUse: true` — BUSL-1.1 is source-available rather than strictly OSI "open-source," and `commercialUse: true` is directionally right (production use is allowed short of building a competing product) but doesn't capture the restriction; changing those values is a business-copy judgment call beyond a license-identifier fix, left for the owner/marketing pass. `repository`/`homepage` URLs are still only structurally verified against `git remote -v`, not fetched live. |
| 8 | No secrets in tracked files | **PARTIAL** | Spot-checked this session's own diffs only — no secrets found there. A full-repo secret scan was **not** run this session (out of the assigned scope); DATA POLICY prose (local-only, OTEL opt-in) is otherwise accurate per prior audits. |
| 9 | README leads with native install path | **PASS** | Confirmed in the IMP-08 cross-check (2026-07-06) — both root and plugin READMEs lead Installation with the native `/plugin marketplace add` flow. |

**Net result (updated 2026-07-07): the license blocker is resolved.** Item 7 was
the only FAIL and has been corrected repo-wide per the owner's decision (BUSL-1.1
is correct; every "MIT" claim was fixed to match). Two items remain
carried-forward/unverified rather than failed, and still need a live check
before the user actually submits: item 3 (reserved/impersonation name lookup)
and the URL-resolution half of item 7 (an actual HTTP fetch of `repository`/
`homepage`, not just the structural `git remote -v` match done this session).
Item 6 (`npm run ci`) was substituted with a cited recent green run rather than
independently re-executed. None of these three require a code change — they're
live checks to run once, ideally right before submission.

## 5. Post-approval behavior

- Anthropic CI pins your plugin to a **specific commit SHA** in the community
  `marketplace.json` and re-pins automatically as you push new commits.
- The public catalog **syncs nightly**, so expect a delay between approval and
  the plugin appearing. Check the
  [community catalog](https://github.com/anthropics/claude-plugins-community/blob/main/.claude-plugin/marketplace.json)
  for the plugin name to confirm it is installable.
- If Anthropic later lists us in the **official** marketplace, our CLI can prompt
  users to install via plugin hints (`/en/plugin-hints`) — a separate, future step.

## 6. Reconciling the legacy `_marketplace/` package

`plugins/artibot/_marketplace/` (v3.9.0, 2026-04) contains reusable listing copy
(`elevator-pitch.md`, `feature-matrix.md`, `demo-script.md`, screenshot specs) —
**keep and reuse these**. But three of its assumptions are now stale:

1. It names `plugins/artibot/marketplace.json` as the manifest source of truth.
   The live manifest is repo-root `.claude-plugin/marketplace.json`.
2. `SUBMISSION_CHECKLIST.md` §9 says "PR to the official marketplace repo." The
   real path is the in-app form → community marketplace (§3 above). Its own
   `NEXT_ACTIONS.md` already recorded the official-repo PR auto-rejection.
3. It references manifest fields (`entryPoints`, `qualityMetrics`, `media.*`,
   `safetyCompliance.*`) that are **not** part of the current marketplace schema.
   The live manifest is intentionally minimal and schema-clean; do not re-add them.

Recommendation: treat this file as the current submission runbook; mine the
legacy package only for listing copy and media specs.

## 7. Human-only actions (require user)

- Complete the claude.ai or Console submission form (login required).
- Provide media assets (demo video, screenshots, icon) — deferred per
  `_marketplace/NEXT_ACTIONS.md` §A.
- Approve any git tag/release push tied to submission.

## 8. Submission draft (copy-paste ready)

> §4a item 7 (license mismatch) is resolved as of 2026-07-07 — the repo owner
> confirmed Business Source License 1.1 is correct, and every `license` field
> plus README prose now says so. The license field below reflects that.

Numbers below are pulled live from `scripts/ci/validate-readme-claims.js`
(2026-07-07 run) and `CLAUDE.md`'s documented test count — no marketing
rounding or embellishment.

**Plugin name**
```text
artibot
```

**One-line description (English)**
```text
Cognitive orchestration framework with dual-process routing, hierarchical
memory, self-learning, and native Agent Teams for Claude Code.
```

**Detailed description**
```text
Artibot is a 5-layer orchestration framework for Claude Code built on the
native Agent Teams API (TeamCreate/SendMessage/TaskCreate — not one-shot
Task() delegation). It ships 28 specialized agents, 73 slash commands, and
114 domain skills, backed by 10,600+ automated tests.

Core capabilities:
- Dual-process cognitive routing (System 1 fast pattern-match / System 2
  deliberative reasoning) that escalates by measured complexity.
- Hierarchical memory (working / episodic / semantic) with active curation
  and cross-session continuity.
- Verifiable-reward self-learning (test-pass / typecheck / no-revisit signals)
  that biases routing and skill selection over time — no data leaves the
  local machine (local-only by default; OpenTelemetry export is opt-in).
- A marketing/knowledge-work skill set (SEO, CRO, ad copy, analytics,
  presentations) alongside the developer-focused agents.

Known limitations of the native marketplace install path: the 8
auto-activating rule files (DEV Protocol, Quality Gates, and related
coordination patterns) are not delivered natively — Claude Code's plugin
manifest schema has no field for them, so they load only via the full
`install.sh`/`install.ps1` path. A handful of convenience commands (`/theme`,
`/update`) and the themed statusline currently assume the full-install layout
and may need `/theme` re-run after a native update. Everything else (agents,
skills, commands, hooks) loads identically either way.
```

**Category**
```text
development
```

**License**
```text
Business Source License 1.1 (BUSL-1.1) — source-available, free for
non-production use and for production use that is not a Commercial Competing
Product. Converts to Apache License 2.0 on 2030-02-20.
```

**Repository URL**
```text
https://github.com/Yoodaddy0311/artibot
```

**Known limitations disclosure (form field, if offered separately from the description)**
```text
Native marketplace install does not deliver 8 auto-activating rule files
(DEV Protocol / Quality Gates enforcement) — Claude Code's plugin schema has
no "rules" field, so `claude plugin validate` reports it as unrecognized and
ignores it. Use the repo's full install.sh/install.ps1 path if you rely on
that automation. Separately, /theme and /update currently assume the
full-install file layout and may need /theme re-run after a native-install
update; the project tracks a path-resolver fix for full native parity.
```

**Use-case examples (form field "사용 사례 예시" — required on the 2026-07 form,
absent from the original draft; authored live during submission)**
```text
예시 1: "/team 이 기능 구현해줘" — 리더가 작업을 분해해 전문 에이전트 팀(backend/frontend/tdd 등)을 병렬 스폰하고, 상호 크로스체크와 최종 검수(inspector)까지 자동으로 거친 뒤 결과를 보고합니다.

예시 2: "/autopilot 리팩터링 돌려놔" — 자리를 비우는 동안 PRD 생성→계획→병렬 실행→교차검증→테스트 검증→완료 보고서까지 7단계를 무인으로 수행하며, 위험 명령(force-push, rm -rf)은 안전 가드가 차단합니다.

예시 3: "/learning" — 세션에서 축적된 학습 신호(테스트 통과율, 도구 성과)를 대시보드로 진단하고, "/learning review"로 대화에서 추출된 학습 후보를 사람이 승인/거절하는 검토 게이트를 거쳐 반영합니다.

예시 4: "/seo 우리 랜딩페이지 감사해줘" — 개발 외에도 SEO 감사, 광고 카피, CRO, 프레젠테이션 설계 등 마케팅 전문 에이전트 7종이 같은 오케스트레이션 위에서 동작합니다.
```

## 9. Submission record (2026-07-07)

Form filled and submitted by the owner via the in-app flow (step 2 "Plugin
information" + step 3 "Submission details"):

| Form field | Value used |
|---|---|
| 플러그인 링크 / 홈페이지 | `https://github.com/Yoodaddy0311/artibot` (both) |
| 플러그인 이름 | `artibot` (form's duplicate-name check served as the §4 item-3 reserved-name lookup) |
| 플러그인 설명 | §8 detailed description, verbatim |
| 사용 사례 예시 | §8 use-case examples, verbatim |
| 지원 플랫폼 | Claude Code only (artibot-cowork deferred to a separate submission) |
| 라이선스 유형 | `BUSL-1.1` |
| 개인정보 처리방침 URL | left blank (no standalone privacy doc yet; plugin is local-only — PRIVACY.md tracked as follow-up) |
| 이메일 주소 | `ad-display@artience.com` (matches manifest owner email as of commit `b6d7c75`) |

Next: review notices arrive at the owner email. On approval the plugin is
pinned by commit SHA in `anthropics/claude-plugins-community` and the public
catalog syncs nightly. If changes are requested, update the repo and re-submit
per §3.
