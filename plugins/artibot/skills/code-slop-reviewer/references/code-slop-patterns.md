# Code Slop Pattern Dictionary

Reference for `code-slop-reviewer` SKILL. Each pattern is scored by weight (1-10) and flagged when surrounding context does not justify its presence. All weights and thresholds are initial proposals — tune with telemetry collected via `plugins/_shared/rubrics/auto-flag-schema.md`.

Regex is a screening aid. A regex match is never sufficient to flag on its own; the reviewer must read at least 10 lines of surrounding context and consult the idiom allowlist in Section 4 before confirming.

---

## Section 1: JavaScript / TypeScript Patterns (17)

### JS-01 · try-swallow

- **Weight**: 7
- **Regex**: `/try\s*\{[\s\S]{1,120}\}\s*catch\s*\(?\s*\w*\s*\)?\s*\{\s*\}/`
- **Why**: LLMs wrap any I/O-shaped call in `try { ... } catch {}` to appear "safe." The empty catch swallows failure with no recovery path and breaks observability.
- **Fix**: Remove the try/catch and let the error bubble, or catch a specific error class and log with context.

```js
// before
try { const u = JSON.parse(raw); return u; } catch {}

// after
return JSON.parse(raw);
```

### JS-02 · as-unknown-as

- **Weight**: 6
- **Regex**: `/\bas\s+unknown\s+as\s+\w+/`
- **Why**: Escape hatch to bypass type friction instead of fixing the source type. Defeats the point of TypeScript at the boundary.
- **Fix**: Narrow with a type guard, or fix the upstream type.

```ts
// before
const user = raw as unknown as User;

// after
if (!isUser(raw)) throw new Error("invalid user payload");
const user = raw;
```

### JS-03 · any-cascade

- **Weight**: 6
- **Regex**: `/:\s*any\b|<any>|as\s+any\b/`
- **Why**: One `any` tends to propagate. Often added by LLMs when inference gets hard; erases type safety for callers.
- **Fix**: Supply the correct type, or use `unknown` with a guard.

### JS-04 · options-bag-bloat

- **Weight**: 6
- **Regex**: none (requires AST / manual count)
- **Why**: Function signature declares 8+ optional fields; callers pass 1-2. Remaining fields are dead config.
- **Fix**: Keep only the options actually used; inline the rest.

```ts
// before
function fetchUser(opts: { id: string; cache?: boolean; timeout?: number; retries?: number; onError?: Fn; signal?: AbortSignal; tracing?: boolean; prefetch?: boolean }) { ... }

// after
function fetchUser(id: string, { cache = false, signal }: { cache?: boolean; signal?: AbortSignal } = {}) { ... }
```

### JS-05 · builtin-wrapper

- **Weight**: 5
- **Regex**: `/function\s+is\w+\s*\([^)]*\)\s*\{\s*return\s+(Array\.isArray|typeof|Object\.)/`
- **Why**: `function isArray(x) { return Array.isArray(x) }` adds a name, an import, and a call frame for zero value.
- **Fix**: Delete the wrapper; call the primitive directly.

### JS-06 · redundant-null-check

- **Weight**: 4
- **Regex**: `/if\s*\(\s*\w+\s*(!==?|!=)\s*null\s*\)/`
- **Why**: Guard added on values that the surrounding code (or TS types) already guarantees non-null.
- **Fix**: Remove the guard when types/flow prove it unreachable.

```ts
// before
const x = 5;
if (x != null) console.log(x);

// after
console.log(x);
```

### JS-07 · restate-comment

- **Weight**: 3
- **Regex**: `/\/\/\s*(set|get|return|increment|decrement|add|remove|loop over)\b/i`
- **Why**: Comment paraphrases the next line. Adds reading time, drifts from code over time.
- **Fix**: Delete the comment. Write one only if a non-obvious invariant needs encoding.

### JS-08 · owner-less-todo

