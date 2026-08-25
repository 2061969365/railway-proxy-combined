import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAPPINGS_PATH = path.join(__dirname, "..", "config", "mappings.json");

let mappings = {};

const DEFAULTS = {
  // Main Claude Code models
  "claude-sonnet-4-6": "deepseek-v4-flash-free",
  "claude-opus-4-8": "mimo-v2.5-free",
  "claude-haiku-4-5": "nemotron-3-ultra-free",
  "claude-sonnet-4": "north-mini-code-free",
  // Fable / Mythos variants
  "claude-fable-5": "deepseek-v4-flash-free",
  "claude-mythos-5": "deepseek-v4-flash-free",
  // Versioned / dated names Claude Code may use
  "claude-sonnet-4-20250514": "deepseek-v4-flash-free",
  "claude-opus-4-20250918": "mimo-v2.5-free",
  "claude-haiku-3-5-20241022": "nemotron-3-ultra-free",
  "claude-3-5-sonnet-20241022": "north-mini-code-free",
  "claude-3-5-haiku-20241022": "nemotron-3-ultra-free",
  "claude-opus-4-5": "mimo-v2.5-free",
  "claude-opus-4-5-20251101": "mimo-v2.5-free",
  "claude-sonnet-4-5": "deepseek-v4-flash-free",
  "claude-sonnet-4-5-20250929": "deepseek-v4-flash-free",
  "claude-haiku-4-5-20251001": "nemotron-3-ultra-free",
  "claude-3-7-sonnet-20250219": "north-mini-code-free",
  "claude-3-7-sonnet-latest": "north-mini-code-free",
  "claude-opus-4-1-20250805": "mimo-v2.5-free",
};

function load() {
  try {
    const raw = fs.readFileSync(MAPPINGS_PATH, "utf-8");
    mappings = JSON.parse(raw);
  } catch {
    mappings = {};
  }
  let changed = false;
  for (const [alias, model] of Object.entries(DEFAULTS)) {
    if (!mappings[alias]) {
      mappings[alias] = model;
      changed = true;
    }
  }
  if (changed) save(mappings);
  return mappings;
}

function save(data) {
  fs.writeFileSync(MAPPINGS_PATH, JSON.stringify(data, null, 2), "utf-8");
  mappings = data;
}

function getAll() {
  return { ...mappings };
}

function get(alias) {
  return mappings[alias] || alias;
}

function resolve(model) {
  return mappings[model] || model;
}

function set(alias, realModel) {
  mappings[alias] = realModel;
  save(mappings);
  return mappings;
}

function remove(alias) {
  delete mappings[alias];
  save(mappings);
  return mappings;
}

load();

export { getAll, get, resolve, set, remove, load, save };