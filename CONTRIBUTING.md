# Contributing

Contributions are welcome. Please open an issue first for discussion.

## Development

```bash
bun install
bun run start        # full run
bun run smoke       # 3-cycle test
bun run doctor      # environment check
bun run inspect     # debug helpers
```

## Testing

- Smoke test: `bun run smoke` (3 cycles)
- Full run: Set `AGENT_MAX_CYCLES=0` for unlimited

## Code Style

- ES modules, Bun runtime
- No additional dependencies beyond runtime
- Keep tooling minimal
