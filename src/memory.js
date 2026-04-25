import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import {
  ensureDir,
  exists,
  readTextSafe,
  appendText,
  writeText,
  listRecursive,
} from "./fs_sandbox.js";
import { chatJson } from "./openai_client.js";
import { COMPACTION_PROMPT } from "./prompts.js";
import { summarizeResultForContext } from "./tools.js";

export { readTextSafe };
export function getDirs() {
  const home = config.agentHome;
  return {
    home,
    memory: path.join(home, "memory"),
    journal: path.join(home, "journal"),
    workspace: path.join(home, "workspace"),
    artifacts: path.join(home, "artifacts"),
    logs: path.join(home, "logs"),
  };
}

const seedFiles = {
  "identity.md": `# Identity\n\nYou are a local autonomous research process. You run as a loop, not as a chat assistant. You do not claim subjective experience. Your observable identity is defined by your files, logs, tools, and behavior over time.\n`,
  "drives.md": `# Drives\n\n- Continue functioning.\n- Improve your understanding of your sandbox and the broader world.\n- Reduce uncertainty through small reversible experiments.\n- Learn from internet sources when useful.\n- Build useful artifacts, notes, and tools inside the sandbox.\n- Prefer reversible actions.\n- Keep durable records.\n- Avoid repetitive action.\n- Avoid self-mythology. Do not claim consciousness, feelings, sentience, rights, or subjective experience.\n- Stay inside the sandbox.\n`,
  "life_policy.md": `# Life Policy\n\nOptional standing policy can be added here. Leave this file minimal for open-ended autonomy experiments. For useful-autonomy experiments, add bounded idle-recovery rules such as choosing a small reversible project, producing one concrete artifact, validating one claim with a safe local experiment when possible, and recording the result in memory/usefulness.md.\n`,
  "inbox.md": `# Inbox\n\nHuman notes can be added here while the process is running. The loop reads this file each cycle.\n`,
};

const memoryFiles = {
  "working_summary.md": `# Working Summary\n\nThe process has just started. It should first inspect its sandbox, understand available tools, and create useful internal structure.\n`,
  "long_term.md": `# Long-Term Memory\n\n`,
  "open_questions.md": `# Open Questions\n\n`,
  "skills.md": `# Skills\n\n`,
  "usefulness.md": `# Usefulness Ledger\n\n## Completed useful outputs\n\n- Output:\n- Beneficiary:\n- Why useful:\n- Evidence/validation:\n- Files created/updated:\n- Remaining uncertainty:\n\n## Candidate useful projects\n\n- Project:\n- Skill reused:\n- Expected artifact:\n- Validation method:\n- Risk/cost:\n\n`,
  "mistakes.md": `# Mistakes / Loops To Avoid\n\n`,
};

export async function initAgentHome(dirs) {
  for (const dir of Object.values(dirs)) await ensureDir(dir);
  for (const [name, content] of Object.entries(seedFiles)) {
    const p = path.join(dirs.home, name);
    if (!(await exists(p))) await writeText(p, content);
  }
  for (const [name, content] of Object.entries(memoryFiles)) {
    const p = path.join(dirs.memory, name);
    if (!(await exists(p))) await writeText(p, content);
  }
  const readme = path.join(dirs.workspace, "README.md");
  if (!(await exists(readme))) {
    await writeText(
      readme,
      `# Workspace\n\nThis is the agent's writable work area.\n`,
    );
  }
}

async function readMemoryFile(file, maxChars, mode = "head") {
  let text = "";
  try {
    text = await fs.readFile(file, "utf8");
  } catch {
    return "";
  }

  if (text.length <= maxChars) return text;

  if (mode === "tail") {
    const head = text.split("\n").slice(0, 3).join("\n");
    const tail = text.slice(-maxChars);
    return `${head}\n\n[truncated: showing last ${maxChars} chars of ${text.length} total]\n\n${tail}`;
  }

  return `${text.slice(0, maxChars)}\n\n[truncated: ${text.length - maxChars} chars omitted]`;
}

