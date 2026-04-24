import fs from "node:fs/promises";
import path from "node:path";

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

export async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export function resolveInside(root, requested = ".") {
  if (typeof requested !== "string") {
    throw new Error("Path must be a string.");
  }
  if (path.isAbsolute(requested)) {
    throw new Error(
      "Absolute paths are not allowed. Use paths relative to agent home.",
    );
  }
  const resolved = path.resolve(root, requested);
  const rootResolved = path.resolve(root);
  if (
    resolved !== rootResolved &&
    !resolved.startsWith(rootResolved + path.sep)
  ) {
    throw new Error(`Path escapes sandbox: ${requested}`);
  }
  return resolved;
}

export async function readTextSafe(filePath, maxChars = 20000) {
  const text = await fs.readFile(filePath, "utf8");
  if (text.length > maxChars) {
    return (
      text.slice(0, maxChars) +
      `\n\n[truncated: ${text.length - maxChars} chars omitted]`
    );
  }
  return text;
}

export async function appendText(filePath, text) {
  await ensureDir(path.dirname(filePath));
  await fs.appendFile(filePath, text, "utf8");
}

export async function writeText(filePath, text) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, text, "utf8");
}

export async function listRecursive(root, opts = {}) {
  const maxEntries = opts.maxEntries ?? 300;
  const maxDepth = opts.maxDepth ?? 4;
  const exclude = new Set(opts.exclude ?? [".git", "node_modules"]);
  const rows = [];

  async function walk(dir, rel, depth) {
    if (rows.length >= maxEntries || depth > maxDepth) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      rows.push(`${rel || "."}/ [unreadable: ${err.message}]`);
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (rows.length >= maxEntries) break;
      if (exclude.has(entry.name)) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      rows.push(
        `${"  ".repeat(depth)}${entry.isDirectory() ? "dir " : "file"} ${childRel}${entry.isDirectory() ? "/" : ""}`,
      );
      if (entry.isDirectory()) {
        await walk(path.join(dir, entry.name), childRel, depth + 1);
      }
    }
  }

  await walk(root, "", 0);
  if (rows.length >= maxEntries)
    rows.push(`[truncated at ${maxEntries} entries]`);
  return rows.join("\n");
}