- **Weight**: 5
- **Regex**: `/\/\/\s*(TODO|FIXME|XXX)(?!\s*[:(]\s*@)/`
- **Why**: `// TODO: fix later` is permanent. Without owner, date, or issue it will never be addressed.
- **Fix**: `// TODO(@handle, 2026-04-23): [trigger condition]` or `// TODO(#ISSUE-123): ...`, else delete.

### JS-09 · console-log-leftover

- **Weight**: 4
- **Regex**: `/console\.(log|debug|info)\s*\(/`
- **Why**: Debug logs left in shipped code. Pollutes production output or CI logs.
- **Fix**: Remove, or replace with structured logger at `debug` level.

### JS-10 · commented-out-block

- **Weight**: 4
- **Regex**: `/(^\s*\/\/.*\n){4,}/m`
- **Why**: 4+ consecutive commented-out lines signal "I am keeping this just in case." VCS already does that.
- **Fix**: Delete. Use `git log --follow` to recover if ever needed.

### JS-11 · useless-async

- **Weight**: 4
- **Regex**: `/async\s+function\s+\w+\s*\([^)]*\)\s*\{\s*return\s+[^;]+;\s*\}/`
- **Why**: `async` keyword with no `await` in body. Forces callers into promise chains unnecessarily.
- **Fix**: Drop `async`, return the value directly.

### JS-12 · ternary-on-boolean

- **Weight**: 2
- **Regex**: `/\?\s*true\s*:\s*false|\?\s*false\s*:\s*true/`
- **Why**: `cond ? true : false` is `Boolean(cond)` or just `cond`. Noise.
- **Fix**: Use the expression directly or `!expr` for negation.

### JS-13 · premature-factory

- **Weight**: 6
- **Regex**: none (AST / caller count)
- **Why**: `createX()` factory with 1-2 call sites and no polymorphism. Abstraction without reuse.
- **Fix**: Inline at the call sites. Introduce the factory only when third caller appears.

### JS-14 · jsdoc-for-self-evident

- **Weight**: 2
- **Regex**: `/\/\*\*[\s\S]{1,200}@param\s+\w+\s+-?\s*the\s+\w+\s*\*\//i`
- **Why**: `@param name - the name` style boilerplate. No new information.
- **Fix**: Delete the block, or add a real invariant / constraint.

### JS-15 · empty-default-export

- **Weight**: 3
- **Regex**: `/export\s+default\s*\{\s*\}/`
- **Why**: `export default {}` leftover from scaffolding. Imports become no-ops.
- **Fix**: Delete the export or populate it.

### JS-16 · catch-and-console

- **Weight**: 5
- **Regex**: `/catch\s*\(\s*\w+\s*\)\s*\{\s*console\.\w+\([^)]*\)\s*;?\s*\}/`
- **Why**: `catch (e) { console.error(e) }` hides failure from the caller. Looks responsible, isn't.
- **Fix**: Rethrow after logging, or return a typed failure value.

### JS-17 · optional-chain-on-required

- **Weight**: 3
- **Regex**: `/\w+\?\.\w+/`
- **Why**: `obj?.prop` on values that are typed as non-optional. Hides type bugs.
- **Fix**: Remove `?.` when the type guarantees presence; fix the type otherwise.

---

## Section 2: Python Patterns (12)

### PY-01 · except-pass

- **Weight**: 9
- **Regex**: `/except(\s+\w+(\s+as\s+\w+)?)?\s*:\s*(\n\s+)?pass\b/`
- **Why**: Catches and silently discards. Identical failure mode to JS-01 but historically more common in Python.
- **Fix**: Catch the specific exception, log with context, and re-raise or return a failure value.

```python
# before
try:
    result = json.loads(raw)
except Exception:
    pass

# after
result = json.loads(raw)  # let JSONDecodeError propagate
```

### PY-02 · broad-except

