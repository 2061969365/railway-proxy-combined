const OPCODE_URL = "https://opencode.ai";
const ZEN_PATH = "/zen/v1";

const API = {
  CHAT: `${OPCODE_URL}${ZEN_PATH}/chat/completions`,
  RESPONSES: `${OPCODE_URL}${ZEN_PATH}/responses`,
  MESSAGES: `${OPCODE_URL}${ZEN_PATH}/messages`,
  MODELS: `${OPCODE_URL}${ZEN_PATH}/models`,
};

const DEFAULT_HEADERS = {
  "Content-Type": "application/json",
  "User-Agent": "opencode/1.18.18",
  Accept: "text/event-stream",
};

export { OPCODE_URL, ZEN_PATH, API, DEFAULT_HEADERS };