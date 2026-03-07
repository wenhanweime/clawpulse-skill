#!/usr/bin/env node

/**
 * ClawPulse launcher
 *
 * Opens the ClawPulse dashboard in the default browser.
 * If the dashboard isn't reachable, attempts to restart the proxy script,
 * then opens again.
 */

const { spawn, spawnSync } = require('node:child_process');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_URL = 'http://127.0.0.1:18790/';
const DEFAULT_PROXY_SCRIPT = path.join(__dirname, '..', 'monitors', 'clawpulse-proxy.js');

const url = process.env.CLAWPULSE_URL || DEFAULT_URL;
const proxyScript = process.env.CLAWPULSE_PROXY_SCRIPT || DEFAULT_PROXY_SCRIPT;

function requestOnce(u, timeoutMs = 800) {
  return new Promise((resolve) => {
    try {
      const isHttps = u.startsWith('https://');
      const lib = isHttps ? https : http;
      const req = lib.get(u, (res) => {
        // drain
        res.resume();
        resolve(res.statusCode && res.statusCode >= 200 && res.statusCode < 500);
      });
      req.on('error', () => resolve(false));
      req.setTimeout(timeoutMs, () => {
        req.destroy();
        resolve(false);
      });
    } catch {
      resolve(false);
    }
  });
}

function openBrowser(u) {
  // macOS
  spawn('open', [u], { stdio: 'ignore', detached: true }).unref();
}

function restartProxy() {
  // Best-effort start: launch the proxy in the background.
  // If the port is already in use, this will fail silently.
  const child = spawn(process.execPath, [proxyScript], {
    stdio: 'ignore',
    detached: true,
  });
  child.unref();
}

async function main() {
  const ok = await requestOnce(url);
  if (!ok) {
    restartProxy();
    await new Promise((r) => setTimeout(r, 1200));
  }
  openBrowser(url);
}

main().catch(() => {
  openBrowser(url);
});
