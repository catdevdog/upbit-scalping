import config from "./config/env.js";
import { calculateEntryScore } from "./strategies/index.js";
import executor from "./trading/executor.js";
import position from "./trading/position.js";
import riskManager from "./trading/riskManager.js";
import stateManager from "./logger/stateManager.js";
import tradeLogger from "./logger/tradeLogger.js";
import performanceTracker from "./logger/performanceTracker.js";
import emergencyMonitor from "./monitor/emergencyStop.js";
import marketContext from "./strategies/marketContext.js";
import dashboard from "./logger/dashboardLogger.js";
import { sleep, log, formatKRW, formatPercent } from "./utils/helpers.js";

class UpbitScalpingBot {
  constructor() {
    this.isRunning = false;
    this.riskCheckInterval = null;
    this.dashboardInterval = null;
    this.dataUpdateInterval = null;
    this.priceUpdateInterval = null;
    this.isProcessingSell = false;
    this.lastSyncTime = 0;
    this.syncInterval = 30000;
  }

  async initialize() {
    console.clear();

    dashboard.logEvent("INFO", "⚡ 업비트 스캘핑 봇 초기화 중...");

    log("info", `📈 마켓: ${config.MARKET}`);
    log("info", `⚡ 모드: SCALPING (전액 매수)`);
    log(
      "info",
      `🛡️ 손절: ${config.STOP_LOSS_PERCENT}% / 익절: ${config.TAKE_PROFIT_PERCENT}%`
    );
    log("info", `⏱️ 체크 주기: ${config.TRADE_CHECK_INTERVAL / 1000}초`);
    log("success", "✅ 스캘핑 전용 시스템 활성화");
    log("success", "📊 실시간 대시보드 활성화\n");

    await this.checkAndHandleDust();

    const savedState = stateManager.loadState();
    if (savedState && savedState.position) {
      position.loadState(savedState.position);
    }

    await this.syncPosition();
    await this.updateDashboardData();

    this.isRunning = true;

    dashboard.logEvent("SUCCESS", "초기화 완료! 스캘핑 시작...");

    await sleep(2000);
  }

