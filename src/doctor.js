#!/usr/bin/env bun
import { config } from "./config.js";

async function main() {
  console.log("Open-ended agent harness doctor");
  console.log(`base_url=${config.baseUrl}`);
  console.log(`model=${config.model}`);
  console.log(`agent_home=${config.agentHome}`);

  const url = `${config.baseUrl}/chat/completions`;
  const body = {
    model: config.model,
    messages: [
      { role: "user", content: 'Reply with exactly this JSON: {"ok":true}' },
    ],
    temperature: 0,
    max_tokens: 64,
    stream: false,
    response_format: { type: "json_object" },
  };

  let response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const firstError = await response.text();
    console.log(`JSON-mode request failed: HTTP ${response.status}`);
    console.log(firstError.slice(0, 1000));
    console.log("Retrying without response_format...");
    delete body.response_format;
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
    });
  }

  if (!response.ok) {
    const text = await response.text();
    console.error(`LLM endpoint failed: HTTP ${response.status}`);
    console.error(text.slice(0, 2000));
    process.exit(1);
  }

  const data = await response.json();
  console.log("Endpoint response:");
  console.log(JSON.stringify(data, null, 2).slice(0, 2000));
  console.log("Doctor check completed.");
}

main().catch((err) => {
  console.error(err.stack || err.message || err);
  process.exit(1);
});
