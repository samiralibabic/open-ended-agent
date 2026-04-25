import { config } from "./config.js";

function extractJsonObject(text) {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {}

  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first >= 0 && last > first) {
    const candidate = cleaned.slice(first, last + 1);
    try {
      return JSON.parse(candidate);
    } catch {
      for (let i = candidate.length - 1; i >= first; i--) {
        if (candidate[i] === "}") {
          try {
            return JSON.parse(candidate.slice(first, i + 1));
          } catch {}
        }
      }
    }
  }
  throw new Error(
    `Model did not return parseable JSON. First 500 chars:\n${cleaned.slice(0, 500)}`,
  );
}

async function chatRequestStream(messages, options) {
  const startMs = Date.now();
  const body = {
    model: options.model ?? config.model,
    messages,
    temperature: options.temperature ?? config.temperature,
    max_tokens: options.maxTokens ?? config.maxTokens,
    stream: true,
  };

  if (options.jsonMode ?? config.jsonMode) {
    body.response_format = { type: "json_object" };
  }

  const timeoutMs = options.timeoutMs ?? config.llmTimeoutMs ?? 0;
  const controller = new AbortController();
  const timer =
    timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;

  let response;
  let responseText;
  try {
    const fetchStart = Date.now();
    response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    const elapsed = Date.now() - startMs;
    const errMsg =
      err?.name === "AbortError"
        ? `LLM request aborted after ${elapsed}ms`
        : `LLM request failed after ${elapsed}ms: ${err?.name ?? "unknown"} ${err?.message ?? String(err)}`;
    const cause = err?.cause;
    const extra =
      cause
        ? ` cause=${cause?.name ?? "?"} code=${cause?.code ?? "?"} ${cause?.message ?? ""}`
        : "";
    throw new Error(errMsg + extra);
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (!response.ok) {
    const text = await response.text();
    const elapsed = Date.now() - startMs;
    const err = new Error(
      `LLM request failed after ${elapsed}ms: HTTP ${response.status} ${response.statusText}\n${text.slice(0, 2000)}`,
    );
    err.status = response.status;
    err.body = text;
    throw err;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  const maxChars = options.maxResponseChars ?? config.maxResponseChars ?? 30000;
  let done = false;

  try {
    while (!done) {
      const { value, done: readerDone } = await reader.read();
      done = readerDone;
      if (value) {
        buffer += decoder.decode(value, { stream: !done });
        let eoi;
        while ((eoi = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, eoi);
          buffer = buffer.slice(eoi + 1);
          if (line.startsWith("data: ")) {
            const data = line.slice(6).trim();
            if (data === "[DONE]") {
              done = true;
              break;
            }
            try {
              const parsed = JSON.parse(data);
              const delta = parsed?.choices?.[0]?.delta?.content;
              if (typeof delta === "string") {
                content += delta;
                if (content.length > maxChars) {
                  throw new Error(
                    `LLM streamed more than ${maxChars} chars without completing JSON (likely runaway generation). Truncated at ${content.length}.`,
                  );
                }
              }
            } catch {
              // ignore parse errors for non-JSON SSE lines
            }
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  const elapsed = Date.now() - startMs;
  if (!content.trim()) {
    throw new Error(
      `LLM returned empty completion after ${elapsed}ms. Check model/prompt.`,
    );
  }
  return content;
}

async function chatRequest(messages, options = {}) {
  const startMs = Date.now();
  const body = {
    model: options.model ?? config.model,
    messages,
    temperature: options.temperature ?? config.temperature,
    max_tokens: options.maxTokens ?? config.maxTokens,
    stream: false,
  };

  if (options.jsonMode ?? config.jsonMode) {
    body.response_format = { type: "json_object" };
  }

  const timeoutMs = options.timeoutMs ?? config.llmTimeoutMs ?? 0;
  const controller = new AbortController();
  const timer =
    timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;

  let response;
  try {
    response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    const elapsed = Date.now() - startMs;
    if (err?.name === "AbortError")
      throw new Error(`LLM request timed out after ${elapsed}ms`);
    const cause = err?.cause;
    const extra =
      cause
        ? ` cause=${cause?.name ?? "?"} code=${cause?.code ?? "?"} ${cause?.message ?? ""}`
        : "";
    throw new Error(
      `LLM fetch failed after ${elapsed}ms: ${err?.name ?? "unknown"} ${err?.message ?? String(err)}${extra}`,
    );
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (!response.ok) {
    const text = await response.text();
    const elapsed = Date.now() - startMs;
    const err = new Error(
      `LLM request failed after ${elapsed}ms: HTTP ${response.status} ${response.statusText}\n${text.slice(0, 2000)}`,
    );
    err.status = response.status;
    err.body = text;
    throw err;
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new Error(
      `Unexpected LLM response shape: ${JSON.stringify(data).slice(0, 1000)}`,
    );
  }
  return content;
}

export async function chatJson(messages, options = {}) {
  const useStream = options.stream ?? config.llmStream ?? true;
  const startMs = Date.now();

  try {
    let content;
    if (useStream) {
      content = await chatRequestStream(messages, options);
    } else {
      content = await chatRequest(messages, options);
    }
    try {
      return {
        raw: content,
        json: extractJsonObject(content),
        usedJsonMode: options.jsonMode ?? config.jsonMode,
        streamed: useStream,
        elapsedMs: Date.now() - startMs,
      };
    } catch (parseErr) {
      if (useStream) {
        const content2 = await chatRequest(messages, { ...options, stream: false });
        try {
          return {
            raw: content2,
            json: extractJsonObject(content2),
            usedJsonMode: options.jsonMode ?? config.jsonMode,
            streamed: false,
            elapsedMs: Date.now() - startMs,
          };
        } catch {}
      }
      throw parseErr;
    }
  } catch (streamErr) {
    const usedJsonMode = options.jsonMode ?? config.jsonMode;
    const looksLikeJsonModeError =
      usedJsonMode &&
      /response_format|json/i.test(String(streamErr.body ?? streamErr.message));

    if (looksLikeJsonModeError) {
      const content = await chatRequest(messages, {
        ...options,
        stream: false,
        jsonMode: false,
      });
      try {
        return {
          raw: content,
          json: extractJsonObject(content),
          usedJsonMode: false,
          streamed: false,
          elapsedMs: Date.now() - startMs,
        };
      } catch {}
    }

    if (useStream && /JSON|Unexpected end|parse/i.test(String(streamErr.message))) {
      const content = await chatRequest(messages, { ...options, stream: false });
      try {
        return {
          raw: content,
          json: extractJsonObject(content),
          usedJsonMode: options.jsonMode ?? config.jsonMode,
          streamed: false,
          elapsedMs: Date.now() - startMs,
        };
      } catch {}
    }

    throw streamErr;
  }
}

export async function simpleChat(messages, options = {}) {
  const useStream = options.stream ?? config.llmStream ?? true;
  if (useStream) {
    return chatRequestStream(messages, { ...options, jsonMode: false });
  }
  return chatRequest(messages, { ...options, jsonMode: false });
}