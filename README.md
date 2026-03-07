# ClawPulse skill

Open the **ClawPulse** local monitoring dashboard in the default browser.

## What it does

- Opens the dashboard URL (default: `http://127.0.0.1:18790/`).
- If the dashboard is not reachable, it tries to start the local proxy script:
  - `~/.openclaw/monitors/gateway-proxy-enhanced.js`

## Requirements

- macOS (uses the `open` command)
- A running ClawPulse proxy on port **18790** (or let the skill try to start it)

## Usage

Trigger phrases (examples):

- “open clawpulse”
- “open the dashboard”
- “show the monitor”

## Repo layout

- `SKILL.md` — skill definition
- `scripts/open.js` — launcher script
