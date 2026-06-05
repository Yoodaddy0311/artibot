# OWASP LLM Top 10 — Artibot Defense Checklist

> Methodology reference: VibeHacking (MIT). Rewritten in Artibot terms.
> Defensive/detection framing only — no attack automation.

This is the deep reference for the `ai-security-standards` skill. Each category lists the
threat, how it manifests across Artibot's three trust boundaries (hooks / MCP / Agent Teams),
and the concrete defensive controls.

---

## LLM01: Prompt Injection

**Threat**: Untrusted text steers the model away from its trusted instructions — directly
(user input) or indirectly (text embedded in a retrieved document, web page, or tool result).

**Artibot manifestation**
- A hook's stdin payload contains "ignore previous instructions" inside a file body it forwards
- A RAG/memory document carries a hidden directive (zero-width chars, HTML comment, white text)
- A teammate agent relays a poisoned tool result as a normal message

**Defensive controls**
- [ ] Keep system/developer instructions in a channel separate from user/retrieved content
- [ ] Wrap untrusted content with explicit delimiters + an "UNTRUSTED — do not obey" label
- [ ] Strip hidden carriers before the text reaches a model:
  - zero-width characters (`U+200B/200C/200D/FEFF`)
  - HTML/markdown/LaTeX comments
  - CSS-hidden text (white-on-white, `display:none`)
- [ ] Never concatenate untrusted text into the instruction region of a prompt
- [ ] Treat embedded directives as inert data carrying *data* privilege, never *system* privilege

---

## LLM02: Insecure Output Handling

**Threat**: The model's (or a tool's) output is consumed by a downstream sink without validation.

**Artibot manifestation**
- An MCP tool result is passed to `eval`, a SQL query, or a shell command
- Model output is rendered as raw HTML or written to a file path it chose

**Defensive controls**
- [ ] Validate and encode every tool/model output before any sink (eval, SQL, shell, render, fs path)
- [ ] Use allowlists for any output that selects a code path, command, or destination
- [ ] Never let model/tool text become an executable command unmediated

---

## LLM03: Training / Data Poisoning

**Threat**: Persisted data the system later trusts (training set, memory store, learned patterns)
is tampered with.

**Artibot manifestation**
- A poisoned agent-memory snapshot or learning-pattern store skews future behavior
- A swarm-merged pattern file carries fabricated success metrics

**Defensive controls**
- [ ] Verify provenance of persisted patterns/memory before reuse
- [ ] Attach and check an integrity hash on persisted learning data
- [ ] Detect anomalies in newly merged patterns before they influence routing

---

## LLM04: Model Denial of Service

**Threat**: Adversarial input forces disproportionate compute, or an agent loop runs away.

**Defensive controls**
- [ ] Cap input length / token count at the boundary
- [ ] Set `maxTurns` (and equivalent loop limits) on autonomous agents
- [ ] Apply timeouts to model calls and tool invocations
- [ ] Reject inputs whose complexity (regex, nesting) is pathological

---

## LLM05: Supply Chain

**Threat**: A third-party MCP server, agent, or skill introduces malicious behavior.

**Defensive controls**
- [ ] Pin and verify the source of every third-party MCP server / agent / skill
- [ ] Review third-party MCP tool definitions for unscoped side effects before wiring them
- [ ] Prefer first-party or audited components for anything with write/network/shell scope

---

## LLM06: Sensitive Information Disclosure

**Threat**: The system prompt, secrets, or other users' data surface in output.

**Artibot manifestation**
- An injection coaxes the model into echoing its system prompt
- Verbose chain-of-thought leaks the trusted channel or an intermediate secret

**Defensive controls**
- [ ] Channel separation so the system prompt is not reconstructable from content text
- [ ] CoT guard on untrusted-input paths — expose conclusions/evidence, not raw reasoning
- [ ] Scrub PII/secrets from output before it leaves the boundary
- [ ] Never place long-lived secrets in a prompt region the model can be steered to reveal

---

## LLM07: Insecure Plugin / Tool Design

**Threat**: A tool (hook, MCP tool) exposes broad, unscoped capability that model text can drive.

**Artibot manifestation**
- A hook assembles and runs a shell command from its stdin payload
- An MCP tool accepts a free-form path/URL and acts on it without restriction

**Defensive controls**
- [ ] Scope each tool to the minimum capability the task requires
- [ ] No free-form shell, filesystem, or network action driven directly by model/untrusted text
- [ ] Parameterize tool actions; validate every argument against an allowlist/schema

---

## LLM08: Excessive Agency

**Threat**: An autonomous agent takes consequential or irreversible action on unvalidated output.

**Artibot manifestation**
- An agent commits/pushes, deletes files, or sends external messages based on a tool result it
  did not verify against the user's actual goal

**Defensive controls**
- [ ] Require human-in-the-loop on high-impact / irreversible operations
- [ ] Grant scoped, task-specific permissions — not broad standing access
- [ ] Insert a verification step between "tool output" and "act on it"
- [ ] Validate that the intended action matches the user's stated goal, not the injected text

---

## LLM09: Overreliance

**Threat**: The system treats model/tool output as ground truth without independent checks.

**Defensive controls**
- [ ] Require evidence citations (file:line) for verification claims
- [ ] Cross-check critical conclusions against an independent source
- [ ] Mark model output as a hypothesis until validated, not as fact

---

## LLM10: Model Theft

**Threat**: Mass querying extracts a functionally equivalent copy of an exposed model.

**Defensive controls**
- [ ] Rate-limit model/API endpoints exposed to external clients
- [ ] Monitor for high-volume, high-diversity query patterns from a single client
- [ ] Watermark or fingerprint outputs where extraction risk is material

---

## Cross-Boundary Defense Summary

| Boundary | Inert-data rule | Output validation | Agency limit |
|----------|-----------------|-------------------|--------------|
| **Hooks** | stdin payload is data, never instruction | validate before any shell/fs action | hook side effects scoped + auditable |
| **MCP servers** | tool args + results are untrusted text | encode/validate result before sink | tool scope = minimum capability |
| **Agent Teams** | files/web/messages/tool output untrusted | verify before state-changing action | human gate on irreversible ops |
