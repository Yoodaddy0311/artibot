# plugins/_shared

Cross-plugin primitives shared between `plugins/artibot` (code-focused) and
`plugins/artibot-cowork` (content/marketing-focused). This directory hosts the
rubric vocabulary, schemas, and standards both plugins compile against — so a
rubric tier in code review means the same thing as the equivalent tier in a
long-form content review.

Last updated: 2026-04-24

---

## Purpose

| Goal | Non-Goal |
|------|----------|
| Host domain-neutral primitives (severity tiers, floor mechanics, flag schemas) | Host domain-specific content (code linting rules, marketing voice dictionaries) |
| Keep rubric vocabulary consistent across plugins | Replace per-plugin rubrics — each plugin still owns its own scoring table |
| Provide a single place to evolve the tier / floor / flag standards | Become a dumping ground for every shared string literal |
| Allow a reviewer to trust that "Critical" in content review = "Critical" in code review | Enforce runtime contracts (that belongs in code, not shared docs) |

If a primitive is only meaningful for one plugin, it does NOT belong here. Move
it to that plugin's own `skills/` or `references/` tree.

---

## Structure

| Path | Contents |
|------|----------|
| `rubrics/severity-tiers.md` | 3-tier severity vocabulary (Critical / Major / Minor), mapping examples, IDE color guidance |
| `rubrics/category-floor.md` | Single-axis collapse defense — category floors, formulas, tier downgrade rules |
| `rubrics/auto-flag-schema.md` | YAML schema for declarative auto-flag rules — regex / count / ratio patterns |
| `VERSION` | Single-line semantic version for this shared surface area |
| `README.md` | This file |

### Planned additions (post-1.0)

| Path | Purpose | Target version |
|------|---------|----------------|
| `memory/` | Cross-plugin memory index format and retention policy | 1.1.0 |
| `profiles/` | Reusable persona + voice profile schemas | 1.2.0 |
| `standards/` | Frontmatter and manifest schemas referenced by both plugins | 1.3.0 |

These slots are reserved but empty until a concrete need lands. Do not pre-create
folders for them.

---

## Import convention

Each consuming plugin references `_shared/` via a relative path from its own
`plugins/<plugin-name>/` root:

| Consumer | Example reference |
|----------|-------------------|
| `plugins/artibot` | `../_shared/rubrics/severity-tiers.md` |
| `plugins/artibot-cowork` | `../_shared/rubrics/severity-tiers.md` |

Skill and agent markdown files link these paths in their `## References` section.
Plugins must NOT copy content from `_shared/` — always reference, so a change to
the shared surface propagates everywhere.

---

## Versioning

### Version file

`plugins/_shared/VERSION` holds a single [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html)
string (no `v` prefix, single trailing newline). Example: `1.0.0`.

### Compatibility declaration

Each consuming plugin declares the shared version it was built against in its
own manifest (`.claude-plugin/plugin.json`):

```json
{
  "name": "artibot-cowork",
  "version": "0.4.0",
  "sharedVersion": "1.0.0"
}
```

A plugin is compatible with any `_shared/` that satisfies the same MAJOR and a
MINOR >= its declared value.

### Bump rules

| Change class | Version bump |
|--------------|-------------|
| Rename a tier, remove a field from the auto-flag schema, delete a file | **MAJOR** (`2.0.0`) |
| Add a new tier below Minor, add optional schema fields, add a new file under `rubrics/` | **MINOR** (`1.1.0`) |
| Fix wording, add examples, clarify floor formula prose without changing numbers | **PATCH** (`1.0.1`) |

### Breaking change policy

A MAJOR bump requires: (1) a dated migration note appended to the changed file,
(2) a grace window of at least one MINOR release of each consuming plugin where
the old and new shapes both validate, and (3) coordinated updates to all
consuming plugin manifests in the same release commit.

---

## Principles

1. **Domain-neutral.** If the text says "code" or "content", it doesn't belong
   here; move it to the owning plugin.
2. **Reference, don't copy.** Consumers link to these files, not clone them.
3. **Stable over clever.** Prefer boring wording that survives rubric changes
   over tight phrasing that must be rewritten every quarter.
4. **Data policy preserved.** Nothing in `_shared/` calls external services,
   ships data outside the plugin boundary, or assumes network access.
5. **One source of truth per concept.** Each tier / floor / schema field has
   exactly one authoritative location — no parallel definitions.

---

## Governance

| Action | Owner | Cadence |
|--------|-------|---------|
| Add a new file under `rubrics/` | Any plugin owner with review | Per-release |
| Rename or remove an existing primitive | Lead + affected plugin owners | Quarterly review |
| Bump VERSION | Release-coordinator | On every change |
| Audit unused or duplicated primitives | Rotating owner | Twice yearly |

Proposed changes open as a regular PR touching `_shared/` plus the consuming
plugins in the same commit. Changes that touch only `_shared/` without updating
dependents are rejected — the shared surface must not drift ahead of its users.
