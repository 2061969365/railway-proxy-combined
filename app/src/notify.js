import { spawn } from "child_process";
import path from "path";

const DEFAULT_CONFIG = {
  enabled: false,
  exe: "",
  debounceMs: 300000,
  rateLimitDebounceMs: 600000,
};

const PROXY_ENV = {
  HTTP_PROXY: process.env.HTTP_PROXY || process.env.HTTPS_PROXY || "http://127.0.0.1:10809",
  HTTPS_PROXY: process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "http://127.0.0.1:10809",
  NODE_USE_ENV_PROXY: "1",
};

let config = { ...DEFAULT_CONFIG };
const lastSent = new Map();
const history = [];
const MAX_HISTORY = 30;

function setNotifyConfig(cfg) {
  if (!cfg || typeof cfg !== "object") return;
  config = {
    ...config,
    ...cfg,
    debounceMs: Number(cfg.debounceMs) > 0 ? Number(cfg.debounceMs) : config.debounceMs,
    rateLimitDebounceMs: Number(cfg.rateLimitDebounceMs) > 0 ? Number(cfg.rateLimitDebounceMs) : config.rateLimitDebounceMs,
  };
}

function getNotifyConfig() {
  return { ...config, lastSent: Object.fromEntries(lastSent), history: [...history] };
}

function debounceFor(kind) {
  return kind === "rate-limit" ? config.rateLimitDebounceMs : config.debounceMs;
}

function pushHistory(entry) {
  history.unshift(entry);
  if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
}

function spawnNotify(summary) {
  return new Promise((resolve) => {
    const exe = config.exe;
    if (!exe) {
      console.log(`[NOTIFY] no exe configured, skip: ${summary}`);
      return resolve({ ok: false, error: "no-exe" });
    }
    const exeDir = path.dirname(exe);
    try {
      const child = spawn(exe, ["notify", "--source", "claude", "--task", summary, "--force"], {
        cwd: exeDir,
        env: { ...process.env, ...PROXY_ENV },
        windowsHide: true,
        stdio: "ignore",
      });
      let done = false;
      const finish = (ok, error) => {
        if (done) return;
        done = true;
        resolve({ ok, error });
      };
      child.on("error", (err) => {
        console.log(`[NOTIFY] spawn error: ${err.message}`);
        finish(false, err.message);
      });
      child.on("close", (code) => {
        console.log(`[NOTIFY] exited code=${code} task="${summary}"`);
        finish(code === 0, code === 0 ? null : `exit code ${code}`);
      });
      setTimeout(() => {
        try { child.kill(); } catch {}
        finish(false, "timeout");
      }, 30000);
    } catch (err) {
      console.log(`[NOTIFY] failed to spawn: ${err.message}`);
      resolve({ ok: false, error: err.message });
    }
  });
}

async function notifyError(kind, summary) {
  if (!config.enabled) return { sent: false, reason: "disabled" };
  const now = Date.now();
  const debounceMs = debounceFor(kind);
  const last = lastSent.get(kind) || 0;
  if (now - last < debounceMs) {
    return { sent: false, reason: "debounced", remainingMs: debounceMs - (now - last) };
  }
  lastSent.set(kind, now);
  pushHistory({ time: now, kind, summary, status: "sending" });
  const result = await spawnNotify(summary);
  const entry = history[0];
  if (entry && entry.time === now) {
    entry.status = result.ok ? "sent" : "failed";
    entry.error = result.error || undefined;
  }
  return { sent: result.ok, error: result.error };
}

async function testNotify(summary) {
  const msg = summary || "[测试] OpenCode 代理错误通知通道正常";
  pushHistory({ time: Date.now(), kind: "test", summary: msg, status: "sending" });
  const result = await spawnNotify(msg);
  const entry = history[0];
  if (entry && entry.kind === "test") {
    entry.status = result.ok ? "sent" : "failed";
    entry.error = result.error || undefined;
  }
  return { ok: result.ok, error: result.error };
}

function getHistory() {
  return history.slice(0, MAX_HISTORY);
}

export { setNotifyConfig, getNotifyConfig, notifyError, testNotify, getHistory };