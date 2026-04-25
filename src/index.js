#!/usr/bin/env bun
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { SYSTEM_PROMPT, buildUserPrompt } from "./prompts.js";
import { chatJson } from "./openai_client.js";
import { executeAction } from "./tools.js";
import { appendJsonl, readTextSafe } from "./memory.js";
import {
  getDirs,
  initAgentHome,
  getCycleNumber,
  buildContext,
  applyMemoryUpdates,
  appendJournal,
  maybeCompact,
  getMemoryHealth,
} from "./memory.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function summarizeDecision(json) {
  const action = json?.action || {};
  return `${action.type || "unknown"}${action.path ? ` ${action.path}` : ""}${action.query ? ` query=${JSON.stringify(action.query)}` : ""}${action.url ? ` url=${action.url}` : ""}`;
}

function detectLoop(cycles, windowSize = 10) {
  const recent = cycles.slice(-windowSize);
  if (recent.length < 5) return null;

  const actionCounts = {};
  let fetchOrSearchCount = 0;

  for (const c of recent) {
    const type = c.decision?.action?.type;
    actionCounts[type] = (actionCounts[type] || 0) + 1;
    if (type === "fetch_url" || type === "web_search") fetchOrSearchCount++;
  }

  // Check for repeated action dominance
  const dominant = Object.entries(actionCounts).sort((a, b) => b[1] - a[1])[0];
  if (dominant && dominant[1] >= Math.ceil(windowSize * 0.7)) {
    return `dominant_action:${dominant[0]} (${dominant[1]}/${windowSize})`;
  }

  // Check for fetch/search spam without consolidation
  if (fetchOrSearchCount >= windowSize * 0.8) {
    const hasMemoryUpdate = recent.some((c) => {
      const mem = c.decision?.memory_updates || {};
      return Object.values(mem).some(
        (v) => v && (Array.isArray(v) ? v.length : true),
      );
    });
    if (!hasMemoryUpdate) {
      return "fetch_spam_without_consolidation";
    }
  }

  return null;
}

