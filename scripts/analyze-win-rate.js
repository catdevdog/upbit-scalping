#!/usr/bin/env node

/**
 * 승률 분석 리포트
 * - 거래 로그를 분석하여 승률 패턴 발견
 * - 어떤 조건에서 승률이 높은지 파악
 */

import fs from "fs";
import path from "path";

const LOGS_DIR = process.env.LOG_DIR || "./logs";
const TRADE_LOG = path.join(LOGS_DIR, process.env.TRADE_LOG || "trades.jsonl");

function loadTrades() {
  if (!fs.existsSync(TRADE_LOG)) {
    console.log("거래 로그 없음:", TRADE_LOG);
    return [];
  }

  const lines = fs.readFileSync(TRADE_LOG, "utf8").split("\n").filter(Boolean);
  const trades = [];

  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      trades.push(event);
    } catch {}
  }

  return trades;
}

function pairEntryExit(events) {
  const pairs = [];
  let entry = null;

  for (const evt of events) {
    if (evt.type === "ENTRY") {
      entry = evt;
    } else if (evt.type === "EXIT" && entry) {
      pairs.push({
        entry,
        exit: evt,
        win: Number(evt.pnlKRW) > 0,
        pnlKRW: Number(evt.pnlKRW),
        holdSec: evt.holdSec,
        reason: evt.reason,
      });
      entry = null;
    }
  }

  return pairs;
}

function analyzeByCondition(pairs, getCondition, conditionName) {
  const groups = new Map();

  for (const pair of pairs) {
    const condition = getCondition(pair);
    if (!condition) continue;

    if (!groups.has(condition)) {
      groups.set(condition, { wins: 0, losses: 0, totalPnL: 0 });
    }

    const group = groups.get(condition);
    if (pair.win) {
      group.wins++;
    } else {
      group.losses++;
    }
    group.totalPnL += pair.pnlKRW;
  }

  const results = Array.from(groups.entries()).map(([cond, stats]) => ({
    condition: cond,
    trades: stats.wins + stats.losses,
    wins: stats.wins,
    losses: stats.losses,
    winRate: stats.wins / (stats.wins + stats.losses),
    avgPnL: stats.totalPnL / (stats.wins + stats.losses),
    totalPnL: stats.totalPnL,
  }));

  results.sort((a, b) => b.winRate - a.winRate);

  console.log(`\n📊 ${conditionName} 별 승률:`);
  console.log("─".repeat(80));

  for (const r of results) {
    const wrColor = r.winRate >= 0.75 ? "🟢" : r.winRate >= 0.65 ? "🟡" : "🔴";
    console.log(
      `${wrColor} ${String(r.condition).padEnd(20)} | ` +
        `거래 ${String(r.trades).padStart(3)}건 | ` +
        `승률 ${(r.winRate * 100).toFixed(1).padStart(5)}% | ` +
        `평균 ${r.avgPnL >= 0 ? "+" : ""}${Math.round(r.avgPnL)
          .toString()
          .padStart(6)} KRW | ` +
        `합계 ${r.totalPnL >= 0 ? "+" : ""}${Math.round(
          r.totalPnL
        ).toLocaleString()} KRW`
    );
  }

  return results;
}

