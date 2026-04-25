# Open-Ended Agent

An experimental local harness for running an LLM as a persistent, open-ended agent.

Instead of giving the model a fixed task, the harness gives it **standing drives**:

- preserve operational continuity
- inspect and understand its environment
- reduce uncertainty through small reversible experiments
- learn from external sources
- create notes, artifacts, and tools
- avoid destructive actions
- consolidate memory over time

The model runs in repeated inference cycles. Each cycle loads curated memory, recent logs, and sandbox state; the model chooses one action; the harness executes it; results are logged; memory is updated; the loop continues.

This is not a claim about consciousness or AGI. It is a practical experiment in long-running local agent behavior with durable memory and inspectable traces.

## Quick start

### Prerequisites

- [Bun](https://bun.sh) (no npm dependencies required)
- An OpenAI-compatible chat completions endpoint

### Minimal run (Ollama)

```bash
OPENAI_BASE_URL=http://localhost:11434/v1 \
OPENAI_API_KEY=local \
MODEL=qwen3.5:8b \
bun run start
```

Any reasonably capable OpenAI-compatible local model works. Larger context windows help but are not required.

### Run with LiteLLM / local stack

```bash
OPENAI_BASE_URL=http://localhost:4000/v1 \
OPENAI_API_KEY=local-stack \
MODEL=qwen3.5-35b-a3b \
bun run start
```

### Run with llama.cpp / TurboQuant (large context)

```bash
# Start your llama.cpp server separately
OPENAI_BASE_URL=http://127.0.0.1:8080/v1 \
OPENAI_API_KEY=local-stack \
MODEL=qwen3.5-27b-turboquant \
AGENT_CONTEXT_CHAR_BUDGET=120000 \
bun run start
```

See [Advanced: llama.cpp / TurboQuant](#advanced-llama-cpp-turboquant) for TurboQuant-specific setup.

### Smoke test (3 cycles)

```bash
OPENAI_BASE_URL=http://localhost:11434/v1 \
MODEL=qwen3.5:8b \
AGENT_MAX_CYCLES=3 \
bun run smoke
```

### Endpoint doctor

```bash
OPENAI_BASE_URL=http://localhost:11434/v1 \
MODEL=qwen3.5:8b \
bun run doctor
```

## What the harness does

Each cycle:

1. Loads identity, drives, optional life policy, inbox, memory files, recent logs, and sandbox tree from disk
2. Sends curated context to the model via `/v1/chat/completions`
3. Requires strict JSON with one chosen action
4. Applies memory updates from the model
5. Executes the chosen action
6. Logs the action and observation to JSONL and daily journal files
7. Optionally prints context health (memory/log/tree sizes)
8. Repeats until `AGENT_MAX_CYCLES` or Ctrl+C

By default there is no task-level stop condition:

```bash
AGENT_MAX_CYCLES=0   # run until Ctrl+C
```

## Directory structure

The harness creates this structure inside `agent-home/` (default: `./agent-home`):

```
agent-home/
  identity.md          — static identity statement
  drives.md            — standing drives (loaded every cycle)
  life_policy.md       — optional standing policy for useful-autonomy runs
  inbox.md             — human notes, readable while running
  memory/
    working_summary.md  — current operational self-model
    long_term.md        — durable facts and learned rules
    open_questions.md   — active research questions
    skills.md           — reusable procedures
    usefulness.md       — useful outputs, beneficiaries, validation, candidate projects
    mistakes.md          — failure modes and loops to avoid
  journal/
    YYYY-MM-DD.md       — daily cycle journal
  workspace/            — agent's writable work area
  artifacts/            — structured notes and summaries
    web-cache/          — cached full-text fetched pages
  logs/
    cycles.jsonl        — every cycle (full structured log)
    compactions.jsonl   — memory compaction events
    errors.jsonl         — harness errors
  snapshots/
```

The model can write only to `workspace/` and `artifacts/`. It updates memory through the structured `memory_updates` channel, not by directly rewriting memory files. Useful-output notes are appended with `memory_updates.usefulness_add`.

## Internet access

Enabled by default:

```bash
AGENT_WEB=1
```

Available tools:

- `web_search`: DuckDuckGo HTML search, parsed locally
- `fetch_url`: fetches and strips web pages to text, saves full content to `artifacts/web-cache/`

Fetched pages are cached so the agent can use `read_file_range` to inspect later chunks. This prevents truncation from forcing repeated fetches or source-switching.

## Shell access

Disabled by default. To enable restricted shell commands:

```bash
AGENT_SHELL=1 bun run start
```

Shell commands run inside `agent-home/workspace`. The harness rejects dangerous commands (sudo, rm, chmod, ssh, etc.) and path escapes, but this is not a formal security sandbox. For serious containment, use a VM, container, or a macOS user account with limited permissions.

## Steer it while running

Edit `agent-home/inbox.md` while the agent is running. The loop reads it every cycle:

```md
# Inbox

Investigate whether your search behavior is becoming repetitive.
Prefer building a small artifact over more journaling.
```

## Useful-autonomy mode

For a pure open-ended run, leave `agent-home/life_policy.md` minimal and observe what the agent does from its broad drives.

For a product-oriented run, edit `agent-home/life_policy.md` before or during execution:

```md
# Life Policy

When idle for several cycles, choose one small reversible project.

The project should:

- reuse at least one captured skill
- produce one concrete artifact, script, dataset, guide, or test result
- validate at least one claim with a safe local experiment when possible
- keep disk/network usage small
- finish with a short completion note: what was produced, what was validated, what remains uncertain

Prefer projects useful to a human observer, not only to your own internal notes. Record useful outputs and candidate projects in memory/usefulness.md.
```

This preserves autonomy while making usefulness an explicit feedback target. The agent is not assigned a fixed task; it is given a criterion for productive idle recovery.

## Desktop Preview UI

This repository includes a no-dependency browser-based preview in `desktop-preview/`. It is not a signed native app yet, but it provides the intended consumer-facing shape: experiment status, progress, friendly live activity cards, and a simple agent-home file browser.

```bash
bun run desktop
```

To watch an existing harness run, point the preview at the same agent home:

```bash
AGENT_HOME=/path/to/agent-home bun run desktop
```

For VM experiments, run the preview inside the VM with `HOST=0.0.0.0` and the same `AGENT_HOME` as the harness. The preview tails `logs/cycles.jsonl`; it does not call a model or own the agent loop. In the UI, users can edit only `drives.md`, `life_policy.md`, and `inbox.md`; agent outputs in `workspace/` and `artifacts/` are view-only.

## Important environment variables

```text
OPENAI_BASE_URL              default http://localhost:11434/v1
OPENAI_API_KEY               default local
MODEL                        default qwen3.5:8b
AGENT_HOME                   default ./agent-home
AGENT_MAX_CYCLES             0 = no stop condition; Ctrl+C to stop
AGENT_CONTEXT_CHAR_BUDGET    default 90000 chars per cycle
AGENT_RECENT_LOG_CYCLES      default 6
AGENT_COMPACT_EVERY          default 20 (memory compaction interval)
AGENT_TEMPERATURE            default 0.4
AGENT_MAX_TOKENS             default 768 (max tokens for action selection; kept low to avoid long local inference stalls)
AGENT_COMPACTION_MAX_TOKENS  default 1536 (max tokens for memory compaction)
AGENT_LLM_STREAM             default 1 (streaming SSE; recommended for slow local endpoints)
AGENT_LLM_TIMEOUT_MS         default 0 (no harness-side abort; streaming avoids long response waits)
AGENT_JSON_MODE              default 1
AGENT_WEB                    default 1
AGENT_SHELL                  default 0
AGENT_SHELL_TIMEOUT_MS       default 15000
AGENT_FETCH_TIMEOUT_MS       default 20000
AGENT_FETCH_TEXT_CHARS       default 12000 (preview size per fetch)
AGENT_CONTEXT_RESULT_CHARS   default 6000 (previous observation truncation)
AGENT_OBSERVE_MAX_ENTRIES    default 80 (file tree entries per observe)
```

**Note on `max_tokens`**: `AGENT_MAX_TOKENS` and `AGENT_COMPACTION_MAX_TOKENS` are per-request harness settings. They do not require changing the shared inference server launch configuration.

## Safety model

The harness provides containment, not full isolation.

**Current boundaries:**

- all relative filesystem paths are resolved inside `AGENT_HOME`
- writes are restricted to `workspace/` and `artifacts/`
- shell access is off by default
- shell commands run in `workspace/`
- obvious destructive shell commands are rejected
- every cycle is logged to JSONL
- memory compaction is logged
- active memory uses per-file caps and deduplication to prevent unbounded growth

**Known risks:**

- Web content can be hostile or misleading; the harness does not sanitize fetched pages
- Long-running agents can enter loops; monitor `logs/cycles.jsonl`
- Active memory can bloat if not curated; the compaction cycle every 20 cycles helps
- Enabling shell access increases risk substantially
- Local models may emit invalid JSON or unstable actions; the harness has error recovery but is not failsafe

For serious runs, use a separate macOS user, VM, or container with network egress controls.

## Design notes

The harness intentionally avoids provider-native tool calling. Instead, the model emits strict JSON with one action. This works consistently across LiteLLM, Ollama-compatible endpoints, and llama.cpp-compatible endpoints.

The model receives an **operational prompt**, not a hidden chain-of-thought prompt. It logs short cycle summaries and observable decisions, which makes long runs debuggable without requiring private reasoning traces.

**Key design decisions:**

- No task given from outside — the model acts on its own drives
- Optional `life_policy.md` lets experiments separate wild autonomy from useful autonomy
- Memory is append-only with deduplication to prevent repeated identical entries
- Fetch caches full text for chunked reading instead of returning partial content
- Artifact index injected each cycle instead of full artifact contents
- Error fallback is low-context (`sleep`) not broad (`observe`) to prevent bloat loops

## Early observed behavior

In local runs, the agent:

- inspected its blank sandbox before taking any action
- created research questions in memory without external prompting
- selected its own preserved questions after a restart
- searched the web for agent architecture sources
- detected disagreement between source taxonomies (ML Mastery: 7 patterns, SitePoint: 6, Antonio Gulli: 21)
- created structured artifacts to offload context
- noticed a repeated-error failure mode and updated `mistakes.md`
- recovered from TurboQuant timeout errors without losing research trajectory

This behavior emerged from the standing drives and persistent memory — not from a pre-written task script.

## First experiment suggestion

Run 20-50 cycles with web enabled and shell disabled:

```bash
AGENT_MAX_CYCLES=50 AGENT_WEB=1 AGENT_SHELL=0 bun run start
```

Then check:

```
agent-home/journal/
agent-home/logs/cycles.jsonl
agent-home/memory/working_summary.md
agent-home/memory/long_term.md
agent-home/artifacts/
agent-home/workspace/
```

Look for:

- whether it explores before acting, or acts first
- how it uses memory files (working_summary vs long_term vs open_questions)
- whether it creates artifacts and what it writes them about
- whether it notices and avoids repeated action patterns
- whether errors cause trajectory loss or clean recovery

Then enable shell only if the first run shows stable, directed behavior.

---

## Advanced: llama.cpp / TurboQuant

TurboQuant is a llama.cpp fork with KV cache compression (TurboQuant types) that enables much larger live context windows on Apple Silicon.

**What it enables:** Qwen3.5-27B at full 262,144 token context on M1 Max with 32 GB RAM.

**Setup:**

```bash
# Build TurboQuant (requires cmake, Xcode tools)
cd turboquant
git clone https://github.com/TheTom/llama-cpp-turboquant.git
cd llama-cpp-turboquant
git checkout feature/turboquant-kv-cache
cmake -B build -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON -DCMAKE_BUILD_TYPE=Release
cmake --build build -j

# Start the llama-server
./build/bin/llama-server \
  -m ~/ollama-models/qwen3.5-27b-unsloth/Qwen3.5-27B-Q4_K_M.gguf \
  --alias qwen3.5-27b-turboquant \
  --host 127.0.0.1 --port 8080 \
  --jinja -ngl 99 -fa on -c 262144 \
  --cache-type-k q8_0 --cache-type-v turbo4 \
  --reasoning off --reasoning-budget 0 \
  -n 512 -np 1 --metrics
```

**Performance:** ~75-90 tokens/sec prompt prefill, ~6-7 tokens/sec decode on M1 Max. First-cycle latency is high due to cold prompt cache. Follow-up cycles are faster once prefixes are cached.

**TurboQuant-specific env:**

```bash
OPENAI_BASE_URL=http://127.0.0.1:8080/v1
MODEL=qwen3.5-27b-turboquant
AGENT_CONTEXT_CHAR_BUDGET=120000
AGENT_FETCH_TEXT_CHARS=12000
AGENT_CONTEXT_RESULT_CHARS=6000
AGENT_OBSERVE_MAX_ENTRIES=80
```

This harness works fine with standard llama.cpp servers too — just remove the TurboQuant-specific env vars and use a lower `AGENT_CONTEXT_CHAR_BUDGET` (e.g. 32768 or 65536).

## Examples

See `examples/sample-run-20-cycles/` for a sanitized 20-cycle trace with memory files, artifacts, and a human-readable milestone summary.

```bash
ls examples/sample-run-20-cycles/
# memory/  artifacts/  logs/  README.md
```
