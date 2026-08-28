import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { handleProxy } from "./src/proxy.js";
import { fetchModels } from "./src/fetcher.js";
import { getAll, set, remove } from "./src/mapper.js";
import { getAll as getLogs, clear as clearLogs } from "./src/logger.js";
import { MODEL_META, getFreeModelScores } from "./src/modelMeta.js";
import { setNotifyConfig, getNotifyConfig, notifyError, testNotify, getHistory } from "./src/notify.js";
import { writeHeartbeat, writeCrashReport, readCrashReport, readHeartbeat, clearCrashReport, setLastRequest } from "./src/crash.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SETTINGS_PATH = path.join(__dirname, "config", "settings.json");
const PID_PATH = path.join(__dirname, "config", "pid.json");
try {
  const cur = fs.readFileSync(PID_PATH, "utf-8");
  const pidData = JSON.parse(cur);
  if (pidData.pid && pidData.pid !== process.pid) {
    let alive = false;
    try { process.kill(pidData.pid, 0); alive = true; } catch {}
    if (alive) {
      let hbAge = Infinity;
      try { const hb = JSON.parse(fs.readFileSync(path.join(__dirname, "config", "heartbeat.json"), "utf-8")); hbAge = Date.now() - hb.time; } catch {}
      if (hbAge < 30000) { console.error(`[FATAL] 已有实例 PID ${pidData.pid} 仍在运行 (heartbeat ${hbAge}ms)，请先 stop.bat 再启动`); process.exit(1); }
      else console.error(`[WARN] 旧 PID ${pidData.pid} heartbeat stale ${hbAge}ms，视为僵死，抢占锁`);
    }
  }
} catch {}
try { fs.writeFileSync(PID_PATH, JSON.stringify({ pid: process.pid, time: Date.now() }), { flag: "wx" }); } catch (e) {
  if (e.code === "EEXIST") { console.error(`[FATAL] pid.json 已被抢占，另一实例正在启动`); process.exit(1); }
  try { fs.writeFileSync(PID_PATH, JSON.stringify({ pid: process.pid, time: Date.now() })); } catch {}
}
process.on("exit", () => { try { const cur = JSON.parse(fs.readFileSync(PID_PATH, "utf-8")); if (cur.pid === process.pid) fs.unlinkSync(PID_PATH); } catch {} });
let settings = { port: 4096, host: "127.0.0.1" };

