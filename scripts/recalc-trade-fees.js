#!/usr/bin/env node

import fs from "fs";
import { CFG, PATHS } from "../src/config/index.js";

const feeRate = Number(CFG?.strat?.FEE ?? 0);
if (!(feeRate > 0)) {
  console.log("⚠️ 설정된 수수료(FEE)가 0이어서 수정할 항목이 없습니다.");
  process.exit(0);
}

const logFile = PATHS.tradeLog;
if (!fs.existsSync(logFile)) {
  console.log("ℹ️ 거래 로그 파일이 존재하지 않습니다:", logFile);
  process.exit(0);
}

const raw = fs.readFileSync(logFile, "utf8");
const lines = raw.split(/\r?\n/);
if (!lines.length) {
  console.log("ℹ️ 거래 로그가 비어 있습니다.");
  process.exit(0);
}

const roundKRW = (value) => {
  if (!Number.isFinite(value)) return 0;
  return Number(value.toFixed(8));
};

const updated = [];
let updatedEntry = 0;
let updatedExit = 0;

for (const line of lines) {
  if (!line.trim()) continue;
  let event;
  try {
    event = JSON.parse(line);
  } catch (err) {
    console.warn("⚠️ JSON 파싱 실패, 원본 유지:", err?.message ?? err);
    updated.push(line.trim());
    continue;
  }

  if (event.type === "ENTRY") {
    const size = Number(event.size ?? event.volume);
    const price = Number(event.price ?? event.entry);
    const sizeKRW = Number(event.sizeKRW ?? size * price);
    if (Number.isFinite(size) && Number.isFinite(price)) {
      const notional = Number.isFinite(sizeKRW) ? sizeKRW : size * price;
      const feeKRW = roundKRW(notional * feeRate);
      if (
        !Number.isFinite(event.feeKRW) ||
        Math.abs(event.feeKRW - feeKRW) > 1e-6
      ) {
        event.feeKRW = feeKRW;
        updatedEntry += 1;
      }
    }
    updated.push(JSON.stringify(event));
    continue;
  }

  if (event.type === "EXIT") {
    const size = Number(event.size);
    const entry = Number(event.entry);
    const exit = Number(event.exit);
    if (
      Number.isFinite(size) &&
      Number.isFinite(entry) &&
      Number.isFinite(exit)
    ) {
      const entryNotional = size * entry;
      const exitNotional = size * exit;
      const feeEntry = roundKRW(entryNotional * feeRate);
      const feeExit = roundKRW(exitNotional * feeRate);
      const totalFees = roundKRW(feeEntry + feeExit);
      const gross = roundKRW((exit - entry) * size);
      const net = roundKRW(gross - totalFees);
      if (
        !Number.isFinite(event.feesKRW) ||
        Math.abs(event.feesKRW - totalFees) > 1e-6 ||
        !Number.isFinite(event.pnlKRW) ||
        Math.abs(event.pnlKRW - net) > 1e-6
      ) {
        event.feesKRW = totalFees;
        event.feeEntryKRW = feeEntry;
        event.feeExitKRW = feeExit;
        event.pnlGrossKRW = gross;
        event.pnlKRW = net;
        updatedExit += 1;
      }
    }
    updated.push(JSON.stringify(event));
    continue;
  }

  updated.push(JSON.stringify(event));
}

if (updatedEntry === 0 && updatedExit === 0) {
  console.log("ℹ️ 기존 로그는 이미 수수료가 반영되어 있습니다. 변경 없음.");
  process.exit(0);
}

const backupPath = `${logFile}.bak-${Date.now()}`;
fs.copyFileSync(logFile, backupPath);
fs.writeFileSync(logFile, updated.join("\n") + "\n", "utf8");

console.log("✅ 거래 로그를 갱신했습니다.");
console.log("   ↳ 업데이트된 ENTRY", updatedEntry, "건");
console.log("   ↳ 업데이트된 EXIT ", updatedExit, "건");
console.log("   ↳ 백업 파일:", backupPath);
