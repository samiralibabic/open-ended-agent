# Design history

This document explains why `open-ended-agent` has its current shape. It preserves decisions and failed approaches that are not visible from the code alone.

## Original hypothesis

The project began with a simple question:

> What happens if a capable local model can continue choosing actions for as long as the machine keeps running, with persistent memory and tools but no fixed task-level stop condition?

The aim was not to prove that the model is alive or conscious. The aim was to make long-running behavior observable.

At the highest level, the runtime is conventional:

```text
instructions + state + memory + tools + LLM call + loop
```

The experimental emphasis is the continuous cadence and open-ended task framing.

## Continuous one-action loop

Each cycle asks the model to choose exactly one action.

```text
load curated state
-> choose one action
-> execute it
-> observe the result
-> update memory
-> repeat
```

One action per cycle creates a clear heartbeat and makes traces easier to inspect. The loop does not need cron, an external heartbeat, or a new human prompt after startup.

`AGENT_MAX_CYCLES=0` means that the harness continues until it is interrupted or fails. A cycle cap can still be used for experiments and shell-enabled runs.

## Standing instructions instead of a required task

Early versions separated user steering into:

- `drives.md`
- `life_policy.md`
- `inbox.md`

That separation was conceptually clean but cumbersome for users. New homes now use:

- `identity.md`: read-only runtime frame
- `agent.md`: user-editable instructions, current goals, and useful-autonomy policy

The model can be given a concrete goal, broad standing instructions, or both.

## Operational summaries, not hidden chain-of-thought

The harness asks for compact observable fields:

- cycle summary
- reason for the selected action
- expected value
- chosen action
- structured memory updates

It does not request or persist raw hidden chain-of-thought. The goal is debuggability through decisions and evidence, not cognition theater.

## Strict JSON action protocol

The harness uses its own strict JSON protocol instead of provider-native tool calling.

Reasons:

- consistent behavior across Ollama, LiteLLM, and `llama.cpp`
- easier logging and replay
- simpler validation and error recovery
- no dependence on model-specific tool-call templates

Partial or greedily extracted JSON was rejected as a strategy. If output is truncated or invalid, the harness performs a bounded retry rather than accepting an incomplete action.

## Memory architecture

The important split is between active memory and evidence.

### Active memory

Loaded repeatedly into context:

- `working_summary.md`
- `long_term.md`
- `open_questions.md`
- `skills.md`
- `usefulness.md`
- `mistakes.md`

Active memory is capped per file and deduplicated. It is intended to be curated state, not a complete transcript.

### Evidence and history

Not loaded wholesale every cycle:

- `logs/cycles.jsonl`
- `logs/errors.jsonl`
- daily journals
- artifacts
- cached sources

This separation was introduced after repeated errors grew `mistakes.md` to hundreds of kilobytes and dominated every subsequent prompt.

## Structured memory updates

The model cannot use file tools to directly rewrite `memory/`, `logs/`, or `journal/`.

Instead, it emits a `memory_updates` object. This provides:

- bounded item sizes
- deduplication
- explicit update types
- a clear audit trail
- protection from accidental direct mutation

`memory_updates.usefulness_add` records outputs, beneficiaries, validation, and candidate projects.

## Artifacts as external cognition

Artifacts are durable work products and context offloading surfaces.

The context contains a compact artifact index rather than all artifact contents. The agent reads individual artifacts only when needed.

This reduces prompt growth while preserving discoverability.

## Chunked web fetching

Returning only the first part of a long page caused the agent to keep searching for alternate copies.

The current design:

1. fetches and extracts full text
2. stores it under `artifacts/web-cache/`
3. returns metadata, a preview, and the cache path
4. lets the model inspect later ranges with `read_file_range`

Raw PDFs and non-text responses are not inserted into context.

## Low-context error recovery

The original fallback used broad `observe` actions. During repeated failures this expanded context and created a bloat loop.

The fallback is now intentionally cheap, typically `sleep`. Errors are logged, but recovery does not automatically perform another broad inspection.

## Shell isolation

Path checks and command deny-lists are containment measures, not a security boundary. A script can escape assumptions that appear safe at the command-string level.

Therefore:

- shell is disabled by default
- serious shell-enabled runs use a VM, container, or restricted OS user
- commands run in `workspace/`
- obvious destructive commands and path escapes are rejected

The project used Lima VM isolation for its own shell experiments.

## Useful autonomy

Broad instructions produced coherent research and synthesis, but usefulness was not a reliable natural attractor. The model often preferred low-risk reading and note-taking.

Useful-autonomy mode adds a standing policy rather than a fixed task. It asks the agent to select small projects that:

- reuse a captured skill
- create a concrete output
- validate something locally where possible
- keep resource use bounded
- record usefulness
- close with a completion note

This preserves self-direction while making productive behavior an explicit target.

## Project closure

One observed weakness was continued probing after a primary output already worked.

The current default `agent.md` therefore includes a cut-loss rule: after several failed attempts on a secondary feature, record uncertainty, preserve the working result, and close or switch projects.

This is a behavioral policy, not hardcoded harness logic.

## Streaming local inference

Slow local inference exposed a transport problem: non-streaming requests could remain silent until Node's response timeout while the server was still generating.

The current design uses:

- streaming SSE by default
- low action-output token limits
- a separate, larger compaction token budget
- explicit response-size limits
- non-streaming fallback when required

The model should put substantial output into files through tools, not into the JSON action response.

## Observer-only UI

The preview UI was deliberately reduced to an observer and steering surface.

It:

- tails the canonical run
- shows live activity and files
- permits edits only to `agent.md`
- does not call a model
- does not execute actions
- does not start or stop the harness

This avoids two competing agent loops and keeps `src/index.js` as the single source of truth.

## Removed snapshots directory

A `snapshots/` directory was declared and documented but never used. It was removed rather than retaining an implied feature.

Snapshots may return only if a concrete recovery or analysis requirement justifies them.

## Communication model under consideration

A continuously running agent should be able to receive messages without becoming a chatbot that waits for prompts.

The proposed distinction is:

```text
agent.md = durable steering and policy
messages = runtime environmental input
```

A future mailbox may use append-only inbox/outbox records. The agent would notice messages during its normal loop and decide how to respond. Messages would not become the heartbeat and would not override identity, policy, or safety boundaries.

Outgoing external communication should initially be approval-gated or draft-only.

## Relationship to OpenClaw, Hermes, and similar agents

`open-ended-agent` is not a fundamentally different computational class from OpenClaw, Hermes, or other agent runtimes. They all combine instructions, memory, tools, and repeated model calls.

The practical difference is emphasis:

- `open-ended-agent` uses a short continuous loop and is designed to expose long-running behavior with minimal abstraction
- task/event-oriented systems often wake on messages, jobs, schedules, or heartbeats and include more integrations and orchestration

A sufficiently short interval can make an event-oriented agent behave similarly. The value of this project is therefore not a claim of architectural uniqueness. It is a small, transparent experimental runtime and a record of the failure modes encountered while running local models continuously.

## Non-goals

The project does not claim:

- consciousness
- independent desires
- AGI
- a secure sandbox
- guaranteed convergence from longer inference
- superiority to mature agent runtimes

Its narrower purpose is to make persistent, open-ended local-agent behavior easy to run, inspect, and compare.
