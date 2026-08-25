const MAX_LOG = 100;
const logs = [];
let idCounter = 0;

function add(entry) {
  const log = {
    id: ++idCounter,
    timestamp: new Date().toISOString(),
    ...entry,
  };
  logs.unshift(log);
  if (logs.length > MAX_LOG) logs.pop();
  return log;
}

function getAll() {
  return logs;
}

function clear() {
  logs.length = 0;
}

export { add, getAll, clear };