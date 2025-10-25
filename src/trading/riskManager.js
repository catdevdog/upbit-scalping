import config from "../config/env.js";
import { log, formatPercent } from "../utils/helpers.js";
import dashboard from "../logger/dashboardLogger.js";
import { calculateEntryScore } from "../strategies/index.js";
import { calculateRSI } from "../utils/indicators.js";
import upbitAPI from "../api/upbit.js";
import cacheManager from "../utils/cache.js";
import positionManager from "./position.js"; // Position manager import

class RiskManager {
  constructor() {
    this.lastCheckTime = 0;
    this.conditionTracking = {
      stopLoss: false,
      takeProfit: false,
      trailingStop: false,
      timeLimit: false,
      momentumLoss: false,
      sideways: false,
      reverseSignal: false,
    };
  }

  /**
   * 종합 청산 조건 체크 (스캘핑 로직)
   */
  async checkExitConditions(positionData, currentPrice) {
    if (!positionData) return { shouldExit: false };

    const profitRate =
      ((currentPrice - positionData.avgBuyPrice) / positionData.avgBuyPrice) *
      100;
    const holdingSeconds = Math.floor(
      (Date.now() - positionData.buyTime) / 1000
    );

    // === 1. 손절 체크 (최우선) ===
    const stopLossCheck = this.checkStopLoss(profitRate);
    if (stopLossCheck.shouldExit) return stopLossCheck;

    // === 2. 익절 체크 ===
    const takeProfitCheck = this.checkTakeProfit(profitRate);
    if (takeProfitCheck.shouldExit) return takeProfitCheck;

    // === 3. 트레일링 스탑 ===
    const trailingCheck = this.checkTrailingStop(positionData, currentPrice);
    if (trailingCheck.shouldExit) return trailingCheck;

    // === 4. 시간 기반 청산 (스캘핑 핵심) ===
    const timeCheck = this.checkTimeBasedExit(holdingSeconds, profitRate);
    if (timeCheck.shouldExit) return timeCheck;

    // === 5. 모멘텀 소멸 청산 ===
    const momentumCheck = this.checkMomentumExit(holdingSeconds);
    if (momentumCheck.shouldExit) return momentumCheck;

    // === 6. 횡보 청산 ===
    const sidewaysCheck = this.checkSidewaysExit(holdingSeconds, profitRate);
    if (sidewaysCheck.shouldExit) return sidewaysCheck;

    // === 7. 역추세 감지 청산 ===
    if (config.REVERSE_SIGNAL_CHECK) {
      const reverseCheck = await this.checkReverseSignal(
        profitRate,
        holdingSeconds
      );
      if (reverseCheck.shouldExit) return reverseCheck;
    }

    return {
      shouldExit: false,
      profitRate,
      currentPrice,
    };
  }

  /**
   * 손절 체크
   */
  checkStopLoss(profitRate) {
    if (profitRate <= config.STOP_LOSS_PERCENT) {
      if (!this.conditionTracking.stopLoss) {
        this.conditionTracking.stopLoss = true;
        dashboard.addConditionReached(
          "STOP_LOSS",
          profitRate,
          config.STOP_LOSS_PERCENT,
          0
        );
        log("warn", `🛑 손절 조건 충족: ${formatPercent(profitRate)}`);
      }

      return {
        shouldExit: true,
        reason: "STOP_LOSS",
        reasonText: "🛑 손절",
        profitRate,
      };
    } else {
      if (this.conditionTracking.stopLoss) {
        this.conditionTracking.stopLoss = false;
        log("info", `✅ 손절 조건 벗어남: ${formatPercent(profitRate)}`);
      }
    }

    return { shouldExit: false };
  }

  /**
   * 익절 체크 (빠른 익절 포함)
   */
  checkTakeProfit(profitRate) {
    // 빠른 익절 (QUICK_PROFIT)
    if (profitRate >= config.QUICK_PROFIT_PERCENT) {
      if (!this.conditionTracking.takeProfit) {
        this.conditionTracking.takeProfit = true;
        dashboard.addConditionReached(
          "QUICK_PROFIT",
          profitRate,
          config.QUICK_PROFIT_PERCENT,
          0
        );
        log("info", `⚡ 빠른 익절 조건 충족: ${formatPercent(profitRate)}`);
      }

      return {
        shouldExit: true,
        reason: "QUICK_PROFIT",
        reasonText: "⚡ 빠른 익절",
        profitRate,
      };
    }

    // 최종 익절
    if (profitRate >= config.TAKE_PROFIT_PERCENT) {
      if (!this.conditionTracking.takeProfit) {
        this.conditionTracking.takeProfit = true;
        dashboard.addConditionReached(
          "TAKE_PROFIT",
          profitRate,
          config.TAKE_PROFIT_PERCENT,
          0
        );
        log("info", `✨ 익절 조건 충족: ${formatPercent(profitRate)}`);
      }

      return {
        shouldExit: true,
        reason: "TAKE_PROFIT",
        reasonText: "✨ 익절",
        profitRate,
      };
    } else {
      if (this.conditionTracking.takeProfit) {
        this.conditionTracking.takeProfit = false;
        log("info", `⏳ 익절 조건 벗어남: ${formatPercent(profitRate)}`);
      }
    }

    return { shouldExit: false };
  }

