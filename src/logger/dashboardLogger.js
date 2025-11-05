import env from "../config/env.js";
import {
  log,
  formatKRW,
  formatPercent,
  getCurrentTime,
  toNumber,
  safeToFixed,
} from "../utils/helpers.js";
import fs from "fs";

/**
 * 실시간 대시보드 로거 - 스캘핑 최적화 + 유용한 정보 추가
 */
class DashboardLogger {
  constructor() {
    this.lastDashboardTime = 0;
    this.dashboardInterval = 1000;
    this.currentData = {};
    this.recentTrades = [];
    this.eventLogs = [];
    this.sellAttempts = [];

    // 📊 추가 통계
    this.apiCallStats = {
      total: 0,
      success: 0,
      error: 0,
      cacheHit: 0,
      cacheMiss: 0,
      lastResetTime: Date.now(),
    };

    this.lastCheckTime = Date.now();
    this.priceHistory = []; // 최근 가격 이력 (60개 = 1분)
  }

  /**
   * 데이터 업데이트
   */
  updateData(key, data) {
    this.currentData[key] = {
      ...data,
      timestamp: Date.now(),
    };
  }

  /**
   * API 통계 기록
   */
  recordAPICall(type, success = true) {
    this.apiCallStats.total++;
    if (success) {
      this.apiCallStats.success++;
    } else {
      this.apiCallStats.error++;
    }

    if (type === "cache_hit") {
      this.apiCallStats.cacheHit++;
    } else if (type === "cache_miss") {
      this.apiCallStats.cacheMiss++;
    }
  }

  /**
   * 가격 이력 추가
   */
  addPriceHistory(price) {
    this.priceHistory.push({
      price,
      timestamp: Date.now(),
    });

    // 최근 60개만 유지 (1분)
    if (this.priceHistory.length > 60) {
      this.priceHistory.shift();
    }
  }

  /**
   * API 통계 리셋 (1시간마다)
   */
  resetAPIStatsIfNeeded() {
    const now = Date.now();
    const elapsed = now - this.apiCallStats.lastResetTime;

    if (elapsed > 3600000) {
      // 1시간
      this.apiCallStats = {
        total: 0,
        success: 0,
        error: 0,
        cacheHit: 0,
        cacheMiss: 0,
        lastResetTime: now,
      };
    }
  }

  /**
   * 매도 조건 도달 추적
   */
  addConditionReached(condition, profitRate, targetRate, currentPrice) {
    const timestamp = new Date();
    const conditionText =
      {
        STOP_LOSS: `🛑 손절 조건 도달 (${formatPercent(
          profitRate
        )} / 목표 ${formatPercent(targetRate)})`,
        TAKE_PROFIT: `✨ 익절 조건 도달 (${formatPercent(
          profitRate
        )} / 목표 ${formatPercent(targetRate)})`,
        TRAILING_STOP: `📉 트레일링스탑 조건 도달 (${formatPercent(
          profitRate
        )})`,
      }[condition] || condition;

    const attempt = {
      time: timestamp.toLocaleTimeString("ko-KR"),
      type: "CONDITION",
      condition,
      conditionText,
      profitRate,
      targetRate,
      currentPrice,
      timestamp,
    };

    this.sellAttempts.push(attempt);
    if (this.sellAttempts.length > 10) {
      this.sellAttempts.shift();
    }

    this.logEvent("WARNING", conditionText);
  }

  /**
   * 매도 시도 추적
   */
  addSellAttempt(
    reason,
    reasonText,
    success = null,
    note = "",
    profitRate = 0
  ) {
    const timestamp = new Date();
    const attempt = {
      time: timestamp.toLocaleTimeString("ko-KR"),
      type: "ATTEMPT",
      reason,
      reasonText,
      success,
      note,
      profitRate,
      timestamp,
    };

    this.sellAttempts.push(attempt);
    if (this.sellAttempts.length > 10) {
      this.sellAttempts.shift();
    }
  }

  /**
   * 대시보드 출력 여부 체크
   */
  shouldPrintDashboard() {
    const now = Date.now();
    if (now - this.lastDashboardTime >= this.dashboardInterval) {
      this.lastDashboardTime = now;
      return true;
    }
    return false;
  }

  /**
   * 최근 거래 이력 로드
   */
  loadRecentTrades() {
    try {
      const tradesFile = "logs/trades.json";
      if (fs.existsSync(tradesFile)) {
        const data = fs.readFileSync(tradesFile, "utf8");
        const allTrades = JSON.parse(data);
        this.recentTrades = allTrades.slice(-5).reverse();
      }
    } catch (error) {
      this.recentTrades = [];
    }
  }

