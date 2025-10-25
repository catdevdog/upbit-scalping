import upbitAPI from "../api/upbit.js";
import { calculateVolatility } from "../utils/indicators.js";
import { calculateAverage, log } from "../utils/helpers.js";
import cacheManager from "../utils/cache.js";
import config from "../config/env.js";

/**
 * 스캘핑 전용 시장 상황 분석 (간소화)
 */
class MarketContext {
  /**
   * 종합 시장 상황 분석 (캐시 1분)
   */
  async analyze(market) {
    return await cacheManager.get(
      `market_context_${market}`,
      async () => {
        try {
          const [volatilityCheck, volumeAnalysis, microTrend] =
            await Promise.all([
              this.checkVolatility(market),
              this.analyzeVolume(market),
              this.analyzeMicroTrend(market),
            ]);

          const context = {
            // 변동성 정보
            volatility: volatilityCheck.level,
            isHighVolatility: volatilityCheck.isHigh,
            volatilityRatio: volatilityCheck.ratio,

            // 거래량 정보
            volumeTrend: volumeAnalysis.trend,
            volumeStrength: volumeAnalysis.strength,
            volumeRatio: volumeAnalysis.ratio,

            // 단기 추세 (스캘핑용)
            microTrend: microTrend.direction,
            microMomentum: microTrend.momentum,
            microBullish: microTrend.bullish,

            // 종합 판단
            isFavorable: this.calculateFavorability(
              volatilityCheck,
              volumeAnalysis,
              microTrend
            ),

            timestamp: new Date().toISOString(),
          };

          this.logContext(context);
          return context;
        } catch (error) {
          log("error", "[Context] 시장 분석 실패", error.message);
          return this.getDefaultContext();
        }
      },
      60000 // 1분 캐시
    );
  }

  /**
   * 변동성 체크 (5분봉)
   */
  async checkVolatility(market) {
    const candles = await cacheManager.get(
      `candles_5m_${market}_volatility`,
      () => upbitAPI.getCandles(market, 50, "minutes", 5),
      5000
    );

    // 최근 10개 봉의 변동성
    const recentVol = calculateVolatility(candles.slice(0, 10), 10);

    // 평균 변동성
    const avgVol = calculateVolatility(candles, 50);

    const ratio = recentVol / avgVol;

    let level = "NORMAL";
    if (ratio > 2.5) {
      level = "EXTREME";
    } else if (ratio > 2.0) {
      level = "HIGH";
    } else if (ratio < 0.5) {
      level = "LOW";
    }

    return {
      level,
      isHigh: ratio > config.VOLATILITY_THRESHOLD,
      ratio,
      recentVol,
      avgVol,
    };
  }

  /**
   * 거래량 분석 (5분봉)
   */
  async analyzeVolume(market) {
    const candles = await cacheManager.get(
      `candles_5m_${market}_volume_analysis`,
      () => upbitAPI.getCandles(market, 30, "minutes", 5),
      5000
    );

    // 최근 5봉 평균 거래량
    const recentVolumes = candles
      .slice(0, 5)
      .map((c) => c.candle_acc_trade_volume);
    const recentAvg = calculateAverage(recentVolumes);

    // 전체 평균 거래량
    const allVolumes = candles.map((c) => c.candle_acc_trade_volume);
    const overallAvg = calculateAverage(allVolumes);

    const ratio = recentAvg / overallAvg;

    let trend = "NORMAL";
    let strength = 0;

    if (ratio > 2.5) {
      trend = "SURGING";
      strength = 3;
    } else if (ratio > 2.0) {
      trend = "INCREASING";
      strength = 2;
    } else if (ratio > 1.5) {
      trend = "RISING";
      strength = 1;
    } else if (ratio < 0.8) {
      trend = "DECREASING";
      strength = -1;
    }

    return {
      trend,
      strength,
      ratio,
      recentAvg,
      overallAvg,
    };
  }

