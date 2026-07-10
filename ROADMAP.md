# Roadmap

This roadmap separates experimental questions from product-facing work. Priorities may change as new long-running traces expose different failure modes.

## Current status

- `v0.3.0` is the first public experimental release.
- `main` contains unreleased `v0.4.0-alpha.0` work.
- The current alpha includes streaming local inference, useful-autonomy policy, a usefulness ledger, one editable `agent.md`, and an observer-only browser UI.

## Near-term priorities

### 1. Local mailbox and agent communication

Add runtime messaging without making the agent wait for prompts.

Proposed shape:

```text
agent-home/
  messages/
    inbox.jsonl
    outbox.jsonl
```

Requirements:

- incoming messages are environmental inputs, not the loop trigger
- the agent continues working when no messages exist
- messages do not override `identity.md`, `agent.md`, or tool restrictions
- the UI can leave a message and display agent replies
- message state is durable and inspectable
- duplicate delivery and unread/seen semantics are explicit

Before implementation, compare this with using an external runtime such as Hermes or OpenClaw as the communication/integration layer.

### 2. Clean useful-autonomy benchmark

Run a clean-start VM experiment using the current `agent.md` model.

Target sequence:

```text
open start
-> choose bounded project
-> reuse skill
-> create output
-> validate locally
-> record usefulness
-> close project
-> choose another project or sleep
```

Record separately:

- research
- synthesis
- operationalization
- local validation
- skill capture/reuse
- project closure
- disk/network cost
- transport and JSON errors

### 3. Project closure and cut-loss behavior

Validate whether the current policy stops low-value secondary probing.

Desired behavior:

- preserve a working primary result
- stop after several failed attempts on a secondary feature
- record uncertainty
- update the completion note
- move to another bounded project or sleep

Prefer policy changes in `agent.md` over hardcoded stop logic unless repeated runs show policy is insufficient.

### 4. v0.4.0 release validation

Release criteria:

- fresh clone and clean `agent-home` smoke test
- full capped run with streaming and no recurring transport failure
- useful-autonomy output validated locally
- structured usefulness and skill updates work
- observer UI accurately follows the canonical run
- UI writes only `agent.md`
- docs match current behavior
- disk growth remains bounded in a representative VM run

## Comparative experiments

### Hermes/OpenClaw comparison

Run the same local model and policy through another mature runtime.

Hold constant:

- model and inference endpoint
- VM/container environment
- tools and filesystem scope
- starting instructions
- cycle/time budget

Compare:

- setup complexity
- memory quality
- useful outputs
- validation behavior
- idle and loop behavior
- communication support
- observability
- recovery from invalid JSON and slow inference
- resource use

The purpose is to determine which parts of this harness are genuinely useful versus already solved better elsewhere.

## Communication beyond the local UI

After a local mailbox works, consider gated adapters:

- webhooks and local events
- GitHub issues/comments
- email
- calendars and task systems
- other agent runtimes

Initial outgoing behavior should be draft-only or require explicit human approval. A continuously running local agent should not receive unrestricted public posting or email-send authority by default.

## Reliability and testing

Planned work:

- unit tests for memory caps, deduplication, and structured updates
- tests for strict JSON parsing and retry behavior
- tests for SSE parsing and truncated streams
- tests for filesystem path containment
- tests for shell-policy rejection
- tests for observer UI write restrictions
- replay tests from sanitized cycle logs
- CI for supported Node/Bun versions

## Observability

Possible improvements:

- per-project timeline grouping
- explicit message timeline when mailbox support exists
- clearer distinction between idle, sleeping, blocked, and failed
- exportable run reports
- comparison view across two agent homes
- resource metrics: tokens, wall time, disk, and network use

Do not expose raw hidden chain-of-thought. Continue using operational summaries, actions, results, and memory diffs.

## Packaging and UX

Later possibilities:

- one-command VM/container setup for shell-enabled runs
- packaged native observer app
- guided creation of `agent.md`
- safe presets for wild, research, and useful-autonomy runs
- import/export of complete agent homes

The observer UI should remain separate from the canonical agent loop.

## Open research questions

- Does continuous cadence produce meaningfully different behavior from a very short external heartbeat?
- Can the agent reuse skills across unrelated projects rather than merely recording them?
- How many useful micro-projects can it complete before memory quality degrades?
- Which memory should be model-owned, runtime-owned, or generated automatically?
- Does explicit usefulness policy improve outputs without causing repetitive busywork?
- Can messages be integrated without turning the runtime into a prompt-waiting chatbot?
- When should the agent sleep, compact, or deliberately leave the model unloaded?
- What capabilities are better delegated to Hermes/OpenClaw or another orchestration layer?

## Deferred ideas

- periodic full snapshots, unless a concrete recovery need appears
- unrestricted host shell access
- autonomous public posting
- claims about consciousness or AGI
