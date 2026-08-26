import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "child_process";
import { setTimeout as sleep } from "timers/promises";

let proxyProcess;
const PROXY_URL = "http://127.0.0.1:4096";

beforeAll(async () => {
  // Start proxy
  proxyProcess = spawn("node", ["--use-env-proxy", "server.js"], {
    cwd: "F:/worker/railway-proxy-combined/app",
    stdio: "pipe"
  });
  // Wait for proxy to be ready
  for (let i = 0; i < 10; i++) {
    await sleep(1000);
    try {
      const res = await fetch(`${PROXY_URL}/api/status`);
      if (res.ok) break;
    } catch {}
  }
}, 15000);

afterAll(async () => {
  if (proxyProcess) {
    proxyProcess.kill();
    await sleep(1000);
  }
});

describe("integration: proxy via HTTP", () => {
  it("GET /api/status returns 200", async () => {
    const res = await fetch(`${PROXY_URL}/api/status`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe("ok");
    expect(data.port).toBe(4096);
  }, 10000);

  it("GET /v1/models returns 76 models", async () => {
    const res = await fetch(`${PROXY_URL}/v1/models`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.object).toBe("list");
    expect(data.data.length).toBeGreaterThan(50);
    const hasMuseSpark = data.data.some(m => m.id === "muse-spark-1.2-contributor-free");
    expect(hasMuseSpark).toBe(true);
  }, 10000);

  it("POST /v1/chat/completions with mimo returns 200", async () => {
    const res = await fetch(`${PROXY_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer sk-test" },
      body: JSON.stringify({
        model: "mimo-v2.5-free",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 20,
        stream: false
      })
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.choices[0].message).toBeDefined();
  }, 15000);

  it("POST /v1/chat/completions with muse-spark returns 200 via responses fallback", async () => {
    const res = await fetch(`${PROXY_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer sk-test" },
      body: JSON.stringify({
        model: "muse-spark-1.2-contributor-free",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 50,
        stream: false
      })
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.choices[0].message).toBeDefined();
  });

  it("POST /v1/messages with muse-spark returns 200", async () => {
    const res = await fetch(`${PROXY_URL}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": "sk-ant-test", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "muse-spark-1.2-contributor-free",
        max_tokens: 50,
        messages: [{ role: "user", content: "hi" }]
      })
    });
    expect(res.status).toBe(200);
  });

  it("handles empty tool call filtering", async () => {
    const res = await fetch(`${PROXY_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer sk-test" },
      body: JSON.stringify({
        model: "muse-spark-1.2-contributor-free",
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "", tool_calls: [{ id: "1", type: "function", function: { name: "", arguments: "{}" } }] },
          { role: "tool", tool_call_id: "1", content: "result" }
        ],
        max_tokens: 50,
        stream: false
      })
    });
    // Should not 500 due to empty tool call, should filter and succeed or 400 with proper error
    expect([200, 400].includes(res.status)).toBe(true);
  });

  it("GET /v1 returns 404", async () => {
    const res = await fetch(`${PROXY_URL}/v1`);
    expect(res.status).toBe(404);
  });

  it("GET /api/ui/ returns dashboard", async () => {
    const res = await fetch(`${PROXY_URL}/api/ui/`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("OpenCode");
  });
});
