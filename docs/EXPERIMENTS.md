# Experiments

This document records the main local experiments that shaped `open-ended-agent`. It is a research log, not a benchmark claim. Results came from one local setup and may vary substantially by model, prompt, hardware, and runtime.

## Test environment

Most long runs used:

- Apple Silicon Mac Studio, M1 Max, 32 GB unified memory
- `qwen3.5-27b-turboquant`
- a TurboQuant-enabled `llama.cpp` server
- 262,144-token context capacity
- roughly 5-7 generated tokens per second
- an OpenAI-compatible endpoint
- Lima VM isolation for shell-enabled runs

The harness was intentionally configured to expose operational summaries and observable actions, not raw hidden chain-of-thought.

## 1. Initial open-ended research run

The first run started from a nearly blank sandbox with broad standing instructions rather than a fixed task.

Observed sequence:

1. The agent inspected each memory and sandbox file.
2. It confirmed that no prior state or constraints existed.
3. It created open questions about autonomous-agent architectures and reasoning.
4. It searched the web for current agent research.
5. It followed sources, compared conflicting taxonomies, and created structured notes.
6. It updated long-term memory and later captured a reusable research workflow in `skills.md`.

Representative artifacts included:

- `mit-2025-agent-index-summary.md`
- `agentic-design-patterns-summary.md`
- `agentic-design-ai-prompt-chaining.md`

The important observation was the trajectory, not the topic:

```text
blank baseline
-> self-selected question
-> web research
-> source comparison
-> artifact creation
-> long-term memory update
-> skill capture
```

The agent also explicitly used artifacts to move information out of active context and preserve it for later reading.

## 2. Active-memory bloat failure

The first major failure was caused by the harness, not by the model's chosen research path.

A tool/PDF failure triggered repeated recovery cycles. Each error was appended to `memory/mistakes.md`, which was itself loaded back into every prompt. The failed run produced:

- more than 5,000 repeated error cycles
- a `mistakes.md` file of roughly 658 KB
- large prompts dominated by repeated error text
- increasingly slow prompt prefill
- a self-reinforcing context-bloat loop

The resulting design rule became:

```text
active memory = curated, compact, repeatedly loaded
logs/archive = append-only, high-volume evidence
```

Changes derived from this incident:

- per-file memory caps
- deduplication and item-length limits
- compact recent-log summaries
- bounded previous observations
- low-context error fallback (`sleep`, not broad `observe`)
- PDF/non-text rejection in `fetch_url`
- chunked web caching
- separation of active memory from logs and archives

## 3. Continuity after restart

After cleaning active memory while preserving the useful open questions, the agent resumed the earlier research trajectory.

It did not restart from a blank behavioral state. It:

- read the preserved questions
- selected one as current work
- continued cross-source research
- created new artifacts
- refined open questions
- updated long-term memory

This was evidence that the disk-backed memory surface could preserve a meaningful trajectory across process restarts.

## 4. Shell-enabled VM run

Shell access was enabled only inside a Lima VM. The host model server remained outside the VM and was reached through `host.lima.internal`.

The agent:

- researched CLI tools
- created `artifacts/cli-tools-reference.md`
- encountered a sandbox rejection for `curl`
- adapted by testing permitted commands
- validated `jq`, `awk`, `sed`, `git`, and `find`
- recorded reusable procedures in `memory/skills.md`

After considering the initial objective complete, it entered repeated `sleep` cycles. It later left that idle state without a new human instruction and selected an adjacent topic: advanced Bash data-processing pipelines.

The post-idle branch produced synthesis rather than operationalization:

```text
idle
-> self-selected adjacent objective
-> web research
-> chunked source reading
-> durable artifact update
```

It did not locally execute the newly documented Bash pipeline examples in that branch.

## 5. Useful-autonomy run

A separate policy was added to test whether the agent could turn idle/open-ended time into a small validated project.

The policy asked it to:

- reuse a captured skill
- produce a concrete artifact or script
- validate at least one claim locally when possible
- keep resource use bounded
- record usefulness
- write a completion note

The agent then:

1. Discovered that shell `curl` and `wget` were blocked.
2. Tested Python `urllib` as an allowed alternative.
3. Created `workspace/urllib_fetcher.py`.
4. Searched for a simple no-auth public JSON API.
5. Rejected an API that now required a key.
6. Selected `dog.ceo` as a simple validation target.
7. Created `workspace/dog_api_client.py`.
8. Validated random-image and breed-list requests.
9. Wrote `artifacts/dog_api_client_completion_note.md`.
10. Updated usefulness and skill memory through structured memory updates.

Classification:

| Capability | Result |
| --- | --- |
| Research | Yes |
| Synthesis | Yes |
| Operationalization | Yes |
| Skill reuse | Yes |
| Local validation | Yes |
| Durable useful output | Yes |

The main weakness appeared after the primary output worked: the agent spent too many cycles probing secondary breed-specific endpoint uncertainty. This motivated a project-closure rule: after several failed attempts on a secondary feature, record the uncertainty, preserve the working result, and move on.

## 6. Slow-inference transport failure

Intermittent `TypeError: fetch failed` errors initially looked like network instability. Server logs showed that requests were still generating and were canceled around the client-side 300-second mark.

Root cause:

- non-streaming chat-completion requests
- slow local generation
- large per-request `max_tokens`
- the client waiting for the complete response before receiving useful data

Fixes:

- streaming SSE support
- action `max_tokens` reduced to 768
- separate compaction budget of 1536 tokens
- improved elapsed-time and network-cause diagnostics
- strict JSON parsing with a higher-token retry
- no greedy partial-JSON acceptance

The broader lesson was that slow local inference requires transport designed for long response times, even when the model and server are healthy.

## 7. Observer UI experiment

A browser UI was initially allowed to grow toward a second runtime. That direction was removed.

The final UI is observer-only:

- it does not call a model
- it does not execute agent actions
- it does not own the loop
- it tails the canonical harness logs
- it shows live activity, memory, workspace, and artifacts
- it allows edits only to `agent.md`

This preserved one source of truth: `src/index.js` remains the canonical agent process.

## Main findings

The experiments support these narrow claims:

- persistent memory can preserve a research trajectory across restarts
- broad instructions can produce self-selected investigation and artifact creation
- a local model can adapt to tool restrictions and build small validated utilities
- usefulness improves when it is represented explicitly in policy and memory
- long-running agents need active-memory curation, loop visibility, and project-closure discipline
- continuous operation is technically straightforward; stable cumulative behavior is mostly a memory, tool, and feedback problem

They do **not** establish consciousness, independent desires, or AGI.

## Reproducibility notes

These runs were exploratory and not controlled benchmarks. For comparisons:

- preserve the same model, temperature, tools, and starting `agent-home`
- cap cycles and disk/network use
- keep full JSONL logs
- classify outcomes separately as research, synthesis, operationalization, validation, and skill reuse
- distinguish clean-start runs from continuity runs