  /**
   * 트레일링 스탑
   */
  checkTrailingStop(positionData, currentPrice) {
    if (!config.TRAILING_STOP_ENABLED) {
      return { shouldExit: false };
    }

    const dropFromHigh =
      ((positionData.highestPrice - currentPrice) / positionData.highestPrice) *
      100;

    if (dropFromHigh >= config.TRAILING_STOP_PERCENT) {
      if (!this.conditionTracking.trailingStop) {
        this.conditionTracking.trailingStop = true;
        dashboard.addConditionReached(
          "TRAILING_STOP",
          dropFromHigh,
          config.TRAILING_STOP_PERCENT,
          currentPrice
        );
        log(
          "info",
          `📉 트레일링 스탑: 최고가 대비 ${formatPercent(dropFromHigh)} 하락`
        );
      }

      const profitRate =
        ((currentPrice - positionData.avgBuyPrice) / positionData.avgBuyPrice) *
        100;

      return {
        shouldExit: true,
        reason: "TRAILING_STOP",
        reasonText: "📉 트레일링스탑",
        profitRate,
        dropFromHigh,
      };
    } else {
      if (this.conditionTracking.trailingStop) {
        this.conditionTracking.trailingStop = false;
      }
    }

    return { shouldExit: false };
  }

  /**
   * 시간 기반 청산 (스캘핑 핵심)
   */
  checkTimeBasedExit(holdingSeconds, profitRate) {
    // Case 1: 최대 보유 시간 초과 (최소 수익률 체크 추가)
    if (holdingSeconds >= config.MAX_HOLDING_TIME) {
      // 최소 수익률 이상일 때만 청산
      if (profitRate >= config.SIDEWAYS_EXIT_THRESHOLD) {
        if (!this.conditionTracking.timeLimit) {
          this.conditionTracking.timeLimit = true;
          dashboard.addConditionReached("TIME_LIMIT", profitRate, 0, 0);
          log(
            "info",
            `⏰ 최대 보유시간(${config.MAX_HOLDING_TIME}초) 초과 + 수익 확보 → 청산`
          );
        }

        return {
          shouldExit: true,
          reason: "TIME_LIMIT_PROFIT",
          reasonText: `⏰ 시간초과+익절(${holdingSeconds}초)`,
          profitRate,
        };
      } else {
        // 수익률 부족 시 청산하지 않음 (손절선 대기)
        if (!this.conditionTracking.timeLimit) {
          this.conditionTracking.timeLimit = true;
          log(
            "warn",
            `⏰ 시간 초과지만 수익률 부족 (${formatPercent(
              profitRate
            )} < ${formatPercent(
              config.SIDEWAYS_EXIT_THRESHOLD
            )}) - 손절선 대기`
          );
        }
        return { shouldExit: false };
      }
    }

    // Case 2: PROFIT_TIME_LIMIT 초과 + 소폭 수익 → 청산
    if (holdingSeconds >= config.PROFIT_TIME_LIMIT) {
      if (profitRate >= config.SIDEWAYS_EXIT_THRESHOLD) {
        if (!this.conditionTracking.timeLimit) {
          this.conditionTracking.timeLimit = true;
          log(
            "info",
            `🕐 ${config.PROFIT_TIME_LIMIT}초 경과 + 수익 확보 → 청산`
          );
        }

        return {
          shouldExit: true,
          reason: "TIME_PROFIT",
          reasonText: `🕐 시간익절(${holdingSeconds}초)`,
          profitRate,
        };
      }
    }

    // 초기화
    if (
      this.conditionTracking.timeLimit &&
      holdingSeconds < config.PROFIT_TIME_LIMIT
    ) {
      this.conditionTracking.timeLimit = false;
    }

    return { shouldExit: false };
  }

  /**
   * 모멘텀 소멸 청산 (position 모듈 직접 호출)
   */
  checkMomentumExit(holdingSeconds) {
    // 60초 이상 보유 시에만 체크
    if (holdingSeconds < config.SIDEWAYS_TIME_LIMIT) {
      return { shouldExit: false };
    }

    // positionManager 모듈의 메서드 직접 호출
    const momentumLoss = positionManager.checkMomentumLoss();

    if (momentumLoss) {
      if (!this.conditionTracking.momentumLoss) {
        this.conditionTracking.momentumLoss = true;
        log(
          "warn",
          `📊 모멘텀 소멸 감지 (${config.MOMENTUM_CHECK_PERIOD}초간 ${config.MOMENTUM_THRESHOLD}% 미만)`
        );
      }

      // positionManager에서 현재가 조회
      const priceHistory = positionManager.priceHistory;
      if (priceHistory.length === 0) {
        return { shouldExit: false };
      }

      const currentPrice = priceHistory[priceHistory.length - 1]?.price;
      const avgBuyPrice = positionManager.position?.avgBuyPrice;

      if (!currentPrice || !avgBuyPrice) {
        return { shouldExit: false };
      }

      const profitRate = ((currentPrice - avgBuyPrice) / avgBuyPrice) * 100;

      // 최소 수익률 이상일 때만 청산
      if (profitRate >= config.SIDEWAYS_EXIT_THRESHOLD) {
        return {
          shouldExit: true,
          reason: "MOMENTUM_LOSS",
          reasonText: "📊 모멘텀소멸",
          profitRate,
        };
      } else {
        log(
          "debug",
          `📊 모멘텀 소멸이지만 수익률 부족: ${formatPercent(
            profitRate
          )} < ${formatPercent(config.SIDEWAYS_EXIT_THRESHOLD)}`
        );
      }
    } else {
      if (this.conditionTracking.momentumLoss) {
        this.conditionTracking.momentumLoss = false;
      }
    }

    return { shouldExit: false };
  }

