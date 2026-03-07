# ClawPulse skill

Open the **ClawPulse** local monitoring dashboard in the default browser.

## What it does

- Opens the dashboard URL (default: `http://127.0.0.1:18790/`).
- If the dashboard is not reachable, it tries to start the bundled proxy script:
  - `monitors/clawpulse-proxy.js`

## Requirements

- macOS (uses the `open` command)
- A running OpenClaw Gateway on **127.0.0.1:18789**
- The ClawPulse proxy listens on **127.0.0.1:18790** (the skill can try to start it)

## Usage

Trigger phrases (examples):

- “open clawpulse”
- “open the dashboard”
- “show the monitor”

## Repo layout

- `SKILL.md` — skill definition
- `scripts/open.js` — launcher script
