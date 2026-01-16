import fs from "fs";
import path from "path";
import { PATHS } from "../config/index.js";
import { nowKSTString } from "../util/math.js";

const file = path.resolve(PATHS.logDir, "order_events.jsonl");

function ensureDir() {
  try {
    fs.mkdirSync(PATHS.logDir, { recursive: true });
  } catch (_) {}
}

export function appendOrderEvent(evt) {
  try {
    ensureDir();
    const record = Object.assign({ ts: nowKSTString() }, evt);
    // [Perf] 동기식 -> 비동기식 변경
    fs.appendFile(file, JSON.stringify(record) + "\n", () => {});
  } catch (e) {
    // best-effort logging
    try {
      console.warn("Failed to write order event", e?.message);
    } catch (_) {}
  }
}

export default appendOrderEvent;
