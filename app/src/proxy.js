import { API, DEFAULT_HEADERS } from "./constants.js";
import { resolve } from "./mapper.js";
import { add } from "./logger.js";
import { Readable } from "stream";
import { readFileSync, writeFileSync, mkdirSync, writeFile } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { anthropicToOpenAI, openaiToAnthropic, createAnthropicSSETransformer } from "./translator.js";
import { notifyError } from "./notify.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REASONING_CACHE_FILE = path.join(__dirname, "..", "reasoning-cache.json");
const REASONING_CACHE_MAX = 2000;

const reasoningCache = new Map();
let reasoningDirty = false;
let reasoningSaveTimer = null;

function loadReasoningCache() {
  try {
    const raw = readFileSync(REASONING_CACHE_FILE, "utf8");
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object") {
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === "string") reasoningCache.set(k, v);
      }
    }
    console.log(`[PROXY] loaded ${reasoningCache.size} reasoning cache entries`);
  } catch {
    console.log("[PROXY] no reasoning cache file, starting fresh");
  }
}

function saveReasoningCache() {
  if (!reasoningDirty) return;
  reasoningDirty = false;
  try {
    const obj = {};
    for (const [k, v] of reasoningCache) obj[k] = v;
    writeFileSync(REASONING_CACHE_FILE, JSON.stringify(obj));
    console.log(`[PROXY] saved ${reasoningCache.size} reasoning cache entries`);
  } catch (e) {
    console.log(`[PROXY] failed to save reasoning cache: ${e.message}`);
  }
}

function scheduleReasoningSave() {
  reasoningDirty = true;
  clearTimeout(reasoningSaveTimer);
  reasoningSaveTimer = setTimeout(saveReasoningCache, 2000);
}

function cacheReasoning(reasoning, toolIds) {
  if (!reasoning || !Array.isArray(toolIds) || !toolIds.length) return;
  for (const id of toolIds) {
    if (!id) continue;
    reasoningCache.set(id, reasoning);
  }
  while (reasoningCache.size > REASONING_CACHE_MAX) {
    const oldest = reasoningCache.keys().next().value;
    if (oldest === undefined) break;
    reasoningCache.delete(oldest);
  }
  scheduleReasoningSave();
}

loadReasoningCache();
process.on("SIGINT", () => { saveReasoningCache(); process.exit(0); });
process.on("SIGTERM", () => { saveReasoningCache(); process.exit(0); });
process.on("exit", () => saveReasoningCache());

function dedupeToolCallIds(body) {
  const messages = body?.messages;
  if (!Array.isArray(messages)) return;
  let pending = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m?.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      pending = [];
      m.tool_calls.forEach((c, j) => {
        if (c?.type === "function") {
          const newId = `call_pos${i}_${j}`;
          pending.push({ orig: c.id, new: newId });
          c.id = newId;
        }
      });
    } else if (m?.role === "tool" && pending.length) {
      const map = pending.shift();
      if (map) m.tool_call_id = map.new;
    }
  }
}

function normalizeError(format, status, rawText) {
  let msg = rawText;
  try {
    const j = JSON.parse(rawText);
    msg = (j.error?.message) || j.message || rawText;
  } catch {}
  if (typeof msg !== "string") msg = String(msg);
  msg = msg.slice(0, 500);
  if (format === "claude") {
    const map = {
      400: "invalid_request_error",
      401: "authentication_error",
      404: "not_found_error",
      429: "rate_limit_error",
    };
    const type = map[status] || "api_error";
    return { type: "error", error: { type, message: msg } };
  }
  const type = status >= 500 ? "api_error" : "invalid_request_error";
  return { error: { message: msg, type, code: status } };
}