function main() {
  console.log("\n" + "═".repeat(80));
  console.log("🎯 승률 분석 리포트");
  console.log("═".repeat(80));

  const events = loadTrades();
  const pairs = pairEntryExit(events);

  if (!pairs.length) {
    console.log("\n⚠️ 분석할 거래 없음");
    return;
  }

  console.log(`\n총 ${pairs.length}건의 거래 분석`);

  const totalWins = pairs.filter((p) => p.win).length;
  const totalLosses = pairs.length - totalWins;
  const overallWR = totalWins / pairs.length;

  console.log(`승: ${totalWins}건, 패: ${totalLosses}건`);
  console.log(`전체 승률: ${(overallWR * 100).toFixed(2)}%`);

  // 1. ATR 구간별 승률
  analyzeByCondition(
    pairs,
    (p) => {
      const atr = p.entry?.ctx?.atrPct;
      if (!atr) return null;
      if (atr < 0.03) return "< 3%";
      if (atr < 0.05) return "3-5%";
      if (atr < 0.08) return "5-8%";
      return "> 8%";
    },
    "ATR 구간"
  );

  // 2. RVOL 구간별 승률
  analyzeByCondition(
    pairs,
    (p) => {
      const rvol = p.entry?.ctx?.rvol;
      if (!rvol) return null;
      if (rvol < 1.2) return "< 1.2x";
      if (rvol < 1.5) return "1.2-1.5x";
      if (rvol < 2.0) return "1.5-2.0x";
      return "> 2.0x";
    },
    "RVOL 구간"
  );

  // 3. RSI 구간별 승률
  analyzeByCondition(
    pairs,
    (p) => {
      const rsi = p.entry?.ctx?.rsi;
      if (!rsi) return null;
      if (rsi < 45) return "< 45 (약세)";
      if (rsi < 52) return "45-52";
      if (rsi < 62) return "52-62 (최적)";
      if (rsi < 70) return "62-70";
      return "> 70 (과매수)";
    },
    "RSI 구간"
  );

  // 4. 호가 imbalance 구간별 승률
  analyzeByCondition(
    pairs,
    (p) => {
      const imb = p.entry?.ctx?.imbalance;
      if (!imb) return null;
      if (imb < 0.2) return "< 20%";
      if (imb < 0.35) return "20-35%";
      if (imb < 0.5) return "35-50%";
      return "> 50%";
    },
    "호가 불균형"
  );

  // 5. 추세 조건별 승률
  analyzeByCondition(
    pairs,
    (p) => {
      const trendPass = p.entry?.ctx?.trendPass;
      const aboveVWAP = p.entry?.ctx?.aboveVWAP;

      if (trendPass && aboveVWAP) return "추세+VWAP 둘다";
      if (trendPass) return "추세만";
      if (aboveVWAP) return "VWAP만";
      return "둘다 없음";
    },
    "추세 조건"
  );

  // 6. 시간대별 승률
  analyzeByCondition(
    pairs,
    (p) => {
      const ts = p.entry?.ts;
      if (!ts) return null;

      const hour = new Date(ts).getHours();
      if (hour < 9) return "00-09시";
      if (hour < 12) return "09-12시";
      if (hour < 15) return "12-15시";
      if (hour < 18) return "15-18시";
      if (hour < 21) return "18-21시";
      return "21-24시";
    },
    "시간대 (KST)"
  );

  // 7. 청산 사유별 승률
  analyzeByCondition(pairs, (p) => p.exit?.reason || "UNKNOWN", "청산 사유");

  // 8. 보유 시간별 승률
  analyzeByCondition(
    pairs,
    (p) => {
      const hold = p.holdSec;
      if (!hold) return null;
      if (hold < 30) return "< 30초";
      if (hold < 60) return "30-60초";
      if (hold < 120) return "1-2분";
      if (hold < 180) return "2-3분";
      return "> 3분";
    },
    "보유 시간"
  );

  // 권장 설정 도출
  console.log("\n" + "═".repeat(80));
  console.log("💡 권장 설정 (승률 75%+ 조건)");
  console.log("═".repeat(80));

  const highWinRateConditions = [];

  // ATR 분석
  const atrAnalysis = analyzeByCondition(
    pairs.filter((p) => p.win),
    (p) => p.entry?.ctx?.atrPct,
    ""
  );
  const bestATR = atrAnalysis.find((r) => r.winRate >= 0.75);
  if (bestATR) {
    highWinRateConditions.push(
      `ATR: ${bestATR.condition}% 구간에서 승률 ${(
        bestATR.winRate * 100
      ).toFixed(1)}%`
    );
  }

  console.log("\n최고 승률 조건:");
  for (const cond of highWinRateConditions) {
    console.log(`  ✓ ${cond}`);
  }

  console.log("\n" + "═".repeat(80));
}

main();
