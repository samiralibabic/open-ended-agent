#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { URL } from 'node:url';

const APP_VERSION = '0.1.0-preview';
const ROOT = process.cwd();
const HOME = process.env.AGENT_HOME
  ? path.resolve(process.env.AGENT_HOME)
  : path.join(ROOT, 'agent-home');
const CONFIG_PATH = path.join(HOME, 'config.json');
const PORT = Number(process.env.PORT || 5179);
const HOST_BIND = process.env.HOST || '127.0.0.1';
const MAX_EVENTS = 1500;
const OBSERVER_MODE = true;
const OBSERVE_EXISTING_CYCLES = Number(process.env.PREVIEW_OBSERVE_EXISTING_CYCLES || 20);

const defaultConfig = {
  model: process.env.MODEL || 'qwen3.5:8b',
  agentMaxCycles: Number(process.env.AGENT_MAX_CYCLES || 0)
};

let config = { ...defaultConfig };
let cycleCount = 0;
let eventSeq = 0;
let observedCycleLines = 0;
const events = [];

function nowIso() {
  return new Date().toISOString();
}

function addEvent(type, title, details = {}) {
  const event = { id: ++eventSeq, ts: nowIso(), type, title, details };
  events.push(event);
  while (events.length > MAX_EVENTS) events.shift();
  // Keep terminal output useful for users who launched from shell.
  const line = `[${event.ts}] ${type}: ${title}`;
  console.log(line);
  return event;
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

async function readText(filePath, fallback = '') {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return fallback;
  }
}

async function writeText(filePath, content) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, content, 'utf8');
}

function sanitizeRelativePath(rel) {
  if (!rel || typeof rel !== 'string') throw new Error('Missing path');
  const clean = rel.replaceAll('\\\\', '/').replace(/^\/+/, '');
  if (clean.includes('\0')) throw new Error('Invalid path');
  const resolved = path.resolve(HOME, clean);
  if (!resolved.startsWith(HOME + path.sep) && resolved !== HOME) {
    throw new Error('Path escapes agent home');
  }
  return { clean, resolved };
}

async function loadConfig() {
  await ensureAgentHome();
  const raw = await readText(CONFIG_PATH, '');
  if (raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      config = {
        ...defaultConfig,
        ...parsed,
        agentMaxCycles: Number(process.env.AGENT_MAX_CYCLES || parsed.agentMaxCycles || defaultConfig.agentMaxCycles)
      };
    } catch (error) {
      addEvent('config.error', 'Could not parse config.json; using defaults', { error: String(error.message || error) });
    }
  } else {
    await saveConfig(config);
  }
}

async function saveConfig(nextConfig) {
  config = {
    ...defaultConfig,
    ...nextConfig,
    agentMaxCycles: Number(nextConfig.agentMaxCycles ?? defaultConfig.agentMaxCycles)
  };
  await writeText(CONFIG_PATH, JSON.stringify(config, null, 2));
  return config;
}

async function ensureAgentHome() {
  const dirs = [
    HOME,
    path.join(HOME, 'memory'),
    path.join(HOME, 'journal'),
    path.join(HOME, 'workspace'),
    path.join(HOME, 'artifacts'),
    path.join(HOME, 'artifacts', 'web-cache'),
    path.join(HOME, 'logs')
  ];
  for (const dir of dirs) await ensureDir(dir);

  const files = new Map([
    ['identity.md', '# Identity\n\nYou are a persistent local agent running inside a private user-controlled workspace. You act through small reversible steps and keep inspectable traces.\n'],
    ['agent.md', '# Agent Instructions\n\n## Standing drives\n\n- Preserve operational continuity.\n- Improve understanding of the sandbox and broader world.\n- Reduce uncertainty through small reversible experiments.\n- Learn from internet sources when useful.\n- Build useful artifacts, notes, tools, scripts, datasets, guides, or test results.\n- Prefer safe, reversible actions.\n- Avoid destructive actions.\n\n## Current goals\n\nAdd temporary goals, requests, or steering notes here.\n\n## Useful-autonomy policy\n\nWhen idle for several cycles, choose one small reversible project.\n\nThe project should:\n\n- reuse at least one captured skill\n- produce one concrete artifact, script, dataset, guide, or test result\n- validate at least one claim with a safe local experiment when possible\n- keep disk/network usage small\n- record usefulness through `memory_updates.usefulness_add`\n- close with a short completion note\n\nWhen a project has a working primary output, do not spend many cycles on secondary uncertainty.\n\nAfter 3 failed attempts to validate a secondary feature:\n\n- stop probing that feature\n- record the failed attempts and uncertainty\n- preserve the working primary output\n- write or update a completion note\n- choose either a new small project or sleep\n'],
    ['memory/working_summary.md', '# Working summary\n\nNo run history yet.\n'],
    ['memory/long_term.md', '# Long-term memory\n\n'],
    ['memory/open_questions.md', '# Open questions\n\n'],
    ['memory/skills.md', '# Skills\n\n'],
    ['memory/usefulness.md', '# Usefulness Ledger\n\n## Completed useful outputs\n\n- Output:\n- Beneficiary:\n- Why useful:\n- Evidence/validation:\n- Files created/updated:\n- Remaining uncertainty:\n\n## Candidate useful projects\n\n- Project:\n- Skill reused:\n- Expected artifact:\n- Validation method:\n- Risk/cost:\n\n'],
    ['memory/mistakes.md', '# Mistakes and loops to avoid\n\n'],
    ['logs/cycles.jsonl', ''],
    ['logs/errors.jsonl', ''],
    ['logs/compactions.jsonl', '']
  ]);

  for (const [rel, content] of files) {
    const p = path.join(HOME, rel);
    if (!(await exists(p))) await writeText(p, content);
  }
}