  /**
   * 메인 대시보드 출력
   */
  printDashboard() {
    console.clear();

    this.loadRecentTrades();
    this.resetAPIStatsIfNeeded();

    const width = 80;
    const line = "─".repeat(width);
    const doubleLine = "═".repeat(width);

    console.log("\n");
    console.log("\x1b[36m" + doubleLine + "\x1b[0m");
    console.log(this.centerText("⚡ 업비트 스캘핑 Bot v2.0", width));
    console.log(this.centerText(getCurrentTime(), width));
    console.log("\x1b[36m" + doubleLine + "\x1b[0m");

    // 포지션 또는 대기 상태
    if (this.currentData.position?.hasPosition) {
      this.printCompactPosition();
    } else {
      this.printWaitingStatusEnhanced();
    }

    // console.log("\x1b[90m" + line + "\x1b[0m");

    // 🆕 시장 실시간 상태
    this.printMarketStatus();

    // console.log("\x1b[90m" + line + "\x1b[0m");

    // 전략 상태
    this.printStrategyStatusEnhanced();

    // console.log("\x1b[90m" + line + "\x1b[0m");

    // 성과 통계
    this.printCompactPerformance();

    // console.log("\x1b[90m" + line + "\x1b[0m");

    // 🆕 시스템 모니터링
    this.printSystemMonitoring();

    // console.log("\x1b[90m" + line + "\x1b[0m");

    // 최근 거래
    this.printRecentTrades();

    // 매도 추적
    if (
      this.currentData.position?.hasPosition &&
      this.sellAttempts.length > 0
    ) {
      console.log("\x1b[90m" + line + "\x1b[0m");
      this.printSellTracking();
    }

    console.log("\x1b[36m" + doubleLine + "\x1b[0m");
    console.log("");
  }

  /**
   * 🆕 대기 상태 개선 (어떤 신호를 기다리는지 표시)
   */
  printWaitingStatusEnhanced() {
    console.log("");
    console.log("\x1b[1m⏳ 매수 대기 중\x1b[0m");
    console.log("");

    const signals = this.currentData.strategySignals;
    const context = this.currentData.marketContext;

    if (!signals) {
      console.log("  신호 분석 중...");
      console.log("");
      return;
    }

    const totalScore = toNumber(signals.totalScore, 0);
    const threshold = toNumber(signals.threshold, 40);
    const signalCount = toNumber(signals.signalCount, 0);
    const minSignals = toNumber(signals.minSignals, 1);

    // 진입 조건 체크
    const scoreReached = totalScore >= threshold;
    const signalsReached = signalCount >= minSignals;
    const marketOk = context?.isFavorable?.isFavorable || false;

    console.log("  📊 진입 조건 체크:");
    console.log("");

    // 1. 점수
    const scoreIcon = scoreReached ? "✅" : "⏳";
    const scoreColor = scoreReached ? "\x1b[32m" : "\x1b[33m";
    const scoreGap = threshold - totalScore;
    console.log(
      `  ${scoreIcon} 전략 점수: ${scoreColor}${totalScore}/${threshold}점\x1b[0m ${
        scoreReached ? "" : `(${scoreGap}점 부족)`
      }`
    );

    // 2. 신호 개수
    const signalIcon = signalsReached ? "✅" : "⏳";
    const signalColor = signalsReached ? "\x1b[32m" : "\x1b[33m";
    console.log(
      `  ${signalIcon} 활성 신호: ${signalColor}${signalCount}/${minSignals}개\x1b[0m ${
        signalsReached ? "" : `(${minSignals - signalCount}개 더 필요)`
      }`
    );

    // 3. 시장 상태
    const marketIcon = marketOk ? "✅" : "⚠️";
    const marketColor = marketOk ? "\x1b[32m" : "\x1b[31m";
    const marketScore = context?.isFavorable?.score || 0;
    const marketThreshold = context?.isFavorable?.threshold || 50;
    console.log(
      `  ${marketIcon} 시장 상태: ${marketColor}${marketScore}/${marketThreshold}점\x1b[0m ${
        marketOk ? "(진입 가능)" : "(진입 불가)"
      }`
    );

    console.log("");

    // 🆕 부족한 신호 표시
    if (!scoreReached || !signalsReached) {
      console.log("  🔍 기다리는 신호:");
      console.log("");

      if (signals.allResults && signals.allResults.length > 0) {
        // NONE 신호들 (비활성)
        const waitingSignals = signals.allResults.filter(
          (s) => s.signal === "NONE"
        );

        waitingSignals.forEach((signal) => {
          const score = toNumber(signal.score, 0);
          const targetScore = this.getTargetScoreForStrategy(signal.name);
          const gap = targetScore - score;

          console.log(
            `     ⏳ ${signal.name}: ${score}/${targetScore}점 (${gap}점 필요)`
          );
          if (signal.reason) {
            console.log(`        └─ ${signal.reason}`);
          }
        });
      }
    } else {
      console.log(
        "  ✅ \x1b[32m모든 신호 준비 완료! 다음 체크에서 진입 시도\x1b[0m"
      );
    }

    console.log("");

    // 다음 체크까지 시간
    this.printNextCheckTime();
  }