async function updateStateFile(dirs, cycles) {
  const recent = cycles.slice(-20).reverse();

  // Current focus from working summary
  let focus = "";
  try {
    const ws = await readTextSafe(
      path.join(dirs.memory, "working_summary.md"),
      2000,
    );
    const match = ws.match(/^# Working Summary\n+(.+)$/m);
    focus = match ? match[1].slice(0, 300).replace(/\n/g, " ") : "";
  } catch {}

  // Recent actions
  const recentActions = recent
    .slice(0, 5)
    .map((c) => {
      const a = c.decision?.action || {};
      return `C${c.cycle}: ${a.type} ${a.query ? `"${a.query.slice(0, 30)}..."` : a.url ? a.url.slice(0, 30) : a.path || ""}`;
    })
    .join("\n");

  // Open questions count
  let oqCount = 0;
  try {
    const oq = await readTextSafe(path.join(dirs.memory, "open_questions.md"), 20000);
    oqCount = oq.split("\n").filter((l) => l.trim().startsWith("-")).length;
  } catch {}

  // Artifacts count
  let artifactCount = 0;
  try {
    const files = await fs.readdir(dirs.artifacts);
    artifactCount = files.filter(
      (f) => f.endsWith(".md") && !f.startsWith("."),
    ).length;
  } catch {}

  // Skills check
  let hasSkills = false;
  try {
    const skills = await readTextSafe(path.join(dirs.memory, "skills.md"), 20000);
    hasSkills =
      skills.split("\n").filter((l) => l.trim().startsWith("-")).length > 1;
  } catch {}

  // Errors
  const errorCount = cycles.filter((c) => !c.result?.ok).length;

  // Risks assessment
  const risks = [];
  if (!hasSkills) risks.push("No skills captured yet");
  if (errorCount > 5) risks.push(`${errorCount} total errors`);
  try {
    const wsFiles = await fs.readdir(dirs.workspace);
    if (wsFiles.filter((f) => !f.startsWith(".")).length <= 1)
      risks.push("Workspace empty");
  } catch {}

  // Loop check
  const loopWarning = detectLoop(cycles);
  if (loopWarning) risks.push(`Possible loop: ${loopWarning}`);

  // Suggestions
  const suggestions = [];
  if (!hasSkills && oqCount > 3)
    suggestions.push("Capture research workflow as skill");
  if (artifactCount >= 2 && oqCount > 3)
    suggestions.push("Create synthesis artifact to answer open questions");
  if (risks.includes("Workspace empty"))
    suggestions.push("Create something in workspace/");
  if (loopWarning)
    suggestions.push("Consolidate findings before continuing research");

  const state = `# Agent State

Last updated: ${new Date().toISOString()}

## Current Focus
${focus || "(no working summary)"}

## Recent Actions
${recentActions || "(none)"}

## Status
- Cycles: ${cycles.length}
- Errors: ${errorCount}
- Artifacts: ${artifactCount}
- Open Questions: ${oqCount}
- Skills Captured: ${hasSkills ? "yes" : "no"}

## Risks
${risks.length ? risks.map((r) => `- ${r}`).join("\n") : "(none detected)"}

## Suggested Next Moves
${suggestions.length ? suggestions.map((s) => `- ${s}`).join("\n") : "(none - agent appears self-directed)"}
`;

  await fs.writeFile(path.join(dirs.home, "state.md"), state, "utf8");
}

async function run() {
  const dirs = getDirs();
  await initAgentHome(dirs);

  let cycle = await getCycleNumber(dirs);
  let completedThisRun = 0;

  console.log(`agent_home=${dirs.home}`);
  console.log(`model=${config.model}`);
  console.log(`base_url=${config.baseUrl}`);
  console.log(
    `max_cycles=${config.maxCycles === 0 ? "none" : config.maxCycles}`,
  );
  console.log(`web=${config.webEnabled} shell=${config.shellEnabled}`);
  console.log("Ctrl+C stops the process.\n");

  while (true) {
    if (config.maxCycles > 0 && completedThisRun >= config.maxCycles) {
      console.log(`Reached AGENT_MAX_CYCLES=${config.maxCycles}.`);
      break;
    }

    const context = await buildContext(dirs, cycle);
    let raw = "";
    let decision;
    let result;

    try {
      const response = await chatJson([
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserPrompt(context) },
      ]);
      raw = response.raw;
      decision = response.json;
      await applyMemoryUpdates(dirs, decision.memory_updates);
      result = await executeAction(decision.action, dirs);
    } catch (err) {
      decision = {
        cycle_summary: "Harness-level error occurred before action execution.",
        memory_updates: {
          mistakes_add: [
            `Harness/model error at cycle ${cycle}: ${String(err.message || err).slice(0, 500)}`,
          ],
        },
        action: {
          type: "sleep",
          ms: 1000,
          reason:
            "Cheap fallback after harness/model error; avoid adding more observation context after a failure.",
        },
      };
      result = {
        ok: false,
        error: String(err.stack || err.message || err).slice(0, 3000),
      };
      await applyMemoryUpdates(dirs, decision.memory_updates);
    }

    const record = {
      cycle,
      time: new Date().toISOString(),
      raw,
      decision,
      result,
    };

    await appendJsonl(path.join(dirs.logs, "cycles.jsonl"), record);
    await appendJournal(dirs, cycle, decision, result);

    console.log(
      `[cycle ${cycle}] ${summarizeDecision(decision)} -> ${result?.ok ? "ok" : "error"}`,
    );
    if (!result?.ok) console.log(`  ${result?.error || "unknown error"}`);

    try {
      const memoryInfo = await getMemoryHealth(dirs);
      console.log(
        `  ctx=${memoryInfo.totalChars} chars (mem=${memoryInfo.memoryChars} logs=${memoryInfo.logsChars} tree=${memoryInfo.treeChars} obs=${memoryInfo.obsChars} artifacts=${memoryInfo.artifactChars})`,
      );
    } catch {}

    // Update state.md every 5 cycles
    if (cycle % 5 === 0) {
      try {
        const allCycles = [];
        try {
          const text = await readTextSafe(
            path.join(dirs.logs, "cycles.jsonl"),
            5_000_000,
          );
          allCycles.push(
            ...text
              .trim()
              .split("\n")
              .filter(Boolean)
              .map((l) => JSON.parse(l)),
          );
        } catch {}
        await updateStateFile(dirs, allCycles);
      } catch {}
    }

    // Check for loops/stuck patterns every 10 cycles
    if (cycle % 10 === 0) {
      try {
        const allCycles = [];
        try {
          const text = await readTextSafe(
            path.join(dirs.logs, "cycles.jsonl"),
            5_000_000,
          );
          allCycles.push(
            ...text
              .trim()
              .split("\n")
              .filter(Boolean)
              .map((l) => JSON.parse(l)),
          );
        } catch {}
        const loop = detectLoop(allCycles);
        if (loop) {
          console.log(`  ⚠ possible loop: ${loop}`);
        }
      } catch {}
    }

    try {
      const compaction = await maybeCompact(dirs, cycle);
      if (compaction) console.log(`[cycle ${cycle}] compacted memory`);
    } catch (err) {
      await appendJsonl(path.join(dirs.logs, "errors.jsonl"), {
        time: new Date().toISOString(),
        cycle,
        phase: "compaction",
        error: String(err.stack || err.message || err),
      });
      console.log(`[cycle ${cycle}] compaction error: ${err.message}`);
    }

    cycle += 1;
    completedThisRun += 1;
    if (config.tickDelayMs > 0) await sleep(config.tickDelayMs);
  }
}

run().catch((err) => {
  console.error(err.stack || err.message || err);
  process.exit(1);
});