try {
  settings = { ...settings, ...JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8")) };
} catch (e) {
  console.error("[WARN] settings.json 解析失败，使用默认配置:", e.message);
}

if (!process.env.HTTPS_PROXY && !process.env.HTTP_PROXY) {
  console.warn("[WARN] 未检测到代理环境变量 (HTTPS_PROXY/HTTP_PROXY)，上游请求可能无法直连");
}
if (!process.execArgv.includes("--use-env-proxy")) {
  console.warn("[WARN] 未使用 --use-env-proxy 启动，Node 可能不会自动使用系统代理，建议使用 node --use-env-proxy server.js 启动");
}

setNotifyConfig(settings.notify);

function saveSettings(next) {
  settings = { ...settings, ...next };
  try {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
    return true;
  } catch (e) {
    console.error("Failed to save settings:", e.message);
    return false;
  }
}

const app = express();

app.use(cors());
app.use(express.json({ limit: "5mb", verify: (req, res, buf) => { if (buf.length > 5 * 1024 * 1024) throw Object.assign(new Error("Body too large"), { status: 413, statusCode: 413 }); } }));
app.use(express.urlencoded({ limit: "5mb", extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// Dashboard under /api/ui so it is reachable via Cloudflare Tunnel rule (/api -> 4096)
// Assets are referenced relatively (tokens.css/app.js), fetches use /api/* /v1/* which route to this server.
// Redirect bare /api/ui -> /api/ui/ so relative asset URLs resolve correctly.
app.use("/api/ui", (req, res, next) => {
  if (req.path === "") return res.redirect(301, "/api/ui/");
  next();
}, express.static(path.join(__dirname, "public")));

const router = express.Router();

router.get("/models", async (req, res) => {
  const upstream = await fetchModels();
  const mappings = getAll();

  // Build model list that includes mapped aliases (Claude model names)
  // so Claude Code can validate them as "available" models
  const aliasModels = Object.keys(mappings).map((alias) => ({
    id: alias,
    object: "model",
    type: "model",
    created: Math.floor(Date.now() / 1000),
    created_at: Math.floor(Date.now() / 1000),
    owned_by: "opencode-proxy",
  }));

  // Merge upstream models with alias models
  const upstreamData = upstream?.data || upstream || [];
  const upstreamList = Array.isArray(upstreamData) ? upstreamData : [];

  const modelMap = new Map();
  for (const m of aliasModels) modelMap.set(m.id, m);
  for (const m of upstreamList) {
    if (!modelMap.has(m.id)) {
      modelMap.set(m.id, { ...m, type: "model", created_at: m.created_at || m.created });
    }
  }

  res.json({
    object: "list",
    data: [...modelMap.values()],
  });
});

// Individual model lookup — Claude Code may call GET /v1/models/<model_id>
router.get("/models/:modelId", (req, res) => {
  const mappings = getAll();
  const modelId = req.params.modelId;

  if (mappings[modelId] || modelId.endsWith("-free") || modelId === "big-pickle") {
    return res.json({
      id: modelId,
      object: "model",
      type: "model",
      created: Math.floor(Date.now() / 1000),
      created_at: Math.floor(Date.now() / 1000),
      owned_by: "opencode-proxy",
    });
  }

  res.status(404).json({ error: { message: `Model ${modelId} not found` } });
});

router.post("/messages/count_tokens", (req, res) => {
  const body = req.body || {};
  const text = JSON.stringify({ system: body.system || [], messages: body.messages || [], tools: body.tools || [] });
  const inputTokens = Math.max(1, Math.ceil((text.length + 100) / 4));
  res.json({ input_tokens: inputTokens });
});

router.post("/chat/completions", (req, res) => {
  setLastRequest({ path: req.path, model: req.body?.model, format: "openai", bodyBytes: JSON.stringify(req.body || {}).length });
  handleProxy(req, res, "openai");
});
router.post("/messages", (req, res) => {
  setLastRequest({ path: req.path, model: req.body?.model, format: "claude", bodyBytes: JSON.stringify(req.body || {}).length });
  handleProxy(req, res, "claude");
});

router.get("/organizations", (req, res) => {
  res.json({ data: [{ id: "default", name: "default" }] });
});
router.post("/organizations", (req, res) => {
  res.status(200).json({ id: "default", name: "default", created_at: Math.floor(Date.now() / 1000) });
});

app.use("/v1", router);
app.use("/v1/v1", router);  // Claude Code: BASE_URL/v1 + /v1/messages = /v1/v1/messages

const api = express.Router();

api.get("/status", (req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    port: settings.port,
    target: "https://opencode.ai/zen/v1",
    memory: process.memoryUsage(),
    proxy: {
      hasEnv: !!process.env.HTTPS_PROXY || !!process.env.HTTP_PROXY,
      useEnvProxy: process.execArgv.includes("--use-env-proxy"),
      httpProxy: process.env.HTTP_PROXY || process.env.HTTPS_PROXY || null,
    },
    heartbeat: readHeartbeat(),
  });
});
api.get("/crash", (req, res) => {
  const report = readCrashReport();
  if (!report) return res.json({ crash: null });
  res.json({ crash: report });
});
api.delete("/crash", (req, res) => {
  clearCrashReport();
  res.json({ ok: true });
});
api.get("/heartbeat", (req, res) => {
  res.json(readHeartbeat() || { error: "no heartbeat" });
});

api.get("/logs", (req, res) => res.json(getLogs()));
api.delete("/logs", (req, res) => { clearLogs(); res.json({ ok: true }); });

api.get("/mappings", (req, res) => res.json(getAll()));
api.post("/mappings", (req, res) => {
  const { alias, model } = req.body;
  if (!alias || !model) return res.status(400).json({ error: "alias and model required" });
  set(alias, model);
  res.json({ ok: true, mappings: getAll() });
});
api.delete("/mappings/:alias", (req, res) => {
  remove(req.params.alias);
  res.json({ ok: true, mappings: getAll() });
});

api.get("/settings", (req, res) => res.json(settings));

api.get("/notify", (req, res) => {
  res.json({ config: getNotifyConfig(), history: getHistory() });
});

api.post("/notify", (req, res) => {
  const cfg = req.body || {};
  const notifyCfg = {
    enabled: Boolean(cfg.enabled),
    exe: typeof cfg.exe === "string" && cfg.exe.trim() ? cfg.exe.trim() : settings.notify?.exe || "",
    debounceMs: Number(cfg.debounceMs) || settings.notify?.debounceMs || 300000,
    rateLimitDebounceMs: Number(cfg.rateLimitDebounceMs) || settings.notify?.rateLimitDebounceMs || 600000,
  };
  const ok = saveSettings({ notify: notifyCfg });
  setNotifyConfig(notifyCfg);
  res.json({ ok, config: getNotifyConfig(), history: getHistory() });
});

api.post("/notify/test", async (req, res) => {
  const summary = req.body?.summary || "[测试] OpenCode 代理错误通知通道正常";
  const result = await testNotify(summary);
  res.json({ ...result, config: getNotifyConfig(), history: getHistory() });
});

api.get("/model-meta", (req, res) => res.json(MODEL_META));
api.get("/model-scores", (req, res) => res.json(getFreeModelScores()));
api.get("/debug-400", (req, res) => {
  try {
    const p = path.join(__dirname, "debug-400.json");
    const data = JSON.parse(fs.readFileSync(p, "utf-8"));
    res.json(data);
  } catch (e) {
    res.status(404).json({ error: "no debug data", message: e.message });
  }
});

app.use("/api", api);

app.use((req, res) => {
  res.status(404).json({ type: "error", error: { type: "not_found_error", message: `Cannot ${req.method} ${req.path}` } });
});

app.use((err, req, res, next) => {
  console.error(err);
  const status = err.status || err.statusCode || 500;
  if (status === 413) {
    return res.status(413).json({ type: "error", error: { type: "request_too_large", message: "Request body too large" } });
  }
  res.status(status).json({ type: "error", error: { type: status >= 500 ? "api_error" : "invalid_request_error", message: "Internal server error" } });
});

const server = app.listen(settings.port, settings.host, () => {
  console.log(`OpenCode Free Proxy running on http://${settings.host}:${settings.port}`);
  console.log(`Dashboard: http://${settings.host}:${settings.port}`);
});
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
server.requestTimeout = 310000;
server.maxHeadersCount = 20;
server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error(`[FATAL] 端口 ${settings.port} 被占用，请检查是否有其他进程占用该端口或更换端口`);
    process.exit(1);
  }
  throw e;
});