  /**
   * 🆕 전략별 목표 점수
   */
  getTargetScoreForStrategy(strategyName) {
    const targets = {
      RSI: 25,
      Volume: 30,
      Orderbook: 35,
      Candle: 30,
    };
    return targets[strategyName] || 20;
  }

  /**
   * 🆕 다음 체크까지 시간
   */
  printNextCheckTime() {
    const now = Date.now();
    const elapsed = now - this.lastCheckTime;
    const interval = env.TRADE_CHECK_INTERVAL;
    const remaining = Math.max(0, interval - elapsed);
    const seconds = Math.ceil(remaining / 1000);

    if (seconds > 0) {
      console.log(`  ⏱️  다음 체크: ${seconds}초 후`);
      console.log("");
    }
  }

  /**
   * 🆕 시장 실시간 상태 (점수 상세)
   */
  printMarketStatus() {
    return;
    const context = this.currentData.marketContext;

    if (!context) {
      return;
    }

    console.log("");
    console.log("\x1b[1m🌍 시장 실시간 상태\x1b[0m");
    console.log("");

    // 단기 추세
    const trendIcon = this.getTrendIcon(context.microTrend);
    const trendColor = this.getTrendColor(context.microTrend);
    console.log(
      `  ${trendIcon} 단기 추세: ${trendColor}${context.microTrend}\x1b[0m (${context.microMomentum})`
    );
    console.log(`     └─ 양봉: ${context.microBullish || 0}개 / 5개`);

    // 변동성
    const volIcon = context.isHighVolatility ? "⚠️" : "✅";
    const volColor = context.isHighVolatility ? "\x1b[31m" : "\x1b[32m";
    console.log(
      `  ${volIcon} 변동성: ${volColor}${
        context.volatility
      }\x1b[0m (${safeToFixed(context.volatilityRatio, 2)}x)`
    );

    // 거래량
    const volumeIcon = this.getVolumeIcon(context.volumeTrend);
    const volumeColor = this.getVolumeColor(context.volumeTrend);
    console.log(
      `  ${volumeIcon} 거래량: ${volumeColor}${
        context.volumeTrend
      }\x1b[0m (${safeToFixed(context.volumeRatio, 2)}x)`
    );
    console.log(`     └─ 강도: ${context.volumeStrength}`);

    // 🆕 점수 상세
    console.log("");
    console.log("  🎯 시장 점수 상세:");

    // 각 항목별 점수 (간단 계산)
    const volScore = this.calculateVolScore(context);
    const volumeScore = this.calculateVolumeScore(context);
    const trendScore = this.calculateTrendScore(context);

    console.log(`     • 변동성: ${volScore}/30점`);
    console.log(`     • 거래량: ${volumeScore}/30점`);
    console.log(`     • 추세: ${trendScore}/40점`);

    const totalScore = context.isFavorable?.score || 0;
    const scoreColor = totalScore >= 50 ? "\x1b[32m" : "\x1b[31m";
    console.log(`     ────────────────────`);
    console.log(`     = 총점: ${scoreColor}${totalScore}/100점\x1b[0m`);

    // 가격 변동
    if (this.priceHistory.length >= 2) {
      const firstPrice = this.priceHistory[0].price;
      const lastPrice = this.priceHistory[this.priceHistory.length - 1].price;
      const priceChange = ((lastPrice - firstPrice) / firstPrice) * 100;
      const priceIcon = priceChange > 0 ? "📈" : priceChange < 0 ? "📉" : "➡️";
      const priceColor =
        priceChange > 0
          ? "\x1b[32m"
          : priceChange < 0
          ? "\x1b[31m"
          : "\x1b[33m";

      console.log("");
      console.log(
        `  ${priceIcon} 1분 변동: ${priceColor}${formatPercent(
          priceChange
        )}\x1b[0m`
      );
    }

    console.log("");
  }
  /**
   * 변동성 점수 간이 계산
   */
  calculateVolScore(context) {
    if (context.volatility === "NORMAL") return 30;
    if (context.volatility === "LOW") return 15;
    if (context.isHighVolatility) return 0;
    return 20;
  }

