import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { config } from "./config.js";
import {
  ensureDir,
  listRecursive,
  readTextSafe,
  resolveInside,
  writeText,
  appendText,
} from "./fs_sandbox.js";

const WRITE_PREFIXES = ["workspace/", "artifacts/"];
const READ_EXCLUDES = new Set(["node_modules", ".git"]);
const TEXT_CONTENT_TYPES = [
  "text/",
  "application/json",
  "application/xml",
  "application/xhtml+xml",
  "application/rss+xml",
  "application/atom+xml",
];
const CACHE_DIR = "artifacts/web-cache";

function ok(data) {
  return { ok: true, data };
}

function fail(error) {
  return { ok: false, error: String(error?.message ?? error) };
}

function normalizeRel(p = ".") {
  return String(p || ".").replace(/^\.\//, "");
}

function ensureWritableRel(rel) {
  const normalized = normalizeRel(rel);
  if (
    !WRITE_PREFIXES.some(
      (prefix) =>
        normalized === prefix.slice(0, -1) || normalized.startsWith(prefix),
    )
  ) {
    throw new Error(
      `Writes are restricted to ${WRITE_PREFIXES.join(", ")}. Requested: ${rel}`,
    );
  }
  return normalized;
}

async function scanTextFiles(root, query, maxMatches = 50) {
  const q = String(query || "").toLowerCase();
  if (!q.trim()) throw new Error("search_files requires a non-empty query.");
  const rows = [];

  async function walk(dir, rel, depth) {
    if (rows.length >= maxMatches || depth > 8) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (rows.length >= maxMatches) break;
      if (READ_EXCLUDES.has(entry.name)) continue;
      const childAbs = path.join(dir, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name === "web-cache" && depth > 0) continue;
        await walk(childAbs, childRel, depth + 1);
      } else if (
        /\.(md|txt|json|jsonl|js|ts|html|css|csv)$/i.test(entry.name)
      ) {
        try {
          const text = await readTextSafe(childAbs, 200000);
          const lower = text.toLowerCase();
          const idx = lower.indexOf(q);
          if (idx >= 0) {
            const start = Math.max(0, idx - 160);
            const end = Math.min(text.length, idx + q.length + 240);
            rows.push({ path: childRel, snippet: text.slice(start, end) });
          }
        } catch {
          continue;
        }
      }
    }
  }

  await walk(root, "", 0);
  return rows;
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtml(text) {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function parseDuckDuckGo(html) {
  const results = [];
  const linkRe =
    /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let match;
  while ((match = linkRe.exec(html)) && results.length < 8) {
    let url = decodeHtml(match[1]);
    const title = stripHtml(match[2]);
    try {
      const parsed = new URL(url);
      const uddg = parsed.searchParams.get("uddg");
      if (uddg) url = decodeURIComponent(uddg);
    } catch {}
    results.push({ title, url });
  }
  return results;
}

function isLikelyPdfUrl(url) {
  try {
    const parsed = new URL(url);
    return (
      /\.pdf($|[?#])/i.test(parsed.pathname) ||
      (parsed.hostname === "arxiv.org" && parsed.pathname.startsWith("/pdf/"))
    );
  } catch {
    return false;
  }
}

function isTextLike(contentType) {
  const lower = String(contentType || "").toLowerCase();
  return TEXT_CONTENT_TYPES.some((type) => lower.includes(type));
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.fetchTimeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err?.name === "AbortError")
      throw new Error(`fetch timed out after ${config.fetchTimeoutMs}ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function urlToCacheSlug(url) {
  const date = new Date().toISOString().slice(0, 10);
  const hash = crypto.createHash("md5").update(url).digest("hex").slice(0, 8);
  let name;
  try {
    const parsed = new URL(url);
    name = parsed.pathname
      .replace(/\//g, "-")
      .replace(/^-/, "")
      .replace(/[^a-z0-9-]/gi, "-")
      .slice(0, 40);
    if (!name || name === "-") name = parsed.hostname.replace(/\./g, "-");
  } catch {
    name = "fetch";
  }
  return `${date}-${name}-${hash}`;
}

async function webSearch(query) {
  if (!config.webEnabled)
    throw new Error("web_search is disabled. Set AGENT_WEB=1 to enable.");
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const response = await fetchWithTimeout(url, {
    headers: { "User-Agent": "Mozilla/5.0 open-ended-agent-harness/0.3" },
  });
  if (!response.ok)
    throw new Error(`DuckDuckGo returned HTTP ${response.status}`);
  const html = await response.text();
  const results = parseDuckDuckGo(html);
  return {
    query,
    results,
    note: results.length
      ? "Search results parsed from DuckDuckGo HTML."
      : "No parsed results. Try a different query or fetch a known URL.",
  };
}

async function fetchUrl(url, artifactsDir) {
  if (!config.webEnabled)
    throw new Error("fetch_url is disabled. Set AGENT_WEB=1 to enable.");
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol))
    throw new Error("Only http/https URLs are allowed.");

  if (isLikelyPdfUrl(parsed.toString())) {
    return {
      url: parsed.toString(),
      status: null,
      contentType: "application/pdf (inferred from URL)",
      text: "",
      truncated: false,
      skipped: true,
      note: "PDF fetching is intentionally disabled. Prefer an HTML page, text source, or add a dedicated PDF extraction tool. Fetched web pages are saved to the web cache for later chunked reading.",
    };
  }

  const response = await fetchWithTimeout(parsed.toString(), {
    headers: { "User-Agent": "Mozilla/5.0 open-ended-agent-harness/0.3" },
  });
  const contentType = response.headers.get("content-type") || "";

  if (contentType.toLowerCase().includes("application/pdf")) {
    return {
      url: parsed.toString(),
      status: response.status,
      contentType,
      text: "",
      truncated: false,
      skipped: true,
      note: "PDF response skipped. fetch_url handles text/html/text-like pages only. Fetched pages are cached for chunked reading.",
    };
  }

  if (!isTextLike(contentType) && contentType) {
    return {
      url: parsed.toString(),
      status: response.status,
      contentType,
      text: "",
      truncated: false,
      skipped: true,
      note: "Non-text response skipped to prevent binary/noisy payloads. Only text/html and text-like content is fetched.",
    };
  }

  const raw = await response.text();
  const body =
    contentType.includes("html") ||
    raw.trim().startsWith("<!DOCTYPE") ||
    raw.trim().startsWith("<html")
      ? stripHtml(raw)
      : raw.replace(/\s+$/g, "");

  const preview = body.slice(0, config.fetchTextChars);
  const truncated = body.length > config.fetchTextChars;

  let cachePath = null;
  if (body.length > 0) {
    try {
      const cacheFullDir = path.join(artifactsDir, CACHE_DIR);
      await ensureDir(cacheFullDir);
      const slug = urlToCacheSlug(url);
      cachePath = path.join(cacheFullDir, `${slug}.txt`);
      const header = `<!-- source: ${url} -->\n<!-- fetched: ${new Date().toISOString()} -->\n<!-- original_length: ${body.length} -->\n\n`;
      await fs.writeFile(cachePath, header + body, "utf8");
    } catch {
      cachePath = null;
    }
  }

  return {
    url: parsed.toString(),
    status: response.status,
    contentType,
    text: preview,
    truncated,
    originalLength: body.length,
    cachePath,
    cacheNote: cachePath
      ? `Full content saved to ${cachePath}. Use read_file to inspect later chunks, or search artifacts/web-cache/ for cached pages.`
      : "Content was not cached (write error). Use fetch_url again if needed.",
  };
}

function validateShellCommand(command) {
  if (!config.shellEnabled) {
    throw new Error(
      "run_shell is disabled. Set AGENT_SHELL=1 to enable restricted shell commands.",
    );
  }
  if (typeof command !== "string" || !command.trim())
    throw new Error("run_shell requires command.");
  const banned = [
    /\bsudo\b/,
    /\brm\b/,
    /\bmv\b/,
    /\bchmod\b/,
    /\bchown\b/,
    /\bkill\b/,
    /\bpkill\b/,
    /\bssh\b/,
    /\bscp\b/,
    /\bbrew\b/,
    /\bopen\b/,
    /\bosascript\b/,
    /\bcurl\b/,
    /\bwget\b/,
    /\bgit\s+push\b/,
    /\bgit\s+clone\b/,
    /\/Users\//,
    /\/etc\//,
    /\/System\//,
    /\.\./,
    /~\//,
  ];
  for (const re of banned) {
    if (re.test(command))
      throw new Error(`Command rejected by sandbox policy: ${re}`);
  }
  return command;
}

async function runShell(command, cwd) {
  validateShellCommand(command);
  return await new Promise((resolve) => {
    const child = spawn("bash", ["-lc", command], {
      cwd,
      env: { ...process.env, HOME: cwd },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, config.shellTimeoutMs);
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        code,
        stdout: stdout.slice(0, 20000),
        stderr: stderr.slice(0, 20000),
        truncated: stdout.length > 20000 || stderr.length > 20000,
      });
    });
  });
}

export function summarizeResultForContext(
  result,
  maxChars = config.contextResultChars,
) {
  if (!result || typeof result !== "object") return result;
  const data = result.data;
  if (!result.ok)
    return { ok: false, error: String(result.error || "").slice(0, 1200) };

  if (data?.tree && Array.isArray(data.tree)) {
    return {
      ok: true,
      data: {
        note: data.note,
        treeCount: data.tree.length,
        treeSample: data.tree.slice(0, 40),
      },
    };
  }
  if (Array.isArray(data)) {
    return {
      ok: true,
      data: data.slice(0, 80),
      omitted: Math.max(0, data.length - 80),
    };
  }
  if (data?.results && Array.isArray(data.results)) {
    return {
      ok: true,
      data: {
        query: data.query,
        results: data.results.slice(0, 8),
        note: data.note,
      },
    };
  }
  if (typeof data?.text === "string") {
    return {
      ok: true,
      data: {
        url: data.url,
        truncated: data.truncated,
        originalLength: data.originalLength,
        cachePath: data.cachePath,
        text: data.text.slice(0, Math.min(maxChars, 4000)),
        contextTruncated: data.text.length > Math.min(maxChars, 4000),
      },
    };
  }
  const json = JSON.stringify(result);
  if (json.length <= maxChars) return result;
  return {
    ok: true,
    data: {
      summary: json.slice(0, maxChars),
      contextTruncated: true,
      originalChars: json.length,
    },
  };
}

export async function executeAction(action, dirs) {
  try {
    if (!action || typeof action !== "object")
      throw new Error("Missing action object.");
    const type = action.type;
    switch (type) {
      case "observe": {
        const tree = await listRecursive(dirs.home, {
          maxEntries: config.observeMaxEntries,
          maxDepth: 4,
          exclude: ["node_modules", ".git"],
        });
        return ok({
          tree,
          note: "Observation includes a bounded sandbox file tree.",
        });
      }
      case "list_dir": {
        const rel = normalizeRel(action.path || ".");
        const abs = resolveInside(dirs.home, rel);
        const entries = await fs.readdir(abs, { withFileTypes: true });
        return ok(
          entries.map((e) => ({
            name: e.name,
            type: e.isDirectory() ? "dir" : "file",
          })),
        );
      }
      case "read_file": {
        const rel = normalizeRel(action.path);
        const abs = resolveInside(dirs.home, rel);
        const text = await readTextSafe(abs, 40000);
        return ok({ path: rel, text });
      }
      case "read_file_range": {
        const rel = normalizeRel(action.path);
        const abs = resolveInside(dirs.home, rel);
        const start = Math.max(0, Number(action.start ?? 0));
        const length = Math.max(
          1,
          Math.min(Number(action.length ?? 12000), 50000),
        );
        const content = await fs.readFile(abs, "utf8");
        const chunk = content.slice(start, start + length);
        return ok({
          path: rel,
          start,
          length,
          chunk,
          totalLength: content.length,
          moreAvailable: start + length < content.length,
        });
      }
      case "write_file": {
        const rel = ensureWritableRel(action.path);
        const abs = resolveInside(dirs.home, rel);
        await writeText(abs, String(action.content ?? ""));
        return ok({
          path: rel,
          bytes: Buffer.byteLength(String(action.content ?? ""), "utf8"),
        });
      }
      case "append_file": {
        const rel = ensureWritableRel(action.path);
        const abs = resolveInside(dirs.home, rel);
        await appendText(abs, String(action.content ?? ""));
        return ok({
          path: rel,
          bytes: Buffer.byteLength(String(action.content ?? ""), "utf8"),
        });
      }
      case "search_files": {
        const rows = await scanTextFiles(dirs.home, action.query, 50);
        return ok({ query: action.query, matches: rows });
      }
      case "web_search": {
        return ok(await webSearch(action.query));
      }
      case "fetch_url": {
        return ok(await fetchUrl(action.url, dirs.home));
      }
      case "run_shell": {
        await ensureDir(dirs.workspace);
        return ok(await runShell(action.command, dirs.workspace));
      }
      case "reflect": {
        const tree = await listRecursive(dirs.home, {
          maxEntries: Math.min(config.observeMaxEntries, 80),
          maxDepth: 4,
          exclude: ["node_modules", ".git"],
        });
        return ok({
          note: "Reflection action selected. Use this observation to assess repetition, current threads, and next useful exploration.",
          tree,
        });
      }
      case "sleep": {
        const ms = Math.max(0, Math.min(Number(action.ms ?? 1000), 60000));
        await new Promise((r) => setTimeout(r, ms));
        return ok({ sleptMs: ms });
      }
      default:
        throw new Error(`Unknown action type: ${type}`);
    }
  } catch (err) {
    return fail(err);
  }
}
