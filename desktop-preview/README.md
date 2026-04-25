# Open-Ended Agent Desktop Preview

This is a local, no-dependency browser preview for observing a canonical `open-ended-agent` harness run.

It is not a signed native installer. It starts a local Node.js server and serves a browser UI.

## Requirements

- Node.js 20 or newer
- An existing or newly-created agent home directory
- A separate harness process if you want live cycles to appear

## Start

From the repository root:

```bash
bun run desktop
```

Or directly from this folder:

```bash
node server.mjs
```

The UI opens at:

```text
http://127.0.0.1:5179
```

To observe a specific harness home:

```bash
AGENT_HOME=/path/to/agent-home bun run desktop
```

For VM experiments, run the preview inside the VM with the same `AGENT_HOME` as the harness and bind the preview server to all interfaces:

```bash
cd /tmp/agent
AGENT_HOME=/tmp/agent/agent-home-useful-ui \
HOST=0.0.0.0 \
PORT=5179 \
node desktop-preview/server.mjs
```

## What This Preview Includes

- Observer-only dashboard for the canonical harness
- Live activity cards from `logs/cycles.jsonl`
- Collapsible file tree for the agent home
- Viewer/editor for selected files
- Editable steering files: `drives.md`, `life_policy.md`, `inbox.md`
- Read-only agent outputs: `workspace/`, `artifacts/`, memory, logs, journal, identity, and config

## What It Does Not Do

- It does not run an internal mini-agent loop.
- It does not call a model endpoint.
- It does not provide start/stop controls for the harness.
- It does not provide demo or smoke-test routes.
- It does not write files outside the three editable steering files.

Run the actual harness separately, pointing it at the same `AGENT_HOME`:

```bash
AGENT_HOME=/path/to/agent-home bun run start
```

## Environment Variables

```text
AGENT_HOME                     default ./agent-home
HOST                           default 127.0.0.1
PORT                           default 5179
MODEL                          display label only
AGENT_MAX_CYCLES               display progress target when set
PREVIEW_OBSERVE_EXISTING_CYCLES default 20
NO_OPEN                        set to 1 to avoid opening a browser
```

## Safety Model

The preview is an observer and steering UI, not a sandbox. It does not execute agent actions or shell commands.

The UI permits writes only to:

- `drives.md`
- `life_policy.md`
- `inbox.md`

Use a VM, container, or restricted user account for serious shell-enabled harness runs.

## Known Limitations

- Not a native Tauri/Electron app yet.
- No signed installer.
- No auto-updater.
- Harness process detection uses local process names and may be imperfect across platforms.