  /**
   * 거래량 점수 간이 계산
   */
  calculateVolumeScore(context) {
    const strength = context.volumeStrength || 0;
    if (strength >= 2) return 30;
    if (strength >= 1) return 25;
    if (strength === 0) return 15;
    return 5;
  }

  /**
   * 추세 점수 간이 계산
   */
  calculateTrendScore(context) {
    if (context.microTrend === "STRONG_UP") return 40;
    if (context.microTrend === "UP") return 30;
    if (context.microTrend === "NEUTRAL") return 20;
    if (context.microTrend === "DOWN") return 10;
    return 0;
  }

  /**
   * ✅ 전략 상태 개선 - 음수 점수 처리
   */
  printStrategyStatusEnhanced() {
    const signals = this.currentData.strategySignals;

    console.log("");
    console.log("\x1b[1m🎯 전략 신호 분석 (실시간)\x1b[0m");
    console.log("");

    if (!signals) {
      console.log("  분석 중...");
      console.log("");
      return;
    }

    const totalScore = toNumber(signals.totalScore, 0);
    const threshold = toNumber(signals.threshold, 40);

    // ✅ scoreProgress 음수 방지
    const scoreProgress = Math.max(
      0,
      Math.min(100, (totalScore / threshold) * 100)
    );

    // ✅ ATR 정보 추가
    const atr = toNumber(signals.atr, 0);
    const atrThreshold = toNumber(env.MIN_ATR_THRESHOLD, 0.08);
    const atrPass = atr >= atrThreshold;
    const atrColor = atrPass ? "\x1b[32m" : "\x1b[31m";
    const atrIcon = atrPass ? "✅" : "❌";

    // ATR 실패 여부 체크
    const atrFailed = signals.filterFailed === "ATR";

    // 전체 점수 바
    const scoreBar = this.createProgressBar(
      40,
      scoreProgress,
      totalScore >= threshold
    );
    const scoreColor = totalScore >= threshold ? "\x1b[32m" : "\x1b[33m";

    console.log(
      `  📊 총점: ${scoreColor}\x1b[1m${totalScore}/${threshold}점\x1b[0m`
    );
    console.log(`     ${scoreBar}`);

    // ✅ ATR 표시 추가
    console.log("");
    console.log(
      `  ${atrIcon} 변동성 (ATR): ${atrColor}\x1b[1m${atr.toFixed(
        3
      )}%\x1b[0m (기준: ${atrThreshold}%)`
    );

    if (atrFailed || !atrPass) {
      const reason = signals.filterReason || "변동성 부족";
      console.log(`     └─ ⚠️  \x1b[33m${reason} - 진입 대기 중\x1b[0m`);
    } else {
      console.log(`     └─ ✅ \x1b[32m진입 가능한 변동성\x1b[0m`);
    }

    console.log("");

    // 각 전략별 상세
    if (signals.allResults && signals.allResults.length > 0) {
      console.log("  📈 전략별 상세:");
      console.log("");

      signals.allResults.forEach((signal) => {
        const isBuy = signal.signal === "BUY";
        const icon = isBuy ? "🚀" : "⏳";
        const color = isBuy ? "\x1b[32m" : "\x1b[90m";

        // ✅ 음수 점수 처리
        const score = toNumber(signal.score, 0);
        const targetScore = this.getTargetScoreForStrategy(signal.name);

        // ✅ progress 음수 방지
        const progress = Math.max(
          0,
          Math.min(100, (score / targetScore) * 100)
        );

        // ✅ 음수 점수 표시 개선
        const scoreDisplay =
          score < 0 ? `\x1b[31m${score}점\x1b[0m` : `${color}${score}점\x1b[0m`;

        console.log(`     ${icon} ${signal.name.padEnd(10)} ${scoreDisplay}`);

        // 미니 프로그레스 바
        const miniBar = this.createMiniProgressBar(20, progress, isBuy);
        console.log(`        ${miniBar} ${signal.reason || "대기 중"}`);
      });
    }

    console.log("");
  }

