// Model metadata: coding scores, capabilities, deprecated status
// Based on Artificial Analysis Coding Index (Terminal-Bench Hard, SciCode)

export const MODEL_META = {
  // Deprecated / no longer free — show strikethrough
  "qwen3.6-plus-free": { deprecated: true, note: "No longer free" },
  "minimax-m3-free": { deprecated: true, note: "No longer free" },

  // Free models with coding scores (ranked by strength)
  "mimo-v2.5-free": { score: 42.1, image: true, reasoning: false },
  "deepseek-v4-flash-free": { score: 38.7, reasoning: true },
  "nemotron-3-ultra-free": { score: 37.6, reasoning: false },
  "north-mini-code-free": { score: 33.4, reasoning: false },

  // Models on OpenCode but not in the free list (for reference)
  "big-pickle": { score: 47.5, reasoning: true },
  "kimi-k2.6": { score: 47.1, reasoning: true },
  "glm-5.1": { score: 43.4, reasoning: false },
  "kimi-k2.5": { score: 42.1, reasoning: true },
  "minimax-m2.7": { score: 41.9, reasoning: false },
  "deepseek-v4-flash": { score: 38.7, reasoning: true },
  "glm-5": { score: 37.6, reasoning: false },
  "minimax-m2.5": { score: 35.4, reasoning: false },
};

// Coding scores sorted by rank (for chart display)
export function getFreeModelScores() {
  return [
    { id: "mimo-v2.5-free", score: 42.1, image: true },
    { id: "deepseek-v4-flash-free", score: 38.7 },
    { id: "nemotron-3-ultra-free", score: 37.6 },
    { id: "north-mini-code-free", score: 33.4 },
  ].sort((a, b) => b.score - a.score);
}
