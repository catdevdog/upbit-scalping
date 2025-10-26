import config from "../config/env.js";
import {
  checkScalpingRSI,
  checkScalpingVolume,
  checkScalpingOrderbook,
  checkScalpingCandle,
  checkATRFilter,
} from "./scalping.js";
import { log } from "../utils/helpers.js";

/**
 * ⚡ 스캘핑 전용 진입 점수 계산 (ATR 필터 수정)
 */
export async function calculateEntryScore(market) {
  const results = [];

  log("debug", "⚡ 스캘핑 모드 - 빠른 전략 실행");

  // ✅ 병렬로 전략 실행 (API 효율화)
  const strategies = [];

  if (config.STRATEGY_RSI) {
    strategies.push(
      checkScalpingRSI(market).then((result) => ({
        name: "RSI",
        ...result,
      }))
    );
  }

  if (config.STRATEGY_VOLUME) {
    strategies.push(
      checkScalpingVolume(market).then((result) => ({
        name: "Volume",
        ...result,
      }))
    );
  }

  if (config.STRATEGY_ORDERBOOK) {
    strategies.push(
      checkScalpingOrderbook(market).then((result) => ({
        name: "Orderbook",
        ...result,
      }))
    );
  }

  if (config.STRATEGY_CANDLE) {
    strategies.push(
      checkScalpingCandle(market).then((result) => ({
        name: "Candle",
        ...result,
      }))
    );
  }

  // 모든 전략 결과 대기
  const allResults = await Promise.all(strategies);
  results.push(...allResults);

  // ✅ 매수 신호 필터링 (BUY인 것만 카운트)
  const buySignals = results.filter((r) => r.signal === "BUY");
  const signalCount = buySignals.length;

  // ✅ 점수 계산 (모든 전략 점수 합산 - signal과 무관)
  const totalScore = results.reduce((sum, r) => sum + (r.score || 0), 0);

  // ✅ ATR 변동성 필터 체크 (선택적)
  const atrFilter = await checkATRFilter(market);

  if (!atrFilter.pass) {
    log("warn", `❌ ATR 필터 미통과: ${atrFilter.reason} - 진입 불가`);

    // ✅ ATR 필터 실패 시에도 실제 점수 유지 (대시보드 표시용)
    return {
      shouldBuy: false,
      totalScore, // ✅ 실제 계산된 점수 유지
      signalCount,
      totalStrategies: results.length,
      signals: buySignals,
      allResults: results,
      threshold: config.ENTRY_SCORE_THRESHOLD,
      minSignals: config.MIN_SIGNALS,
      filterFailed: "ATR",
      filterReason: atrFilter.reason,
      atr: atrFilter.atr,
    };
  }

  log("debug", `✅ ATR 필터 통과: ${atrFilter.reason}`);

  log("debug", `📊 전략 결과:`);
  results.forEach((r) => {
    log("debug", `   ${r.name}: ${r.signal} (${r.score}점) - ${r.reason}`);
  });
  log("debug", `📊 총점: ${totalScore}점 (BUY 신호 ${signalCount}개)`);

  // 진입 조건 판단 (총점만 체크)
  const shouldBuy = totalScore >= config.ENTRY_SCORE_THRESHOLD;

  // 디버그 로그
  if (shouldBuy) {
    log(
      "info",
      `⚡ 스캘핑 매수 신호! 점수: ${totalScore}/${
        config.ENTRY_SCORE_THRESHOLD
      }, 신호: ${signalCount}개, ATR: ${atrFilter.atr.toFixed(2)}%`
    );
    results.forEach((r) => {
      if (r.score > 0) {
        log("debug", `  • ${r.name}: ${r.score}점 (${r.reason})`);
      }
    });
  }

  return {
    shouldBuy,
    totalScore,
    signalCount,
    totalStrategies: results.length,
    signals: buySignals,
    allResults: results,
    threshold: config.ENTRY_SCORE_THRESHOLD,
    minSignals: config.MIN_SIGNALS,
    atr: atrFilter.atr,
  };
}
