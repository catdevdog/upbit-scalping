#!/usr/bin/env node

import fs from "fs";
import { PATHS, CFG } from "../src/config/index.js";

const logPath = PATHS.tradeLog;

function readEvents(file) {
  if (!fs.existsSync(file)) {
    console.error(`로그 파일을 찾을 수 없습니다: ${file}`);
    process.exit(1);
  }
  const raw = fs.readFileSync(file, "utf8");
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const events = [];
  let parseErrors = 0;
  for (const line of lines) {
    try {
      events.push(JSON.parse(line));
    } catch (e) {
      parseErrors += 1;
    }
  }
  if (parseErrors) {
    console.warn(`⚠️  JSON 파싱 실패 ${parseErrors}건을 건너뜀`);
  }
  return events;
}

function pairTrades(events) {
  const trades = [];
  let pending = null;
  for (const evt of events) {
    if (evt.type === "ENTRY") {
      pending = evt;
    } else if (evt.type === "EXIT" && pending) {
      trades.push({ entry: pending, exit: evt });
      pending = null;
    }
  }
  return { trades, danglingEntry: pending };
}

function safeNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

function average(values) {
  const finite = values.filter((v) => Number.isFinite(v));
  if (!finite.length) return NaN;
  return finite.reduce((acc, cur) => acc + cur, 0) / finite.length;
}

function median(values) {
  const finite = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!finite.length) return NaN;
  const mid = Math.floor(finite.length / 2);
  if (finite.length % 2 === 0) {
    return (finite[mid - 1] + finite[mid]) / 2;
  }
  return finite[mid];
}

function durationInSec(entry, exit) {
  const hold = safeNumber(exit?.holdSec);
  if (Number.isFinite(hold)) return hold;
  const entryEpoch = safeNumber(entry?.tsEpoch ?? entry?.entryTs);
  const exitEpoch = safeNumber(exit?.tsEpoch ?? exit?.exitTs);
  if (Number.isFinite(entryEpoch) && Number.isFinite(exitEpoch)) {
    return Math.max(0, Math.round((exitEpoch - entryEpoch) / 1000));
  }
  return NaN;
}

function percent(count, total) {
  if (!total) return "0.0%";
  return `${((count / total) * 100).toFixed(1)}%`;
}

function toTradeSummary(paired) {
  return paired.map(({ entry, exit }) => {
    const ctx = entry?.ctx ?? entry?.context ?? null;
    const reason = String(exit?.reason ?? "UNKNOWN").toUpperCase();
    const durationSec = durationInSec(entry, exit);
    const pnlKRW = safeNumber(exit?.pnlKRW);
    const mfePct = safeNumber(exit?.mfePct);
    return {
      entry,
      exit,
      ctx,
      reason,
      durationSec,
      pnlKRW,
      mfePct,
      movedToBE: Boolean(exit?.movedToBE),
      positionId: entry?.positionId ?? exit?.positionId,
    };
  });
}

function summarizeByReason(trades) {
  const map = new Map();
  for (const trade of trades) {
    const info = map.get(trade.reason) ?? {
      count: 0,
      durations: [],
      pnls: [],
    };
    info.count += 1;
    if (Number.isFinite(trade.durationSec))
      info.durations.push(trade.durationSec);
    if (Number.isFinite(trade.pnlKRW)) info.pnls.push(trade.pnlKRW);
    map.set(trade.reason, info);
  }
  return map;
}