  /**
   * 단기 추세 분석 (1분봉, 스캘핑용)
   */
  async analyzeMicroTrend(market) {
    const candles = await cacheManager.get(
      `candles_1m_${market}_micro`,
      () => upbitAPI.getCandles(market, 10, "minutes", 1),
      1000
    );

    // 최근 5개 봉 (5분) 분석
    const recent = candles.slice(0, 5);

    // 상승/하락 봉 카운트
    const bullish = recent.filter(
      (c) => c.trade_price > c.opening_price
    ).length;

    const bearish = recent.filter(
      (c) => c.trade_price < c.opening_price
    ).length;

    // 평균 변화율
    const changes = recent.map(
      (c) => ((c.trade_price - c.opening_price) / c.opening_price) * 100
    );
    const avgChange = calculateAverage(changes);

    // 추세 방향
    let direction = "NEUTRAL";
    if (bullish >= 4) {
      direction = "STRONG_UP";
    } else if (bullish >= 3) {
      direction = "UP";
    } else if (bearish >= 4) {
      direction = "STRONG_DOWN";
    } else if (bearish >= 3) {
      direction = "DOWN";
    }

    // 모멘텀 (최근 2봉의 추세)
    const lastTwo = candles.slice(0, 2);
    const lastBullish = lastTwo.filter(
      (c) => c.trade_price > c.opening_price
    ).length;

    const momentum =
      lastBullish === 2
        ? "POSITIVE"
        : lastBullish === 0
        ? "NEGATIVE"
        : "NEUTRAL";

    return {
      direction,
      momentum,
      bullish,
      bearish,
      avgChange,
      total: recent.length,
    };
  }

