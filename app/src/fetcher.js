import { API, DEFAULT_HEADERS } from "./constants.js";
import { getModelsCached, isBreakerOpen } from "./cache.js";

async function _fetchModelsOnce() {
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

async function fetchModels() {
  if (isBreakerOpen("models:429")) {
    console.warn("[CACHE] models breaker open, skip upstream");
    return null;
  }
  const data = await getModelsCached(_fetchModelsOnce);
  if (data === null) {
    const { openBreaker } = await import("./cache.js");
    openBreaker("models:429", 30 * 1000);
  }
  return data;
}

export { fetchModels };