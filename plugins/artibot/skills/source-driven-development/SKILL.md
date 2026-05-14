---
context: fork
name: source-driven-development
description: "DETECT → FETCH → IMPLEMENT → CITE for framework, library, and SDK work. Grounds every implementation decision in current official documentation, not training data. Pairs with sdd-cache hook for cheap revalidation."
lang: [en]
platforms: [claude-code, gemini-cli, codex-cli, cursor]
level: 2
triggers:
  - "framework"
  - "library"
  - "SDK"
  - "current best practice"
  - "official docs"
  - "MDN"
  - "deprecated"
  - "migration"
  - "API reference"
  - "version migration"
  - "공식 문서"
  - "마이그레이션"
  - "최신 문서"
  - "API 레퍼런스"
agents:
  - "backend-developer"
  - "frontend-developer"
  - "tdd-guide"
  - "code-reviewer"
allowed-tools:
  - Read
  - WebFetch
  - mcp__plugin_artibot_context7__query-docs
  - mcp__plugin_artibot_context7__resolve-library-id
tokens: "~5K"
category: "workflow"
whenNotToUse: "Pure business logic with no framework dependency (data structures, loops, conditionals). Internal helpers that don't touch any third-party API. The user explicitly opts for speed over verification ('just do it quickly'). Offline sessions where WebFetch is unavailable AND no Context7 cache hit exists — fall back to explicit unverified flags."
---

# Source-Driven Development