  async checkAndHandleDust() {
    try {
      const currency = config.MARKET.split("-")[1];
      const coinPosition = await executor.getCoinPosition(config.MARKET);

      if (coinPosition.balance === 0) {
        log("info", "✅ Dust 없음 - 깨끗한 상태");
        return;
      }

      const currentPrice = await executor.getCurrentPrice(config.MARKET);
      const dustValueKRW = coinPosition.balance * currentPrice;

      log("warn", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      log("warn", "🔍 Dust(잔여 소량) 감지!");
      log("warn", `   수량: ${coinPosition.balance.toFixed(8)} ${currency}`);
      log("warn", `   가치: ${formatKRW(dustValueKRW)}`);

      if (dustValueKRW < 100) {
        log("info", "✅ 100원 미만 소량 - 무시");
        log("warn", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
        return;
      }

      log("warn", "🗑️  100원 이상 잔여 - 자동 매도 시작");
      log("warn", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

      const sellResult = await executor.executeSell(
        config.MARKET,
        coinPosition.balance,
        "DUST_CLEANUP",
        "🗑️ Dust 정리",
        0
      );

      if (sellResult) {
        log("success", "✅ Dust 자동 매도 완료\n");
      } else {
        log("warn", "⚠️ Dust 매도 실패 - 수동 처리 필요\n");
      }
    } catch (error) {
      log("error", "Dust 체크 실패", error.message);
    }
  }

  async syncPosition() {
    try {
      const now = Date.now();
      if (now - this.lastSyncTime < this.syncInterval) {
        return;
      }

      this.lastSyncTime = now;

      const coinPosition = await executor.getCoinPosition(config.MARKET);

      if (coinPosition.balance === 0 && position.hasPosition()) {
        log("warn", "⚠️ 유령 포지션 감지 - 포지션 제거");
        position.position = null;
        this.saveState();
        return;
      }

      if (coinPosition.balance > 0 && !position.hasPosition()) {
        log("warn", "⚠️ 미동기 포지션 감지 - 복구 시도");

        const currentPrice = await executor.getCurrentPrice(config.MARKET);
        const currentValueKRW = coinPosition.balance * currentPrice;

        position.openPosition(
          coinPosition.balance,
          coinPosition.avgBuyPrice,
          currentValueKRW
        );
        position.updateHighestPrice(coinPosition.avgBuyPrice);

        log("success", "✅ 포지션 복구 완료");
        this.saveState();
      }
    } catch (error) {
      log("error", "포지션 동기화 실패", error.message);
    }
  }

  startRiskMonitoring() {
    this.riskCheckInterval = setInterval(async () => {
      if (!position.hasPosition()) return;

      try {
        const currentPrice = await executor.getCurrentPrice(config.MARKET);
        position.updatePrice(currentPrice);
        position.updateHighestPrice(currentPrice);

        const exitInfo = await riskManager.checkExitCondition(currentPrice);
        if (exitInfo.shouldExit) {
          await this.executeSell(exitInfo);
        }
      } catch (error) {
        log("error", "손익 체크 실패", error.message);
      }
    }, config.RISK_CHECK_INTERVAL);
  }

  startPriceUpdate() {
    this.priceUpdateInterval = setInterval(async () => {
      if (!position.hasPosition()) return;

      try {
        const currentPrice = await executor.getCurrentPrice(config.MARKET);
        position.updatePrice(currentPrice);
        position.updateHighestPrice(currentPrice);
      } catch (error) {
        log("error", "가격 업데이트 실패", error.message);
      }
    }, 3000);
  }

  startPriceUpdate() {
    this.priceUpdateInterval = setInterval(async () => {
      if (!position.hasPosition()) return;

      try {
        const currentPrice = await executor.getCurrentPrice(config.MARKET);
        position.updatePrice(currentPrice);
        position.updateHighestPrice(currentPrice);
      } catch (error) {
        log("error", "가격 업데이트 실패", error.message);
      }
    }, 3000);
  }

  async updateDashboardData() {
    try {
      const currentPrice = await executor.getCurrentPrice(config.MARKET);
      dashboard.updateData("currentPrice", currentPrice);

      // ✅ 수정: analyzeMarket → analyze
      const context = await marketContext.analyze(config.MARKET);
      dashboard.updateData("marketContext", context);

      const signals = await calculateEntryScore(config.MARKET);
      dashboard.updateData("strategySignals", signals);

      if (position.hasPosition()) {
        dashboard.updateData("position", {
          hasPosition: true,
          data: position.getPosition(),
          currentPrice: currentPrice,
        });
      } else {
        dashboard.updateData("position", { hasPosition: false });
      }

      dashboard.updateData("stopLoss", config.STOP_LOSS_PERCENT);
      dashboard.updateData("takeProfit", config.TAKE_PROFIT_PERCENT);

      const performance = performanceTracker.getPerformanceSummary();
      dashboard.updateData("performance", performance);
    } catch (error) {
      log("error", "대시보드 데이터 업데이트 실패", error.message);
    }
  }

  async executeBuy(signals, contextScore) {
    try {
      const krwBalance = await executor.getAvailableKRW();
      const buyAmount = executor.calculateBuyAmount(krwBalance);

      if (buyAmount === 0) {
        dashboard.logEvent(
          "WARNING",
          `투자 불가: 잔고 ${formatKRW(krwBalance)}`
        );
        return;
      }

      dashboard.logEvent("BUY", "⚡ 스캘핑 전액 매수 시도", {
        잔고: formatKRW(krwBalance),
        매수금액: formatKRW(buyAmount),
        전략점수: signals.totalScore + "점",
        시장점수: contextScore + "/100",
      });

      const result = await executor.executeBuy(config.MARKET, buyAmount);

      if (!result || !result.success) {
        dashboard.logEvent("WARNING", "매수 실패 - 다음 기회 대기");
        return;
      }

      let coinPosition = null;
      let attempts = 0;
      const maxAttempts = 5;
      const delays = [500, 1000, 2000, 3000, 5000];

      while (attempts < maxAttempts) {
        try {
          coinPosition = await executor.getCoinPosition(config.MARKET);

          if (coinPosition.balance > 0) {
            log("success", `✅ 포지션 확인 성공 (${attempts + 1}회 시도)`);
            break;
          }

          attempts++;
          if (attempts < maxAttempts) {
            const delay = delays[attempts - 1] || 3000;
            log(
              "warn",
              `⚠️ 포지션 확인 실패 (${attempts}/${maxAttempts}) - ${delay}ms 후 재시도...`
            );
            await sleep(delay);
          }
        } catch (error) {
          attempts++;
          log(
            "error",
            `포지션 조회 오류 (${attempts}/${maxAttempts}): ${error.message}`
          );

          if (attempts < maxAttempts) {
            const delay = delays[attempts - 1] || 3000;
            await sleep(delay);
          }
        }
      }

      if (coinPosition && coinPosition.balance > 0) {
        position.openPosition(
          coinPosition.balance,
          coinPosition.avgBuyPrice,
          buyAmount
        );

        position.updateHighestPrice(coinPosition.avgBuyPrice);

        const currentPrice = await executor.getCurrentPrice(config.MARKET);
        const immediateProfit =
          ((currentPrice - coinPosition.avgBuyPrice) /
            coinPosition.avgBuyPrice) *
          100;

        dashboard.logEvent("SUCCESS", "✅ 매수 완료!", {
          수량: coinPosition.balance.toFixed(8),
          평균단가: formatKRW(coinPosition.avgBuyPrice),
          현재가: formatKRW(currentPrice),
          초기손익: formatPercent(immediateProfit),
        });

        log("info", `🎯 최고가 초기값: ${formatKRW(coinPosition.avgBuyPrice)}`);

        riskManager.resetTracking();
        this.saveState();
        await this.updateDashboardData();
        return;
      } else {
        log("warn", "⚠️ 포지션 조회 실패 - 주문 정보로 포지션 생성 시도");

        if (result.executedVolume && result.avgPrice) {
          log("info", "✅ executor에서 포지션 확인 완료 - 바로 사용");

          position.openPosition(
            result.executedVolume,
            result.avgPrice,
            buyAmount
          );

          position.updateHighestPrice(result.avgPrice);

          const currentPrice = await executor.getCurrentPrice(config.MARKET);
          const immediateProfit =
            ((currentPrice - result.avgPrice) / result.avgPrice) * 100;

          dashboard.logEvent("SUCCESS", "✅ 매수 완료!", {
            수량: result.executedVolume.toFixed(8),
            평균단가: formatKRW(result.avgPrice),
            현재가: formatKRW(currentPrice),
            초기손익: formatPercent(immediateProfit),
          });

          log("info", `🎯 최고가 초기값: ${formatKRW(result.avgPrice)}`);

          riskManager.resetTracking();
          this.saveState();
          await this.updateDashboardData();
          return;
        } else {
          log(
            "error",
            "❌ 매수 완료 후 포지션 생성 실패 - 다음 사이클에서 동기화"
          );
          dashboard.logEvent(
            "ERROR",
            "매수 완료 후 포지션 생성 실패 - 자동 동기화 대기"
          );

          // ✅ 대시보드 업데이트 추가
          await this.updateDashboardData();
        }
      }
    } catch (error) {
      dashboard.logEvent("ERROR", "매수 실행 오류: " + error.message);
      emergencyMonitor.recordError();

      // ✅ 에러 발생 시에도 대시보드 업데이트
      await this.updateDashboardData();
    }
  }

  async executeSell(exitInfo) {
    if (this.isProcessingSell) {
      log("warn", "⚠️ 매도 이미 진행 중 - 중복 호출 무시");
      return;
    }

    this.isProcessingSell = true;
    const sellStartTime = Date.now();

    try {
      const pos = position.getPosition();
      if (!pos) {
        log("warn", "⚠️ 매도할 포지션 없음");
        return;
      }

      const { reason, reasonText, profitRate, price } = exitInfo;

      dashboard.logEvent("SELL", `💸 매도 실행 (${reasonText})`);
      log("warn", `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      log("warn", `🚨 매도 시작!`);
      log("warn", `   사유: ${reasonText}`);
      log("warn", `   수익률: ${formatPercent(profitRate)}`);
      log("warn", `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

      const result = await executor.executeSell(
        config.MARKET,
        pos.balance,
        reason,
        reasonText,
        profitRate
      );

      if (!result) {
        log("error", "❌ 매도 실패");
        dashboard.logEvent("WARNING", "매도 실패 - 다음 체크에서 재시도");
        return;
      }

      log(
        "success",
        `✅ executor.executeSell 완료! (${Date.now() - sellStartTime}ms)`
      );

      if (result.alreadySold) {
        log("success", "✅ 이미 매도 완료된 상태 확인 - 포지션 제거");
        position.position = null;
        this.saveState();
        await this.updateDashboardData();
        return;
      }

      const coinPosition = await executor.getCoinPosition(config.MARKET);
      if (coinPosition.balance > 0) {
        log(
          "warn",
          `⚠️ 매도 후에도 잔여 수량 존재: ${coinPosition.balance.toFixed(8)}`
        );
        return;
      }

      const currentPrice = await executor.getCurrentPrice(config.MARKET);
      const sellAmount = pos.balance * currentPrice;

      const tradeResult = position.closePosition(currentPrice, sellAmount);
      tradeResult.reason = reason;

      const profit = tradeResult.profit;
      const finalProfitRate = tradeResult.profitRate;

      tradeLogger.logTrade(tradeResult);

      dashboard.logEvent(
        profit >= 0 ? "SUCCESS" : "WARNING",
        `✅ 매도 완료! ${reasonText}`,
        {
          최종수익률: formatPercent(finalProfitRate),
          최종수익: formatKRW(profit),
          매도가: formatKRW(currentPrice),
          보유시간: tradeResult.holdingMinutes + "분",
        }
      );

      const summary = performanceTracker.getPerformanceSummary();
      log("info", "");
      log("info", "📊 누적 통계:");
      log("info", `   총 거래: ${summary.totalTrades}회`);
      log("info", `   승률: ${formatPercent(summary.winRate)}`);
      log("info", `   평균 수익률: ${formatPercent(summary.avgProfit)}`);
      log("info", `   누적 수익: ${formatKRW(summary.totalProfit)}`);
      log("info", "");

      this.saveState();
      await this.updateDashboardData();
      riskManager.resetTracking();

      log("success", `✅ 매도 전체 완료! (${Date.now() - sellStartTime}ms)`);
    } catch (error) {
      dashboard.logEvent("ERROR", "매도 오류: " + error.message);
      log("error", "executeSell 오류:", error);
      emergencyMonitor.recordError();
    } finally {
      this.isProcessingSell = false;
    }
  }

  async checkAndTrade() {
    try {
      await this.syncPosition();

      if (position.hasPosition()) {
        return;
      }

      if (executor.isCurrentlyBuying()) {
        return;
      }

      const signals = await calculateEntryScore(config.MARKET);

      // ✅ 수정: analyzeMarket → analyze
      const context = await marketContext.analyze(config.MARKET);

      if (signals.shouldEnter && context.isFavorable.isFavorable) {
        dashboard.logEvent("SIGNAL", "🎯 진입 조건 만족!", {
          전략점수: signals.totalScore + "점",
          시장점수: context.isFavorable.score + "/100",
          활성신호: signals.signalCount + "개",
        });

        await this.executeBuy(signals, context.isFavorable.score);
      }
    } catch (error) {
      dashboard.logEvent("ERROR", "거래 체크 실패: " + error.message);
      emergencyMonitor.recordError();
    }
  }
  /**
   * ✅ 대시보드 갱신 - 출력과 데이터 업데이트 분리
   */
  startDashboardUpdates() {
    // 100ms마다 대시보드 출력 (화면 갱신)
    this.dashboardInterval = setInterval(() => {
      if (dashboard.shouldPrintDashboard()) {
        dashboard.printDashboard();
      }
    }, 100);

    // 5초마다 데이터 업데이트 (API 호출)
    this.dataUpdateInterval = setInterval(async () => {
      await this.updateDashboardData();
    }, 5000);
  }

  async updateDashboardData() {
    try {
      const currentPrice = await executor.getCurrentPrice(config.MARKET);
      dashboard.updateData("currentPrice", currentPrice);

      const context = await marketContext.analyze(config.MARKET);
      dashboard.updateData("marketContext", context);

      const signals = await calculateEntryScore(config.MARKET);
      dashboard.updateData("strategySignals", signals);

      if (position.hasPosition()) {
        dashboard.updateData("position", {
          hasPosition: true,
          data: position.getPosition(),
          currentPrice: currentPrice,
        });
      } else {
        dashboard.updateData("position", { hasPosition: false });
      }

      dashboard.updateData("stopLoss", config.STOP_LOSS_PERCENT);
      dashboard.updateData("takeProfit", config.TAKE_PROFIT_PERCENT);

      const performance = performanceTracker.getPerformanceSummary();
      dashboard.updateData("performance", performance);
    } catch (error) {
      log("error", "대시보드 데이터 업데이트 실패", error.message);
    }
  }

  async run() {
    await this.initialize();
    this.startRiskMonitoring();
    this.startPriceUpdate();
    this.startDashboardUpdates();

    while (this.isRunning) {
      await this.checkAndTrade();
      await sleep(config.TRADE_CHECK_INTERVAL);
    }
  }

  saveState() {
    stateManager.saveState({
      position: position.getState(),
    });
  }

  async stop() {
    dashboard.logEvent("INFO", "프로그램 종료 중...");
    this.isRunning = false;

    if (this.riskCheckInterval) clearInterval(this.riskCheckInterval);
    if (this.dashboardInterval) clearInterval(this.dashboardInterval);
    if (this.dataUpdateInterval) clearInterval(this.dataUpdateInterval);
    if (this.priceUpdateInterval) clearInterval(this.priceUpdateInterval);

    this.saveState();
    dashboard.logEvent("SUCCESS", "안전하게 종료되었습니다");
    process.exit(0);
  }
}

const bot = new UpbitScalpingBot();

process.on("SIGINT", () => bot.stop());
process.on("SIGTERM", () => bot.stop());
process.on("unhandledRejection", (error) => {
  dashboard.logEvent("ERROR", "Unhandled Rejection: " + error.message);
});
process.on("uncaughtException", (error) => {
  dashboard.logEvent("ERROR", "Uncaught Exception: " + error.message);
  bot.stop();
});

bot.run().catch((error) => {
  dashboard.logEvent("ERROR", "프로그램 실행 실패: " + error.message);
  process.exit(1);
});