  /**
   * 횡보 청산 (position 모듈 직접 호출)
   */
  checkSidewaysExit(holdingSeconds, profitRate) {
    // 60초 이상 보유 시에만 체크
    if (holdingSeconds < config.SIDEWAYS_TIME_LIMIT) {
      return { shouldExit: false };
    }

    // positionManager 모듈의 메서드 직접 호출
    const isSideways = positionManager.isSideways(config.SIDEWAYS_TIME_LIMIT);

    if (isSideways) {
      if (!this.conditionTracking.sideways) {
        this.conditionTracking.sideways = true;
        log(
          "warn",
          `➡️ 횡보 감지 (${config.SIDEWAYS_TIME_LIMIT}초간 0.1% 미만 변동)`
        );
      }

      // 최소 수익률 이상일 때만 청산
      if (profitRate >= config.SIDEWAYS_EXIT_THRESHOLD) {
        return {
          shouldExit: true,
          reason: "SIDEWAYS",
          reasonText: "➡️ 횡보청산",
          profitRate,
        };
      } else {
        log(
          "debug",
          `📊 횡보지만 수익률 부족: ${formatPercent(
            profitRate
          )} < ${formatPercent(config.SIDEWAYS_EXIT_THRESHOLD)}`
        );
      }
    } else {
      if (this.conditionTracking.sideways) {
        this.conditionTracking.sideways = false;
      }
    }

    return { shouldExit: false };
  }

  /**
   * 역추세 감지 청산
   */
  async checkReverseSignal(profitRate, holdingSeconds) {
    // 최소 보유 시간 체크 (60초 미만에서는 역추세 청산 안 함)
    if (holdingSeconds < config.SIDEWAYS_TIME_LIMIT) {
      return { shouldExit: false };
    }

    try {
      // (1) 진입 신호 재확인
      const signals = await calculateEntryScore(config.MARKET);

      // 모든 매수 신호가 사라짐
      if (signals.signalCount === 0) {
        if (!this.conditionTracking.reverseSignal) {
          this.conditionTracking.reverseSignal = true;
          log("warn", `🔄 진입 신호 모두 소멸 → 청산 고려`);
        }

        // 손실이 아니면 청산
        if (profitRate >= config.SIDEWAYS_EXIT_THRESHOLD) {
          return {
            shouldExit: true,
            reason: "SIGNAL_LOSS",
            reasonText: "🔄 신호소멸",
            profitRate,
          };
        }
      }

      // (2) RSI 과매수 체크
      const candles = await cacheManager.get(
        `candles_1m_${config.MARKET}_rsi`,
        () => upbitAPI.getCandles(config.MARKET, 20, "minutes", 1),
        1000
      );

      if (candles && candles.length >= 15) {
        const rsi = calculateRSI(candles, 14);

        if (rsi >= config.RSI_OVERBOUGHT) {
          if (!this.conditionTracking.reverseSignal) {
            this.conditionTracking.reverseSignal = true;
            log("warn", `🔄 RSI 과매수 (${rsi.toFixed(1)}) → 청산 고려`);
          }

          // 손실이 아니면 청산
          if (profitRate >= config.SIDEWAYS_EXIT_THRESHOLD) {
            return {
              shouldExit: true,
              reason: "RSI_OVERBOUGHT",
              reasonText: "🔄 과매수",
              profitRate,
            };
          }
        }
      }

      // 초기화
      if (this.conditionTracking.reverseSignal) {
        this.conditionTracking.reverseSignal = false;
      }
    } catch (error) {
      log("error", "역추세 체크 실패", error.message);
    }

    return { shouldExit: false };
  }

  /**
   * 포지션 모니터링
   */
  async monitorPosition(positionData, getCurrentPrice) {
    if (!positionData) return;

    const currentPrice = await getCurrentPrice();
    const profitRate =
      ((currentPrice - positionData.avgBuyPrice) / positionData.avgBuyPrice) *
      100;

    return profitRate;
  }

  /**
   * 조건 추적 초기화 (새 포지션 진입 시)
   */
  resetTracking() {
    this.conditionTracking = {
      stopLoss: false,
      takeProfit: false,
      trailingStop: false,
      timeLimit: false,
      momentumLoss: false,
      sideways: false,
      reverseSignal: false,
    };
  }
}

export default new RiskManager();