setInterval(writeHeartbeat, 10000).unref();
writeHeartbeat();
setInterval(() => {
  const m = process.memoryUsage();
  try { fs.appendFileSync(path.join(__dirname, "config", "heap.csv"), `${Date.now()},${m.heapUsed},${m.rss},${m.heapTotal},${m.external}\n`); } catch {}
  if (m.heapUsed > 600 * 1024 * 1024) {
    const r = writeCrashReport(new Error(`heap warn ${m.heapUsed}`), "heap-warn");
    console.error(`[HEAP-WARN] ${m.heapUsed} lastReq ${r.lastReq?.bodyBytes || 0}B`);
  }
}, 5000).unref();
process.on("exit", (code) => {
  try { fs.appendFileSync(path.join(__dirname, "config", "exit.log"), JSON.stringify({ time: new Date().toISOString(), code, pid: process.pid, heap: process.memoryUsage(), lastReq: (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, "config", "heartbeat.json"), "utf-8")).lastReq; } catch { return null; } })() }) + "\n"); } catch {}
});
process.on("SIGBREAK", () => {
  const r = writeCrashReport(new Error("SIGBREAK"), "SIGBREAK");
  try { notifyError("fatal", `[崩溃] SIGBREAK heap ${r.memory.heapUsed} lastReq ${r.lastReq?.bodyBytes || 0}B`); } catch {}
  shutdownAndExit(1);
});
process.on("beforeExit", (code) => { console.error(`[beforeExit] ${code}`); });

function shutdownAndExit(code = 1) {
  console.error(`[FATAL] unhandled error, shutting down gracefully`);
  try { server.close(() => process.exit(code)); } catch { process.exit(code); }
  setTimeout(() => process.exit(code), 5000).unref();
}
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err);
  const report = writeCrashReport(err, "uncaughtException");
  try { notifyError("fatal", `[崩溃] uncaughtException: ${(err?.message || String(err)).slice(0, 120)} | lastReq ${report.lastReq?.model || "?"} ${report.lastReq?.bodyBytes || 0}B`); } catch {}
  shutdownAndExit(1);
});
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
  const err = reason instanceof Error ? reason : new Error(String(reason));
  const report = writeCrashReport(err, "unhandledRejection");
  try { notifyError("fatal", `[崩溃] unhandledRejection: ${(err?.message || String(err)).slice(0, 120)} | lastReq ${report.lastReq?.model || "?"} ${report.lastReq?.bodyBytes || 0}B`); } catch {}
  shutdownAndExit(1);
});
process.on("SIGINT", () => { server.close(() => process.exit(0)); });
process.on("SIGTERM", () => { server.close(() => process.exit(0)); });