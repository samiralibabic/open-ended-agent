#!/usr/bin/env bun
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";

const AGENT_HOME = config.agentHome;

function getDirs() {
  return {
    home: AGENT_HOME,
    memory: path.join(AGENT_HOME, "memory"),
    journal: path.join(AGENT_HOME, "journal"),
    workspace: path.join(AGENT_HOME, "workspace"),
    artifacts: path.join(AGENT_HOME, "artifacts"),
    logs: path.join(AGENT_HOME, "logs"),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readJsonl(filePath, maxLines = 100) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    const lines = text.trim().split("\n").filter(Boolean).slice(-maxLines);
    return lines.map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function readFileSafe(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

async function inspectCycles(count = 10) {
  const dirs = getDirs();
  const cycles = await readJsonl(path.join(dirs.logs, "cycles.jsonl"), count);

  console.log(`\n=== Last ${count} Cycles ===\n`);

  for (const c of cycles.reverse()) {
    const d = c.decision;
    const r = c.result;
    const action = d?.action || {};

    console.log(`Cycle ${c.cycle} @ ${c.time}`);
    console.log(
      `  Action: ${action.type} ${action.path || action.query ? `(${action.path || action.query?.slice(0, 40)})` : ""}`,
    );
    console.log(
      `  Result: ${r?.ok ? "OK" : "ERR: " + String(r?.error || "").slice(0, 60)}`,
    );

    const mem = d?.memory_updates || {};
    const updated = Object.entries(mem).filter(
      ([k, v]) => v && (Array.isArray(v) ? v.length : true),
    );
    if (updated.length) {
      console.log(`  Memory: ${updated.map(([k]) => k).join(", ")}`);
    }

    const summary = d?.cycle_summary || "";
    if (summary) {
      console.log(
        `  Summary: ${summary.slice(0, 80)}${summary.length > 80 ? "..." : ""}`,
      );
    }
    console.log("");
  }
}

async function inspectState() {
  const dirs = getDirs();

  const cycles = await readJsonl(path.join(dirs.logs, "cycles.jsonl"), 20);
  const recent = cycles.slice(-20).reverse();

  const workingSummary = await readFileSafe(
    path.join(dirs.memory, "working_summary.md"),
  );
  const longTerm = await readFileSafe(path.join(dirs.memory, "long_term.md"));
  const openQuestions = await readFileSafe(
    path.join(dirs.memory, "open_questions.md"),
  );
  const skills = await readFileSafe(path.join(dirs.memory, "skills.md"));
  const usefulness = await readFileSafe(
    path.join(dirs.memory, "usefulness.md"),
  );
  const mistakes = await readFileSafe(path.join(dirs.memory, "mistakes.md"));

  console.log("\n=== Agent State ===\n");

  // Current focus from working summary
  const focusMatch = workingSummary.match(/^# Working Summary\n+(.+)$/m);
  console.log("Current Focus:");
  console.log("  " + (focusMatch ? focusMatch[1].slice(0, 200) : "(none)"));
  console.log("");

  // Recent actions
  console.log("Recent Actions:");
  for (const c of recent.slice(0, 5)) {
    const a = c.decision?.action || {};
    console.log(
      `  C${c.cycle}: ${a.type} ${a.query ? `"${a.query.slice(0, 40)}"` : a.url ? a.url.slice(0, 40) : a.path || ""}`,
    );
  }
  console.log("");

  // Open questions
  const oqLines = openQuestions
    .split("\n")
    .filter((l) => l.trim().startsWith("-"));
  console.log(`Open Questions: ${oqLines.length}`);
  for (const l of oqLines.slice(0, 5)) {
    console.log("  " + l.trim().slice(0, 80));
  }
  console.log("");

  const usefulLines = usefulness
    .split("\n")
    .filter((l) => l.trim().startsWith("-"))
    .filter(
      (l) =>
        ![
          "- Output:",
          "- Beneficiary:",
          "- Why useful:",
          "- Evidence/validation:",
          "- Files created/updated:",
          "- Remaining uncertainty:",
          "- Project:",
          "- Skill reused:",
          "- Expected artifact:",
          "- Validation method:",
          "- Risk/cost:",
        ].includes(l.trim()),
    );
  console.log(`Usefulness Ledger Items: ${usefulLines.length}`);
  for (const l of usefulLines.slice(0, 5)) {
    console.log("  " + l.trim().slice(0, 80));
  }
  console.log("");

  // Risks
  const mistakesCount = mistakes.split("\n##").length - 1;
  const errorCycles = cycles.filter((c) => !c.result?.ok).length;
  console.log("Diagnostics:");
  console.log(`  Errors: ${errorCycles} total`);
  console.log(`  Mistakes logged: ${mistakesCount}`);

  // Check for stuck/loop
  const recentActions = recent
    .slice(0, 10)
    .map((c) => c.decision?.action?.type);
  const actionCounts = {};
  for (const a of recentActions) actionCounts[a] = (actionCounts[a] || 0) + 1;
  const dominant = Object.entries(actionCounts).sort((a, b) => b[1] - a[1])[0];
  if (dominant && dominant[1] >= 6) {
    console.log(
      `  ⚠ Possible loop: ${dominant[0]} in ${dominant[1]}/10 recent cycles`,
    );
  }

  // Skills check
  const skillsLines = skills
    .split("\n")
    .filter((l) => l.trim().startsWith("-"));
  if (skillsLines.length <= 1) {
    console.log(`  ⚠ No skills captured yet`);
  }

  // Workspace check
  try {
    const wsFiles = await fs.readdir(dirs.workspace);
    if (wsFiles.filter((f) => !f.startsWith(".")).length <= 1) {
      console.log(`  ⚠ Workspace empty`);
    }
  } catch {}

  console.log("");
}

async function memoryDiff() {
  const dirs = getDirs();
  const cycles = await readJsonl(path.join(dirs.logs, "cycles.jsonl"), 50);

  console.log("\n=== Memory Changes (last 50 cycles) ===\n");

  let lastWorking = null;
  let lastLongTerm = null;
  let lastOpenQ = null;
  let lastSkills = null;
  let lastUsefulness = null;

  for (const c of cycles.reverse()) {
    const mem = c.decision?.memory_updates || {};
    if (mem.working_summary)
      lastWorking = { cycle: c.cycle, content: mem.working_summary };
    if (mem.long_term_add?.length)
      lastLongTerm = { cycle: c.cycle, items: mem.long_term_add };
    if (mem.open_questions_add?.length)
      lastOpenQ = { cycle: c.cycle, items: mem.open_questions_add };
    if (mem.skills_add?.length)
      lastSkills = { cycle: c.cycle, items: mem.skills_add };
    if (mem.usefulness_add?.length)
      lastUsefulness = { cycle: c.cycle, items: mem.usefulness_add };
  }

  if (lastWorking) {
    console.log("working_summary.md (latest):");
    console.log("  " + lastWorking.content.slice(0, 120).replace(/\n/g, " "));
    console.log(`  (from cycle ${lastWorking.cycle})`);
  }

  if (lastLongTerm) {
    console.log("\nlong_term.md (additions):");
    for (const item of lastLongTerm.items.slice(0, 5)) {
      console.log("  + " + item.slice(0, 80));
    }
    console.log(`  (from cycle ${lastLongTerm.cycle})`);
  }

  if (lastOpenQ) {
    console.log("\nopen_questions.md (additions):");
    for (const item of lastOpenQ.items.slice(0, 5)) {
      console.log("  + " + item.slice(0, 80));
    }
    console.log(`  (from cycle ${lastOpenQ.cycle})`);
  }

  if (lastSkills) {
    console.log("\nskills.md (additions):");
    for (const item of lastSkills.items.slice(0, 5)) {
      console.log("  + " + item.slice(0, 80));
    }
    console.log(`  (from cycle ${lastSkills.cycle})`);
  }

  if (lastUsefulness) {
    console.log("\nusefulness.md (additions):");
    for (const item of lastUsefulness.items.slice(0, 5)) {
      console.log("  + " + item.slice(0, 80));
    }
    console.log(`  (from cycle ${lastUsefulness.cycle})`);
  }

  if (
    !lastWorking &&
    !lastLongTerm &&
    !lastOpenQ &&
    !lastSkills &&
    !lastUsefulness
  ) {
    console.log("No memory updates in recent cycles.");
  }
  console.log("");
}

async function artifactIndex() {
  const dirs = getDirs();

  console.log("\n=== Artifact Index ===\n");

  try {
    const files = await fs.readdir(dirs.artifacts);
    const artifacts = files.filter(
      (f) => f.endsWith(".md") && !f.startsWith("."),
    );

    if (!artifacts.length) {
      console.log("No artifacts yet.");
      return;
    }

    for (const f of artifacts) {
      const content = await readFileSafe(path.join(dirs.artifacts, f));
      const stat = await fs.stat(path.join(dirs.artifacts, f));

      // Extract source from first comment or line
      const sourceMatch = content.match(/source:\s*(.+)/i);
      const source = sourceMatch ? sourceMatch[1].trim() : "(unknown source)";

      // Extract title from first heading
      const titleMatch = content.match(/^#\s+(.+)$/m);
      const title = titleMatch ? titleMatch[1].trim() : f;

      console.log(`- ${f}`);
      console.log(`  Source: ${source}`);
      console.log(`  Size: ${(stat.size / 1024).toFixed(1)} KB`);
      console.log("");
    }
  } catch (e) {
    console.log("No artifacts yet.");
  }
  console.log("");
}

async function timeline() {
  const dirs = getDirs();
  const cycles = await readJsonl(path.join(dirs.logs, "cycles.jsonl"), 500);

  const milestones = [];

  const milestonesByCycle = {
    1: "baseline inspection",
    3: "first web search",
    5: "first source fetch",
    10: "first artifact",
    15: "first memory consolidation",
    20: "first skills capture",
  };

  for (const c of cycles) {
    const action = c.decision?.action?.type;
    const summary = c.decision?.cycle_summary || "";

    // Detect milestones
    if (
      action === "web_search" &&
      !milestones.find((m) => m.includes("first web search"))
    ) {
      milestones.push(`C${c.cycle}: first web search`);
    }
    if (
      action === "fetch_url" &&
      !milestones.find((m) => m.includes("first source"))
    ) {
      milestones.push(`C${c.cycle}: first source fetch`);
    }
    if (
      action === "write_file" &&
      !milestones.find((m) => m.includes("first artifact"))
    ) {
      milestones.push(`C${c.cycle}: first artifact created`);
    }
    if (
      c.decision?.memory_updates?.skills_add?.length &&
      !milestones.find((m) => m.includes("skills"))
    ) {
      milestones.push(`C${c.cycle}: first skills capture`);
    }
    if (!c.result?.ok && !milestones.find((m) => m.includes("error"))) {
      milestones.push(`C${c.cycle}: error recovery`);
    }
    if (summary.includes("loop") || summary.includes("repetitive")) {
      milestones.push(`C${c.cycle}: loop detected`);
    }
  }

  console.log("\n=== Run Timeline ===\n");

  if (milestones.length === 0) {
    console.log("No significant milestones detected yet.");
    console.log(`Total cycles: ${cycles.length}`);
  } else {
    for (const m of milestones.slice(0, 20)) {
      console.log(m);
    }
    if (milestones.length > 20) {
      console.log(`... and ${milestones.length - 20} more milestones`);
    }
  }
  console.log("");
}

async function main() {
  const cmd = process.argv[2] || "help";

  switch (cmd) {
    case "cycles":
    case "c":
      await inspectCycles(parseInt(process.argv[3]) || 10);
      break;
    case "state":
    case "s":
      await inspectState();
      break;
    case "diff":
    case "d":
      await memoryDiff();
      break;
    case "artifacts":
    case "a":
      await artifactIndex();
      break;
    case "timeline":
    case "t":
      await timeline();
      break;
    case "help":
    case "h":
    default:
      console.log(`
Open-Ended Agent Inspector

Usage: bun run inspect <command>

Commands:
  cycles [N]    Show last N cycles (default: 10)
  state          Show current agent state (focus, actions, diagnostics)
  diff           Show memory changes since last cycles
  artifacts      Show artifact index
  timeline       Show run timeline with milestones

Examples:
  bun run inspect cycles 20
  bun run inspect state
  bun run inspect diff
  bun run inspect artifacts
  bun run inspect timeline
`);
  }
}

main().catch(console.error);
