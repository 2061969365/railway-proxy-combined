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

function isResponsesModel(model) {
  // Only muse-spark family requires /v1/responses (verified via zen docs table @ai-sdk/openai)
  // Keep narrow to avoid misrouting gpt-* which use chat/completions
  return typeof model === "string" && model.startsWith("muse-spark");
}

function chatBodyToResponses(chatBody) {
  try {
    const parsed = JSON.parse(chatBody);
    const input = [];
    const instructions = parsed.messages?.filter(m => m.role === "system").map(m => typeof m.content === "string" ? m.content : "").join("\n") || undefined;
    for (const m of (parsed.messages || [])) {
      if (m.role === "system") continue;
      if (m.role === "user") {
        const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        input.push({ role: "user", content: [{ type: "input_text", text }] });
      } else if (m.role === "assistant") {
        const text = typeof m.content === "string" ? m.content : "";
        if (text) input.push({ role: "assistant", content: [{ type: "output_text", text }] });
        if (Array.isArray(m.tool_calls)) {
          for (const tc of m.tool_calls) {
            input.push({ type: "function_call", call_id: tc.id, name: tc.function?.name || "", arguments: tc.function?.arguments || "{}" });
          }
        }
      } else if (m.role === "tool") {
        input.push({ type: "function_call_output", call_id: m.tool_call_id, output: typeof m.content === "string" ? m.content : JSON.stringify(m.content) });
      }
    }
    const out = { model: parsed.model, input, stream: parsed.stream !== false };
    if (instructions) out.instructions = instructions;
    if (parsed.tools) out.tools = parsed.tools.map(t => ({ type: "function", name: t.function?.name || t.name, description: t.function?.description || "", parameters: t.function?.parameters || t.input_schema || { type: "object", properties: {} } }));
    if (parsed.tool_choice) {
      const tc = parsed.tool_choice;
      if (tc === "auto" || tc === "none" || tc === "required") out.tool_choice = tc;
      else if (tc.type) out.tool_choice = tc.type === "tool" ? { type: "function", name: tc.name } : tc.type;
    }
    if (parsed.max_tokens) out.max_output_tokens = parsed.max_tokens;
    if (parsed.temperature != null) out.temperature = parsed.temperature;
    if (parsed.top_p != null) out.top_p = parsed.top_p;
    return JSON.stringify(out);
  } catch { return chatBody; }
}

