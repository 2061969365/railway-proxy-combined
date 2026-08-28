function anthropicToOpenAI(body, reasoningCache) {
  const messages = [];
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
  const thinkingFamily = getThinkingFamily(body.model);

  const sysText = extractSystemText(body.system);
  if (sysText) messages.push({ role: "system", content: sysText });

  if (body.messages) {
    for (const msg of body.messages) {
      const blocks = Array.isArray(msg.content) ? msg.content : null;

      if (msg.role === "assistant") {
        let oaContent = textFromBlocks(msg.content);
        // DeepSeek 拒绝 content 为 null 的 assistant 消息（oh-my-pi #788）
        if (thinkingFamily && oaContent == null) oaContent = "";
        const oa = { role: "assistant", content: oaContent };
        const thinking = blocks
          ? blocks.filter((b) => b.type === "thinking").map((b) => b.thinking || "").filter(Boolean).join("\n")
          : "";
        if (thinking) {
          oa.reasoning_content = thinking;
        } else {
          const toolIds = blocks
            ? blocks.filter((b) => b.type === "tool_use").map((b) => b.id).filter(Boolean)
            : [];
          for (const id of toolIds) {
            const cached = reasoningCache?.get(id);
            if (cached) { oa.reasoning_content = cached; break; }
          }
          // DeepSeek/Kimi thinking 模式 + tools：assistant 消息缺 reasoning_content 必 400。
          // 生产验证（hermes #15478）兜底：DeepSeek 用 ""，Kimi 用 " " 更稳。仅对 thinking 系生效。
          if (hasTools && thinkingFamily && !oa.reasoning_content) {
            oa.reasoning_content = thinkingFamily === "kimi" ? " " : "";
          }
        }
        const toolCalls = blocks
          ? blocks
              .filter((b) => b.type === "tool_use" && b.name)
              .map((b) => ({
                id: b.id || `toolu_${Math.random().toString(36).slice(2, 10)}`,
                type: "function",
                function: {
                  name: b.name,
                  arguments: JSON.stringify(b.input ?? {}),
                },
              }))
          : [];
        if (toolCalls.length) oa.tool_calls = toolCalls;
        messages.push(oa);
      } else if (msg.role === "user" && blocks?.some((b) => b.type === "tool_result")) {
        // 防御：同 tool_call_id 重复 tool_result 去重（litellm #16711）
        const seen = new Set();
        for (const b of blocks) {
          if (b.type !== "tool_result") continue;
          const id = b.tool_use_id || `toolu_unknown`;
          if (seen.has(id)) continue;
          seen.add(id);
          messages.push({
            role: "tool",
            tool_call_id: id,
            content: toolResultText(b),
          });
        }
        const other = textFromBlocks(blocks.filter((b) => b.type !== "tool_result"));
        if (other) messages.push({ role: "user", content: other });
      } else {
        messages.push({ role: msg.role, content: normalizeContent(msg.content) });
      }
    }
  }

  const oa = {
    model: stripModelSuffix(body.model),
    messages,
    stream: body.stream !== false,
  };

  // max_tokens clamp：免费端点输出上限通常较小（LiteLLM #22249）
  const MAX_OUTPUT = 128000;
  if (body.max_tokens) oa.max_tokens = Math.min(Number(body.max_tokens) || MAX_OUTPUT, MAX_OUTPUT);
  if (body.temperature != null) oa.temperature = body.temperature;
  if (body.top_p != null) oa.top_p = body.top_p;
  if (body.stop_sequences) oa.stop = body.stop_sequences;
  if (oa.stream) oa.stream_options = { include_usage: true };

  // Claude Code subagent 会同时发 thinking:disabled + reasoning_effort → DeepSeek 400（CC #65863）
  if (body.thinking?.type === "disabled") {
    delete oa.reasoning_effort;
    delete oa.output_config;
  } else {
    if (body.reasoning_effort) oa.reasoning_effort = body.reasoning_effort;
  }

  if (Array.isArray(body.tools) && body.tools.length) {
    oa.tools = body.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description || "",
        parameters: t.input_schema || { type: "object", properties: {} },
      },
    }));
  }

  if (body.tool_choice) {
    const tc = body.tool_choice;
    if (tc.type === "any") oa.tool_choice = "required";
    else if (tc.type === "auto" || tc.type === "none") oa.tool_choice = tc.type;
    else if (tc.type === "tool" && tc.name) {
      oa.tool_choice = { type: "function", function: { name: tc.name } };
    }
  }

  return oa;
}