## Contents
- [When This Skill Applies](#when-this-skill-applies)
- [When NOT to Use](#when-not-to-use)
- [The Process: DETECT → FETCH → IMPLEMENT → CITE](#the-process)
- [Cache-Aware Operation (sdd-cache hook)](#cache-aware-operation)
- [Source Hierarchy](#source-hierarchy)
- [Citation Rules](#citation-rules)
- [Common Rationalizations](#common-rationalizations)
- [Red Flags](#red-flags)
- [Verification](#verification)

## When This Skill Applies

- Implementing any framework-, library-, or SDK-specific code (React, Next.js, Express, Prisma, Tailwind, NestJS, Django, FastAPI, Spring, etc.)
- Migrating between major versions where API surface changed
- Reviewing existing code that may use deprecated patterns
- Building boilerplate / starter code that will be copied across files
- The user asks for "current best practice" or "the right way" to do something framework-specific
- Any framework feature with a known migration history (React forms, Next.js routing, Tailwind config, Vue composition API)
- The training-data cutoff is older than the framework version detected in `package.json`

## When NOT to Use

- Pure business logic that does not depend on a specific framework version (loops, conditionals, data structures, math)
- Internal helper functions that don't touch any third-party API
- The user explicitly opts for speed over verification ("just do it quickly", "don't bother fetching")
- Offline session where WebFetch is unavailable AND no `webfetch-cache` hit exists; fall back to explicit `UNVERIFIED:` markers in code
- A throwaway prototype with explicit "this code will not ship" framing

## The Process: DETECT → FETCH → IMPLEMENT → CITE

```
DETECT ──→ FETCH ──→ IMPLEMENT ──→ CITE
  │          │           │            │
  ▼          ▼           ▼            ▼
 What       Get the    Follow the   Show your
 stack?     relevant   documented   sources
            docs       patterns
```

### Step 1: DETECT stack and versions

Read the project's dependency manifest first. Always.

| File | Read for |
|---|---|
| `package.json` | Node, React, Vue, Angular, Svelte, Next.js, frameworks |
| `composer.json` | PHP / Symfony / Laravel |
| `requirements.txt` / `pyproject.toml` | Python / Django / Flask / FastAPI |
| `go.mod` | Go modules |
| `Cargo.toml` | Rust crates |
| `Gemfile` | Ruby / Rails |
| `pubspec.yaml` | Flutter / Dart |
| `.tool-versions` / `.nvmrc` | Runtime versions |

State what you found explicitly:

```
STACK DETECTED:
- React 19.1.0 (from package.json)
- Vite 6.2.0
- Tailwind CSS 4.0.3
→ Fetching official docs for the patterns below.
```

If versions are missing or ambiguous, ask the user. Do not guess — version determines which patterns are correct.

### Step 2: FETCH official documentation

Fetch the SPECIFIC page for the feature you implement. Not the homepage. Not the full docs.

Preferred fetch order:
1. `mcp__plugin_artibot_context7__resolve-library-id` then `mcp__plugin_artibot_context7__query-docs` — best when the library is registered with Context7 (most major frameworks are)
2. `WebFetch` of the canonical doc URL — when Context7 doesn't cover it

The `webfetch-cache-pre.js` and `webfetch-cache-post.js` hooks (from Squad C, Adoption ID AD-24, also called `sdd-cache`) automatically handle HTTP 304 revalidation, so repeated fetches of the same doc page within a session are nearly free. See § Cache-Aware Operation below.

**Be precise:**

| Bad | Good |
|---|---|
| Fetch react.dev | Fetch react.dev/reference/react/useActionState |
| Search "django authentication best practices" | Fetch docs.djangoproject.com/en/6.0/topics/auth/ |
| Fetch nextjs.org | Fetch nextjs.org/docs/app/building-your-application/routing |

Extract patterns + deprecation warnings + migration guidance. If two official sources disagree (e.g., changelog vs API reference), surface the conflict to the user — never silently pick one.

### Step 3: IMPLEMENT following documented patterns

Write code that matches what the docs show. Specifically:
- Use API signatures from the docs, not from memory
- If docs show a new API, use the new API
- If docs deprecate a pattern, do not use the deprecated version
- If docs don't cover something, flag the implementation as `UNVERIFIED`

When docs conflict with existing project code, surface the conflict:

```
CONFLICT DETECTED:
The codebase uses useState for form-pending state, but React 19 docs
recommend useActionState for this pattern.
(Source: react.dev/reference/react/useActionState)

Options:
A) Use the modern pattern (useActionState) — consistent with current docs
B) Match existing code (useState) — consistent with codebase
→ Which approach do you prefer?
```

Never silently choose; the user owns that decision.

### Step 4: CITE your sources

Every framework-specific pattern gets a citation the user can click and verify.

**In code comments:**

```typescript
// React 19 form handling with useActionState
// Source: https://react.dev/reference/react/useActionState#usage
const [state, formAction, isPending] = useActionState(submitOrder, initialState);
```

**In conversation:**

```
Using useActionState instead of manual useState for form-pending.
React 19 replaced the manual isPending pattern with this hook.

Source: https://react.dev/blog/2024/12/05/react-19#actions
```

If you could not verify a pattern:

```
UNVERIFIED: I could not find official documentation for this exact
pattern in the current version. This is from training data and may
be outdated. Verify before production use.
```

Honesty about non-verification beats false confidence every time.

## Cache-Aware Operation

Squad C's `webfetch-cache-pre.js` / `webfetch-cache-post.js` hooks (the Artibot port of agent-skills' sdd-cache, Adoption ID AD-24) intercept WebFetch calls and:

1. On `WebFetch.pre`: compute a cache key from the URL, look up `runtime/cache/webfetch/<sha>.json`, send `If-None-Match` / `If-Modified-Since` headers if available
2. On `WebFetch.post`: if upstream returned 304, serve cached body; otherwise update cache with new ETag/Last-Modified + body

For source-driven-development this means:
- Re-fetching the same doc page within minutes is ~free (304 response, no body transfer)
- The cache lives at `runtime/cache/webfetch/`, gitignored, never leaves the user's machine (DATA POLICY compliant)
- HEAD request is the only revalidation traffic — no body is transmitted unless content actually changed
- See `plugins/artibot/docs/webfetch-cache.md` for the cache key format and TTL policy

If the cache hit is fresh (within the cache's freshness window), you can skip the WebFetch entirely. The hook surfaces this via a hint in the WebFetch tool result; persona just reads the cached body.

## Source Hierarchy

| Priority | Source | Examples |
|---|---|---|
| 1 (highest) | Official documentation | react.dev, docs.djangoproject.com, symfony.com/doc, nextjs.org/docs |
| 2 | Official blog / changelog | react.dev/blog, nextjs.org/blog, vuejs.org/blog |
| 3 | Web standards references | MDN (developer.mozilla.org), web.dev, html.spec.whatwg.org |
| 4 | Browser/runtime compatibility | caniuse.com, node.green |

**Never authoritative:**
- Stack Overflow answers (single-author opinions)
- Tutorial blog posts (even popular ones)
- AI-generated documentation summaries
- Your own training data

If only non-authoritative sources exist, flag the answer as `UNVERIFIED:` and stop. Do not paper over with hedge words like "I believe" or "I think".

## Citation Rules

- Full URLs, not shortened links (no bit.ly, no t.co)
- Prefer deep links with anchors (`/useActionState#usage` survives doc restructuring better than `/useActionState` alone)
- Quote the relevant passage when it supports a non-obvious decision
- Include browser/runtime compatibility data (caniuse, node.green) when recommending platform features
- Cite version ranges explicitly: "React 19+", "Next.js 14.2+"
- Mark unverified explicitly with the literal `UNVERIFIED:` token at line start

## Common Rationalizations

| Rationalization | Why it's wrong | What to do instead |
|---|---|---|
| "I'm confident about this API" | Training data contains outdated API signatures that look correct but break against current versions; confidence is not evidence | Fetch the doc page; if docs say what you remember, the citation costs nothing extra |
| "Fetching docs wastes tokens" | Hallucinating an API wastes far more — user spends an hour debugging, then discovers the function signature changed; one fetch prevents hours of rework. The sdd-cache hook makes repeat fetches near-free | Fetch on first use; rely on cache for revalidation in the same session |
| "The docs won't have what I need" | If officials docs don't cover the pattern, that's information — the pattern may not be officially recommended; flag as `UNVERIFIED:` is the honest answer | Search the docs first; if absent, mark unverified explicitly |
| "I'll just mention it might be outdated" | A vague disclaimer doesn't help the user; either verify and cite, or clearly flag as `UNVERIFIED:` | No hedging — verify or flag |
| "Simple task, no need to check" | Simple tasks become templates copied across the codebase; one outdated form handler becomes ten | Verify even simple framework-specific patterns; the cache makes it cheap |
| "The user wants speed, not verification" | Speed without verification ships bugs that cost more than the verification time | Confirm explicitly: "Do you want me to skip verification? I'll mark code as UNVERIFIED if so." |
| "I checked Stack Overflow, that's good enough" | Stack Overflow drifts faster than docs; popular answers are often outdated; SO is not authoritative | Use SO for hints, then verify against official docs before citing |
| "The framework is well-known, training data is enough" | Well-known frameworks have the most active deprecation churn; React Hooks, Next.js App Router, Tailwind v4 all reshaped APIs across recent major versions | Always verify framework-specific code regardless of framework popularity |

## Red Flags

- Writing framework-specific code without reading the dep manifest first
- Using "I believe" or "I think" about an API instead of citing
- Implementing a pattern without knowing which version it applies to
- Citing Stack Overflow or a tutorial blog as the primary source
- Using deprecated APIs because they appear in training data
- Skipping the version detection step ("I'll just use React patterns")
- Delivering code without citations for framework-specific decisions
- Fetching the docs homepage rather than a specific reference page
- Silently picking one when two official sources conflict
- Ignoring the `webfetch-cache` hint that says "cached body available"

## Verification

After implementing with source-driven-development:

- [ ] Framework + library versions identified from dep manifest (`package.json`, etc.)
- [ ] Official documentation fetched for every framework-specific pattern
- [ ] All sources are official docs / changelogs / standards refs (no Stack Overflow as primary)
- [ ] Code follows patterns shown in CURRENT version's documentation
- [ ] Non-trivial decisions include source citations with full URLs
- [ ] No deprecated APIs used (cross-checked against migration guides)
- [ ] Conflicts between docs and existing code surfaced to the user
- [ ] Anything not verified is explicitly flagged `UNVERIFIED:`
- [ ] WebFetch cache hits leveraged (no redundant body transfers when 304 was available)

## See Also

- [persona-distill](../persona-distill/SKILL.md) — applies the same source-citation discipline to persona authoring
- `plugins/artibot/docs/webfetch-cache.md` — cache key format, freshness, eviction (from Squad C)
- `plugins/artibot/scripts/hooks/webfetch-cache-pre.js` — pre-fetch revalidation hook
- `plugins/artibot/scripts/hooks/webfetch-cache-post.js` — post-fetch cache write hook
- Benchmark source: `runtime/benchmark/agent-skills-benchmark.md` (Adoption ID AD-32)