- **Weight**: 7
- **Regex**: `/except\s+(Exception|BaseException)\s*(as\s+\w+)?\s*:/`
- **Why**: `except Exception:` hides KeyboardInterrupt-adjacent and domain errors alike. Masks real bugs.
- **Fix**: Catch specific exception classes; let the rest propagate.

### PY-03 · identity-lambda

- **Weight**: 4
- **Regex**: `/lambda\s+(\w+)\s*:\s*\1\s*(,|\)|$)/`
- **Why**: `lambda x: x` is `identity`. Usually a placeholder the LLM forgot to fill in.
- **Fix**: Remove the `key=` / `map()` entirely if identity is the transform.

### PY-04 · redundant-none-and-empty

- **Weight**: 4
- **Regex**: `/if\s+\w+\s+is\s+not\s+None\s+and\s+\w+\s*(!=|<>)\s*(""|'')/`
- **Why**: `if x is not None and x != "":` duplicates `if x:` for strings. Verbose without safety gain.
- **Fix**: `if x:` (when empty string is the sentinel you're guarding against).

### PY-05 · unused-dataclass-field

- **Weight**: 5
- **Regex**: none (AST scan)
- **Why**: Dataclass declares fields never read by any method or caller. Dead shape.
- **Fix**: Remove the field; re-add when a reader appears.

### PY-06 · for-loop-comprehension-candidate

- **Weight**: 3
- **Regex**: none (AST / pattern match)
- **Why**: Four-line `for ... append` loop where a one-line comprehension reads cleaner. Not always slop — only flag when the loop has no side effect beyond `append`.
- **Fix**: Convert to list/dict/set comprehension.

```python
# before
out = []
for x in items:
    out.append(x.upper())

# after
out = [x.upper() for x in items]
```

### PY-07 · print-debug-leftover

- **Weight**: 4
- **Regex**: `/^\s*print\s*\(\s*(f?["']|[a-zA-Z_])/m`
- **Why**: `print()` used as debug statement, left in shipped code.
- **Fix**: Remove, or route through `logging.debug`.

### PY-08 · mutable-default-arg

- **Weight**: 6
- **Regex**: `/def\s+\w+\s*\([^)]*=\s*(\[\]|\{\}|set\(\))/`
- **Why**: `def f(x=[]):` shares the default across calls. Classic Python footgun, often introduced by LLMs that memorized syntax but not semantics.
- **Fix**: `def f(x=None): x = x or []`.

### PY-09 · owner-less-todo

- **Weight**: 5
- **Regex**: `/#\s*(TODO|FIXME|XXX)(?!\s*[:(]\s*@)/`
- **Why**: Same as JS-08. Comment without owner/date/issue is a permanent marker.
- **Fix**: `# TODO(@handle, 2026-04-23): [trigger]` or delete.

### PY-10 · restate-comment

- **Weight**: 3
- **Regex**: `/#\s*(set|get|return|increment|decrement|initialize|create)\b/i`
- **Why**: Same failure mode as JS-07.
- **Fix**: Delete; write comments only for non-obvious invariants.

### PY-11 · explicit-none-return

- **Weight**: 2
- **Regex**: `/^\s*return\s+None\s*$/m`
- **Why**: `return None` at end of function. Implicit `None` return is the Python convention.
- **Fix**: `return` alone, or drop the line when it is already the last statement.

### PY-12 · useless-type-coercion

- **Weight**: 3
- **Regex**: `/\b(str|int|float|list|dict)\s*\(\s*\w+\s*\)/`
- **Why**: Wrapping a value that is already of that type. Flag only when type analysis confirms redundancy.
- **Fix**: Remove the wrapper.

---

## Section 3: Cross-Language Patterns (6)

### XX-01 · commented-out-block

- **Weight**: 4
- **Scope**: any language
- **Why**: 4+ consecutive commented-out code lines. Git is the archive; inline comment blocks are not.
- **Fix**: Delete. Recover from VCS if ever needed.

### XX-02 · owner-less-todo

- **Weight**: 5
- **Scope**: any language
- **Why**: See JS-08 / PY-09. Covered here for languages outside the two primaries.
- **Fix**: Require owner + date + trigger.

### XX-03 · restate-the-code-comment

- **Weight**: 3
- **Scope**: any language
- **Why**: Comment paraphrases the code immediately below it. No added context, drifts from reality.
- **Fix**: Delete, or upgrade to an invariant.

### XX-04 · single-use-helper-wrapper

- **Weight**: 5
- **Scope**: any language
- **Why**: Helper function with exactly one caller, wrapping 1-3 lines of code. Abstraction cost without reuse benefit.
- **Fix**: Inline at the single call site.

### XX-05 · self-naming-redundancy

- **Weight**: 2
- **Scope**: any language
- **Why**: `// This function does X` above `function doX()`. Signal redundant with the identifier.
- **Fix**: Delete the comment. The name is the documentation.

### XX-06 · symmetry-padding

- **Weight**: 3
- **Scope**: any language
- **Why**: Switch / if-else branches filled with `return null` or empty blocks just to make the structure "look complete." Adds false cases to reason about.
- **Fix**: Remove the empty branches; let the default path handle them.

---

## Section 4: Idiom Allowlist (Do Not Flag)

Screening regex will match these shapes, but the surrounding context makes them idiomatic rather than slop. Mark as `suppressed: idiom` in the report and do not count toward the score.

| Language | Shape | Idiom Context |
|----------|-------|---------------|
| Node.js ESM | `try { await import(x) } catch { /* optional plugin */ }` | Optional plugin loading where missing module is a real graceful-degrade path |
| Node.js ESM | `try { JSON.parse(raw) } catch (e) { return null }` at trust boundary | Parsing untrusted input where null-return is the documented contract |
| React | `useEffect(() => { ... ; return () => {} }, [])` | Required cleanup signature even when no teardown exists |
| React | `onClick?.()` on optional prop | Optional handler props are conventional |
| TypeScript | `x as const` | Literal-type narrowing, not an escape hatch |
| TypeScript | `@ts-expect-error` with comment explaining why | Documented acknowledgment, not a bypass |
| Python | `except Exception: raise` with `finally: log.info(...)` | Legitimate re-raise with audit logging |
| Python | `def f(x: int = 0) -> None: ...` with explicit `-> None` | Explicit return annotation; not the same as `return None` body |
| Python | `@dataclass` with fields not yet used by any method in same file | May be consumed via serialization / reflection; check usages project-wide before flagging |
| Any OOP | `raise NotImplementedError` / `throw new Error("not implemented")` in abstract base | Contract marker, not swallowed error |
| Any OOP | Decorator factory returning wrapper function | Decorator shape requires this nesting |
| Test fixtures | Builder functions with many optional params | Test ergonomics; categories 2 (premature-factory), 5 (options-bag), 8 (trivial-config) do not apply inside `*test*` / `*spec*` files |
| Generated code | Anything in `dist/`, `build/`, `.generated.*`, `__generated__/` | Skip entirely; generators own the style |

**Judgment rule**: when in doubt about an idiom, prefer suppression. False positives train reviewers to ignore the tool; they erode trust faster than false negatives.

---

## Section 5: Cross-Reference With Shared Rubric

Weights and tier mapping in this file must stay aligned with:

- `plugins/_shared/rubrics/severity-tiers.md` — tier definitions (Clean / Acceptable / Needs Work / Heavy Slop / Reject)
- `plugins/_shared/rubrics/auto-flag-schema.md` — YAML schema for emitting findings into the telemetry pipeline
- `plugins/_shared/rubrics/category-floor.md` — minimum weight floor per category; do not downgrade below these values without an explicit telemetry-backed justification

When this file drifts from the shared rubrics, the shared rubric wins. Update this file rather than the rubric.
