#!/usr/bin/env node
/**
 * export-to-tool.mjs — Cross-tool parity exporter (v0.5.1).
 *
 * Reads Artibot's source-of-truth agents under `plugins/artibot/agents/{name}.md`
 * and projects them into the format each supported tool expects.
 *
 * Supported --tool values:
 *   cursor    -> <out>/{name}.mdc           Cursor Rules-for-AI file
 *   codex     -> <out>/{name}.md            OpenAI Codex CLI agent spec
 *   opencode  -> <out>/{name}.md            OpenCode agent markdown
 *
 * USAGE
 *   node plugins/artibot/scripts/export-to-tool.mjs --tool cursor --out ./cursor-export/
 *   node plugins/artibot/scripts/export-to-tool.mjs --tool codex --out ./codex-export/ --agents orchestrator,planner
 *   node plugins/artibot/scripts/export-to-tool.mjs --tool opencode --out ./opencode-export/ --dry-run
 *
 * DATA POLICY
 *   Local-only. No network calls. No third-party forwarding.
 *
 * See: plugins/artibot/AGENTS.md  (conversion rules table)
 *      plugins/artibot/docs/cross-tool-export.md (user guide)
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SUPPORTED_TOOLS = new Set(["cursor", "codex", "opencode"]);
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(SCRIPT_DIR, "..");
const AGENTS_DIR = join(PLUGIN_ROOT, "agents");

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const args = {
    tool: null,
    out: null,
    agents: null,
    dryRun: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--tool") args.tool = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--agents") args.agents = argv[++i];
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--help" || a === "-h") args.help = true;
  }
  return args;
}

function printHelp() {
  process.stderr.write(
    [
      "export-to-tool.mjs — Artibot cross-tool exporter",
      "",
      "Usage:",
      "  node export-to-tool.mjs --tool <cursor|codex|opencode> --out <dir> [options]",
      "",
      "Required:",
      "  --tool      Target tool: cursor, codex, opencode",
      "  --out       Output directory (created if missing)",
      "",
      "Options:",
      "  --agents    Comma-separated subset (default: all discovered agents)",
      "  --dry-run   Convert only; do not write files (summary to stderr)",
      "  --help      Show this help",
      "",
    ].join("\n")
  );
}

// ---------------------------------------------------------------------------
// Frontmatter parser (minimal YAML subset used in agent files)
// Handles:
//   - key: value  (scalar)
//   - key: |      (multi-line block scalar, joined by newlines)
//   - key:        (followed by "- item" lines -> array)
//   - key: [a, b] (inline array)
//   - lines starting with "#" inside a block are preserved as comments
// ---------------------------------------------------------------------------

/**
 * Consume consecutive "  - item" lines starting at `start` and return the
 * collected items plus the next line index. Inline "# comment" suffixes are
 * stripped; blank / commented lines inside the block are skipped.
 */
