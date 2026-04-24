# Mistakes / Loops To Avoid

- Do not retry broad `observe` after harness/model/tool errors; use low-context recovery actions (sleep, reflect, read a specific file).
- Do not treat repeated connection or timeout errors as durable new knowledge after the first occurrence.
- Active memory files must stay curated. High-volume error traces belong in `logs/`, not in memory files.
- `fetch_url` should not feed raw PDFs or large non-text responses into context.
- When a fetched page is truncated, use the cache path to read later chunks rather than re-fetching or searching for alternate sources.