async function listTree(rel = '.', maxEntries = 120) {
  const { resolved } = sanitizeRelativePath(rel);
  const out = [];
  async function walk(dir, prefix = '') {
    if (out.length >= maxEntries) return;
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (out.length >= maxEntries) break;
      if (entry.name === 'config.json') continue;
      if (prefix === '' && ['drives.md', 'life_policy.md', 'inbox.md', 'snapshots'].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const childRel = path.relative(HOME, full).replaceAll(path.sep, '/');
      out.push({ path: childRel, type: entry.isDirectory() ? 'dir' : 'file' });
      if (entry.isDirectory() && prefix.length < 120) await walk(full, `${prefix}${entry.name}/`);
    }
  }
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat) return [];
  if (stat.isDirectory()) await walk(resolved);
  else out.push({ path: path.relative(HOME, resolved).replaceAll(path.sep, '/'), type: 'file' });
  return out;
}

function normalizeCycleRecord(record) {
  const action = record.action || record.decision?.action || { type: 'unknown' };
  const observation = record.observation || record.result || {};
  const cycle = record.cycle || 0;
  const ts = record.ts || record.time || nowIso();
  const summary = record.cycle_summary || record.decision?.cycle_summary || '';
  const ok = observation.ok !== false;
  return { cycle, ts, summary, action, observation, ok };
}

function actionTitle(action) {
  const detail = action.query || action.url || action.path || action.command || action.reason || '';
  return `${action.type || 'unknown'}${detail ? `: ${String(detail).slice(0, 120)}` : ''}`;
}

async function observeCycleLog() {
  if (!OBSERVER_MODE) return;
  const logPath = path.join(HOME, 'logs', 'cycles.jsonl');
  const raw = await readText(logPath, '');
  const lines = raw.trim().split('\n').filter(Boolean);

  if (observedCycleLines === 0 && lines.length > OBSERVE_EXISTING_CYCLES) {
    observedCycleLines = lines.length - OBSERVE_EXISTING_CYCLES;
  }

  if (lines.length < observedCycleLines) observedCycleLines = 0;
  const nextLines = lines.slice(observedCycleLines);
  observedCycleLines = lines.length;
  if (!nextLines.length) return;

  for (const line of nextLines) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      addEvent('cycle.unparsed', 'Could not parse cycle log line', { line: line.slice(0, 500) });
      continue;
    }
    const c = normalizeCycleRecord(parsed);
    cycleCount = Math.max(cycleCount, c.cycle || 0);
    addEvent(c.ok ? 'harness.cycle' : 'harness.cycle.error', `Cycle ${c.cycle}: ${actionTitle(c.action)}`, {
      summary: c.summary,
      action: c.action,
      result: summarizeObservation(c.observation)
    });
  }
}

function summarizeObservation(observation) {
  const copy = { ...observation };
  if (copy.text && copy.text.length > 500) copy.text = `${copy.text.slice(0, 500)}\n\n[truncated]`;
  if (copy.preview && copy.preview.length > 500) copy.preview = `${copy.preview.slice(0, 500)}\n\n[truncated]`;
  if (Array.isArray(copy.tree)) copy.tree = copy.tree.slice(0, 20);
  return copy;
}

