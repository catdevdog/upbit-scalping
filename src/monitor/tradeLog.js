// 체결 로그(JSONL) 관리
// - ENTRY/EXIT 이벤트를 한 줄 JSON으로 기록
// - 대시보드에서 최근 10건·승률 통계에 사용
// - [Update] 메모리 캐싱 도입으로 I/O 병목 제거
// - [개선 7] LRU 방식 메모리 캐시 제한 (최대 1000건)

import fs from "fs";
import { PATHS } from "../config/index.js";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 개선 7: 메모리 캐시 제한 (LRU 방식)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const MAX_CACHE_SIZE = 1000; // 최근 1000건만 유지

let _eventsCache = null;

export function ensureLogDir() {
  try {
    fs.mkdirSync(PATHS.logDir, { recursive: true });
  } catch {}
}

function loadCacheIfNeeded() {
  if (_eventsCache !== null) return;
  _eventsCache = [];
  try {
    if (fs.existsSync(PATHS.tradeLog)) {
      const text = fs.readFileSync(PATHS.tradeLog, "utf8");
      const lines = text.split(/\r?\n/).filter(Boolean);
      const parsed = lines
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean);

      // 개선 7: 최근 N건만 메모리에 유지
      _eventsCache = parsed.slice(-MAX_CACHE_SIZE);
    }
  } catch (e) {
    console.error("TradeLog load error:", e);
  }
}

export function appendTrade(event) {
  try {
    ensureLogDir();

    // 1. 메모리 업데이트 (개선 7: LRU 방식)
    loadCacheIfNeeded();
    if (_eventsCache) {
      _eventsCache.push(event);
      // 캐시 크기 제한
      if (_eventsCache.length > MAX_CACHE_SIZE) {
        _eventsCache = _eventsCache.slice(-MAX_CACHE_SIZE);
      }
    }

    // 2. 파일 쓰기 (비동기)
    const line = JSON.stringify(event) + "\n";
    fs.appendFile(PATHS.tradeLog, line, (err) => {
      if (err) console.error("TradeLog append error:", err);
    });
  } catch {}
}

/**
 * 메모리 캐시된 거래 내역 조회 (Non-blocking)
 */
export function getTradeStats() {
  loadCacheIfNeeded();
  const events = _eventsCache || []; // fallback

  const exits = events.filter((e) => e.type === "EXIT");
  const wins = exits.filter((e) => Number(e.pnlKRW) > 0).length;
  const losses = exits.filter((e) => Number(e.pnlKRW) <= 0).length;
  const pnl = exits.reduce((s, e) => s + Number(e.pnlKRW || 0), 0);
  const winrate = exits.length ? wins / exits.length : 0;

  return {
    exits,
    stats: { wins, losses, winrate, pnl, trades: exits.length },
    allEvents: events,
  };
}

// 하위 호환성 유지 (이제 파일 읽지 않음)
export const readExits = getTradeStats;
