import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CRASH_PATH = path.join(__dirname, "..", "config", "crash.json");
const HEARTBEAT_PATH = path.join(__dirname, "..", "config", "heartbeat.json");

let lastReq = null;

export function setLastRequest(info) {
  lastReq = { time: new Date().toISOString(), ...info };
}

export function writeHeartbeat() {
  try {
    fs.writeFileSync(HEARTBEAT_PATH, JSON.stringify({ time: Date.now(), iso: new Date().toISOString(), pid: process.pid, memory: process.memoryUsage(), lastReq }, null, 2));
  } catch {}
}

export function writeCrashReport(err, kind = "uncaughtException") {
  const report = {
    time: new Date().toISOString(),
    kind,
    pid: process.pid,
    error: { message: err?.message || String(err), stack: err?.stack || "", name: err?.name || "" },
    memory: process.memoryUsage(),
    uptime: process.uptime(),
    lastReq,
    nodeVersion: process.version,
  };
  try {
    fs.writeFileSync(CRASH_PATH, JSON.stringify(report, null, 2));
    console.error(`[CRASH] report written to ${CRASH_PATH}`);
  } catch (e) {
    console.error(`[CRASH] failed to write report: ${e.message}`);
  }
  return report;
}

export function readCrashReport() {
  try {
    return JSON.parse(fs.readFileSync(CRASH_PATH, "utf-8"));
  } catch {
    return null;
  }
}

export function readHeartbeat() {
  try {
    return JSON.parse(fs.readFileSync(HEARTBEAT_PATH, "utf-8"));
  } catch {
    return null;
  }
}

export function clearCrashReport() {
  try { fs.unlinkSync(CRASH_PATH); } catch {}
}