async function isObservedHarnessRunning() {
  return await new Promise((resolve) => {
    const child = spawn('pgrep', ['-f', 'node src/index.js|bun run src/index.js']);
    child.on('close', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

async function getObservedHarnessModel() {
  return await new Promise((resolve) => {
    let out = '';
    const child = spawn('pgrep', ['-af', 'node src/index.js|bun run src/index.js']);
    child.stdout.on('data', (chunk) => { out += chunk.toString('utf8'); });
    child.on('close', () => {
      const match = out.match(/(?:^|\s)MODEL=([^\s]+)/);
      resolve(match ? match[1] : '');
    });
    child.on('error', () => resolve(''));
  });
}

async function readCycleRecords(limit = 80) {
  const raw = await readText(path.join(HOME, 'logs', 'cycles.jsonl'), '');
  const lines = raw.trim().split('\n').filter(Boolean);
  const records = [];
  for (const line of lines.slice(-limit)) {
    try {
      records.push(normalizeCycleRecord(JSON.parse(line)));
    } catch {}
  }
  return { total: lines.length, records };
}

function firstBodyLine(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))[0] || '';
}

function compactLedgerItems(text) {
  const template = new Set([
    '- Output:',
    '- Beneficiary:',
    '- Why useful:',
    '- Evidence/validation:',
    '- Files created/updated:',
    '- Remaining uncertainty:',
    '- Project:',
    '- Skill reused:',
    '- Expected artifact:',
    '- Validation method:',
    '- Risk/cost:'
  ]);
  return String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('-') && !template.has(line))
    .slice(-8);
}

async function buildFriendlySummary(memory, cycleTotal, recentCycles, observedRunning, observedModel) {
  const maxCycles = Number(config.agentMaxCycles || 0);
  const lastCycle = recentCycles[recentCycles.length - 1] || null;
  const artifacts = (await listTree('artifacts', 120)).filter((item) => item.type === 'file' && !item.path.includes('/web-cache/'));
  const workspaceFiles = (await listTree('workspace', 80)).filter((item) => item.type === 'file' && item.path !== 'workspace/README.md');
  const usefulItems = compactLedgerItems(memory.usefulness);

  let statusLabel = observedRunning ? 'Experiment running' : 'Experiment stopped';
  let statusDescription = observedRunning
    ? 'The agent is running in the sandbox. New cycles will appear here as they finish.'
    : 'No active harness process was detected for this agent home.';
  if (!cycleTotal) statusDescription = observedRunning ? 'Waiting for the first cycle to finish.' : 'No cycles have been recorded yet.';

  return {
    statusLabel,
    statusDescription,
    progressLabel: maxCycles > 0 ? `Cycle ${cycleTotal} of ${maxCycles}` : `Cycle ${cycleTotal}`,
    modelLabel: observedModel || config.model || 'Unknown model',
    currentFocus: firstBodyLine(memory.working_summary) || 'Waiting for the agent to establish a focus.',
    lastCycle,
    recentCycles: recentCycles.slice(-20).reverse(),
    outputs: [...artifacts.slice(-10), ...workspaceFiles.slice(-10)],
    usefulnessItems: usefulItems,
    canControlInternalLoop: false
  };
}

async function getAppState() {
  await observeCycleLog();
  const memoryFiles = ['working_summary', 'long_term', 'open_questions', 'skills', 'usefulness', 'mistakes'];
  const memory = {};
  for (const key of memoryFiles) memory[key] = await readText(path.join(HOME, 'memory', `${key}.md`), '');
  const observedRunning = await isObservedHarnessRunning();
  const observedModel = observedRunning ? await getObservedHarnessModel() : '';
  const cycleData = await readCycleRecords();
  cycleCount = Math.max(cycleCount, cycleData.total);
  return {
    version: APP_VERSION,
    home: HOME,
    platform: `${os.platform()} ${os.arch()}`,
    node: process.version,
    running: observedRunning,
    observerMode: OBSERVER_MODE,
    cycleCount: cycleData.total,
    config: { ...config, model: observedModel || config.model },
    agent: await readText(path.join(HOME, 'agent.md'), ''),
    memory,
    friendly: await buildFriendlySummary(memory, cycleData.total, cycleData.records, observedRunning, observedModel),
    tree: await listTree('.', 180)
  };
}

async function readRequestJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function sendJson(res, value, status = 200) {
  const body = JSON.stringify(value, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function sendText(res, value, contentType = 'text/plain; charset=utf-8', status = 200) {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store'
  });
  res.end(value);
}

async function route(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname === '/') return sendText(res, INDEX_HTML, 'text/html; charset=utf-8');
    if (url.pathname === '/style.css') return sendText(res, STYLE_CSS, 'text/css; charset=utf-8');
    if (url.pathname === '/app.js') return sendText(res, APP_JS, 'application/javascript; charset=utf-8');

    if (url.pathname === '/api/state' && req.method === 'GET') return sendJson(res, await getAppState());
    if (url.pathname === '/api/events' && req.method === 'GET') {
      const since = Number(url.searchParams.get('since') || 0);
      return sendJson(res, { events: events.filter((event) => event.id > since) });
    }
    if (url.pathname === '/api/file' && req.method === 'GET') {
      const rel = url.searchParams.get('path');
      const { clean, resolved } = sanitizeRelativePath(rel);
      const text = await readText(resolved, '');
      return sendJson(res, { path: clean, text });
    }
    if (url.pathname === '/api/file' && req.method === 'POST') {
      const body = await readRequestJson(req);
      const rel = String(body.path || '');
      const content = String(body.text ?? '');
      const { clean, resolved } = sanitizeRelativePath(rel);
      const editable = clean === 'agent.md';
      if (!editable) throw new Error('This file is read-only in the UI');
      await writeText(resolved, content);
      addEvent('file.saved', `Saved ${clean}`);
      return sendJson(res, { ok: true, path: clean });
    }
    return sendJson(res, { ok: false, error: 'Not found' }, 404);
  } catch (error) {
    const payload = { ok: false, error: String(error.message || error) };
    addEvent('api.error', `${req.method} ${url.pathname} failed`, payload);
    return sendJson(res, payload, 500);
  }
}