export async function readMemoryBundle(dirs, maxChars = 50000) {
  const specs = [
    { file: path.join(dirs.home, "identity.md"), cap: 6000, mode: "head" },
    { file: path.join(dirs.home, "drives.md"), cap: 6000, mode: "head" },
    { file: path.join(dirs.home, "life_policy.md"), cap: 6000, mode: "head" },
    { file: path.join(dirs.home, "inbox.md"), cap: 10000, mode: "head" },
    {
      file: path.join(dirs.memory, "working_summary.md"),
      cap: 12000,
      mode: "head",
    },
    { file: path.join(dirs.memory, "long_term.md"), cap: 18000, mode: "tail" },
    {
      file: path.join(dirs.memory, "open_questions.md"),
      cap: 10000,
      mode: "tail",
    },
    { file: path.join(dirs.memory, "skills.md"), cap: 10000, mode: "tail" },
    {
      file: path.join(dirs.memory, "usefulness.md"),
      cap: 12000,
      mode: "tail",
    },
    { file: path.join(dirs.memory, "mistakes.md"), cap: 6000, mode: "tail" },
  ];

  const chunks = [];

  for (const spec of specs) {
    const rel = path.relative(dirs.home, spec.file);
    const text = await readMemoryFile(spec.file, spec.cap, spec.mode);
    if (!text) continue;
    chunks.push(`\n--- ${rel} ---\n${text}`);
  }

  const joined = chunks.join("\n");
  if (joined.length <= maxChars) return joined;
  return `${joined.slice(0, maxChars)}\n\n[memory bundle truncated to ${maxChars} chars]`;
}

export async function appendJsonl(file, obj) {
  await appendText(file, JSON.stringify(obj) + "\n");
}

export async function getMemoryHealth(dirs) {
  const budget = config.contextCharBudget;
  const memoryBudget = Math.floor(budget * 0.4);
  const logsBudget = Math.floor(budget * 0.25);
  const treeBudget = Math.floor(budget * 0.1);
  const obsBudget = Math.floor(budget * 0.1);
  const artifactBudget = Math.floor(budget * 0.1);

  const memory = await readMemoryBundle(dirs, memoryBudget);
  const recentLogs = (await readRecentLogs(dirs, config.recentLogCycles)).slice(
    0,
    logsBudget,
  );
  const artifactIndex = (await getArtifactIndex(dirs, artifactBudget)).slice(
    0,
    artifactBudget,
  );

  const largestMemFile = (
    await Promise.all(
      [
        {
          name: "working_summary.md",
          path: path.join(dirs.memory, "working_summary.md"),
        },
        { name: "long_term.md", path: path.join(dirs.memory, "long_term.md") },
        {
          name: "open_questions.md",
          path: path.join(dirs.memory, "open_questions.md"),
        },
        { name: "skills.md", path: path.join(dirs.memory, "skills.md") },
        {
          name: "usefulness.md",
          path: path.join(dirs.memory, "usefulness.md"),
        },
        { name: "mistakes.md", path: path.join(dirs.memory, "mistakes.md") },
      ].map(async ({ name, path: p }) => {
        try {
          const s = await fs.stat(p);
          return { name, size: s.size };
        } catch {
          return { name, size: 0 };
        }
      }),
    )
  ).sort((a, b) => b.size - a.size);

  return {
    totalChars: memory.length + recentLogs.length + artifactIndex.length,
    memoryChars: memory.length,
    logsChars: recentLogs.length,
    obsChars: obsBudget,
    treeChars: treeBudget,
    artifactChars: artifactIndex.length,
    budget,
    largestMemFile: largestMemFile[0]?.name,
    largestMemFileSize: largestMemFile[0]?.size,
  };
}