function extractSystemText(system) {
  if (!system) return "";
  if (typeof system === "string") return system;
  if (system.text) return system.text;
  if (Array.isArray(system)) {
    return system
      .map((b) => (b?.type === "text" ? b.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

// 返回推理模型族："deepseek" | "kimi" | null
// 仅对需要回传 reasoning_content 的 thinking 系模型生效。
// 注意：legacy deepseek-reasoner 语义相反（须删除该字段），故不包含。
function getThinkingFamily(model) {
  if (!model || typeof model !== "string") return null;
  const m = model.toLowerCase();
  if (m.startsWith("deepseek-v4") || m.includes("deepseek-v4")) return "deepseek";
  if (m.startsWith("kimi-") || m.includes("kimi")) return "kimi";
  return null;
}

// Claude Code 交互式会话会把模型选择器显示标签（如 "claude-opus-4-8[1m]"）透传
// 进请求体，需剥离 [N] 后缀（CC #60913）
function stripModelSuffix(model) {
  if (!model || typeof model !== "string") return model;
  return model.replace(/\[\d+[mks]?\]/i, "").trim();
}

function normalizeContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "image") return "[Image]";
      if (block.type === "thinking") return "";
      if (block.type === "tool_result") return "";
      if (block.type === "tool_use") return "";
      return JSON.stringify(block);
    }).filter(Boolean).join("\n");
  }
  return String(content);
}

function textFromBlocks(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "image") return "[Image]";
      return "";
    }).filter(Boolean).join("\n");
  }
  return "";
}

function toolResultText(block) {
  const c = block.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((b) => b.text || JSON.stringify(b)).join("\n");
  return JSON.stringify(c);
}

function openaiToAnthropic(oaBody, reqModel, originalModel, onTurnComplete) {
  const choice = oaBody.choices?.[0] || {};
  const msg = choice.message || {};

  const blocks = [];
  if (msg.content) blocks.push({ type: "text", text: msg.content });

  let hasToolUse = false;
  const toolIds = [];
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      let input = {};
      try {
        input = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {};
      } catch {
        input = { _raw: tc.function?.arguments };
      }
      const id = tc.id || `toolu_${Math.random().toString(36).slice(2, 10)}`;
      blocks.push({
        type: "tool_use",
        id,
        name: tc.function?.name || "",
        input,
      });
      hasToolUse = true;
      toolIds.push(id);
    }
  }

  if (hasToolUse && msg.reasoning_content && onTurnComplete) {
    onTurnComplete(msg.reasoning_content, toolIds);
  }

  const resp = {
    id: oaBody.id,
    type: "message",
    role: msg.role || "assistant",
    content: blocks,
    model: originalModel || reqModel || oaBody.model || "",
    stop_reason: hasToolUse ? "tool_use" : mapFinishReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: oaBody.usage?.prompt_tokens || 0,
      output_tokens: oaBody.usage?.completion_tokens || 0,
    },
  };

  return resp;
}

function mapFinishReason(fr) {
  switch (fr) {
    case "stop": return "end_turn";
    case "length": return "max_tokens";
    case "content_filter": return "content_filter";
    case "tool_calls": return "tool_use";
    default: return fr || "end_turn";
  }
}