const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Open-Ended Agent</title>
  <link rel="stylesheet" href="/style.css" />
</head>
<body>
  <header class="topbar">
    <div>
      <h1>Open-Ended Agent</h1>
      <p>Watch a local AI experiment run in a sandbox.</p>
    </div>
    <div class="statusbar">
      <span id="runStatus" class="pill">Loading</span>
      <span id="progressStatus" class="pill muted">Cycle -</span>
      <span id="modelStatus" class="pill muted">Model -</span>
    </div>
  </header>

  <main class="layout">
    <section class="panel timeline">
      <div class="sectionHeader"><h2>Live activity</h2><div class="buttons inlineButtons"><button id="refresh">Refresh</button><button id="clearTimeline">Clear view</button></div></div>
      <div id="events" class="events empty">Waiting for cycles...</div>
    </section>

    <div class="resizeHandle" data-resize="right" title="Drag to resize panes"></div>

    <section class="panel outputs">
      <h2>Memory and files</h2>
      <h3>Files</h3>
      <div id="tree" class="tree"></div>
      <div class="vResizeHandle" data-vtarget="tree" title="Drag to resize this section"></div>
      <div class="sectionHeader fileHeader"><h3>Selected file</h3><button id="saveSelectedFile">Save file</button></div>
      <textarea id="fileView" class="fileView" spellcheck="false"></textarea>
      <div id="fileStatus" class="fileStatus">Select a file to view it.</div>
    </section>
  </main>

  <script src="/app.js"></script>