  /**
   * 🆕 시스템 모니터링
   */
  printSystemMonitoring() {
    return;
    console.log("");
    console.log("\x1b[1m⚙️ 시스템 모니터링\x1b[0m");
    console.log("");

    // API 통계
    const total = this.apiCallStats.total;
    const success = this.apiCallStats.success;
    const error = this.apiCallStats.error;
    const successRate = total > 0 ? (success / total) * 100 : 0;

    const apiColor =
      successRate >= 95
        ? "\x1b[32m"
        : successRate >= 80
        ? "\x1b[33m"
        : "\x1b[31m";

    console.log(
      `  📡 API 호출: ${total}회 (성공률: ${apiColor}${safeToFixed(
        successRate,
        1
      )}%\x1b[0m)`
    );

    if (error > 0) {
      console.log(`     └─ ❌ 에러: ${error}회`);
    }

    // 캐시 효율
    const cacheTotal = this.apiCallStats.cacheHit + this.apiCallStats.cacheMiss;
    const cacheHitRate =
      cacheTotal > 0 ? (this.apiCallStats.cacheHit / cacheTotal) * 100 : 0;

    if (cacheTotal > 0) {
      const cacheColor =
        cacheHitRate >= 70
          ? "\x1b[32m"
          : cacheHitRate >= 50
          ? "\x1b[33m"
          : "\x1b[31m";
      console.log(
        `  💾 캐시 효율: ${cacheColor}${safeToFixed(
          cacheHitRate,
          1
        )}%\x1b[0m (${this.apiCallStats.cacheHit}/${cacheTotal})`
      );
    }

    // 메모리 사용량
    const memUsage = process.memoryUsage();
    const memMB = Math.round(memUsage.heapUsed / 1024 / 1024);
    const memColor =
      memMB < 100 ? "\x1b[32m" : memMB < 200 ? "\x1b[33m" : "\x1b[31m";

    console.log(`  💻 메모리: ${memColor}${memMB}MB\x1b[0m`);

    // 업타임
    const uptime = process.uptime();
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    console.log(`  ⏰ 가동시간: ${hours}시간 ${minutes}분`);

    console.log("");
  }

  /**
   * ✅ 미니 프로그레스 바 (전략용) - 음수 방어
   */
  createMiniProgressBar(width, progress, isComplete) {
    // ✅ CRITICAL: progress와 width 검증 및 보정
    const safeWidth = Math.max(1, Math.min(100, Math.floor(width || 20)));
    const safeProgress = Math.max(0, Math.min(100, parseFloat(progress || 0)));

    // ✅ filledWidth 음수 방지
    const filledWidth = Math.max(
      0,
      Math.floor((safeWidth * safeProgress) / 100)
    );
    const emptyWidth = Math.max(0, safeWidth - filledWidth);

    if (isComplete) {
      return "\x1b[32m" + "█".repeat(safeWidth) + "\x1b[0m";
    } else {
      const filled = "\x1b[33m" + "█".repeat(filledWidth) + "\x1b[0m";
      const empty = "\x1b[90m" + "░".repeat(emptyWidth) + "\x1b[0m";
      return filled + empty;
    }
  }

  /**
   * 추세 아이콘
   */
  getTrendIcon(trend) {
    const icons = {
      STRONG_UP: "🚀",
      UP: "📈",
      NEUTRAL: "➡️",
      DOWN: "📉",
      STRONG_DOWN: "⚠️",
    };
    return icons[trend] || "❓";
  }

  /**
   * 추세 색상
   */
  getTrendColor(trend) {
    if (trend.includes("UP")) return "\x1b[32m";
    if (trend.includes("DOWN")) return "\x1b[31m";
    return "\x1b[33m";
  }

  /**
   * 거래량 아이콘
   */
  getVolumeIcon(volumeTrend) {
    const icons = {
      SURGING: "🔥",
      INCREASING: "📊",
      RISING: "📈",
      NORMAL: "➡️",
      DECREASING: "📉",
      DRYING: "⚠️",
    };
    return icons[volumeTrend] || "❓";
  }

  /**
   * 거래량 색상
   */
  getVolumeColor(volumeTrend) {
    if (["SURGING", "INCREASING", "RISING"].includes(volumeTrend))
      return "\x1b[32m";
    if (["DECREASING", "DRYING"].includes(volumeTrend)) return "\x1b[31m";
    return "\x1b[33m";
  }