function report() {
  const events = readEvents(logPath);
  if (!events.length) {
    console.log("체결 로그가 비어 있습니다.");
    return;
  }

  const { trades: paired, danglingEntry } = pairTrades(events);
  if (!paired.length) {
    console.log("EXIT 로그가 없어 분석할 트레이드가 없습니다.");
    if (danglingEntry) console.log("현재 미종결 포지션 1건이 감지되었습니다.");
    return;
  }

  const trades = toTradeSummary(paired);
  const reasonMap = summarizeByReason(trades);
  const totalTrades = trades.length;

  console.log(
    `총 ${totalTrades}건의 완결 거래 분석 완료${
      danglingEntry ? " (+미종결 1건)" : ""
    }.`
  );
  console.log("\n사유별 요약:");
  const reasonRows = Array.from(reasonMap.entries()).map(([reason, info]) => ({
    reason,
    trades: info.count,
    share: percent(info.count, totalTrades),
    avgHoldSec: Number.isFinite(average(info.durations))
      ? average(info.durations).toFixed(1)
      : "n/a",
    medianHoldSec: Number.isFinite(median(info.durations))
      ? median(info.durations).toFixed(1)
      : "n/a",
    avgPnlKRW: Number.isFinite(average(info.pnls))
      ? average(info.pnls).toFixed(0)
      : "n/a",
  }));
  console.table(reasonRows);

  const timeouts = trades.filter((t) => t.reason === "TIMEOUT");
  if (timeouts.length) {
    const timeoutAvgHold = average(timeouts.map((t) => t.durationSec));
    const timeoutMedianHold = median(timeouts.map((t) => t.durationSec));
    const timeoutAvgAtr = average(
      timeouts.map((t) => safeNumber(t.ctx?.atrPct))
    );
    const timeoutAvgRvol = average(
      timeouts.map((t) => safeNumber(t.ctx?.rvol))
    );
    const timeoutAvgProb = average(
      timeouts.map((t) => safeNumber(t.ctx?.prob))
    );
    const momentumUsed = timeouts.filter((t) => t.ctx?.momentumOverride).length;
    const trendGatePass = timeouts.filter((t) => t.ctx?.trendGate).length;
    const beTriggered = timeouts.filter((t) => t.movedToBE).length;
    const nearRvolFloor = timeouts.filter((t) => {
      const rvol = safeNumber(t.ctx?.rvol);
      if (!Number.isFinite(rvol)) return false;
      return rvol - CFG.strat.MIN_RVOL <= 0.2;
    }).length;
    const nearAtrFloor = timeouts.filter((t) => {
      const atr = safeNumber(t.ctx?.atrPct);
      const lo = safeNumber(t.ctx?.atrLo);
      if (!Number.isFinite(atr) || !Number.isFinite(lo)) return false;
      return atr - lo <= 0.03;
    }).length;
    const nearProbFloor = timeouts.filter((t) => {
      const prob = safeNumber(t.ctx?.prob);
      const pStar = safeNumber(t.ctx?.pStar);
      if (!Number.isFinite(prob) || !Number.isFinite(pStar)) return false;
      return prob - pStar <= 0.02;
    }).length;
    const momentumStrong = timeouts.filter((t) => t.ctx?.momentumStrong).length;
    const atrTightPass = timeouts.filter((t) => t.ctx?.atrTightPass).length;

    console.log("\nTIMEOUT 상세:");
    console.log(
      `- 건수: ${timeouts.length} (${percent(timeouts.length, totalTrades)})`
    );
    console.log(
      `- 보유시간 평균/중앙값: ${
        Number.isFinite(timeoutAvgHold) ? timeoutAvgHold.toFixed(1) : "n/a"
      }s / ${
        Number.isFinite(timeoutMedianHold)
          ? timeoutMedianHold.toFixed(1)
          : "n/a"
      }s`
    );
    console.log(
      `- 평균 ATR%: ${
        Number.isFinite(timeoutAvgAtr) ? timeoutAvgAtr.toFixed(3) : "n/a"
      } (로우 대비 ${nearAtrFloor}/${timeouts.length}건이 0.03%p 이내)`
    );
    console.log(
      `- 평균 RVOL: ${
        Number.isFinite(timeoutAvgRvol) ? timeoutAvgRvol.toFixed(2) : "n/a"
      } (최소치 +0.2x 이내 ${nearRvolFloor}건)`
    );
    console.log(
      `- 평균 진입 스코어 p: ${
        Number.isFinite(timeoutAvgProb)
          ? (timeoutAvgProb * 100).toFixed(1)
          : "n/a"
      }% (p* 근접 ${nearProbFloor}건)`
    );
    console.log(
      `- 모멘텀 예외 진입: ${momentumUsed}/${timeouts.length} (${percent(
        momentumUsed,
        timeouts.length
      )})`
    );
    console.log(
      `- 강화 조건 충족(ATR Tight & Momentum Strong): ${atrTightPass}/${timeouts.length} ATR, ${momentumStrong}/${timeouts.length} Momentum`
    );
    console.log(
      `- 추세 필터 통과 진입: ${trendGatePass}/${timeouts.length} (${percent(
        trendGatePass,
        timeouts.length
      )})`
    );
    console.log(
      `- BE 이동 후 TIMEOUT: ${beTriggered}/${timeouts.length} (${percent(
        beTriggered,
        timeouts.length
      )})`
    );
  }

  const stalls = trades.filter((t) => t.reason === "STALL");
  if (stalls.length) {
    const stallAvgHold = average(stalls.map((t) => t.durationSec));
    const stallMedianHold = median(stalls.map((t) => t.durationSec));
    const stallAvgProb = average(stalls.map((t) => safeNumber(t.ctx?.prob)));
    console.log("\nSTALL 상세:");
    console.log(
      `- 건수: ${stalls.length} (${percent(stalls.length, totalTrades)})`
    );
    console.log(
      `- 보유시간 평균/중앙값: ${
        Number.isFinite(stallAvgHold) ? stallAvgHold.toFixed(1) : "n/a"
      }s / ${
        Number.isFinite(stallMedianHold) ? stallMedianHold.toFixed(1) : "n/a"
      }s`
    );
    console.log(
      `- 평균 진입 스코어 p: ${
        Number.isFinite(stallAvgProb) ? (stallAvgProb * 100).toFixed(1) : "n/a"
      }%`
    );
  }

  const shortHold = trades.filter(
    (t) => Number.isFinite(t.durationSec) && t.durationSec <= 5
  );
  if (shortHold.length) {
    console.log("\n초단기 청산 (≤5초) 분포:");
    const shortMap = summarizeByReason(shortHold);
    const rows = Array.from(shortMap.entries()).map(([reason, info]) => ({
      reason,
      trades: info.count,
      share: percent(info.count, shortHold.length),
      avgHoldSec: Number.isFinite(average(info.durations))
        ? average(info.durations).toFixed(1)
        : "n/a",
    }));
    console.table(rows);
  }
}

report();