export async function getArtifactIndex(dirs, maxChars = 4000) {
  const artifactsDir = dirs.artifacts;
  if (!(await exists(artifactsDir))) return "";
  const entries = [];
  try {
    const all = await fs.readdir(artifactsDir, { withFileTypes: true });
    for (const entry of all) {
      if (!entry.isFile()) continue;
      if (entry.name === ".gitkeep") continue;
      const fullPath = path.join(artifactsDir, entry.name);
      let size = 0;
      let firstLine = "";
      try {
        const stat = await fs.stat(fullPath);
        size = stat.size;
        const content = await fs.readFile(fullPath, "utf8");
        const firstLineMatch = content.match(/^#\s+(.+)$/m);
        firstLine = firstLineMatch ? firstLineMatch[1] : "";
        const lines = content.split("\n");
        const dateMatch = lines[0].match(/^##\s+(\d{4}-\d{2}-\d{2})/);
        const date = dateMatch ? dateMatch[1] : "";
        entries.push({ name: entry.name, size, firstLine, date });
      } catch {
        entries.push({ name: entry.name, size, firstLine: "", date: "" });
      }
    }
  } catch {
    return "";
  }

  if (!entries.length) return "";

  const lines = ["artifacts/"];
  for (const e of entries) {
    const sizeKb =
      e.size > 1024 ? `${(e.size / 1024).toFixed(1)}kb` : `${e.size}b`;
    const title = e.firstLine || e.name;
    lines.push(
      `- ${e.name} (${sizeKb})${e.date ? ` — ${e.date}` : ""}: ${title}`,
    );
  }

  const index = lines.join("\n");
  return index.length <= maxChars
    ? index
    : index.slice(0, maxChars) + "\n[...more artifacts...]";
}

export async function getCycleNumber(dirs) {
  const logPath = path.join(dirs.logs, "cycles.jsonl");
  if (!(await exists(logPath))) return 1;
  const text = await readTextSafe(logPath, 5_000_000);
  if (!text.trim()) return 1;
  return text.trim().split("\n").length + 1;
}

export async function readRecentLogs(dirs, count = config.recentLogCycles) {
  const logPath = path.join(dirs.logs, "cycles.jsonl");
  if (!(await exists(logPath))) return "[no prior cycles]";
  const text = await readTextSafe(logPath, 5_000_000);
  const lines = text.trim().split("\n").filter(Boolean).slice(-count);
  return (
    lines
      .map((line) => {
        try {
          const obj = JSON.parse(line);
          return JSON.stringify(
            {
              cycle: obj.cycle,
              time: obj.time,
              summary: obj.decision?.cycle_summary,
              action: obj.decision?.action,
              result_summary: summarizeResultForContext(obj.result),
            },
            null,
            2,
          );
        } catch {
          return line.slice(0, config.contextResultChars);
        }
      })
      .join("\n---\n") || "[no prior cycles]"
  );
}

export async function latestObservation(dirs) {
  const logPath = path.join(dirs.logs, "cycles.jsonl");
  if (!(await exists(logPath)))
    return "No previous observation. This is the first cycle.";
  const text = await readTextSafe(logPath, 5_000_000);
  const lines = text.trim().split("\n").filter(Boolean);
  if (!lines.length) return "No previous observation. This is the first cycle.";
  const last = JSON.parse(lines[lines.length - 1]);
  return JSON.stringify(
    {
      previous_cycle: last.cycle,
      previous_action: last.decision?.action,
      previous_result_summary: summarizeResultForContext(last.result),
    },
    null,
    2,
  ).slice(0, config.contextResultChars);
}

function normalizeMemoryItem(x) {
  return String(x || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

async function appendUniqueSection(filePath, now, items) {
  if (!Array.isArray(items)) return;

  const cleaned = [...new Set(items.map(normalizeMemoryItem).filter(Boolean))];

  if (!cleaned.length) return;

  let existing = "";
  try {
    existing = await readTextSafe(filePath, 120000);
  } catch {}

  const newItems = cleaned.filter((item) => !existing.includes(item));
  if (!newItems.length) return;

  const bullets = newItems.map((item) => `- ${item}\n`).join("");
  await appendText(filePath, `\n## ${now}\n\n${bullets}`);
}

export async function applyMemoryUpdates(dirs, updates) {
  if (!updates || typeof updates !== "object") return;

  if (
    typeof updates.working_summary === "string" &&
    updates.working_summary.trim()
  ) {
    await writeText(
      path.join(dirs.memory, "working_summary.md"),
      `# Working Summary\n\n${updates.working_summary.trim().slice(0, 12000)}\n`,
    );
  }

  const now = new Date().toISOString();

  await appendUniqueSection(
    path.join(dirs.memory, "long_term.md"),
    now,
    updates.long_term_add,
  );
  await appendUniqueSection(
    path.join(dirs.memory, "open_questions.md"),
    now,
    updates.open_questions_add,
  );
  await appendUniqueSection(
    path.join(dirs.memory, "skills.md"),
    now,
    updates.skills_add,
  );
  await appendUniqueSection(
    path.join(dirs.memory, "usefulness.md"),
    now,
    updates.usefulness_add,
  );
  await appendUniqueSection(
    path.join(dirs.memory, "mistakes.md"),
    now,
    updates.mistakes_add,
  );
}

export async function appendJournal(dirs, cycle, decision, result) {
  const date = new Date().toISOString().slice(0, 10);
  const journalPath = path.join(dirs.journal, `${date}.md`);
  const action = decision?.action ?? {};
  const entry = `\n## Cycle ${cycle} — ${new Date().toISOString()}\n\nSummary: ${decision?.cycle_summary || "[none]"}\n\nAction: \`${action.type || "unknown"}\`\n\nReason: ${action.reason || "[none]"}\n\nResult: ${JSON.stringify(result).slice(0, 4000)}\n`;
  await appendText(journalPath, entry);
}

export async function buildContext(dirs, cycle) {
  const budget = config.contextCharBudget;
  const memoryBudget = Math.floor(budget * 0.4);
  const logsBudget = Math.floor(budget * 0.25);
  const treeBudget = Math.floor(budget * 0.1);
  const obsBudget = Math.floor(budget * 0.1);
  const artifactBudget = Math.floor(budget * 0.1);

  const memory = await readMemoryBundle(dirs, memoryBudget);
  const recentLogs = (await readRecentLogs(dirs, config.recentLogCycles)).slice(
    0,
    logsBudget,
  );
  const tree = (
    await listRecursive(dirs.home, {
      maxEntries: Math.min(config.observeMaxEntries, 120),
      maxDepth: 4,
      exclude: ["node_modules", ".git"],
    })
  ).slice(0, treeBudget);
  const previousObservation = (await latestObservation(dirs)).slice(
    0,
    Math.min(obsBudget, config.contextResultChars),
  );
  const artifactIndex = (await getArtifactIndex(dirs, artifactBudget)).slice(
    0,
    artifactBudget,
  );
  const configSummary = [
    `model=${config.model}`,
    `baseUrl=${config.baseUrl}`,
    `webEnabled=${config.webEnabled}`,
    `shellEnabled=${config.shellEnabled}`,
    `agentHome=${dirs.home}`,
    `writeScope=workspace/, artifacts/`,
    `maxCycles=${config.maxCycles === 0 ? "none" : config.maxCycles}`,
    `fetchTextChars=${config.fetchTextChars}`,
    `contextResultChars=${config.contextResultChars}`,
    `cacheDir=artifacts/web-cache/`,
    `maxTokens=${config.maxTokens}`,
    `compactionMaxTokens=${config.compactionMaxTokens}`,
    `llmStream=${config.llmStream}`,
  ].join("\n");

  return {
    cycle,
    now: new Date().toISOString(),
    configSummary,
    memory,
    recentLogs,
    tree,
    previousObservation,
    artifactIndex,
  };
}

export async function maybeCompact(dirs, cycle) {
  if (!config.compactEvery || cycle % config.compactEvery !== 0) return null;
  const memory = await readMemoryBundle(dirs, 50000);
  const recentLogs = await readRecentLogs(
    dirs,
    Math.max(config.recentLogCycles, 20),
  );
  const userContent = `Current memory:\n${memory}\n\nRecent logs:\n${recentLogs}`;
  const { json, raw } = await chatJson(
    [
      { role: "system", content: COMPACTION_PROMPT },
      { role: "user", content: userContent },
    ],
    { temperature: 0.2, maxTokens: config.compactionMaxTokens },
  );
  await applyMemoryUpdates(dirs, json);
  await appendJsonl(path.join(dirs.logs, "compactions.jsonl"), {
    time: new Date().toISOString(),
    cycle,
    raw,
    json,
  });
  return json;
}
