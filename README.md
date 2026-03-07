# ClawPulse skill

A tiny skill that opens the **ClawPulse** local monitoring dashboard in your default browser.

- Dashboard (default): `http://127.0.0.1:18790/`
- Gateway (expected): `ws://127.0.0.1:18789`

## What it does

1. Tries to reach the dashboard URL.
2. If the dashboard is not reachable, it starts the bundled ClawPulse proxy server in the background.
3. Opens the dashboard in your browser.

## Installation

### Option A (recommended): install via `npx skills add`

This is the standard way to install skills from GitHub.

```bash
npx skills add wenhanweime/clawpulse-skill
```

If you want to skip prompts and install globally:

```bash
npx skills add wenhanweime/clawpulse-skill --yes --global
```

After installation, your agent should be able to use the skill automatically.

### Option B: download/clone manually

If you just want the files:

```bash
git clone https://github.com/wenhanweime/clawpulse-skill.git
cd clawpulse-skill
```

> Note: manual clone alone does **not** automatically register the skill with your agent.
> Use `npx skills add ...` if you want it wired into your agent’s skills folder.

## Requirements

- macOS (the launcher uses the `open` command)
- OpenClaw Gateway running locally on **127.0.0.1:18789**

## Configuration (optional)

You can override defaults via environment variables:

- `CLAWPULSE_URL` (default: `http://127.0.0.1:18790/`)
- `CLAWPULSE_PROXY_SCRIPT` (default: `monitors/clawpulse-proxy.js` inside this repo when installed)

Example:

```bash
CLAWPULSE_URL=http://127.0.0.1:18790/ npx skills add wenhanweime/clawpulse-skill --yes --global
```

## How it works (repo layout)

- `SKILL.md` — skill definition (metadata + procedure)
- `scripts/open.js` — launcher script that opens the dashboard and starts the proxy if needed
- `monitors/clawpulse-proxy.js` — bundled proxy server (HTTP + SSE + JSON status)
- `monitors/clawpulse.html` — dashboard UI

## Troubleshooting

- If `http://127.0.0.1:18790/` won’t open, make sure OpenClaw Gateway is running on `127.0.0.1:18789`.
- If port `18790` is already in use, stop the conflicting process or change the port in the proxy script.
