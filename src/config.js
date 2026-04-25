import path from "node:path";

function env(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return value;
}

function intEnv(name, fallback) {
  const raw = env(name, String(fallback));
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function floatEnv(name, fallback) {
  const raw = env(name, String(fallback));
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

function boolEnv(name, fallback) {
  const raw = env(name, fallback ? "1" : "0").toLowerCase();
  return ["1", "true", "yes", "on"].includes(raw);
}

function normalizeBaseUrl(url) {
  return url.replace(/\/$/, "");
}

export const config = {
  baseUrl: normalizeBaseUrl(env("OPENAI_BASE_URL", "http://localhost:4000/v1")),
  apiKey: env("OPENAI_API_KEY", "local-stack"),
  model: env("MODEL", "qwen3.5-35b-a3b"),
  agentHome: path.resolve(env("AGENT_HOME", "./agent-home")),
  maxCycles: intEnv("AGENT_MAX_CYCLES", 0),
  contextCharBudget: intEnv("AGENT_CONTEXT_CHAR_BUDGET", 90000),
  recentLogCycles: intEnv("AGENT_RECENT_LOG_CYCLES", 6),
  compactEvery: intEnv("AGENT_COMPACT_EVERY", 20),
  tickDelayMs: intEnv("AGENT_TICK_DELAY_MS", 0),
  temperature: floatEnv("AGENT_TEMPERATURE", 0.4),
  maxTokens: intEnv("AGENT_MAX_TOKENS", 768),
  compactionMaxTokens: intEnv("AGENT_COMPACTION_MAX_TOKENS", 1536),
  llmStream: boolEnv("AGENT_LLM_STREAM", true),
  llmTimeoutMs: intEnv("AGENT_LLM_TIMEOUT_MS", 0),
  jsonMode: boolEnv("AGENT_JSON_MODE", true),
  webEnabled: boolEnv("AGENT_WEB", true),
  shellEnabled: boolEnv("AGENT_SHELL", false),
  shellTimeoutMs: intEnv("AGENT_SHELL_TIMEOUT_MS", 15000),
  fetchTimeoutMs: intEnv("AGENT_FETCH_TIMEOUT_MS", 20000),
  fetchTextChars: intEnv("AGENT_FETCH_TEXT_CHARS", 12000),
  contextResultChars: intEnv("AGENT_CONTEXT_RESULT_CHARS", 6000),
  observeMaxEntries: intEnv("AGENT_OBSERVE_MAX_ENTRIES", 80),
};