  printCompactPosition() {
    const position = this.currentData.position;
    if (!position || !position.hasPosition) return;

    const pos = position.data;
    const currentPrice = toNumber(position.currentPrice || pos.avgBuyPrice, 0);
    const avgBuyPrice = toNumber(pos.avgBuyPrice, 0);
    const balance = toNumber(pos.balance, 0);

    const evaluatedAmount = currentPrice * balance;
    const investedAmount = toNumber(pos.totalInvested, 0);
    const profit = evaluatedAmount - investedAmount;
    const profitRate = investedAmount > 0 ? (profit / investedAmount) * 100 : 0;

    const stopLoss = toNumber(env.STOP_LOSS_PERCENT, -0.5);
    const takeProfit = toNumber(env.TAKE_PROFIT_PERCENT, 0.6);
    const stopLossPrice = avgBuyPrice * (1 + stopLoss / 100);
    const takeProfitPrice = avgBuyPrice * (1 + takeProfit / 100);

    const stopLossTriggered = profitRate <= stopLoss;
    const takeProfitTriggered = profitRate >= takeProfit;

    const profitColor = profitRate >= 0 ? "\x1b[32m" : "\x1b[31m";
    const profitIcon = profitRate >= 0 ? "💰" : "📉";

    console.log("");
    console.log("\x1b[1m📊 포지션 현황 (실시간)\x1b[0m");
    console.log("");

    // 🔥 핵심 정보 한눈에 보기
    console.log("  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log(
      `  ${profitIcon} 현재가: \x1b[1m\x1b[33m${formatKRW(currentPrice)}\x1b[0m`
    );
    console.log(`  💵 매수가: ${formatKRW(avgBuyPrice)}`);
    console.log(
      `  📈 수익률: \x1b[1m${profitColor}${formatPercent(
        profitRate
      )}\x1b[0m ${profitColor}(${formatKRW(profit)})\x1b[0m`
    );
    console.log("  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("");

    // 🆕 매도 조건 상태 명확히 표시
    console.log("\x1b[1m🎯 매도 조건 체크\x1b[0m");
    console.log("");

    // 손절
    const stopGap = currentPrice - stopLossPrice;
    const stopGapPercent = (stopGap / avgBuyPrice) * 100;

    console.log(
      `  🛑 손절가: ${formatKRW(stopLossPrice)} (${formatPercent(stopLoss)})`
    );
    if (stopLossTriggered) {
      console.log(`     🚨 \x1b[31m\x1b[1m손절 발동! 즉시 매도 예정\x1b[0m`);
    } else if (stopGapPercent < 0.1) {
      console.log(
        `     ⚠️  \x1b[33m손절 임박! ${formatKRW(
          Math.abs(stopGap)
        )} (${formatPercent(Math.abs(stopGapPercent))})\x1b[0m`
      );
    } else {
      console.log(
        `     ✅ 안전 (여유: ${formatKRW(stopGap)} / ${formatPercent(
          stopGapPercent
        )})`
      );
    }
    console.log("");

    // 익절
    const takeGap = takeProfitPrice - currentPrice;
    const takeGapPercent = (takeGap / avgBuyPrice) * 100;

    console.log(
      `  ✨ 익절가: ${formatKRW(takeProfitPrice)} (+${formatPercent(
        takeProfit
      )})`
    );
    if (takeProfitTriggered) {
      console.log(`     🎉 \x1b[32m\x1b[1m익절 발동! 즉시 매도 예정\x1b[0m`);
    } else if (takeGapPercent < 0.1) {
      console.log(
        `     🔥 \x1b[33m익절 임박! ${formatKRW(takeGap)} (${formatPercent(
          takeGapPercent
        )})\x1b[0m`
      );
    } else {
      console.log(
        `     ⏳ 목표까지: ${formatKRW(takeGap)} (${formatPercent(
          takeGapPercent
        )})`
      );
    }
    console.log("");

    // 트레일링 스탑
    if (env.TRAILING_STOP_ENABLED && pos.highestPrice) {
      const highestPrice = toNumber(pos.highestPrice, avgBuyPrice);
      const dropFromHigh =
        highestPrice > 0
          ? ((highestPrice - currentPrice) / highestPrice) * 100
          : 0;
      const trailingTriggered = dropFromHigh >= env.TRAILING_STOP_PERCENT;

      console.log(
        `  📉 트레일링: ${formatPercent(
          env.TRAILING_STOP_PERCENT
        )} (최고가 대비)`
      );
      console.log(`     최고가: ${formatKRW(highestPrice)}`);
      console.log(`     하락률: ${formatPercent(dropFromHigh)}`);

      if (trailingTriggered) {
        console.log(
          `     🚨 \x1b[31m\x1b[1m트레일링 발동! 즉시 매도 예정\x1b[0m`
        );
      } else {
        const remaining = env.TRAILING_STOP_PERCENT - dropFromHigh;
        console.log(`     ✅ 여유: ${formatPercent(remaining)}`);
      }
      console.log("");
    }

    // 보유 정보
    const holdingTime = this.getCompactHoldingTime(pos.buyTime);

    console.log("\x1b[1m💎 보유 정보\x1b[0m");
    console.log("");
    console.log(`  ⏱️  보유시간: ${holdingTime}`);
    console.log(`  💰 투자원금: ${formatKRW(investedAmount)}`);
    console.log(`  📊 평가금액: ${formatKRW(evaluatedAmount)}`);
    console.log(
      `  🪙 수량: ${safeToFixed(balance, 8)} ${env.MARKET.split("-")[1]}`
    );
    console.log("");
  }

  /**
   * ✅ 프로그레스 바 생성 - 음수 방어
   */
  createProgressBar(width, progress, isComplete) {
    // ✅ CRITICAL: progress와 width 검증 및 보정
    const safeWidth = Math.max(1, Math.min(100, Math.floor(width || 40)));
    const safeProgress = Math.max(0, Math.min(100, parseFloat(progress || 0)));

    // ✅ filledWidth 음수 방지
    const filledWidth = Math.max(
      0,
      Math.floor((safeWidth * safeProgress) / 100)
    );
    const emptyWidth = Math.max(0, safeWidth - filledWidth);

    if (isComplete) {
      return "\x1b[32m" + "█".repeat(safeWidth) + "\x1b[0m";
    } else {
      const filled = "\x1b[33m" + "█".repeat(filledWidth) + "\x1b[0m";
      const empty = "\x1b[90m" + "░".repeat(emptyWidth) + "\x1b[0m";
      return filled + empty + ` ${safeToFixed(safeProgress, 1)}%`;
    }
  }

  printSellTracking() {
    console.log("");
    console.log("\x1b[1m🔍 매도 추적 로그\x1b[0m");
    console.log("");

    if (this.sellAttempts.length === 0) {
      console.log("  대기 중...");
      console.log("");
      return;
    }

    const recentAttempts = this.sellAttempts.slice(-10);

    recentAttempts.forEach((attempt) => {
      if (attempt.type === "CONDITION") {
        const conditionIcon =
          {
            STOP_LOSS: "🛑",
            TAKE_PROFIT: "✨",
            TRAILING_STOP: "📉",
          }[attempt.condition] || "⚠️";

        console.log(
          `  ${conditionIcon} [${attempt.time}] ${attempt.conditionText}`
        );
        console.log(`     └─ 현재가: ${formatKRW(attempt.currentPrice)}`);
      } else if (attempt.type === "ATTEMPT") {
        let icon = "⏳";
        let color = "\x1b[33m";
        let status = "시도";

        if (attempt.success === true) {
          icon = "✅";
          color = "\x1b[32m";
          status = "성공";
        } else if (attempt.success === false) {
          icon = "❌";
          color = "\x1b[31m";
          status = `실패 (${attempt.note})`;
        }

        console.log(
          `  ${icon} [${attempt.time}] ${attempt.reasonText} ${color}${status}\x1b[0m`
        );

        if (attempt.profitRate !== 0) {
          const profitColor = attempt.profitRate >= 0 ? "\x1b[32m" : "\x1b[31m";
          console.log(
            `     └─ 수익률: ${profitColor}${formatPercent(
              attempt.profitRate
            )}\x1b[0m`
          );
        }
      }
    });

    console.log("");
  }

  printCompactPerformance() {
    const perf = this.currentData.performance;

    console.log("");
    console.log("\x1b[1m📈 성과 통계\x1b[0m");
    console.log("");

    if (!perf || toNumber(perf.totalTrades, 0) === 0) {
      console.log("  거래 내역 없음");
      console.log("");
      return;
    }

    const totalTrades = toNumber(perf.totalTrades, 0);
    const wins = toNumber(perf.wins, 0);
    const losses = toNumber(perf.losses, 0);
    const winRate = toNumber(perf.winRate, 0);
    const avgProfit = toNumber(perf.avgProfit, 0);
    const totalProfit = toNumber(perf.totalProfit, 0);
    const maxProfit = toNumber(perf.maxProfit, 0);
    const maxLoss = toNumber(perf.maxLoss, 0);

    const winRateColor =
      winRate >= 70 ? "\x1b[32m" : winRate >= 50 ? "\x1b[33m" : "\x1b[31m";
    const winRateIcon = winRate >= 70 ? "🏆" : winRate >= 50 ? "📊" : "📉";

    const avgColor = avgProfit >= 0 ? "\x1b[32m" : "\x1b[31m";
    const totalColor = totalProfit >= 0 ? "\x1b[32m" : "\x1b[31m";

    console.log(`  📊 총 거래: ${totalTrades}회`);
    console.log(`  ✅ 수익: ${wins}회  ❌ 손실: ${losses}회`);
    console.log(
      `  ${winRateIcon} 승률: ${winRateColor}\x1b[1m${safeToFixed(
        winRate,
        1
      )}%\x1b[0m`
    );
    console.log(
      `  💹 평균 수익률: ${avgColor}\x1b[1m${formatPercent(avgProfit)}\x1b[0m`
    );
    console.log(
      `  💰 누적 수익: ${totalColor}\x1b[1m${formatKRW(totalProfit)}\x1b[0m`
    );
    console.log("");
    console.log(`  🔺 최대 수익: \x1b[32m${formatPercent(maxProfit)}\x1b[0m`);
    console.log(`  🔻 최대 손실: \x1b[31m${formatPercent(maxLoss)}\x1b[0m`);
    console.log("");
  }

  printRecentTrades() {
    console.log("");
    console.log("\x1b[1m📋 최근 거래 (최근 5건)\x1b[0m");
    console.log("");

    if (this.recentTrades.length === 0) {
      console.log("  거래 내역 없음");
      console.log("");
      return;
    }

    this.recentTrades.forEach((trade) => {
      const id = trade.id || "?";
      const time = new Date(trade.sellTime).toLocaleString("ko-KR", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
      const profitRate = toNumber(trade.profitRate, 0);
      const profit = toNumber(trade.profit, 0);
      const duration = toNumber(trade.holdingMinutes, 0);
      const reason = trade.reason || "";

      const profitColor = profitRate >= 0 ? "\x1b[32m" : "\x1b[31m";
      const profitIcon = profitRate >= 0 ? "💰" : "📉";

      const reasonIcon =
        {
          STOP_LOSS: "🛑",
          TAKE_PROFIT: "✨",
          TRAILING_STOP: "📉",
        }[reason] || "";

      console.log(
        `  ${profitIcon} #${String(id).padStart(
          3,
          "0"
        )}  ${time}  ${profitColor}\x1b[1m${formatPercent(
          profitRate
        )}\x1b[0m  ${profitColor}${formatKRW(
          profit
        )}\x1b[0m  ${duration}분 ${reasonIcon}`
      );
    });

    console.log("");
  }

  logEvent(type, message, data = null) {
    const icons = {
      BUY: "💰",
      SELL: "💸",
      SIGNAL: "🎯",
      WARNING: "⚠️",
      ERROR: "❌",
      SUCCESS: "✅",
      INFO: "💬",
      CONDITION: "🔔",
    };

    const icon = icons[type] || "📝";
    const timestamp = new Date().toLocaleTimeString("ko-KR");
    let logMessage = `${icon} [${timestamp}] ${message}`;

    if (data) {
      const dataStr = Object.entries(data)
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ");
      logMessage += ` (${dataStr})`;
    }

    this.eventLogs.push(logMessage);
    if (this.eventLogs.length > 15) {
      this.eventLogs.shift();
    }

    if (["BUY", "SELL", "ERROR", "WARNING"].includes(type)) {
      console.log("\n" + logMessage);
      if (data) {
        console.log(
          "   " + JSON.stringify(data, null, 2).split("\n").join("\n   ")
        );
      }
      console.log("");
    }
  }

  centerText(text, width) {
    const strLength = text.length;
    const padding = Math.floor((width - strLength) / 2);
    return " ".repeat(Math.max(0, padding)) + text;
  }

  getCompactHoldingTime(buyTime) {
    try {
      const now = new Date();
      const buy = new Date(buyTime);
      const diffMs = now - buy;

      if (diffMs < 0) return "0초";

      const hours = Math.floor(diffMs / (1000 * 60 * 60));
      const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
      const seconds = Math.floor((diffMs % (1000 * 60)) / 1000);

      if (hours > 0) {
        return `${hours}시간 ${minutes}분`;
      } else if (minutes > 0) {
        return `${minutes}분 ${seconds}초`;
      } else {
        return `${seconds}초`;
      }
    } catch (error) {
      return "계산 불가";
    }
  }
}

export default new DashboardLogger();
