#!/usr/bin/env node
/**
 * export-to-tool.mjs — Cross-tool parity exporter (skeleton, v0.5.0).
 *
 * Reads Artibot's AGENTS.md + plugins/artibot/agents/ *.md source of truth
 * and projects them into the format each supported tool expects.
 *
 * Supported --tool values:
 *   cursor   -> .cursor/rules/<agent>.mdc
 *   codex    -> AGENTS.md + .codex/agents/<agent>.md
 *   opencode -> .opencode/agents.json
 *
 * USAGE
 *   node plugins/artibot/scripts/export-to-tool.mjs --tool cursor   --out ./.cursor/rules/
 *   node plugins/artibot/scripts/export-to-tool.mjs --tool codex    --out ./
 *   node plugins/artibot/scripts/export-to-tool.mjs --tool opencode --out ./.opencode/
 *
 * STATUS
 *   v0.5.0 — CLI scaffold + agent enumeration only. Actual format conversion
 *            is intentionally stubbed (see TODO markers) and lands in v0.5.1.
 *
 * DATA POLICY
 *   Local-only. No network calls. No third-party forwarding.
 *
 * See: plugins/artibot/AGENTS.md  (conversion rules table)
 *      plugins/artibot/docs/mcp-2.0-integration.md
 */

import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

const SUPPORTED_TOOLS = new Set(["cursor", "codex", "opencode"]);
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(SCRIPT_DIR, "..");
const AGENTS_DIR = join(PLUGIN_ROOT, "agents");

function parseArgs(argv) {
  const args = { tool: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--tool") args.tool = argv[++i];
    else if (a === "--out") args.out = argv[++i];
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
      "  node export-to-tool.mjs --tool <cursor|codex|opencode> --out <dir>",
      "",
      "Flags:",
      "  --tool   Target tool (required)",
      "  --out    Output directory (required)",
      "  --help   Show this help",
      "",
    ].join("\n")
  );
}

/** Minimal frontmatter parser — avoids external deps (Artibot is zero-runtime-dep). */
function parseFrontmatter(src) {
  if (!src.startsWith("---")) return { frontmatter: {}, body: src };
  const end = src.indexOf("\n---", 3);
  if (end === -1) return { frontmatter: {}, body: src };
  const raw = src.slice(3, end).trim();
  const body = src.slice(end + 4).replace(/^\n/, "");
  const fm = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    const [, key, value] = m;
    fm[key] = value.trim();
  }
  return { frontmatter: fm, body };
}

async function collectAgents() {
  let entries;
  try {
    entries = await readdir(AGENTS_DIR);
  } catch (err) {
    process.stderr.write(`[export] cannot read ${AGENTS_DIR}: ${err.message}\n`);
    return [];
  }
  const out = [];
  for (const file of entries) {
    if (!file.endsWith(".md")) continue;
    const full = join(AGENTS_DIR, file);
    const src = await readFile(full, "utf8");
    const { frontmatter, body } = parseFrontmatter(src);
    out.push({
      file,
      name: frontmatter.name || basename(file, ".md"),
      description: frontmatter.description || "",
      model: frontmatter.model || "opus",
      category: frontmatter.category || "",
      body,
    });
  }
  return out;
}

// TODO(v0.5.1): implement full .mdc emission with globs + alwaysApply.
async function exportCursor(agents, outDir) {
  await mkdir(outDir, { recursive: true });
  for (const a of agents) {
    const mdc = `---\ndescription: ${a.description}\nalwaysApply: false\n---\n\n${a.body}`;
    await writeFile(join(outDir, `${a.name}.mdc`), mdc, "utf8");
  }
  return agents.length;
}

// TODO(v0.5.1): emit combined AGENTS.md index + per-agent body under .codex/agents/.
async function exportCodex(agents, outDir) {
  await mkdir(outDir, { recursive: true });
  const sections = agents.map(
    (a) =>
      `## ${a.name}\n\n**Model:** ${a.model}  \n**Category:** ${a.category}\n\n${a.description}\n\n${a.body}`
  );
  const index = `# Artibot Agents (Codex export)\n\n${sections.join("\n\n---\n\n")}\n`;
  await writeFile(join(outDir, "AGENTS.md"), index, "utf8");
  return agents.length;
}

// TODO(v0.5.1): richer schema (tools[], permissions) and JSON schema validation.
async function exportOpenCode(agents, outDir) {
  await mkdir(outDir, { recursive: true });
  const payload = agents.map((a) => ({
    name: a.name,
    description: a.description,
    model: a.model,
    category: a.category,
    systemPrompt: a.body,
  }));
  await writeFile(join(outDir, "agents.json"), JSON.stringify(payload, null, 2), "utf8");
  return agents.length;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.tool || !args.out) {
    printHelp();
    process.exit(args.help ? 0 : 1);
  }
  if (!SUPPORTED_TOOLS.has(args.tool)) {
    process.stderr.write(
      `[export] unsupported tool: ${args.tool} (supported: ${[...SUPPORTED_TOOLS].join(", ")})\n`
    );
    process.exit(2);
  }

  const agents = await collectAgents();
  if (agents.length === 0) {
    process.stderr.write(`[export] no agents discovered under ${AGENTS_DIR}\n`);
    process.exit(3);
  }

  let written = 0;
  if (args.tool === "cursor") written = await exportCursor(agents, resolve(args.out));
  else if (args.tool === "codex") written = await exportCodex(agents, resolve(args.out));
  else if (args.tool === "opencode") written = await exportOpenCode(agents, resolve(args.out));

  process.stderr.write(
    `[export] tool=${args.tool} agents=${agents.length} written=${written} out=${resolve(args.out)}\n`
  );
}

main().catch((err) => {
  process.stderr.write(`[export] fatal: ${err.stack || err.message}\n`);
  process.exit(99);
});
