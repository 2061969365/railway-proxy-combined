import { API, DEFAULT_HEADERS } from "./constants.js";

async function fetchModels() {
  try {
    if (!process.env.HTTPS_PROXY && !process.env.HTTP_PROXY && !process.execArgv.includes("--use-env-proxy")) {
      console.warn("[WARN] fetchModels 未检测到代理，可能无法获取上游模型列表");
    }
    const res = await fetch(API.MODELS, {
      headers: {
        "User-Agent": "opencode/1.18.18",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data;
  } catch (err) {
    console.error("Failed to fetch models:", err.message);
    return null;
  }
}

export { fetchModels };