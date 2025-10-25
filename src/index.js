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
    this.priceUpdateInterval = null;
    this.isProcessingSell = false; // ✅ 매도 중복 방지
    this.lastSyncTime = 0; // ✅ 마지막 동기화 시간
    this.syncInterval = 30000; // ✅ 30초마다 한 번만 동기화
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

    // ✅ Dust 체크 및 처리
    await this.checkAndHandleDust();

    // 이전 상태 복구
    const savedState = stateManager.loadState();
    if (savedState && savedState.position) {
      position.loadState(savedState.position);
    }

    // 현재 포지션 동기화
    await this.syncPosition();

    // 초기 데이터 수집
    await this.updateDashboardData();

    this.isRunning = true;

    dashboard.logEvent("SUCCESS", "초기화 완료! 스캘핑 시작...");

    await sleep(2000);
  }
  /**
   * ✅ Dust(잔여 소량) 체크 및 처리
   */
  async checkAndHandleDust() {
    try {
      const currency = config.MARKET.split("-")[1];
      const coinPosition = await executor.getCoinPosition(config.MARKET);

      if (coinPosition.balance === 0) {
        log("info", "✅ Dust 없음 - 깨끗한 상태");
        return;
      }

      // 현재가 조회
      const currentPrice = await executor.getCurrentPrice(config.MARKET);
      const dustValueKRW = coinPosition.balance * currentPrice;

      log("warn", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      log("warn", "🔍 Dust(잔여 소량) 감지!");
      log("warn", `   수량: ${coinPosition.balance.toFixed(8)} ${currency}`);
      log("warn", `   평가액: ${formatKRW(dustValueKRW)}`);
      log("warn", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

      // Dust 임계값 확인
      if (dustValueKRW < config.DUST_THRESHOLD_KRW) {
        if (config.AUTO_IGNORE_DUST) {
          log(
            "info",
            `⚠️ ${formatKRW(dustValueKRW)} < ${formatKRW(
              config.DUST_THRESHOLD_KRW
            )} (임계값)`
          );
          log("info", "✅ 자동 무시 활성화 - Dust 무시하고 진행");
          log("info", "💡 참고: 업비트 최소 주문 금액은 5,000원입니다");

          dashboard.logEvent(
            "WARNING",
            `Dust 감지됨 (${formatKRW(dustValueKRW)}) - 자동 무시`
          );

          // 로컬 포지션도 없애기
          if (position.hasPosition()) {
            position.position = null;
            this.saveState();
          }
        } else {
          log("error", "❌ Dust가 임계값 미만이지만 자동 무시가 비활성화됨");
          log(
            "error",
            "💡 수동으로 처리하거나 AUTO_IGNORE_DUST=true로 설정하세요"
          );

          dashboard.logEvent("ERROR", "Dust 처리 필요 - 자동 무시 비활성화");
        }
      } else {
        // 5000원 이상이면 매도 시도
        log("warn", `⚠️ Dust가 ${formatKRW(dustValueKRW)}로 매도 가능 금액`);
        log("info", "💡 수동 매도를 권장합니다 (최소 주문: 5,000원)");

        dashboard.logEvent(
          "WARNING",
          `매도 가능한 잔여 수량 감지 (${formatKRW(dustValueKRW)})`
        );

        // 5000원 이상이면 매도 시도
        if (dustValueKRW >= 5000) {
          log("info", "🔄 자동 매도 시도 중...");

          try {
            const sellResult = await executor.executeSell(
              config.MARKET,
              coinPosition.balance,
              "DUST_CLEANUP",
              "🧹 Dust정리",
              0
            );

            if (sellResult && sellResult.success) {
              log("success", "✅ Dust 자동 매도 완료!");
              dashboard.logEvent("SUCCESS", "Dust 자동 정리 완료");
            } else {
              log("warn", "⚠️ Dust 자동 매도 실패 - 수동 처리 필요");
            }
          } catch (error) {
            log("error", `Dust 매도 실패: ${error.message}`);
          }
        }
      }

      log("info", "");
    } catch (error) {
      log("error", "Dust 체크 실패", error.message);
    }
  }
  async syncPosition() {
    try {
      const coinPosition = await executor.getCoinPosition(config.MARKET);

      if (coinPosition.balance > 0) {
        // ✅ Dust 체크
        const currentPrice = await executor.getCurrentPrice(config.MARKET);
        const valueKRW = coinPosition.balance * currentPrice;

        if (valueKRW < config.DUST_THRESHOLD_KRW) {
          log("info", "⚠️ Dust 수량이므로 포지션 무시");
          return;
        }

        log("info", "📊 기존 포지션 감지");

        if (!position.hasPosition()) {
          position.openPosition(
            coinPosition.balance,
            coinPosition.avgBuyPrice,
            coinPosition.balance * coinPosition.avgBuyPrice
          );

          position.updateHighestPrice(currentPrice);

          log("info", `   평균가: ${formatKRW(coinPosition.avgBuyPrice)}`);
          log("info", `   현재가: ${formatKRW(currentPrice)}`);
        }
      }
    } catch (error) {
      log("error", "포지션 동기화 실패", error.message);
    }
  }

  /**
   * ✅ 리스크 모니터링
   */
  async startRiskMonitoring() {
    let lastSellAttemptTime = 0;
    const SELL_TIMEOUT = 30000;

    this.riskCheckInterval = setInterval(async () => {
      try {
        // 포지션 없으면 모든 플래그 해제
        if (!position.hasPosition()) {
          if (this.isProcessingSell) {
            log("warn", "⚠️ 포지션 없는데 매도 플래그가 true - 강제 해제");
            this.isProcessingSell = false;
          }
          if (executor.isCurrentlySelling()) {
            log(
              "warn",
              "⚠️ 포지션 없는데 executor.isSelling이 true - 강제 해제"
            );
            executor.resetSellFlag();
          }
          return;
        }

        // 타임아웃 체크
        if (this.isProcessingSell) {
          const elapsed = Date.now() - lastSellAttemptTime;
          if (elapsed > SELL_TIMEOUT) {
            log(
              "error",
              `🚨 매도 타임아웃! ${elapsed}ms 경과 - 강제 해제 및 포지션 동기화`
            );

            this.isProcessingSell = false;
            executor.resetSellFlag();

            // ✅ 실제 포지션 확인 (Dust 고려)
            const coinPosition = await executor.getCoinPosition(config.MARKET);
            const currentPrice = await executor.getCurrentPrice(config.MARKET);
            const valueKRW = coinPosition.balance * currentPrice;

            if (
              coinPosition.balance === 0 ||
              valueKRW < config.DUST_THRESHOLD_KRW
            ) {
              log(
                "success",
                "✅ 실제로는 매도 완료 (또는 Dust) - 로컬 포지션 제거"
              );
              position.position = null;
              this.saveState();
              await this.updateDashboardData();
              return;
            } else {
              log(
                "warn",
                `⚠️ 아직 보유 중: ${coinPosition.balance.toFixed(
                  8
                )} (${formatKRW(valueKRW)}) - 계속 진행`
              );
            }
          } else {
            return;
          }
        }

        const currentPrice = await executor.getCurrentPrice(config.MARKET);

        position.updatePrice(currentPrice);
        position.updateHighestPrice(currentPrice);

        const pos = position.getPosition();
        const profitRate =
          ((currentPrice - pos.avgBuyPrice) / pos.avgBuyPrice) * 100;
        const holdingSeconds = position.getHoldingSeconds();

        log(
          "debug",
          `💹 보유 ${holdingSeconds}초 | 수익률: ${formatPercent(
            profitRate
          )} | 손절: ${config.STOP_LOSS_PERCENT}% | 익절: ${
            config.TAKE_PROFIT_PERCENT
          }%`
        );

        dashboard.updateData("position", {
          hasPosition: true,
          data: position.getPosition(),
          currentPrice: currentPrice,
        });

        const exitCheck = await riskManager.checkExitConditions(
          position.getPosition(),
          currentPrice
        );

        log("debug", `🔍 shouldExit: ${exitCheck.shouldExit}`);

        if (exitCheck.shouldExit) {
          log("warn", `🚨 매도 조건 충족! ${exitCheck.reasonText}`);
          log("warn", `   현재 수익률: ${formatPercent(exitCheck.profitRate)}`);
          log("warn", `   보유 시간: ${holdingSeconds}초`);

          lastSellAttemptTime = Date.now();
          await this.executeSell(exitCheck);
        }
      } catch (error) {
        dashboard.logEvent("ERROR", "리스크 체크 실패: " + error.message);
        emergencyMonitor.recordError();

        if (this.isProcessingSell) {
          const elapsed = Date.now() - lastSellAttemptTime;
          if (elapsed > 10000) {
            log("error", "에러 발생 후 10초 경과 - 두 플래그 모두 해제");
            this.isProcessingSell = false;
            executor.resetSellFlag();
          }
        }
      }
    }, config.RISK_CHECK_INTERVAL);
  }

  /**
   * 가격 업데이트
   */
  async startPriceUpdate() {
    this.priceUpdateInterval = setInterval(async () => {
      try {
        const currentPrice = await executor.getCurrentPrice(config.MARKET);

        if (position.hasPosition()) {
          dashboard.updateData("position", {
            hasPosition: true,
            data: position.getPosition(),
            currentPrice: currentPrice,
          });
        }
      } catch (error) {
        // 조용히 처리
      }
    }, 1000);
  }

  /**
   * 대시보드 갱신
   */
  async startDashboardUpdates() {
    this.dashboardInterval = setInterval(() => {
      if (dashboard.shouldPrintDashboard()) {
        dashboard.printDashboard();
      }
    }, 100);
  }

  async updateDashboardData() {
    try {
      // 시장 상황
      const context = await marketContext.analyze(config.MARKET);
      dashboard.updateData("marketContext", context);

      // 전략 신호
      const signals = await calculateEntryScore(config.MARKET);
      dashboard.updateData("strategySignals", signals);

      // 포지션
      if (position.hasPosition()) {
        const currentPrice = await executor.getCurrentPrice(config.MARKET);
        dashboard.updateData("position", {
          hasPosition: true,
          data: position.getPosition(),
          currentPrice: currentPrice,
        });
      } else {
        dashboard.updateData("position", { hasPosition: false });
      }

      // 손익 설정
      dashboard.updateData("stopLoss", config.STOP_LOSS_PERCENT);
      dashboard.updateData("takeProfit", config.TAKE_PROFIT_PERCENT);

      // 성과
      const performance = performanceTracker.getPerformanceSummary();
      dashboard.updateData("performance", performance);
    } catch (error) {
      log("error", "대시보드 데이터 업데이트 실패", error.message);
    }
  }

  /**
   * ✅ 전액 매수 실행 (포지션 확인 강화)
   */
  async executeBuy(signals, contextScore) {
    try {
      // ✅ 전액 매수 (50원만 남김)
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

      // ✅ 포지션 확인 재시도 로직 (최대 5회, 총 15초)
      let coinPosition = null;
      let attempts = 0;
      const maxAttempts = 5;
      const delays = [500, 1000, 2000, 3000, 5000]; // 지수 백오프

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

      // 포지션 확인 성공
      if (coinPosition && coinPosition.balance > 0) {
        // 포지션 오픈
        position.openPosition(
          coinPosition.balance,
          coinPosition.avgBuyPrice,
          buyAmount
        );

        // ✅ 최고가 초기화: 평균 매수가로 설정 (정확)
        position.updateHighestPrice(coinPosition.avgBuyPrice);

        // 매수 직후 현재가 조회
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
      } else {
        // ✅ Fallback: 주문 정보로 포지션 생성
        log("warn", "⚠️ 포지션 조회 실패 - 주문 정보로 포지션 생성 시도");

        if (result.executedVolume && result.avgPrice) {
          log("info", "✅ executor에서 포지션 확인 완료 - 바로 사용");

          // 포지션 오픈
          position.openPosition(
            result.executedVolume,
            result.avgPrice,
            buyAmount
          );

          position.updateHighestPrice(result.avgPrice);

          // 매수 직후 현재가 조회
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
        }
      }
    } catch (error) {
      dashboard.logEvent("ERROR", "매수 실행 오류: " + error.message);
      emergencyMonitor.recordError();
    }
  }

  /**
   * ✅ 매도 실행 - 완료 후 포지션 동기화 강화
   */
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

      // ✅ 이미 매도된 경우 처리
      if (result.alreadySold) {
        log("success", "✅ 이미 매도 완료된 상태 확인 - 포지션 제거");
        position.position = null;
        this.saveState();
        await this.updateDashboardData();
        return;
      }

      // ✅ 매도 후 실제 포지션 재확인
      const coinPosition = await executor.getCoinPosition(config.MARKET);
      if (coinPosition.balance > 0) {
        log(
          "warn",
          `⚠️ 매도 후에도 잔여 수량 존재: ${coinPosition.balance.toFixed(8)}`
        );
        // 포지션은 유지 - 다음 사이클에서 재시도
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
      log("error", `❌ 매도 실행 오류: ${error.message}`);
      dashboard.logEvent("ERROR", "매도 실행 오류: " + error.message);
      emergencyMonitor.recordError();
    } finally {
      const elapsed = Date.now() - sellStartTime;
      log("info", `🔓 isProcessingSell 플래그 해제 (총 ${elapsed}ms)`);
      this.isProcessingSell = false;
    }
  }

  /**
   * ✅ 신호 체크 및 거래 - Dust 고려 + 동기화 최적화
   */
  async checkAndTrade() {
    try {
      const emergency = await emergencyMonitor.checkEmergency(config.MARKET);
      if (emergency) return;

      emergencyMonitor.recordSuccess();

      // ✅ 포지션 동기화 (30초마다 한 번만)
      const now = Date.now();
      if (now - this.lastSyncTime > this.syncInterval) {
        this.lastSyncTime = now;

        const hasLocalPosition = position.hasPosition();
        const coinPosition = await executor.getCoinPosition(config.MARKET);

        // ✅ Dust 고려한 포지션 판단
        const currentPrice = await executor.getCurrentPrice(config.MARKET);
        const valueKRW = coinPosition.balance * currentPrice;
        const hasRemotePosition =
          coinPosition.balance > 0 && valueKRW >= config.DUST_THRESHOLD_KRW;

        if (!hasLocalPosition && hasRemotePosition) {
          log("warn", "⚠️ 포지션 불일치 감지! 자동 동기화 시작...");
          dashboard.logEvent(
            "WARNING",
            "포지션 불일치 감지 - 자동 동기화 실행"
          );

          position.openPosition(
            coinPosition.balance,
            coinPosition.avgBuyPrice,
            coinPosition.balance * coinPosition.avgBuyPrice
          );

          position.updateHighestPrice(currentPrice);

          dashboard.logEvent("SUCCESS", "✅ 포지션 동기화 완료", {
            수량: coinPosition.balance.toFixed(8),
            평균단가: formatKRW(coinPosition.avgBuyPrice),
            현재가: formatKRW(currentPrice),
          });

          log("success", "✅ 포지션 동기화 완료!");

          riskManager.resetTracking();
          this.saveState();
        }

        if (hasLocalPosition && !hasRemotePosition) {
          log("warn", "⚠️ 유령 포지션 감지! 로컬 포지션 제거...");
          dashboard.logEvent("WARNING", "유령 포지션 감지 - 로컬 포지션 제거");

          position.position = null;
          this.saveState();

          log("success", "✅ 유령 포지션 제거 완료");
        }
      }

      await this.updateDashboardData();

      if (position.hasPosition()) {
        return;
      }

      if (executor.isCurrentlyBuying()) {
        return;
      }

      const context = await marketContext.analyze(config.MARKET);

      if (!context.isFavorable.isFavorable) {
        return;
      }

      const signals = await calculateEntryScore(config.MARKET);

      if (signals.shouldBuy) {
        dashboard.logEvent("SIGNAL", "⚡ 스캘핑 매수 신호!", {
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

  async run() {
    await this.initialize();
    this.startRiskMonitoring(); // 손익 체크
    this.startPriceUpdate(); // 가격 업데이트
    this.startDashboardUpdates(); // 대시보드 갱신

    while (this.isRunning) {
      await this.checkAndTrade(); // 신호 체크 + 매수
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
    if (this.priceUpdateInterval) clearInterval(this.priceUpdateInterval);

    this.saveState();
    dashboard.logEvent("SUCCESS", "안전하게 종료되었습니다");
    process.exit(0);
  }
}

// 프로그램 시작
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
