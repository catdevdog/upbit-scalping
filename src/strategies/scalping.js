import upbitAPI from "../api/upbit.js";
import { calculateRSI, calculateRVOL } from "../utils/indicators.js";
import { calculateAverage, log } from "../utils/helpers.js";
import cacheManager from "../utils/cache.js";
import config from "../config/env.js";

/**
 * ⚡ 스캘핑 전용 RSI 전략 (1분봉, 민감)
 */
export async function checkScalpingRSI(market) {
  try {
    const candles = await cacheManager.get(
      `candles_1m_${market}_rsi`,
      () => upbitAPI.getCandles(market, 20, "minutes", 1),
      1000
    );

    if (candles.length < 15) {
      return { signal: "NONE", score: 0, reason: "데이터 부족" };
    }

    const rsi = calculateRSI(candles, 14);
    const prevCandles = candles.slice(1);
    const prevRSI = calculateRSI(prevCandles, 14);

    let score = 0;
    const signals = [];

    // 스캘핑: RSI 기준 더 민감하게
    if (rsi < 35) {
      score += 30;
      signals.push("과매도");
    } else if (rsi < 45) {
      score += 20;
      signals.push("RSI 낮음");
    }

    // 빠른 반등
    if (prevRSI < 35 && rsi >= 35) {
      score += 25;
      signals.push("RSI 반등");
    }

    // 급격한 상승
    const rsiChange = rsi - prevRSI;
    if (rsiChange >= 5) {
      score += 20;
      signals.push("RSI 급등");
    } else if (rsiChange >= 3) {
      score += 10;
      signals.push("RSI 상승");
    }

    const shouldBuy = score >= 25;

    if (shouldBuy) {
      log("debug", `[Scalping RSI] BUY - ${score}점 (${signals.join(", ")})`);
    }

    return {
      signal: shouldBuy ? "BUY" : "NONE",
      score,
      reason: signals.join(", ") || "조건 미충족",
      data: { rsi, prevRSI, rsiChange },
    };
  } catch (error) {
    log("error", "[Scalping RSI] 실행 실패", error.message);
    return { signal: "NONE", score: 0, reason: "실행 실패" };
  }
}

/**
 * ⚡ 스캘핑 전용 거래량 폭증 감지 (1분봉) + RVOL
 */
export async function checkScalpingVolume(market) {
  try {
    const candles = await cacheManager.get(
      `candles_1m_${market}_volume`,
      () => upbitAPI.getCandles(market, 10, "minutes", 1),
      1000
    );

    if (candles.length < 10) {
      return { signal: "NONE", score: 0, reason: "데이터 부족" };
    }

    const currentVolume = candles[0].candle_acc_trade_volume;
    const avgVolume =
      candles
        .slice(1, 6)
        .reduce((sum, c) => sum + c.candle_acc_trade_volume, 0) / 5;

    const volumeRatio = currentVolume / avgVolume;

    // ✅ RVOL 계산
    const rvol = calculateRVOL(currentVolume, candles.slice(1));

    const currentPrice = candles[0].trade_price;
    const prevPrice = candles[1].trade_price;
    const priceChange = ((currentPrice - prevPrice) / prevPrice) * 100;

    let score = 0;
    const signals = [];

    // 거래량 급증 (스캘핑은 더 민감)
    if (volumeRatio >= 3.0) {
      score += 35;
      signals.push("거래량 폭증");
    } else if (volumeRatio >= 2.5) {
      score += 30;
      signals.push("거래량 급증");
    } else if (volumeRatio >= 2.0) {
      score += 25;
      signals.push("거래량 증가");
    } else if (volumeRatio >= 1.5) {
      score += 15;
      signals.push("거래량 상승");
    }

    // ✅ RVOL 보너스 (1.5 이상)
    if (rvol >= 1.5) {
      score += 10;
      signals.push(`RVOL ${rvol.toFixed(2)}x`);
    }

    // 가격 상승 동반
    if (priceChange > 0.5) {
      score += 20;
      signals.push("강한 상승");
    } else if (priceChange > 0.3) {
      score += 15;
      signals.push("가격 상승");
    } else if (priceChange > 0.1) {
      score += 5;
      signals.push("약한 상승");
    } else if (priceChange < -0.1) {
      // ✅ 가격 하락 시 페널티
      score = Math.max(0, score - 20);
      signals.push("⚠️ 가격 하락");
    }

    const shouldBuy = score >= 30;

    if (shouldBuy) {
      log(
        "debug",
        `[Scalping Volume] BUY - ${score}점 (${signals.join(", ")})`
      );
    }

    return {
      signal: shouldBuy ? "BUY" : "NONE",
      score,
      reason: signals.join(", ") || "조건 미충족",
      data: { volumeRatio, rvol, priceChange },
    };
  } catch (error) {
    log("error", "[Scalping Volume] 실행 실패", error.message);
    return { signal: "NONE", score: 0, reason: "실행 실패" };
  }
}