</body>
</html>`;

const STYLE_CSS = `:root {
  --bg: #f4f1ea;
  --panel: #fffaf1;
  --ink: #201b16;
  --muted: #746a5e;
  --line: #ded3c3;
  --soft: #eee5d6;
  --danger: #9b2d20;
  --ok: #1f6b3a;
  --warn: #8a5a08;
  --accent: #243447;
}
* { box-sizing: border-box; }
html, body { height: 100%; overflow: hidden; }
body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--ink); }
.topbar { height: 74px; display: flex; justify-content: space-between; gap: 20px; align-items: center; padding: 14px 18px; border-bottom: 1px solid var(--line); background: rgba(255,250,241,0.96); position: sticky; top: 0; z-index: 3; backdrop-filter: blur(8px); }
h1 { font-size: 24px; margin: 0; letter-spacing: -0.02em; }
h2 { font-size: 18px; margin: 0 0 12px; letter-spacing: -0.01em; }
h3 { font-size: 13px; margin: 18px 0 8px; color: var(--muted); }
p { margin: 4px 0 0; color: var(--muted); font-size: 14px; line-height: 1.45; }
.layout { --mid-col: 1fr; --right-col: 420px; height: calc(100vh - 74px); display: grid; grid-template-columns: minmax(420px, var(--mid-col)) 8px minmax(300px, var(--right-col)); grid-template-rows: minmax(0, 1fr); gap: 8px; padding: 12px; align-items: stretch; overflow: hidden; }
.panel { min-height: 0; background: var(--panel); border: 1px solid var(--line); border-radius: 18px; padding: 14px; box-shadow: 0 1px 2px rgba(50,30,10,0.04); }
.timeline { grid-column: 1; grid-row: 1; }
.resizeHandle[data-resize="right"] { grid-column: 2; }
.outputs { grid-column: 3; grid-row: 1; }
.resizeHandle { grid-row: 1; width: 8px; min-height: 0; cursor: col-resize; border-radius: 999px; background: transparent; position: relative; }
.resizeHandle::after { content: ""; position: absolute; inset: 24px 2px; border-radius: 999px; background: var(--line); transition: background 120ms ease, inset 120ms ease; }
.resizeHandle:hover::after, .resizeHandle.active::after { inset: 12px 1px; background: var(--accent); }
.vResizeHandle { height: 12px; min-height: 12px; cursor: row-resize; position: relative; margin: 3px 0 8px; flex: 0 0 auto; }
.vResizeHandle::after { content: ""; position: absolute; left: 18%; right: 18%; top: 5px; height: 3px; border-radius: 999px; background: var(--line); transition: background 120ms ease, left 120ms ease, right 120ms ease; }
.vResizeHandle:hover::after, .vResizeHandle.active::after { left: 8%; right: 8%; background: var(--accent); }
.eyebrow { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 8px; }
.statGrid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin: 16px 0 0; }
.stat { background: #fff; border: 1px solid var(--line); border-radius: 14px; padding: 12px; }
.stat span { display: block; color: var(--muted); font-size: 12px; margin-bottom: 5px; }
.stat strong { font-size: 15px; word-break: break-word; }
.notice { margin-top: 14px; background: #eef5ef; border: 1px solid #c8dfcc; color: #244a2d; border-radius: 14px; padding: 10px 12px; font-size: 13px; }
.statusbar { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
.pill { display: inline-flex; align-items: center; border: 1px solid var(--line); background: var(--soft); border-radius: 999px; padding: 7px 11px; font-size: 12px; white-space: nowrap; }
.pill.ok { color: var(--ok); background: #eef5ef; border-color: #c8dfcc; }
.pill.bad { color: var(--danger); background: #fff0ee; border-color: #e4b9b2; }
.pill.muted { color: var(--muted); }
label { display: block; font-size: 12px; color: var(--muted); margin: 9px 0; }
input, textarea, button { font: inherit; }
input, textarea { width: 100%; margin-top: 5px; padding: 9px 10px; border: 1px solid var(--line); border-radius: 11px; background: #fff; color: var(--ink); }
textarea { min-height: 120px; resize: vertical; line-height: 1.4; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
.timeline, .outputs { height: 100%; overflow: hidden; display: flex; flex-direction: column; }
.focusText { min-height: 120px; height: 42%; max-height: none; overflow: auto; font-size: 17px; color: var(--ink); background: #fff; border: 1px solid var(--line); border-radius: 14px; padding: 12px; flex: 0 0 auto; }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.checks { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 2px 10px; margin: 8px 0; }
.checks label { display: flex; align-items: center; gap: 8px; color: var(--ink); }
.checks input { width: auto; margin: 0; }
.buttons { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0 0; }
.inlineButtons { margin: 0; }
button { border: 1px solid var(--line); background: var(--soft); border-radius: 999px; padding: 7px 11px; cursor: pointer; font-size: 12px; line-height: 1.2; white-space: nowrap; }
button:hover { filter: brightness(0.97); }
button:disabled { cursor: not-allowed; opacity: 0.55; }
button.primary { background: var(--accent); color: white; border-color: var(--accent); }
button.danger { color: white; background: var(--danger); border-color: var(--danger); }
.sectionHeader { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 12px; flex: 0 0 auto; }
.sectionHeader h2 { margin-bottom: 0; }
.events { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 10px; overflow: auto; padding-right: 4px; }
.event { border: 1px solid var(--line); border-radius: 14px; padding: 12px; background: #fff; }
.event.ok { border-left: 5px solid var(--ok); }
.event.bad { border-left: 5px solid var(--danger); }
.event.idle { border-left: 5px solid var(--muted); }
.event .meta { display: flex; justify-content: space-between; gap: 12px; color: var(--muted); font-size: 12px; margin-bottom: 5px; }
.event .title { font-size: 15px; font-weight: 700; }
.event .summary { color: var(--muted); font-size: 13px; margin-top: 6px; line-height: 1.4; }
.event details { margin-top: 8px; }
.event details summary { cursor: pointer; color: var(--muted); font-size: 13px; font-weight: 500; }
.event pre { white-space: pre-wrap; font-size: 11px; color: var(--muted); margin: 8px 0 0; max-height: 160px; overflow: auto; }
.list { display: grid; gap: 8px; min-height: 54px; height: 150px; max-height: none; overflow: auto; padding-right: 3px; flex: 0 0 auto; }
.listItem { background: #fff; border: 1px solid var(--line); border-radius: 12px; padding: 10px; font-size: 13px; text-align: left; }
.listItem:hover { border-color: var(--accent); }
.listItem strong { display: block; margin-bottom: 3px; }
.listItem span { color: var(--muted); }
.empty { color: var(--muted); font-size: 13px; }
.advanced { margin-top: 14px; overflow: auto; }
.advanced summary { cursor: pointer; color: var(--muted); font-size: 13px; }
.tree { border: 1px solid var(--line); border-radius: 10px; height: 42%; min-height: 120px; overflow: auto; background: #fff; padding: 4px; flex: 0 0 auto; }
.treeRow { display: flex; align-items: center; gap: 5px; width: 100%; text-align: left; border: 0; border-radius: 8px; background: white; font-size: 12px; padding: 5px 7px; color: var(--ink); }
.treeRow:hover { background: var(--soft); }
.treeRow.selected { background: var(--soft); }
.treeRow.file { cursor: pointer; }
.treeRow.readonly { color: var(--muted); opacity: 0.68; }
.treeRow.dir { font-weight: 650; }
.treeCaret { width: 14px; color: var(--muted); display: inline-block; text-align: center; }
.treeChildren { margin-left: 14px; border-left: 1px solid var(--line); padding-left: 5px; }
.fileView, .mini { background: #171411; color: #f7efe4; border-radius: 10px; padding: 10px; overflow: auto; white-space: pre-wrap; font-size: 11px; min-height: 48px; }
.fileView { flex: 1 1 auto; min-height: 120px; height: auto; max-height: none; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.fileHeader { margin-top: 10px; margin-bottom: 8px; }
.fileHeader h3 { margin: 0; }
.fileStatus { color: var(--muted); font-size: 12px; margin-top: 6px; min-height: 16px; }
@media (max-width: 1180px) {
  html, body { overflow: auto; }
  .topbar { height: auto; position: static; align-items: flex-start; flex-direction: column; }
  .layout { height: auto; min-height: 100vh; grid-template-columns: 1fr; grid-template-rows: none; overflow: visible; }
  .resizeHandle { display: none; }
  .vResizeHandle { display: none; }
  .timeline, .outputs { grid-column: auto; grid-row: auto; }
  .timeline, .outputs { height: auto; overflow: visible; flex-direction: column; }
  .events { max-height: 520px; }
  .statGrid { grid-template-columns: 1fr; }
  .tree { height: auto; max-height: 300px; flex: 0 0 auto; }
  #fileView { min-height: 200px; height: auto; }
  .outputs .panel { height: auto; }
  .vResizeHandle { display: none; }
}
@media (max-width: 640px) {
  .topbar { padding: 12px; gap: 10px; }
  h1 { font-size: 20px; }
  .layout { padding: 8px; gap: 8px; }
  .panel { border-radius: 14px; padding: 12px; }
  .statusbar { justify-content: flex-start; }
  .pill { font-size: 11px; padding: 6px 9px; }
  .checks, .grid2 { grid-template-columns: 1fr; }
  .focusText { font-size: 15px; height: auto; max-height: 180px; }
  .events { max-height: 360px; }
  .list { height: auto; max-height: 220px; }
  .tree { height: auto; max-height: 240px; }
  #fileView { min-height: 160px; }
}
`;

const APP_JS = `let state = null;
let lastEventId = 0;
let expandedTreePaths = new Set(JSON.parse(localStorage.getItem('openEndedAgentExpandedTree') || '["artifacts","workspace","memory"]'));
let selectedFilePath = localStorage.getItem('openEndedAgentSelectedFile') || '';
let treeInitialized = false;
let lastTimelineSignature = '';
let lastTreeSignature = '';
const $ = (id) => document.getElementById(id);

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const data = await response.json();
  if (!response.ok || data.ok === false) throw new Error(data.error || 'Request failed');
  return data;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

function actionLabel(action) {
  if (!action) return 'did something';
  const type = action.type || 'unknown';
  const labels = { read_file: 'Read a file', read_file_range: 'Read part of a file', run_shell: 'Ran a safe command', write_file: 'Created a file', append_file: 'Updated a file', web_search: 'Searched the web', fetch_url: 'Read a web page', sleep: 'Sleeping', reflect: 'Reflected', list_dir: 'Looked at files', observe: 'Observed the workspace' };
  return labels[type] || type.replaceAll('_', ' ');
}

function actionTarget(action) {
  return action?.path || action?.query || action?.url || action?.command || action?.reason || '';
}

function updateDashboard() {
  const f = state.friendly || {};
  $('runStatus').textContent = state.running ? 'Running' : 'Stopped';
  $('runStatus').className = 'pill ' + (state.running ? 'ok' : 'muted');
  $('progressStatus').textContent = f.progressLabel || ('Cycle ' + (state.cycleCount || 0));
  $('modelStatus').textContent = f.modelLabel || state.config?.model || 'Model unknown';
  renderTimelineFromState();
}

function renderTimelineFromState() {
  const openDetails = new Set([...document.querySelectorAll('.eventDetails')].filter((el) => el.open).map((el) => el.dataset.cycle));
  const cycles = state.friendly?.recentCycles || [];
  const signature = cycles.map((cycle) => cycle.cycle + ':' + cycle.ts + ':' + cycle.ok).join('|');
  if (signature === lastTimelineSignature) return;
  lastTimelineSignature = signature;
  const scrollTop = $('events').scrollTop;
  $('events').className = 'events' + (cycles.length ? '' : ' empty');
  if (!cycles.length) { $('events').textContent = 'Waiting for cycles...'; return; }
  $('events').innerHTML = cycles.map((cycle) => renderCycleCard(cycle, openDetails.has(String(cycle.cycle)))).join('');
  $('events').scrollTop = scrollTop;
}

function renderCycleCard(cycle, detailsOpen = false) {
  const action = cycle.action || {};
  const target = actionTarget(action);
  const cls = cycle.ok ? (action.type === 'sleep' ? 'idle' : 'ok') : 'bad';
  const result = cycle.ok ? 'Succeeded' : 'Blocked or failed';
  return '<div class="event ' + cls + '">' +
    '<div class="meta"><span>Cycle ' + escapeHtml(cycle.cycle) + '</span><span>' + escapeHtml(new Date(cycle.ts).toLocaleTimeString()) + '</span></div>' +
    '<div class="title">' + escapeHtml(actionLabel(action)) + '</div>' +
    (target ? '<div class="summary">Target: ' + escapeHtml(String(target).slice(0, 180)) + '</div>' : '') +
    (cycle.summary ? '<div class="summary">Why: ' + escapeHtml(cycle.summary) + '</div>' : '') +
    '<div class="summary">Result: ' + escapeHtml(result) + '</div>' +
    '<details class="eventDetails" data-cycle="' + escapeHtml(cycle.cycle) + '"' + (detailsOpen ? ' open' : '') + '><summary>Technical details</summary><pre>' + escapeHtml(JSON.stringify({ action: cycle.action, result: cycle.observation }, null, 2)) + '</pre></details>' +
    '</div>';
}

function renderTree(force = false) {
  const signature = (state.tree || []).map((item) => item.type + ':' + item.path).sort().join('|');
  if (!force && signature === lastTreeSignature) return;
  lastTreeSignature = signature;
  $('tree').innerHTML = '';
  const root = buildTree(state.tree || []);
  const children = Object.values(root.children).sort(sortTreeNodes);
  if (!children.length) { $('tree').textContent = 'No files yet.'; return; }
  for (const child of children) $('tree').appendChild(renderTreeNode(child));
}

function buildTree(items) {
  const root = { name: '.', path: '.', type: 'dir', children: {} };
  for (const item of items) {
    const parts = String(item.path || '').split('/').filter(Boolean);
    let node = root;
    let current = '';
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      current = current ? current + '/' + part : part;
      const isLast = i === parts.length - 1;
      if (!node.children[part]) node.children[part] = { name: part, path: current, type: isLast ? item.type : 'dir', children: {} };
      if (isLast) node.children[part].type = item.type;
      node = node.children[part];
    }
  }
  return root;
}

function sortTreeNodes(a, b) {
  if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
  return a.name.localeCompare(b.name);
}

function renderTreeNode(node) {
  const wrap = document.createElement('div');
  wrap.className = 'treeNode';
  const row = document.createElement('button');
  const isDir = node.type === 'dir';
  const isOpen = expandedTreePaths.has(node.path);
  row.className = 'treeRow ' + (isDir ? 'dir' : 'file') + (!isDir && !isEditableFile(node.path) ? ' readonly' : '') + (node.path === selectedFilePath ? ' selected' : '');
  row.dataset.path = node.path;
  row.innerHTML = '<span class="treeCaret">' + (isDir ? (isOpen ? '▾' : '▸') : '·') + '</span><span>' + escapeHtml(node.name) + '</span>';
  row.onclick = () => {
    if (isDir) {
      if (expandedTreePaths.has(node.path)) expandedTreePaths.delete(node.path); else expandedTreePaths.add(node.path);
      localStorage.setItem('openEndedAgentExpandedTree', JSON.stringify([...expandedTreePaths]));
      renderTree(true);
    } else openFile(node.path);
  };
  wrap.appendChild(row);
  if (isDir && isOpen) {
    const kids = document.createElement('div');
    kids.className = 'treeChildren';
    for (const child of Object.values(node.children).sort(sortTreeNodes)) kids.appendChild(renderTreeNode(child));
    wrap.appendChild(kids);
  }
  return wrap;
}

async function openFile(path) {
  try {
    const data = await api('/api/file?path=' + encodeURIComponent(path));
    selectedFilePath = data.path;
    localStorage.setItem('openEndedAgentSelectedFile', selectedFilePath);
    $('fileView').value = data.text || '';
    const editable = isEditableFile(data.path);
    $('fileView').readOnly = !editable;
    $('saveSelectedFile').disabled = !editable;
    $('fileStatus').textContent = editable ? 'Editing ' + data.path : data.path + ' is read-only';
    renderTree(true);
    $('fileView').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  } catch (error) { $('fileStatus').textContent = String(error.message || error); }
}

function isEditableFile(path) {
  return path === 'agent.md';
}

async function saveSelectedFile() {
  if (!selectedFilePath || !isEditableFile(selectedFilePath)) return;
  await api('/api/file', { method: 'POST', body: JSON.stringify({ path: selectedFilePath, text: $('fileView').value }) });
  $('fileStatus').textContent = 'Saved ' + selectedFilePath;
  await refreshState();
}

function loadPaneLayout() {
  try {
    const saved = JSON.parse(localStorage.getItem('openEndedAgentPaneLayout') || '{}');
    const layout = document.querySelector('.layout');
    if (saved.right) layout.style.setProperty('--right-col', saved.right + 'px');
  } catch {}
}

function savePaneLayout(left, right) {
  localStorage.setItem('openEndedAgentPaneLayout', JSON.stringify({ left, right }));
}

function setupPaneResizing() {
  const layout = document.querySelector('.layout');
  const handles = [...document.querySelectorAll('.resizeHandle')];
  if (!layout || !handles.length) return;
  loadPaneLayout();

  let drag = null;
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  for (const handle of handles) {
    handle.addEventListener('pointerdown', (event) => {
      if (window.matchMedia('(max-width: 1180px)').matches) return;
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      handle.classList.add('active');
      const rect = layout.getBoundingClientRect();
      const styles = getComputedStyle(layout);
      drag = {
        side: handle.dataset.resize,
        startX: event.clientX,
        width: rect.width,
        left: parseFloat(styles.getPropertyValue('--left-col')) || 360,
        right: parseFloat(styles.getPropertyValue('--right-col')) || 360,
        handle
      };
    });
  }

  window.addEventListener('pointermove', (event) => {
    if (!drag) return;
    const delta = event.clientX - drag.startX;
    const maxSide = Math.max(300, Math.floor(drag.width * 0.5));
    const right = drag.side === 'right' ? clamp(drag.right - delta, 260, maxSide) : drag.right;
    layout.style.setProperty('--right-col', right + 'px');
    savePaneLayout(drag.left, right);
  });

  window.addEventListener('pointerup', () => {
    if (!drag) return;
    drag.handle.classList.remove('active');
    drag = null;
  });
}

function loadVerticalLayout() {
  try {
    const saved = JSON.parse(localStorage.getItem('openEndedAgentVerticalLayout') || '{}');
    for (const [id, height] of Object.entries(saved)) {
      const el = document.getElementById(id);
      if (el && Number(height)) el.style.height = Number(height) + 'px';
    }
  } catch {}
}

function saveVerticalLayout(id, height) {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('openEndedAgentVerticalLayout') || '{}'); } catch {}
  saved[id] = height;
  localStorage.setItem('openEndedAgentVerticalLayout', JSON.stringify(saved));
}

function setupVerticalResizing() {
  loadVerticalLayout();
  let drag = null;
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  for (const handle of document.querySelectorAll('.vResizeHandle')) {
    handle.addEventListener('pointerdown', (event) => {
      if (window.matchMedia('(max-width: 1180px)').matches) return;
      const target = document.getElementById(handle.dataset.vtarget || '');
      if (!target) return;
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      handle.classList.add('active');
      drag = {
        handle,
        target,
        id: target.id,
        startY: event.clientY,
        height: target.getBoundingClientRect().height,
        parentHeight: target.closest('.panel')?.getBoundingClientRect().height || window.innerHeight
      };
    });
  }

  window.addEventListener('pointermove', (event) => {
    if (!drag) return;
    const delta = event.clientY - drag.startY;
    const max = Math.max(140, drag.parentHeight - 120);
    const next = clamp(drag.height + delta, 48, max);
    drag.target.style.height = next + 'px';
    saveVerticalLayout(drag.id, next);
  });

  window.addEventListener('pointerup', () => {
    if (!drag) return;
    drag.handle.classList.remove('active');
    drag = null;
  });
}

async function refreshState() {
  state = await api('/api/state');
  if (!treeInitialized && selectedFilePath) {
    const parts = selectedFilePath.split('/');
    for (let i = 1; i < parts.length; i++) {
      expandedTreePaths.add(parts.slice(0, i).join('/'));
    }
    treeInitialized = true;
  }
  updateDashboard();
  renderTree();
}

async function pollEvents() {
  try {
    const data = await api('/api/events?since=' + lastEventId);
    for (const event of data.events) lastEventId = Math.max(lastEventId, event.id);
    await refreshState();
  } catch (error) { console.error(error); }
}

$('refresh').onclick = refreshState;
$('clearTimeline').onclick = () => { $('events').innerHTML = ''; };
$('saveSelectedFile').onclick = saveSelectedFile;

setupPaneResizing();
setupVerticalResizing();
refreshState().then(async () => {
  if (selectedFilePath) openFile(selectedFilePath);
  setInterval(pollEvents, 1000);
}).catch((error) => {
  document.body.innerHTML = '<pre style="padding:20px">Failed to initialize: ' + escapeHtml(String(error.message || error)) + '</pre>';
});
`;

await ensureAgentHome();
await loadConfig();
await observeCycleLog();
addEvent('app.ready', `Open-Ended Agent Desktop Preview ${APP_VERSION} ready`, { home: HOME, port: PORT, observerMode: OBSERVER_MODE });
setInterval(() => {
  observeCycleLog().catch((error) => addEvent('observer.error', 'Could not observe cycle log', { error: String(error.message || error) }));
}, 1000);

const server = http.createServer((req, res) => {
  route(req, res);
});

server.listen(PORT, HOST_BIND, () => {
  const url = `http://${HOST_BIND === '0.0.0.0' ? '127.0.0.1' : HOST_BIND}:${PORT}`;
  console.log(`\nOpen-Ended Agent Desktop Preview running at ${url}\nAgent home: ${HOME}\nObserver mode: ${OBSERVER_MODE ? 'on' : 'off'}\n`);
  maybeOpenBrowser(url);
});

function maybeOpenBrowser(url) {
  if (process.env.NO_OPEN === '1') return;
  const platform = os.platform();
  let command;
  let args;
  if (platform === 'darwin') {
    command = 'open';
    args = [url];
  } else if (platform === 'win32') {
    command = 'cmd';
    args = ['/c', 'start', '', url];
  } else {
    command = 'xdg-open';
    args = [url];
  }
  const child = spawn(command, args, { stdio: 'ignore', detached: true });
  child.on('error', () => {});
  child.unref?.();
}