function readNestedArray(lines, start) {
  const items = [];
  let i = start;
  while (i < lines.length) {
    const sub = lines[i];
    const itemMatch = sub.match(/^\s+-\s+(.*)$/);
    if (itemMatch) {
      const v = itemMatch[1].replace(/\s+#.*$/, "").trim().replace(/^["']|["']$/g, "");
      if (v) items.push(v);
      i++;
      continue;
    }
    if (/^\s*#/.test(sub) || /^\s*$/.test(sub)) {
      i++;
      continue;
    }
    break;
  }
  return { items, nextIndex: i };
}

export function parseFrontmatter(src) {
  if (!src.startsWith("---")) return { frontmatter: {}, body: src };
  const endRel = src.slice(3).search(/\r?\n---/);
  if (endRel === -1) return { frontmatter: {}, body: src };
  const end = 3 + endRel;
  const raw = src.slice(3, end).replace(/^\r?\n/, "");
  const afterDelim = src.slice(end).replace(/^\r?\n---/, "");
  const body = afterDelim.replace(/^\r?\n/, "");

  const fm = {};
  const lines = raw.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // skip blanks and comments at top level
    if (/^\s*$/.test(line) || /^\s*#/.test(line)) {
      i++;
      continue;
    }
    const keyMatch = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!keyMatch) {
      i++;
      continue;
    }
    const [, key, rest] = keyMatch;

    // Inline array: key: [a, b, c]
    const inlineArr = rest.match(/^\[(.*)\]$/);
    if (inlineArr) {
      fm[key] = inlineArr[1]
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
      i++;
      continue;
    }

    // Block scalar: key: |  or key: >
    if (rest === "|" || rest === ">") {
      const collected = [];
      i++;
      while (i < lines.length && /^(\s{2,}|\t)/.test(lines[i])) {
        collected.push(lines[i].replace(/^(\s{2}|\t)/, ""));
        i++;
      }
      fm[key] = collected.join("\n").trim();
      continue;
    }

    // Nested array follows (lines starting with "- " or "  - ")
    if (rest === "") {
      const { items, nextIndex } = readNestedArray(lines, i + 1);
      fm[key] = items.length > 0 ? items : "";
      i = nextIndex;
      continue;
    }

    // Plain scalar
    fm[key] = rest.trim().replace(/^["']|["']$/g, "");
    i++;
  }
  return { frontmatter: fm, body };
}

// ---------------------------------------------------------------------------
// Agent discovery
// ---------------------------------------------------------------------------

export async function collectAgents(dir = AGENTS_DIR, filter = null) {
  let entries;
  try {
    entries = await readdir(dir);
  } catch (err) {
    throw new Error(`cannot read agents dir ${dir}: ${err.message}`);
  }
  const filterSet = filter ? new Set(filter.split(",").map((s) => s.trim()).filter(Boolean)) : null;
  const out = [];
  for (const file of entries) {
    if (!file.endsWith(".md")) continue;
    if (file === "INDEX.md") continue;
    const name = basename(file, ".md");
    if (filterSet && !filterSet.has(name)) continue;
    const full = join(dir, file);
    const src = await readFile(full, "utf8");
    const { frontmatter, body } = parseFrontmatter(src);
    out.push({
      file,
      path: full,
      name: frontmatter.name || name,
      description: frontmatter.description || "",
      model: frontmatter.model || "opus",
      modelTier: frontmatter.modelTier || "",
      category: frontmatter.category || "",
      tools: Array.isArray(frontmatter.tools) ? frontmatter.tools : [],
      permissionMode: frontmatter.permissionMode || "",
      maxTurns: frontmatter.maxTurns || "",
      skills: Array.isArray(frontmatter.skills) ? frontmatter.skills : [],
      frontmatter,
      body,
    });
  }
  if (filterSet) {
    // Verify requested agents were found
    const foundNames = new Set(out.map((a) => a.name));
    for (const wanted of filterSet) {
      if (!foundNames.has(wanted)) {
        throw new Error(`agent not found: ${wanted}`);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Helpers: kebab-case, comment block, body transforms
// ---------------------------------------------------------------------------

export function toKebabCase(s) {
  return String(s)
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[\s_]+/g, "-")
    .toLowerCase();
}

/**
 * Replace a "## Team Collaboration" section (and its body until the next "## "
 * heading or EOF) with a disclaimer comment block. Used by codex/opencode
 * since the Claude Code Agent Teams API (TaskCreate/SendMessage etc.) is
 * Claude-specific.
 */
export function stripTeamCollaboration(body, noteLines) {
  // Match: "## Team Collaboration" heading + everything until the NEXT "## " h2
  // heading OR end-of-string (whichever comes first). JS regex has no \Z anchor,
  // so we handle EOF with an explicit alternation on $(?![\s\S]) .
  const re = /^##\s+Team Collaboration[\s\S]*?(?=^##\s|$(?![\s\S]))/m;
  if (!re.test(body)) return body;
  const replacement = noteLines.map((l) => `<!-- ${l} -->`).join("\n") + "\n\n";
  return body.replace(re, replacement);
}

// ---------------------------------------------------------------------------
// Cursor converter
// Target: .cursor/rules/<name>.mdc
//   - frontmatter: description + alwaysApply + globs
//   - body preserved; tools list prepended as HTML comment for reference
// ---------------------------------------------------------------------------

export function convertCursor(agent) {
  const fileName = `${toKebabCase(agent.name)}.mdc`;
  const descEscaped = String(agent.description).replace(/\n/g, " ").replace(/"/g, '\\"');
  const fmLines = [
    "---",
    `description: "${descEscaped}"`,
    `globs: ["**/*"]`,
    "alwaysApply: false",
    "---",
    "",
  ];
  const toolsNote = agent.tools.length
    ? `<!-- Artibot source tools: ${agent.tools.join(", ")} -->`
    : "<!-- Artibot source tools: (none declared) -->";
  const modelNote = agent.model
    ? `<!-- Artibot source model hint: ${agent.model}${agent.modelTier ? ` (${agent.modelTier})` : ""} -->`
    : "";
  const header = [toolsNote, modelNote].filter(Boolean).join("\n");
  const content = `${fmLines.join("\n")}${header}\n\n${agent.body.trimEnd()}\n`;
  return { fileName, content };
}

// ---------------------------------------------------------------------------
// Codex converter
// Target: <out>/<name>.md (user will drop into ~/.codex/agents/)
//   - YAML frontmatter: name, description, model, tools
//   - Claude-specific fields preserved as HTML comments
//   - Team Collaboration section replaced with disclaimer
// ---------------------------------------------------------------------------

export function convertCodex(agent) {
  const fileName = `${toKebabCase(agent.name)}.md`;
  const description = String(agent.description).replace(/\n/g, " ").trim();

  const fmLines = ["---"];
  fmLines.push(`name: ${agent.name}`);
  fmLines.push(`description: "${description.replace(/"/g, '\\"')}"`);
  if (agent.model) fmLines.push(`model: ${agent.model}`);
  if (agent.tools.length) {
    fmLines.push("tools:");
    for (const t of agent.tools) fmLines.push(`  - ${t}`);
  }
  fmLines.push("---");

  const claudeSpecificComments = [];
  if (agent.modelTier) claudeSpecificComments.push(`Claude-specific: modelTier=${agent.modelTier}`);
  if (agent.permissionMode) claudeSpecificComments.push(`Claude-specific: permissionMode=${agent.permissionMode}`);
  if (agent.maxTurns) claudeSpecificComments.push(`Claude-specific: maxTurns=${agent.maxTurns}`);
  if (agent.skills.length) claudeSpecificComments.push(`Claude-specific: skills=${agent.skills.join(", ")}`);

  const commentBlock = claudeSpecificComments.length
    ? claudeSpecificComments.map((c) => `<!-- ${c} -->`).join("\n") + "\n"
    : "";

  const transformedBody = stripTeamCollaboration(agent.body, [
    "Claude Code Teams API (TeamCreate/SendMessage/TaskCreate) — not supported in Codex.",
    "Fallback: sequential subagent spawn; see plugins/artibot/AGENTS.md §4.",
  ]);

  const content = `${fmLines.join("\n")}\n\n${commentBlock}${transformedBody.trimEnd()}\n`;
  return { fileName, content };
}

// ---------------------------------------------------------------------------
// OpenCode converter
// Target: .opencode/agents/<name>.md
//   - Minimal frontmatter: name, description, tools
//   - Other Claude fields tucked into HTML comment
// ---------------------------------------------------------------------------

export function convertOpenCode(agent) {
  const fileName = `${toKebabCase(agent.name)}.md`;
  const description = String(agent.description).replace(/\n/g, " ").trim();

  const fmLines = ["---"];
  fmLines.push(`name: ${agent.name}`);
  fmLines.push(`description: "${description.replace(/"/g, '\\"')}"`);
  if (agent.tools.length) {
    fmLines.push("tools:");
    for (const t of agent.tools) fmLines.push(`  - ${t}`);
  }
  fmLines.push("---");

  const hiddenMeta = [];
  if (agent.model) hiddenMeta.push(`model=${agent.model}`);
  if (agent.modelTier) hiddenMeta.push(`modelTier=${agent.modelTier}`);
  if (agent.category) hiddenMeta.push(`category=${agent.category}`);
  if (agent.permissionMode) hiddenMeta.push(`permissionMode=${agent.permissionMode}`);
  if (agent.maxTurns) hiddenMeta.push(`maxTurns=${agent.maxTurns}`);
  if (agent.skills.length) hiddenMeta.push(`skills=${agent.skills.join(", ")}`);

  const metaBlock = hiddenMeta.length
    ? `<!-- artibot-meta: ${hiddenMeta.join("; ")} -->\n`
    : "";

  const transformedBody = stripTeamCollaboration(agent.body, [
    "Team Collaboration section removed — OpenCode does not support Claude Agent Teams API.",
  ]);

  const content = `${fmLines.join("\n")}\n\n${metaBlock}${transformedBody.trimEnd()}\n`;
  return { fileName, content };
}

// ---------------------------------------------------------------------------
// Converter registry
// ---------------------------------------------------------------------------

export const CONVERTERS = {
  cursor: convertCursor,
  codex: convertCodex,
  opencode: convertOpenCode,
};

// ---------------------------------------------------------------------------
// Orchestrator: run conversion, optionally write
// ---------------------------------------------------------------------------

export async function runExport({ tool, out, agents, dryRun }, agentsDir = AGENTS_DIR) {
  if (!SUPPORTED_TOOLS.has(tool)) {
    throw new Error(`unsupported tool: ${tool} (supported: ${[...SUPPORTED_TOOLS].join(", ")})`);
  }
  const converter = CONVERTERS[tool];
  const collected = await collectAgents(agentsDir, agents);
  if (collected.length === 0) {
    throw new Error(`no agents discovered under ${agentsDir}`);
  }

  const results = collected.map((a) => ({ agent: a, ...converter(a) }));

  if (!dryRun) {
    if (!out) throw new Error("--out is required unless --dry-run is specified");
    const absOut = resolve(out);
    try {
      await mkdir(absOut, { recursive: true });
    } catch (err) {
      throw new Error(`output dir creation failed: ${absOut}: ${err.message}`);
    }
    for (const r of results) {
      const target = join(absOut, r.fileName);
      await writeFile(target, r.content, "utf8");
    }
  }

  return {
    tool,
    out: out ? resolve(out) : null,
    dryRun: Boolean(dryRun),
    agentCount: collected.length,
    files: results.map((r) => ({ name: r.agent.name, fileName: r.fileName, bytes: Buffer.byteLength(r.content, "utf8") })),
  };
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  if (!args.tool) {
    process.stderr.write("[export] --tool is required\n");
    printHelp();
    process.exit(1);
  }
  if (!args.out && !args.dryRun) {
    process.stderr.write("[export] --out is required (or use --dry-run)\n");
    printHelp();
    process.exit(1);
  }
  if (!SUPPORTED_TOOLS.has(args.tool)) {
    process.stderr.write(
      `[export] unsupported tool: ${args.tool} (supported: ${[...SUPPORTED_TOOLS].join(", ")})\n`
    );
    process.exit(2);
  }

  try {
    const summary = await runExport(args);
    const mode = summary.dryRun ? "dry-run" : "written";
    process.stderr.write(
      `[export] tool=${summary.tool} agents=${summary.agentCount} mode=${mode}` +
        (summary.out ? ` out=${summary.out}` : "") +
        "\n"
    );
    for (const f of summary.files) {
      process.stderr.write(`[export]   ${f.name} -> ${f.fileName} (${f.bytes}B)\n`);
    }
    process.exit(0);
  } catch (err) {
    process.stderr.write(`[export] error: ${err.message}\n`);
    process.exit(3);
  }
}

// Only run main() when invoked directly (not when imported by tests)
const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
const thisPath = fileURLToPath(import.meta.url);
if (invokedPath === thisPath) {
  main().catch((err) => {
    process.stderr.write(`[export] fatal: ${err.stack || err.message}\n`);
    process.exit(99);
  });
}
