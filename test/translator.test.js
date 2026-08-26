import { describe, it, expect } from "vitest";
import { anthropicToOpenAI, openaiToAnthropic } from "../app/src/translator.js";
import { chatBodyToResponses, responsesToChat } from "../app/src/proxy.js";

describe("translator: anthropicToOpenAI", () => {
  it("converts simple text message", () => {
    const body = {
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 100
    };
    const result = anthropicToOpenAI(body, new Map());
    expect(result.model).toBe("claude-sonnet-4-6");
    expect(result.messages[0].content).toBe("hi");
  });

  it("handles tool_use with empty name by filtering", () => {
    const body = {
      model: "claude-sonnet-4-6",
      messages: [{ role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "", input: {} }] }],
      tools: [{ name: "Bash", description: "Run shell", input_schema: { type: "object", properties: { command: { type: "string" } } } }]
    };
    const result = anthropicToOpenAI(body, new Map());
    expect(result.messages[0].tool_calls).toBeUndefined(); // Empty tool should be filtered
  });

  it("preserves valid tool calls", () => {
    const body = {
      model: "claude-sonnet-4-6",
      messages: [{ role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }] }],
      tools: [{ name: "Bash", description: "Run shell", input_schema: { type: "object", properties: { command: { type: "string" } } } }]
    };
    const result = anthropicToOpenAI(body, new Map());
    expect(result.messages[0].tool_calls).toHaveLength(1);
    expect(result.messages[0].tool_calls[0].function.name).toBe("Bash");
  });
});

describe("proxy: chatBodyToResponses", () => {
  it("converts chat messages to responses input", () => {
    const chatBody = JSON.stringify({
      model: "muse-spark-1.2-contributor-free",
      messages: [{ role: "user", content: "hi" }],
      stream: false
    });
    const result = JSON.parse(chatBodyToResponses(chatBody));
    expect(result.model).toBe("muse-spark-1.2-contributor-free");
    expect(result.input[0].content[0].text).toBe("hi");
    expect(result.stream).toBe(false);
  });

  it("handles system instructions", () => {
    const chatBody = JSON.stringify({
      model: "muse-spark-1.2-contributor-free",
      messages: [{ role: "system", content: "You are helpful" }, { role: "user", content: "hi" }],
      stream: false
    });
    const result = JSON.parse(chatBodyToResponses(chatBody));
    expect(result.instructions).toBe("You are helpful");
    expect(result.input).toHaveLength(1); // Only user, system is in instructions
  });

  it("filters empty tool calls", () => {
    const chatBody = JSON.stringify({
      model: "muse-spark-1.2-contributor-free",
      messages: [{ role: "assistant", content: "", tool_calls: [{ id: "1", type: "function", function: { name: "", arguments: "{}" } }] }],
      stream: false
    });
    const result = JSON.parse(chatBodyToResponses(chatBody));
    expect(result.input.filter(i => i.type === "function_call")).toHaveLength(0);
  });
});

describe("proxy: responsesToChat", () => {
  it("converts responses output to chat completion", () => {
    const responsesJson = {
      id: "resp_123",
      model: "muse-spark-1.2-contributor-free",
      status: "completed",
      output: [
        { type: "message", content: [{ type: "output_text", text: "pong" }] }
      ],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
    };
    const result = responsesToChat(responsesJson, "muse-spark-1.2-contributor-free");
    expect(result.choices[0].message.content).toBe("pong");
    expect(result.model).toBe("muse-spark-1.2-contributor-free");
  });

  it("handles tool calls in responses", () => {
    const responsesJson = {
      id: "resp_123",
      model: "muse-spark-1.2-contributor-free",
      status: "completed",
      output: [
        { type: "function_call", call_id: "call_123", name: "get_weather", arguments: '{"city":"Tokyo"}' }
      ],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
    };
    const result = responsesToChat(responsesJson, "muse-spark-1.2-contributor-free");
    expect(result.choices[0].message.tool_calls[0].function.name).toBe("get_weather");
    expect(result.choices[0].finish_reason).toBe("tool_calls");
  });
});
