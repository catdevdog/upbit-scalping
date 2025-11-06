// 체결 로그(JSONL) 관리
// - ENTRY/EXIT 이벤트를 한 줄 JSON으로 기록
// - 대시보드에서 최근 10건·승률 통계에 사용

import fs from "fs";
import { PATHS } from "../config/index.js";

export function ensureLogDir() {
  try {
    fs.mkdirSync(PATHS.logDir, { recursive: true });
  } catch {}
}

export function appendTrade(event) {
  try {
    ensureLogDir();
    const line = JSON.stringify(event) + "\n";
    fs.appendFileSync(PATHS.tradeLog, line);
  } catch {}
}

export function readExits() {
  try {
    const text = fs.readFileSync(PATHS.tradeLog, "utf8");
    const lines = text.split(/\r?\n/).filter(Boolean);
    const events = lines
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    const exits = events.filter((e) => e.type === "EXIT");
    const wins = exits.filter((e) => Number(e.pnlKRW) > 0).length;
    const losses = exits.filter((e) => Number(e.pnlKRW) <= 0).length;
    const pnl = exits.reduce((s, e) => s + Number(e.pnlKRW || 0), 0);
    const winrate = exits.length ? wins / exits.length : 0;
    return {
      exits,
      stats: { wins, losses, winrate, pnl, trades: exits.length },
    };
  } catch {
    return {
      exits: [],
      stats: { wins: 0, losses: 0, winrate: 0, pnl: 0, trades: 0 },
    };
  }
}