function createAnthropicSSETransformer(originalModel, onTurnComplete, onError) {
  let buffer = "";
  const decoder = new TextDecoder();
  const st = {
    messageStartSent: false,
    nextBlockIndex: 0,
    activeType: null,
    activeIndex: -1,
    activeToolIndex: -1,
    tools: new Map(),
    stopReason: "end_turn",
    usage: undefined,
    finished: false,
    reasoning: "",
  };

  function stopActive(controller) {
    if (st.activeType === null) return;
    controller.enqueue(formatSSE("content_block_stop", { index: st.activeIndex }));
    st.activeType = null;
    st.activeIndex = -1;
  }

  function startThinking(controller) {
    stopActive(controller);
    st.activeIndex = st.nextBlockIndex++;
    st.activeType = "thinking";
    st.activeToolIndex = -1;
    controller.enqueue(formatSSE("content_block_start", {
      index: st.activeIndex,
      content_block: { type: "thinking", thinking: "" },
    }));
  }

  function startText(controller) {
    stopActive(controller);
    st.activeIndex = st.nextBlockIndex++;
    st.activeType = "text";
    st.activeToolIndex = -1;
    controller.enqueue(formatSSE("content_block_start", {
      index: st.activeIndex,
      content_block: { type: "text", text: "" },
    }));
  }

  function startTool(controller, tool) {
    stopActive(controller);
    st.activeIndex = st.nextBlockIndex++;
    st.activeType = "tool";
    st.activeToolIndex = tool.idx;
    tool.emitted = true;
    controller.enqueue(formatSSE("content_block_start", {
      index: st.activeIndex,
      content_block: { type: "tool_use", id: tool.id, name: tool.name, input: {} },
    }));
  }

  function emitToolDelta(controller, tool, partial, idx) {
    if (st.activeType !== "tool" || st.activeToolIndex !== idx) {
      if (st.activeType !== null) stopActive(controller);
      startTool(controller, tool);
    }
    controller.enqueue(formatSSE("content_block_delta", {
      index: st.activeIndex,
      delta: { type: "input_json_delta", partial_json: partial },
    }));
  }

  function finish(controller) {
    if (st.finished) return;
    st.finished = true;
    if (!st.messageStartSent) {
      st.messageStartSent = true;
      controller.enqueue(formatSSE("message_start", {
        message: {
          id: "msg_unknown",
          type: "message",
          role: "assistant",
          content: [],
          model: originalModel || "",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }));
    }
    stopActive(controller);
    if (st.tools.size > 0 && st.stopReason !== "max_tokens") {
      const idxs = [...st.tools.keys()].sort((a, b) => a - b);
      let hasPending = false;
      for (const idx of idxs) {
        const tool = st.tools.get(idx);
        if (tool.emitted) continue;
        hasPending = true;
        const blockIndex = st.nextBlockIndex++;
        controller.enqueue(formatSSE("content_block_start", {
          index: blockIndex,
          content_block: { type: "tool_use", id: tool.id, name: tool.name, input: {} },
        }));
        controller.enqueue(formatSSE("content_block_delta", {
          index: blockIndex,
          delta: { type: "input_json_delta", partial_json: tool.args || "{}" },
        }));
        controller.enqueue(formatSSE("content_block_stop", { index: blockIndex }));
      }
      if (hasPending || st.tools.size > 0) st.stopReason = "tool_use";
    }
    const payload = {
      delta: { stop_reason: st.stopReason, stop_sequence: null },
      usage: st.usage || { input_tokens: 0, output_tokens: 0 },
    };
    controller.enqueue(formatSSE("message_delta", payload));
    controller.enqueue(formatSSE("message_stop", {}));
    if (onTurnComplete && st.reasoning && st.tools.size > 0) {
      const toolIds = [...st.tools.values()].map((t) => t.id).filter(Boolean);
      if (toolIds.length) onTurnComplete(st.reasoning, toolIds);
    }
  }

  function handleLine(line, controller) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data: ")) return;
    const jsonStr = trimmed.slice(6);
    if (jsonStr === "[DONE]") return;
    if (st.finished) return;

    let oa;
    try {
      oa = JSON.parse(jsonStr);
    } catch {
      return;
    }

    if (oa.error) {
      if (onError) onError(oa.error);
      if (!st.messageStartSent) {
        st.messageStartSent = true;
        controller.enqueue(formatSSE("message_start", {
          message: {
            id: "msg_unknown",
            type: "message",
            role: "assistant",
            content: [],
            model: originalModel || "",
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        }));
      }
      const msg = oa.error.message || JSON.stringify(oa.error);
      controller.enqueue(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: oa.error.type || "api_error", message: msg } })}\n\n`);
      controller.enqueue(formatSSE("message_stop", {}));
      st.finished = true;
      return;
    }

    if (oa.usage) {
      st.usage = {
        input_tokens: oa.usage.prompt_tokens || 0,
        output_tokens: oa.usage.completion_tokens || 0,
      };
    }

    const choice = oa.choices?.[0] || {};
    const delta = choice.delta || {};

    if (!st.messageStartSent) {
      st.messageStartSent = true;
      controller.enqueue(formatSSE("message_start", {
        message: {
          id: oa.id || "msg_unknown",
          type: "message",
          role: delta.role || "assistant",
          content: [],
          model: originalModel || oa.model || "",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }));
    }

    if (delta.reasoning_content) {
      if (st.activeType !== "thinking") startThinking(controller);
      st.reasoning += delta.reasoning_content;
      controller.enqueue(formatSSE("content_block_delta", {
        index: st.activeIndex,
        delta: { type: "thinking_delta", thinking: delta.reasoning_content },
      }));
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        let tool = st.tools.get(idx);
        if (!tool) {
          tool = { id: tc.id || `toolu_${idx}`, name: tc.function?.name || "", args: "", idx };
          st.tools.set(idx, tool);
        }
        if (tc.id) tool.id = tc.id;
        if (tc.function?.name) tool.name = tc.function?.name;
        if (tc.function?.arguments) {
          tool.args += tc.function.arguments;
          emitToolDelta(controller, tool, tc.function.arguments, idx);
        } else if (tc.id || tc.function?.name) {
          if (st.activeType !== "tool" || st.activeToolIndex !== idx) {
            startTool(controller, tool);
          }
        }
      }
    }

    if (delta.content) {
      if (st.activeType !== "text") startText(controller);
      controller.enqueue(formatSSE("content_block_delta", {
        index: st.activeIndex,
        delta: { type: "text_delta", text: delta.content },
      }));
    }

    if (choice.finish_reason) {
      st.stopReason = mapFinishReason(choice.finish_reason);
    }
  }

  return new TransformStream({
    start() {},

    transform(chunk, controller) {
      const text = decoder.decode(chunk, { stream: true });
      buffer += text;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        handleLine(line, controller);
      }
    },

    flush(controller) {
      if (buffer) {
        const lines = buffer.split("\n");
        buffer = "";
        for (const line of lines) {
          handleLine(line, controller);
        }
      }
      finish(controller);
    },
  });
}

function formatSSE(type, data) {
  const payload = JSON.stringify({ type, ...data });
  return `event: ${type}\ndata: ${payload}\n\n`;
}

export { anthropicToOpenAI, openaiToAnthropic, createAnthropicSSETransformer };