function responsesToChat(responsesJson, originalModel) {
  try {
    const j = typeof responsesJson === "string" ? JSON.parse(responsesJson) : responsesJson;
    const outText = (j.output || []).filter(o => o.type === "message").flatMap(o => o.content || []).filter(c => c.type === "output_text").map(c => c.text).join("\n");
    const reasoning = (j.output || []).filter(o => o.type === "reasoning").flatMap(o => o.summary || []).map(s => s.text).join("\n");
    const toolCalls = (j.output || []).filter(o => o.type === "function_call").map(o => ({ id: o.call_id || o.id, type: "function", function: { name: o.name, arguments: o.arguments || "{}" } }));
    const hasTool = toolCalls.length > 0;
    return {
      id: j.id || `gen-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now()/1000),
      model: j.model || originalModel,
      choices: [{ index: 0, finish_reason: hasTool ? "tool_calls" : (j.status === "completed" ? "stop" : "length"), message: { role: "assistant", content: outText || "", reasoning_content: reasoning || undefined, reasoning: reasoning || undefined, tool_calls: hasTool ? toolCalls : undefined } }],
      usage: { prompt_tokens: j.usage?.input_tokens || 0, completion_tokens: j.usage?.output_tokens || 0, total_tokens: j.usage?.total_tokens || 0 }
    };
  } catch { return responsesJson; }
}

function createResponsesToChatSSETransformer(originalModel) {
  let buffer = "";
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const toolCalls = new Map();
  return new TransformStream({
    transform(chunk, controller) {
      const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      buffer += text;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith("data: ")) continue;
        const d = t.slice(6);
        if (d === "[DONE]") continue;
        let ev;
        try { ev = JSON.parse(d); } catch { continue; }
        if (ev.type === "response.output_text.delta" && ev.delta) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id: ev.item_id || "gen", object: "chat.completion.chunk", created: Math.floor(Date.now()/1000), model: originalModel, choices: [{ index: 0, delta: { content: ev.delta }, finish_reason: null }] })}\n\n`));
        } else if (ev.type === "response.output_item.added" && ev.item?.type === "function_call") {
          const idx = ev.output_index ?? 0;
          toolCalls.set(ev.item.id || `call_${idx}`, { id: ev.item.call_id || ev.item.id, name: ev.item.name || "", args: "" });
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id: ev.item.id || "gen", object: "chat.completion.chunk", created: Math.floor(Date.now()/1000), model: originalModel, choices: [{ index: 0, delta: { tool_calls: [{ index: idx, id: ev.item.call_id || ev.item.id, type: "function", function: { name: ev.item.name || "", arguments: "" } }] }, finish_reason: null }] })}\n\n`));
        } else if (ev.type === "response.function_call_arguments.delta" && ev.delta) {
          const itemId = ev.item_id;
          const tc = toolCalls.get(itemId);
          if (tc) {
            tc.args += ev.delta;
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id: itemId, object: "chat.completion.chunk", created: Math.floor(Date.now()/1000), model: originalModel, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ev.delta } }] }, finish_reason: null }] })}\n\n`));
          }
        } else if (ev.type === "response.output_item.done" && ev.item?.type === "function_call") {
          // finalize tool call if needed
        } else if (ev.type === "response.completed" || ev.type === "response.incomplete") {
          const usage = ev.response?.usage || {};
          // If we had tool calls, ensure finish_reason is tool_calls
          const hasTool = toolCalls.size > 0;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id: ev.response?.id || "gen", object: "chat.completion.chunk", created: Math.floor(Date.now()/1000), model: originalModel, choices: [{ index: 0, delta: {}, finish_reason: hasTool ? "tool_calls" : (ev.type === "response.completed" ? "stop" : "length") }], usage: { prompt_tokens: usage.input_tokens || 0, completion_tokens: usage.output_tokens || 0, total_tokens: usage.total_tokens || 0 } })}\n\n`));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        } else if (ev.type === "response.failed" || ev.type === "error") {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: ev.error || ev } )}\n\n`));
        }
      }
    },
    flush(controller) {
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
    }
  });
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
    // Direct routing for known responses models (avoid 4x retry delay)
    let upstreamRes;
    let cachedErrText = null;
    if (isResponsesModel(resolvedModel)) {
      console.log(`[PROXY] ${resolvedModel} is responses model, direct to /v1/responses`);
      const responsesBody = chatBodyToResponses(upstreamBody);
      try {
        const respRes = await fetch(API.RESPONSES, { method: "POST", headers, body: responsesBody, signal: controller.signal });
        if (respRes.ok) {
          if (!stream) {
            const txt = await respRes.text();
            const chatJson = responsesToChat(txt, originalModel);
            upstreamRes = new Response(JSON.stringify(chatJson), { status: 200, headers: { "Content-Type": "application/json" } });
          } else {
            // Keep raw responses SSE, will be translated below in the stream handling branch
            upstreamRes = respRes;
            // Mark as responses for downstream translation
            upstreamRes._isResponses = true;
          }
        } else {
          upstreamRes = respRes;
          try { cachedErrText = await respRes.text(); } catch { cachedErrText = ""; }
        }
      } catch (e) {
        if (e.name === "AbortError") throw e;
        console.log(`[PROXY] direct responses error: ${e.message}, fallback to chat`);
        upstreamRes = await fetchUpstream();
      }
    } else {
      upstreamRes = await fetchUpstream();
    }

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

    // 500 fallback: try responses endpoint for any model that fails on chat (future-proof for responses-based free models)
    if (!upstreamRes.ok && upstreamRes.status >= 500) {
      let peek500;
      try { peek500 = cachedErrText ?? await upstreamRes.text(); } catch { peek500 = ""; }
      cachedErrText = peek500;
      console.log(`[PROXY] ${upstreamRes.status} for ${resolvedModel}, trying responses endpoint...`);
      const responsesBody = chatBodyToResponses(upstreamBody);
      let respRes;
      try {
        respRes = await fetch(API.RESPONSES, { method: "POST", headers, body: responsesBody, signal: controller.signal });
      } catch (e) {
        if (e.name === "AbortError") throw e;
        console.log(`[PROXY] responses fallback network error: ${e.message}`);
      }
      if (respRes && respRes.ok) {
        if (!stream) {
          const txt = await respRes.text();
          const chatJson = responsesToChat(txt, originalModel);
          upstreamRes = new Response(JSON.stringify(chatJson), { status: 200, headers: { "Content-Type": "application/json" } });
          console.log(`[PROXY] ✓ responses fallback succeeded for ${originalModel}`);
        } else {
          upstreamRes = respRes;
          upstreamRes._isResponses = true;
          console.log(`[PROXY] ✓ responses fallback (stream) for ${originalModel}`);
        }
        cachedErrText = null;
      } else if (respRes) {
        try { const t = await respRes.text(); console.log(`[PROXY] ✗ responses fallback ${respRes.status}: ${t.slice(0,150)}`); } catch {}
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
        let sourceStream = upstreamRes.body;
        if (upstreamRes._isResponses) {
          sourceStream = sourceStream.pipeThrough(createResponsesToChatSSETransformer(originalModel));
        }
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
        const webStream = sourceStream
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
        let sourceStream = upstreamRes.body;
        // Translate responses SSE -> chat SSE if needed
        if (upstreamRes._isResponses) {
          sourceStream = sourceStream.pipeThrough(createResponsesToChatSSETransformer(originalModel));
        }
        const nodeStream = Readable.fromWeb(sourceStream);
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
