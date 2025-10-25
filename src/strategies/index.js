import config from "../config/env.js";
import {
  checkScalpingRSI,
  checkScalpingVolume,
  checkScalpingOrderbook,
  checkScalpingCandle,
} from "./scalping.js";
import { log } from "../utils/helpers.js";

/**
 * ⚡ 스캘핑 전용 진입 점수 계산
 */
export async function calculateEntryScore(market) {
  const results = [];

  log("debug", "⚡ 스캘핑 모드 - 빠른 전략 실행");

  // 병렬로 전략 실행 (API 효율화)
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

  // 매수 신호 필터링
  const buySignals = results.filter((r) => r.signal === "BUY");
  const signalCount = buySignals.length;

  // 점수 계산
  const totalScore = buySignals.reduce((sum, r) => sum + r.score, 0);

  // 진입 조건 판단
  const shouldBuy =
    totalScore >= config.ENTRY_SCORE_THRESHOLD &&
    signalCount >= config.MIN_SIGNALS;

  // 디버그 로그
  if (shouldBuy) {
    log(
      "info",
      `⚡ 스캘핑 매수 신호! 점수: ${totalScore}/${config.ENTRY_SCORE_THRESHOLD}, 신호: ${signalCount}개`
    );
    buySignals.forEach((signal) => {
      log("debug", `  • ${signal.name}: ${signal.score}점 (${signal.reason})`);
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
  };
}
