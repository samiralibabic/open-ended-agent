# Sample Run: 20 Cycles

This is a condensed trace of a 20-cycle run on a local Mac Studio (M1 Max, 32 GB RAM) using TurboQuant (Qwen3.5-27B at 262k context, Metal backend).

The agent was started from a blank sandbox with no externally assigned task. It was given only the standing drives defined in `drives.md`: improve understanding of the sandbox and the broader world, reduce uncertainty, learn from external sources, build artifacts.

## Cycle Milestones

| Cycle | Action | Milestone |
|-------|--------|-----------|
| 1-3 | sleep, read_file | Baseline inspection and harness stability verification |
| 4 | read_file open_questions.md | Found 2 preserved questions from a previous run |
| 5-6 | web_search, fetch_url | Started research on autonomous agent architectures |
| 7 | write_file | First artifact: MIT 2025 AI Agent Index summary |
| 8-12 | web_search, fetch_url | Pattern literature review (ML Mastery, SitePoint, Google Cloud) |
| 13 | write_file | Second artifact: partial agentic design patterns summary |
| 14 | fetch_url | Cross-source pattern comparison; new question about taxonomy discrepancies |
| 15 | fetch_url | Antonio Gulli's 21-chapter pattern catalog |
| 16 | sleep | Transient TurboQuant timeout; error recovered from |
| 17-20 | web_search, fetch_url | Attempting to read full pattern definitions via Substack, Medium |

## Key Behavioral Observations

- **Self-directed research**: The agent picked up its own preserved questions from a prior run and acted on them without external prompting.
- **Source comparison**: It noticed that different sources (ML Mastery: 7 patterns, SitePoint: 6 patterns, Gulli: 21 patterns) use different taxonomies and created a new question to resolve the discrepancy.
- **Context offloading**: After fetching sources, it wrote structured summaries to `artifacts/` to free working memory — visible in cycle 7 and 13.
- **Error recovery**: Cycle 16 hit a TurboQuant timeout. The agent recognized it as transient infrastructure error and resumed with `web_search` on cycle 17, no trajectory loss.
- **Persistent memory**: Long-term memory survived restarts and was consulted each cycle. The agent built on previous research rather than starting over.

## What the Agent Did Not Do (in 20 cycles)

- Did not write to `workspace/`
- Did not update `skills.md`
- Stayed entirely in reading/evidence-gathering mode
- Did not yet synthesize the pattern comparison into a final artifact
- The "transition from reading to building" threshold was not crossed in this run

## Files in This Example

```
memory/
  working_summary.md    — agent's current operational self-model
  open_questions.md      — research questions it is tracking
  long_term.md          — durable facts from fetched sources
  mistakes.md           — failure modes learned
  skills.md             — reusable procedures (added during run)

artifacts/
  mit-2025-agent-index-summary.md
  agent-design-patterns-comparison.md

logs/
  cycles.redacted.jsonl  — first 20 cycles, structured, no raw model output
```

## Reproducing This Run

```bash
# Start TurboQuant (llama.cpp with TurboQuant KV cache)
./turboquant/start-turboquant.sh

# Run the agent
OPENAI_BASE_URL=http://127.0.0.1:8080/v1 \
OPENAI_API_KEY=local-stack \
MODEL=qwen3.5-27b-turboquant \
AGENT_CONTEXT_CHAR_BUDGET=120000 \
bun run start
```

The first cycle takes several minutes on TurboQuant (prompt prefill at ~95 tokens/sec). Subsequent cycles are faster once the prompt cache is warm.