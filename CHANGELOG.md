# Changelog

All notable changes to this project will be documented in this file.

## [0.3.0] — 2026-04-24 — First public experimental release

### Added

- **Chunked fetch cache**: `fetch_url` now saves full extracted text to `artifacts/web-cache/` and returns a preview + cache path. The agent can use `read_file_range(path, start, length)` to inspect later chunks.
- **`read_file_range` action**: new tool to read arbitrary byte ranges from cached files, enabling chunked inspection of long fetched pages.
- **Artifact index injection**: `buildContext` now includes a compact artifact index (names, sizes, first headings) instead of full artifact contents, reducing context cost while keeping artifacts discoverable.
- **Memory health reporting**: each cycle now prints a context breakdown: `ctx=N chars (mem=N logs=N tree=N obs=N artifacts=N)`.
- **`getMemoryHealth` function**: exposes per-component context sizes for monitoring.
- **Per-file memory caps with tail mode**: `readMemoryBundle` now uses fixed per-file caps (identity: 6k, drives: 6k, inbox: 10k, working_summary: 12k, long_term: 18k, open_questions: 10k, skills: 10k, mistakes: 6k). Long files use tail mode, showing the last N chars with a header note.
- **Deduplication in memory appends**: `applyMemoryUpdates` uses `Set` normalization and existence checks to prevent repeated identical entries in long_term.md, open_questions.md, skills.md, and mistakes.md. Items capped at 500 chars.
- **Prompts updated**: system prompt now instructs the agent to use `read_file_range` for chunked reading and to actively manage context via artifacts.

### Changed

- `AGENT_RECENT_LOG_CYCLES` default from 8 to 6
- `AGENT_CONTEXT_CHAR_BUDGET` example for TurboQuant updated to 120000
- Context budget allocation revised: memory 40%, logs 25%, tree 10%, observation 10%, artifacts 10%, config 5%
- User prompt now includes artifact index section
- PDF and non-text responses skipped in `fetch_url` with explanatory notes

### Fixed

- Harness no longer feeds raw PDF/binary content into model context
- Error fallback uses `sleep` instead of `observe` to avoid context-bloated recovery loops
- Previous observation uses `summarizeResultForContext` for bounded, structured output

## [0.2.0] — First harness release

- Initial open-ended agent loop
- OpenAI-compatible endpoint support
- Persistent memory files
- Sandbox tools (file ops, web search, fetch, shell)
- JSONL logging and daily journals
- Memory compaction every N cycles