/**
 * ✅ 스캘핑 전용 호가창 분석 (스프레드, 불균형, 깊이)
 */
export async function checkScalpingOrderbook(market) {
  try {
    const orderbook = await cacheManager.get(
      `orderbook_${market}`,
      () => upbitAPI.getOrderbook(market),
      1000
    );

    if (!orderbook || !orderbook.orderbook_units) {
      return { signal: "NONE", score: 0, reason: "호가창 데이터 없음" };
    }

    const units = orderbook.orderbook_units;
    const ask1 = units[0].ask_price; // 최우선 매도호가
    const bid1 = units[0].bid_price; // 최우선 매수호가

    let score = 0;
    const signals = [];

    // === 1. 스프레드 체크 ===
    const spread = ask1 - bid1;
    const spreadPercent = (spread / bid1) * 100;
    const tickSize = bid1 * 0.0001; // 대략적인 틱 크기 (0.01%)
    const spreadTicks = spread / tickSize;

    if (spreadTicks <= config.MAX_SPREAD_TICKS) {
      score += 20;
      signals.push(`좁은 스프레드 ${spreadTicks.toFixed(1)}틱`);
    } else if (spreadTicks <= config.MAX_SPREAD_TICKS * 2) {
      score += 10;
      signals.push(`보통 스프레드 ${spreadTicks.toFixed(1)}틱`);
    } else {
      score -= 10;
      signals.push(`⚠️ 넓은 스프레드 ${spreadTicks.toFixed(1)}틱`);
    }

    // === 2. 호가 불균형 (Imbalance) ===
    let bidDepth = 0;
    let askDepth = 0;
    const depth = Math.min(config.ORDERBOOK_DEPTH, units.length);

    for (let i = 0; i < depth; i++) {
      bidDepth += units[i].bid_size;
      askDepth += units[i].ask_size;
    }

    const totalDepth = bidDepth + askDepth;
    const imbalance = totalDepth > 0 ? (bidDepth - askDepth) / totalDepth : 0;

    if (imbalance >= config.MIN_IMBALANCE) {
      score += 30;
      signals.push(`매수우세 ${(imbalance * 100).toFixed(1)}%`);
    } else if (imbalance >= config.MIN_IMBALANCE * 0.5) {
      score += 20;
      signals.push(`매수압력 ${(imbalance * 100).toFixed(1)}%`);
    } else if (imbalance <= -config.MIN_IMBALANCE) {
      score -= 20;
      signals.push(`⚠️ 매도우세 ${(imbalance * 100).toFixed(1)}%`);
    }

    // === 3. 베스트 호가 잔량 ===
    const bid1Size = units[0].bid_size;
    const ask1Size = units[0].ask_size;
    const bid1Ratio = bid1Size / (bid1Size + ask1Size);

    if (bid1Ratio >= 0.7) {
      score += 15;
      signals.push(`베스트호가 매수강함 ${(bid1Ratio * 100).toFixed(0)}%`);
    } else if (bid1Ratio >= 0.6) {
      score += 10;
      signals.push(`베스트호가 매수우세 ${(bid1Ratio * 100).toFixed(0)}%`);
    }

    // === 4. 호가 깊이 (5~10호가 누적) ===
    const midDepth = Math.floor(depth / 2);
    const nearBidDepth = units
      .slice(0, midDepth)
      .reduce((sum, u) => sum + u.bid_size, 0);
    const farBidDepth = units
      .slice(midDepth, depth)
      .reduce((sum, u) => sum + u.bid_size, 0);

    if (nearBidDepth > farBidDepth * 1.3) {
      score += 10;
      signals.push("근접 매수벽 강함");
    }

    const shouldBuy = score >= 25;

    if (shouldBuy) {
      log(
        "debug",
        `[Scalping Orderbook] BUY - ${score}점 (${signals.join(", ")})`
      );
    }

    return {
      signal: shouldBuy ? "BUY" : "NONE",
      score,
      reason: signals.join(", ") || "조건 미충족",
      data: { spread, spreadPercent, imbalance, bid1Ratio },
    };
  } catch (error) {
    log("error", "[Scalping Orderbook] 실행 실패", error.message);
    return { signal: "NONE", score: 0, reason: "실행 실패" };
  }
}

