// scripts/backfill-candles.js
// Backfill minute candles into logs as JSONL

import fs from "node:fs";
import path from "node:path";
import { CFG } from "../src/config/index.js";
import { getMinuteCandles } from "../src/api/upbitAdapter.js";

const arg = (name, d) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return d;
};

const market = arg("market", CFG.run.market);
const unit = Number(arg("unit", 1));
const days = Number(arg("days", 30));
const out = arg(
  "out",
  path.resolve(process.cwd(), `./logs/candles_${unit}m.jsonl`)
);

const startMs = Date.now() - days * 24 * 60 * 60 * 1000;
let cursor = Date.now();

const ensureDir = (p) => {
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
};

const parseTs = (t) => {
  if (typeof t === "number") return t;
  const d = new Date(t);
  return Number.isFinite(d.getTime()) ? d.getTime() : NaN;
};

function loadExistingTs(filePath) {
  if (!fs.existsSync(filePath)) return new Set();
  const lines = fs.readFileSync(filePath, "utf8").trim().split(/\r?\n/);
  const set = new Set();
  for (const line of lines) {
    if (!line) continue;
    try {
      const row = JSON.parse(line);
      if (Number.isFinite(row.ts)) set.add(row.ts);
    } catch {}
  }
  return set;
}

async function main() {
  ensureDir(out);
  const existing = loadExistingTs(out);
  const outStream = fs.createWriteStream(out, { flags: "a" });

  let fetched = 0;
  while (cursor > startMs) {
    const to = new Date(cursor).toISOString();
    const batch = await getMinuteCandles(unit, market, 200, to);
    if (!batch?.length) break;

    for (const c of batch) {
      const ts = parseTs(c.t);
      if (!Number.isFinite(ts)) continue;
      if (ts < startMs) continue;
      if (existing.has(ts)) continue;

      existing.add(ts);
      outStream.write(
        JSON.stringify({ ts, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v }) + "\n"
      );
      fetched++;
    }

    const oldest = batch[batch.length - 1];
    const oldestTs = parseTs(oldest?.t);
    if (!Number.isFinite(oldestTs)) break;
    cursor = oldestTs - 1;

    await new Promise((r) => setTimeout(r, 200));
  }

  outStream.end();
  console.log(`✅ Backfill 완료: ${fetched} rows → ${out}`);
}

main().catch((e) => {
  console.error(`❌ Backfill 실패: ${e?.message}`);
  process.exit(1);
});
