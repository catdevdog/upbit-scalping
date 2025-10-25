import upbitAPI from "../api/upbit.js";
import { calculateRSI } from "../utils/indicators.js";
import { calculateAverage, log } from "../utils/helpers.js";
import cacheManager from "../utils/cache.js";

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
 * ⚡ 스캘핑 전용 거래량 폭증 감지 (1분봉)
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
      data: { volumeRatio, priceChange },
    };
  } catch (error) {
    log("error", "[Scalping Volume] 실행 실패", error.message);
    return { signal: "NONE", score: 0, reason: "실행 실패" };
  }
}

/**
 * ⚡ 스캘핑 전용 호가창 분석 (1~3호가 집중)
 */
export async function checkScalpingOrderbook(market) {
  try {
    const orderbook = await cacheManager.get(
      `orderbook_${market}`,
      () => upbitAPI.getOrderbook(market),
      1000
    );

    if (!orderbook || !orderbook.orderbook_units) {
      return { signal: "NONE", score: 0, reason: "데이터 부족" };
    }

    const units = orderbook.orderbook_units;

    // 1~3호가 집중 분석
    const topBidSize = units
      .slice(0, 3)
      .reduce((sum, u) => sum + u.bid_size, 0);
    const topAskSize = units
      .slice(0, 3)
      .reduce((sum, u) => sum + u.ask_size, 0);

    // ✅ topAskSize = 0 예외 처리
    if (topAskSize === 0) {
      return { signal: "NONE", score: 0, reason: "매도 호가 없음" };
    }

    const ratio = topBidSize / topAskSize;

    // 1호가 스프레드
    const firstBid = units[0].bid_price;
    const firstAsk = units[0].ask_price;
    const spread = ((firstAsk - firstBid) / firstBid) * 100;

    // 1호가 체결 강도
    const bidStrength = units[0].bid_size / topBidSize;

    let score = 0;
    const signals = [];

    // 매수 압력
    if (ratio >= 4.0) {
      score += 40;
      signals.push("압도적 매수세");
    } else if (ratio >= 3.5) {
      score += 35;
      signals.push("강한 매수세");
    } else if (ratio >= 3.0) {
      score += 30;
      signals.push("매수 우세");
    } else if (ratio >= 2.5) {
      score += 25;
      signals.push("매수 증가");
    }

    // 좁은 스프레드 (빠른 체결)
    if (spread < 0.03) {
      score += 20;
      signals.push("초박 스프레드");
    } else if (spread < 0.05) {
      score += 15;
      signals.push("좁은 스프레드");
    } else if (spread < 0.1) {
      score += 10;
      signals.push("보통 스프레드");
    }

    // 1호가 집중도
    if (bidStrength > 0.6) {
      score += 10;
      signals.push("1호가 집중");
    }

    const shouldBuy = score >= 35;

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
      data: { ratio, spread, bidStrength },
    };
  } catch (error) {
    log("error", "[Scalping Orderbook] 실행 실패", error.message);
    return { signal: "NONE", score: 0, reason: "실행 실패" };
  }
}

/**
 * ⚡ 스캘핑 전용 캔들 패턴 (1분봉)
 */
export async function checkScalpingCandle(market) {
  try {
    const candles = await cacheManager.get(
      `candles_1m_${market}_candle`,
      () => upbitAPI.getCandles(market, 5, "minutes", 1),
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