/**
 * ✅ 스캘핑 전용 캔들 패턴 (1분봉) - 단순화
 */
export async function checkScalpingCandle(market) {
  try {
    const candles = await cacheManager.get(
      `candles_1m_${market}_candle`,
      () => upbitAPI.getCandles(market, 20, "minutes", 1),
      1000
    );

    if (candles.length < 3) {
      return { signal: "NONE", score: 0, reason: "데이터 부족" };
    }

    const current = candles[0];
    const prev1 = candles[1];
    const prev2 = candles[2];

    let score = 0;
    const signals = [];

    // 연속 양봉
    const isBullish = current.trade_price > current.opening_price;
    const prev1Bullish = prev1.trade_price > prev1.opening_price;
    const prev2Bullish = prev2.trade_price > prev2.opening_price;

    if (isBullish && prev1Bullish && prev2Bullish) {
      score += 30;
      signals.push("3연속 양봉");
    } else if (isBullish && prev1Bullish) {
      score += 25;
      signals.push("2연속 양봉");
    } else if (isBullish) {
      score += 15;
      signals.push("양봉");
    }

    // 급등 (1분봉 기준)
    const change =
      ((current.trade_price - current.opening_price) / current.opening_price) *
      100;

    if (change >= 0.7) {
      score += 30;
      signals.push("급등");
    } else if (change >= 0.5) {
      score += 25;
      signals.push("강한 상승");
    } else if (change >= 0.3) {
      score += 15;
      signals.push("중간 상승");
    } else if (change >= 0.1) {
      score += 5;
      signals.push("약한 상승");
    }

    // 거래량 증가
    const volumeRatio =
      current.candle_acc_trade_volume / prev1.candle_acc_trade_volume;
    if (volumeRatio >= 2.0) {
      score += 15;
      signals.push("거래량 급증");
    } else if (volumeRatio >= 1.5) {
      score += 10;
      signals.push("거래량 증가");
    }

    // 상승 모멘텀 (최근 3봉 평균 변화)
    const changes = [
      ((current.trade_price - current.opening_price) / current.opening_price) *
        100,
      ((prev1.trade_price - prev1.opening_price) / prev1.opening_price) * 100,
      ((prev2.trade_price - prev2.opening_price) / prev2.opening_price) * 100,
    ];
    const avgChange = calculateAverage(changes);

    if (avgChange > 0.3) {
      score += 10;
      signals.push("강한 모멘텀");
    }

    const shouldBuy = score >= 30;

    if (shouldBuy) {
      log(
        "debug",
        `[Scalping Candle] BUY - ${score}점 (${signals.join(", ")})`
      );
    }

    return {
      signal: shouldBuy ? "BUY" : "NONE",
      score,
      reason: signals.join(", ") || "조건 미충족",
      data: { change, volumeRatio, avgChange },
    };
  } catch (error) {
    log("error", "[Scalping Candle] 실행 실패", error.message);
    return { signal: "NONE", score: 0, reason: "실행 실패" };
  }
}

/**
 * ✅ ATR 변동성 필터 - 진입 전 체크 (선택적)
 */
export async function checkATRFilter(market) {
  try {
    const candles = await cacheManager.get(
      `candles_1m_${market}_atr`,
      () => upbitAPI.getCandles(market, 20, "minutes", 1),
      1000
    );

    if (candles.length < 10) {
      return { pass: true, reason: "데이터 부족", atr: 0 };
    }

    // 단순 변동성 계산 (ATR 대신)
    const recentCandles = candles.slice(0, 5);
    let totalRange = 0;

    for (const candle of recentCandles) {
      const range =
        ((candle.high_price - candle.low_price) / candle.low_price) * 100;
      totalRange += range;
    }

    const avgRange = totalRange / recentCandles.length;

    if (avgRange < config.MIN_ATR_THRESHOLD) {
      log(
        "warn",
        `⚠️ 변동성 부족 (${avgRange.toFixed(2)}% < ${
          config.MIN_ATR_THRESHOLD
        }%) - 진입 금지`
      );
      return {
        pass: false,
        reason: `변동성 부족 ${avgRange.toFixed(2)}%`,
        atr: avgRange,
      };
    }

    return {
      pass: true,
      reason: `변동성 충분 ${avgRange.toFixed(2)}%`,
      atr: avgRange,
    };
  } catch (error) {
    log("error", "[ATR Filter] 실행 실패", error.message);
    return { pass: true, reason: "필터 실패", atr: 0 }; // 에러 시 통과
  }
}