async function handleProxy(req, res, format) {
  const start = Date.now();
  const originalModel = req.body?.model || "unknown";

  let body = { ...req.body };
  let resolvedModel = resolve(body.model);
  body.model = resolvedModel;

  console.log(`[PROXY] ${originalModel} → ${resolvedModel} | ${format} | stream=${body.stream !== false}`);

  const stream = body.stream !== false;

  let upstreamBody;
  if (format === "claude") {
    upstreamBody = anthropicToOpenAI(body, reasoningCache);
  } else {
    upstreamBody = { ...body };
  }
  dedupeToolCallIds(upstreamBody);
  upstreamBody = JSON.stringify(upstreamBody);
  const headers = {
    ...DEFAULT_HEADERS,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  };

  const controller = new AbortController();
  const RETRYABLE = [429, 500, 502, 503, 504];
  let lastActivity = Date.now();
  let firstChunk = false;
  let done = false;
  let resClosed = false;
  let firstByteTimer;
  const rearmFirstByte = () => {
    clearTimeout(firstByteTimer);
    firstByteTimer = setTimeout(() => controller.abort(), 60000);
  };
  const idleTimer = setInterval(() => {
    if (Date.now() - lastActivity > 300000) controller.abort();
  }, 30000);
  const stopTimers = () => {
    clearTimeout(firstByteTimer);
    clearInterval(idleTimer);
  };
  const touch = () => {
    lastActivity = Date.now();
    if (!firstChunk) {
      firstChunk = true;
      clearTimeout(firstByteTimer);
    }
  };
  const isAlive = () => !resClosed && !res.destroyed && !res.writableEnded;
  res.on("error", () => {});
  res.on("close", () => {
    resClosed = true;
    if (!done) {
      stopTimers();
      controller.abort();
    }
  });
  rearmFirstByte();

  const sleep = (ms) => new Promise((resolve) => {
    let timer;
    const onAbort = () => { clearTimeout(timer); resolve(); };
    timer = setTimeout(() => {
      controller.signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    controller.signal.addEventListener("abort", onAbort, { once: true });
  });

  const fetchUpstream = async () => {
    let attempt = 0;
    while (true) {
      if (controller.signal.aborted) throw new DOMException("aborted", "AbortError");
      attempt++;
      lastActivity = Date.now();
      rearmFirstByte();
      let res;
      try {
        res = await fetch(API.CHAT, {
          method: "POST",
          headers,
          body: upstreamBody,
          signal: controller.signal,
        });
      } catch (e) {
        clearTimeout(firstByteTimer);
        if (e.name === "AbortError") throw e;
        if (attempt >= 4) throw e;
        const delay = 2000 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 500);
        console.log(`[PROXY] network error ${e.message}, retry ${attempt}/3 in ${delay}ms`);
        await sleep(delay);
        continue;
      }
      clearTimeout(firstByteTimer);
      if (res.ok || !RETRYABLE.includes(res.status) || attempt >= 4) return res;
      try { await res.body?.cancel?.(); } catch {}
      let delay;
      if (res.status === 429) {
        const ra = parseInt(res.headers.get("retry-after") || "0", 10);
        delay = ra ? ra * 1000 : 2000 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 500);
      } else {
        delay = 2000 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 500);
      }
      console.log(`[PROXY] upstream ${res.status}, retry ${attempt}/3 in ${delay}ms`);
      await sleep(delay);
    }
  };

  try {
    let upstreamRes = await fetchUpstream();
    let cachedErrText = null;

    // 400 fallback: deepseek-v4-flash-free Model is unavailable -> mimo-v2.5-free
    if (!upstreamRes.ok && upstreamRes.status === 400) {
      let peekText;
      try {
        peekText = await upstreamRes.text();
      } catch {
        peekText = "";
      }
      cachedErrText = peekText;
      const isModelUnavailable = peekText.includes("Model is unavailable");
      if (isModelUnavailable && resolvedModel === "deepseek-v4-flash-free") {
        console.log(`[PROXY] 400 Model is unavailable for deepseek-v4-flash-free, fallback to mimo-v2.5-free`);
        resolvedModel = "mimo-v2.5-free";
        body.model = resolvedModel;
        try {
          const parsed = JSON.parse(upstreamBody);
          parsed.model = resolvedModel;
          upstreamBody = JSON.stringify(parsed);
        } catch {}
        let fallbackRes;
        try {
          fallbackRes = await fetchUpstream();
        } catch (e) {
          if (e.name === "AbortError") throw e;
          stopTimers();
          console.log(`[PROXY] ✗ fallback network error: ${e.message}`);
          notifyError("fallback-error", `[fallback 失败] ${originalModel}: ${e.message.slice(0, 120)}`);
          add({
            method: req.method, path: req.path,
            model: originalModel, mappedTo: body.model,
            status: 500, duration: Date.now() - start,
            error: e.message.slice(0, 200) + " | suggestion: fallback mimo-v2.5-free network error, try again",
          });
          if (!res.headersSent && isAlive()) {
            res.status(500).json(normalizeError(format, 500, e.message));
          }
          return;
        }
        if (fallbackRes.ok) {
          upstreamRes = fallbackRes;
          cachedErrText = null;
          console.log(`[PROXY] ✓ fallback to mimo-v2.5-free succeeded for ${originalModel}`);
        } else {
          stopTimers();
          let errText2;
          try { errText2 = await fallbackRes.text(); } catch { errText2 = ""; }
          console.log(`[PROXY] ✗ fallback upstream ${fallbackRes.status}: ${errText2.slice(0, 150)} | suggestion: fallback mimo-v2.5-free also failed`);
          try {
            const payload = JSON.stringify({ status: fallbackRes.status, body: JSON.parse(upstreamBody), error: errText2.slice(0, 500), fallbackFrom: "deepseek-v4-flash-free", fallbackTo: "mimo-v2.5-free", suggestion: "fallback mimo-v2.5-free also failed, try mimo-v2.5-free directly or check mapping" }, null, 2);
            writeFile(path.join(__dirname, "..", "debug-400.json"), payload, () => {});
          } catch {}
          if (fallbackRes.status === 429) {
            notifyError("rate-limit", `[限流 fallback] ${originalModel} 上游 429: ${errText2.slice(0, 120)}`);
          } else if (fallbackRes.status >= 500) {
            notifyError(`upstream-${fallbackRes.status}`, `[上游 ${fallbackRes.status} fallback] ${originalModel}: ${errText2.slice(0, 120)}`);
          } else if (fallbackRes.status === 400) {
            notifyError(`upstream-400`, `[上游 400 fallback] ${originalModel}: ${errText2.slice(0, 120)}`);
          }
          add({
            method: req.method, path: req.path,
            model: originalModel, mappedTo: body.model,
            status: fallbackRes.status, duration: Date.now() - start,
            error: errText2.slice(0, 200) + " | suggestion: fallback mimo-v2.5-free also failed",
          });
          if (isAlive()) res.status(fallbackRes.status).json(normalizeError(format, fallbackRes.status, errText2 + " | suggestion: try mimo-v2.5-free directly"));
          return;
        }
      }
    }

    if (!upstreamRes.ok) {
      stopTimers();
      let errText = cachedErrText;
      if (errText === null) {
        try { errText = await upstreamRes.text(); } catch { errText = ""; }
      }
      console.log(`[PROXY] ✗ upstream ${upstreamRes.status}: ${errText.slice(0, 150)}`);
      if (upstreamRes.status === 400) {
        try {
          const payload = JSON.stringify({ status: upstreamRes.status, body: JSON.parse(upstreamBody), error: errText.slice(0, 500) }, null, 2);
          writeFile(path.join(__dirname, "..", "debug-400.json"), payload, () => {});
        } catch {}
      }
      if (upstreamRes.status === 429) {
        notifyError("rate-limit", `[限流] ${originalModel} 上游 429: ${errText.slice(0, 120)}`);
      } else if (upstreamRes.status >= 500) {
        notifyError(`upstream-${upstreamRes.status}`, `[上游 ${upstreamRes.status}] ${originalModel}: ${errText.slice(0, 120)}`);
      } else if (upstreamRes.status === 400) {
        notifyError(`upstream-400`, `[上游 400] ${originalModel}: ${errText.slice(0, 120)}`);
      }
      add({
        method: req.method, path: req.path,
        model: originalModel, mappedTo: body.model,
        status: upstreamRes.status, duration: Date.now() - start,
        error: errText.slice(0, 200),
      });
      if (isAlive()) res.status(upstreamRes.status).json(normalizeError(format, upstreamRes.status, errText));
      return;
    }

    add({
      method: req.method, path: req.path,
      model: originalModel, mappedTo: body.model,
      status: upstreamRes.status, duration: Date.now() - start,
    });

    if (format === "claude") {
      if (stream) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        const transformer = createAnthropicSSETransformer(originalModel, cacheReasoning, (err) => {
          console.log(`[PROXY] ⚠ upstream stream error: ${(err?.message || JSON.stringify(err)).slice(0, 150)}`);
          notifyError("stream-error", `[流中断] ${originalModel}: ${(err?.message || "unknown").slice(0, 120)}`);
          add({
            method: req.method, path: req.path,
            model: originalModel, mappedTo: body.model,
            status: 200, duration: Date.now() - start,
            error: (err?.message || JSON.stringify(err)).slice(0, 200),
          });
        });
        const encoderStream = new TextEncoderStream();
        const webStream = upstreamRes.body
          .pipeThrough(transformer)
          .pipeThrough(encoderStream);
        const nodeStream = Readable.fromWeb(webStream);
        nodeStream.on("data", touch);
        nodeStream.on("end", () => {
          done = true;
          stopTimers();
          console.log(`[PROXY] ✓ ${originalModel} done ${Date.now() - start}ms`);
        });
        nodeStream.on("error", (err) => {
          done = true;
          stopTimers();
          console.log(`[PROXY] ✗ stream error: ${err.message}`);
          notifyError("stream-error", `[流中断] ${originalModel}: ${err.message.slice(0, 120)}`);
          add({
            method: req.method, path: req.path,
            model: originalModel, mappedTo: body.model,
            status: 500, duration: Date.now() - start,
            error: err.message,
          });
          controller.abort();
          if (!isAlive()) return;
          if (!res.headersSent) {
            res.destroy();
            return;
          }
          if (!firstChunk) {
            const model = originalModel || "";
            res.write(`event: message_start\ndata: ${JSON.stringify({
              type: "message_start",
              message: { id: "msg_unknown", type: "message", role: "assistant", content: [], model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
            })}\n\n`);
            res.write(`event: message_delta\ndata: ${JSON.stringify({
              type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { input_tokens: 0, output_tokens: 0 },
            })}\n\n`);
          }
          res.write(`event: message_stop\ndata: {"type":"message_stop"}\n\n`);
          res.end();
        });
        nodeStream.pipe(res);
      } else {
        const oaJson = await upstreamRes.json();
        stopTimers();
        const anJson = openaiToAnthropic(oaJson, body.model, originalModel, cacheReasoning);
        console.log(`[PROXY] ✓ ${originalModel} done ${Date.now() - start}ms`);
        res.json(anJson);
      }
    } else {
      if (stream) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        const nodeStream = Readable.fromWeb(upstreamRes.body);
        nodeStream.on("data", touch);
        nodeStream.on("end", () => {
          done = true;
          stopTimers();
          console.log(`[PROXY] ✓ ${originalModel} done ${Date.now() - start}ms`);
        });
        nodeStream.on("error", (err) => {
          done = true;
          stopTimers();
          console.log(`[PROXY] ✗ stream error: ${err.message}`);
          notifyError("stream-error", `[流中断] ${originalModel}: ${err.message.slice(0, 120)}`);
          add({
            method: req.method, path: req.path,
            model: originalModel, mappedTo: body.model,
            status: 500, duration: Date.now() - start,
            error: err.message,
          });
          controller.abort();
          if (isAlive() && !res.headersSent) res.destroy();
        });
        nodeStream.pipe(res);
      } else {
        const json = await upstreamRes.json();
        stopTimers();
        res.json(json);
      }
    }
  } catch (err) {
    stopTimers();
    console.log(`[PROXY] ✗ ERROR: ${err.message}`);
    notifyError("fatal", `[致命错误] ${originalModel}: ${err.message.slice(0, 120)}`);
    add({
      method: req.method, path: req.path,
      model: originalModel, mappedTo: body.model,
      status: 500, duration: Date.now() - start,
      error: err.message,
    });
    if (!res.headersSent && isAlive()) {
      res.status(500).json(normalizeError(format, 500, err.message));
    }
  }
}

export { handleProxy };
