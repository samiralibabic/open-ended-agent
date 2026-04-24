import { config } from './config.js';

function extractJsonObject(text) {
  const cleaned = text.trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {}

  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  if (first >= 0 && last > first) {
    const candidate = cleaned.slice(first, last + 1);
    return JSON.parse(candidate);
  }
  throw new Error(`Model did not return parseable JSON. First 500 chars:\n${cleaned.slice(0, 500)}`);
}

async function chatRequest(messages, options = {}) {
  const body = {
    model: options.model ?? config.model,
    messages,
    temperature: options.temperature ?? config.temperature,
    max_tokens: options.maxTokens ?? config.maxTokens,
    stream: false
  };

  if (options.jsonMode ?? config.jsonMode) {
    body.response_format = { type: 'json_object' };
  }

  const timeoutMs = options.timeoutMs ?? 0;
  const controller = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;

  let response;
  try {
    response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error(`LLM request timed out after ${timeoutMs}ms`);
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (!response.ok) {
    const text = await response.text();
    const err = new Error(`LLM request failed: HTTP ${response.status} ${response.statusText}\n${text.slice(0, 2000)}`);
    err.status = response.status;
    err.body = text;
    throw err;
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new Error(`Unexpected LLM response shape: ${JSON.stringify(data).slice(0, 1000)}`);
  }
  return content;
}

export async function chatJson(messages, options = {}) {
  try {
    const content = await chatRequest(messages, { ...options, jsonMode: options.jsonMode ?? config.jsonMode });
    return { raw: content, json: extractJsonObject(content), usedJsonMode: options.jsonMode ?? config.jsonMode };
  } catch (err) {
    const usedJsonMode = options.jsonMode ?? config.jsonMode;
    const looksLikeJsonModeError = usedJsonMode && /response_format|json/i.test(String(err.body ?? err.message));
    if (!looksLikeJsonModeError) throw err;

    const content = await chatRequest(messages, { ...options, jsonMode: false });
    return { raw: content, json: extractJsonObject(content), usedJsonMode: false };
  }
}

export async function simpleChat(messages, options = {}) {
  return chatRequest(messages, { ...options, jsonMode: false });
}