  /**
   * 종합 진입 가능 여부 판단 (스캘핑 기준)
   */
  calculateFavorability(volatility, volume, micro) {
    let score = 0;
    const reasons = [];

    // 1. 변동성 (가중치 30%)
    if (volatility.level === "NORMAL") {
      score += 30;
      reasons.push("정상 변동성");
    } else if (volatility.level === "LOW") {
      score += 15;
      reasons.push("낮은 변동성");
    } else if (volatility.isHigh) {
      score += 0;
      reasons.push("❌ 높은 변동성");
    } else {
      score += 20;
      reasons.push("보통 변동성");
    }

    // 2. 거래량 (가중치 30%)
    if (volume.strength >= 2) {
      score += 30;
      reasons.push("거래량 급증");
    } else if (volume.strength >= 1) {
      score += 25;
      reasons.push("거래량 증가");
    } else if (volume.strength === 0) {
      score += 15;
      reasons.push("보통 거래량");
    } else {
      score += 5;
      reasons.push("낮은 거래량");
    }

    // 3. 단기 추세 (가중치 40%)
    if (micro.direction === "STRONG_UP") {
      score += 40;
      reasons.push("강한 상승");
    } else if (micro.direction === "UP") {
      score += 30;
      reasons.push("상승 추세");
    } else if (micro.direction === "NEUTRAL") {
      score += 20;
      reasons.push("중립");
    } else {
      score += 0;
      reasons.push("❌ 하락 추세");
    }

    // 스캘핑은 낮은 임계값 (50점)
    const isFavorable = score >= config.MARKET_FAVORABLE_THRESHOLD;

    return {
      score,
      isFavorable,
      reasons: reasons.join(", "),
      threshold: config.MARKET_FAVORABLE_THRESHOLD,
    };
  }
  /**
   * 시장 상황 로깅 (상세 버전)
   */
  logContext(context) {
    const favorable = context.isFavorable.isFavorable;

    log("info", "");
    log("info", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    log("info", "🌍 스캘핑 시장 분석 (상세)");
    log("info", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    // === 단기 추세 ===
    log(
      "info",
      `📊 단기 추세: ${context.microTrend} (${context.microMomentum})`
    );
    log("debug", `   └─ 양봉: ${context.microBullish}개 / 5개`);

    // === 변동성 ===
    log(
      "info",
      `🌊 변동성: ${
        context.volatility
      } (비율: ${context.volatilityRatio.toFixed(2)}x)`
    );
    log(
      "debug",
      `   └─ 최근/평균: ${context.volatilityRatio.toFixed(2)}x (기준: ${
        config.VOLATILITY_THRESHOLD
      }x)`
    );

    // === 거래량 ===
    log(
      "info",
      `📦 거래량: ${context.volumeTrend} (비율: ${context.volumeRatio.toFixed(
        2
      )}x)`
    );
    log(
      "debug",
      `   └─ 강도: ${
        context.volumeStrength
      } (최근/평균: ${context.volumeRatio.toFixed(2)}x)`
    );

    // === 점수 상세 분석 ===
    log("info", "");
    log("info", "🎯 점수 상세:");

    // 변동성 점수
    const volScore = this.getVolatilityScore(context);
    log("info", `   • 변동성: ${volScore.score}/30점 (${volScore.reason})`);

    // 거래량 점수
    const volumeScore = this.getVolumeScore(context);
    log(
      "info",
      `   • 거래량: ${volumeScore.score}/30점 (${volumeScore.reason})`
    );

    // 추세 점수
    const trendScore = this.getTrendScore(context);
    log(
      "info",
      `   • 단기추세: ${trendScore.score}/40점 (${trendScore.reason})`
    );

    log("info", "");
    log(
      favorable ? "success" : "warn",
      `${favorable ? "✅" : "⚠️"} 진입 가능: ${favorable ? "YES" : "NO"} (${
        context.isFavorable.score
      }/${context.isFavorable.threshold}점)`
    );

    if (!favorable) {
      log("warn", `💡 개선 필요: ${context.isFavorable.reasons}`);
    }
    log("info", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
  }

  /**
   * 변동성 점수 계산 (디버깅용)
   */
  getVolatilityScore(context) {
    const volatility = {
      level: context.volatility,
      isHigh: context.isHighVolatility,
      ratio: context.volatilityRatio,
    };

    if (volatility.level === "NORMAL") {
      return { score: 30, reason: "정상 변동성" };
    } else if (volatility.level === "LOW") {
      return { score: 15, reason: "낮은 변동성" };
    } else if (volatility.isHigh) {
      return {
        score: 0,
        reason: `❌ 높은 변동성 (${volatility.ratio.toFixed(2)}x)`,
      };
    } else {
      return { score: 20, reason: "보통 변동성" };
    }
  }

  /**
   * 거래량 점수 계산 (디버깅용)
   */
  getVolumeScore(context) {
    const strength = context.volumeStrength;
    const ratio = context.volumeRatio;

    if (strength >= 2) {
      return { score: 30, reason: `거래량 급증 (${ratio.toFixed(2)}x)` };
    } else if (strength >= 1) {
      return { score: 25, reason: `거래량 증가 (${ratio.toFixed(2)}x)` };
    } else if (strength === 0) {
      return { score: 15, reason: `보통 거래량 (${ratio.toFixed(2)}x)` };
    } else {
      return { score: 5, reason: `❌ 낮은 거래량 (${ratio.toFixed(2)}x)` };
    }
  }

  /**
   * 추세 점수 계산 (디버깅용)
   */
  getTrendScore(context) {
    const direction = context.microTrend;
    const bullish = context.microBullish;

    if (direction === "STRONG_UP") {
      return { score: 40, reason: `강한 상승 (양봉 ${bullish}개)` };
    } else if (direction === "UP") {
      return { score: 30, reason: `상승 추세 (양봉 ${bullish}개)` };
    } else if (direction === "NEUTRAL") {
      return { score: 20, reason: `중립 (양봉 ${bullish}개)` };
    } else if (direction === "DOWN") {
      return { score: 10, reason: `❌ 하락 추세 (양봉 ${bullish}개)` };
    } else {
      return { score: 0, reason: `❌ 강한 하락 (양봉 ${bullish}개)` };
    }
  }

  /**
   * 기본 컨텍스트 (에러 시)
   */
  getDefaultContext() {
    return {
      volatility: "UNKNOWN",
      microTrend: "UNKNOWN",
      isFavorable: {
        score: 0,
        isFavorable: false,
        reasons: "분석 실패",
      },
    };
  }
}

export default new MarketContext();
