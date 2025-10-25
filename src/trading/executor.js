import upbitAPI from "../api/upbit.js";
import config from "../config/env.js";
import { executeWithRetry } from "../utils/retry.js";
import { log, formatKRW, formatPercent, sleep } from "../utils/helpers.js";
import dashboard from "../logger/dashboardLogger.js";

class TradeExecutor {
  constructor() {
    this.isSelling = false;
    this.isBuying = false;
    this.lastBuyTime = 0;
    this.lastSellTime = 0;
    this.sellStartTime = 0;
  }

  /**
   * ✅ 플래그 강제 리셋 메서드
   */
  resetSellFlag() {
    log("warn", "🔓 isSelling 플래그 강제 해제");
    this.isSelling = false;
  }

  resetBuyFlag() {
    log("warn", "🔓 isBuying 플래그 강제 해제");
    this.isBuying = false;
  }

  /**
   * ✅ 플래그 상태 확인
   */
  isCurrentlyBuying() {
    return this.isBuying;
  }

  isCurrentlySelling() {
    return this.isSelling;
  }

  /**
   * ✅ 모든 플래그 리셋
   */
  resetAllFlags() {
    log("warn", "🔄 모든 거래 플래그 초기화");
    this.isSelling = false;
    this.isBuying = false;
  }

  /**
   * ✅ 개선된 매수 실행
   */
  async executeBuy(market, krwAmount) {
    if (this.isBuying) {
      log("warn", "⚠️ 매수 진행 중 - 중복 요청 무시");
      return null;
    }

    const timeSinceLastBuy = Date.now() - this.lastBuyTime;
    if (timeSinceLastBuy < 3000) {
      log("warn", `⚠️ 매수 간격 부족: ${timeSinceLastBuy}ms`);
      return null;
    }

    this.isBuying = true;
    this.lastBuyTime = Date.now();

    const maxRetries = 3;
    let attempt = 0;

    try {
      while (attempt < maxRetries) {
        attempt++;

        try {
          const beforeBalance = await this.getAvailableKRW();
          if (beforeBalance < krwAmount) {
            log(
              "error",
              `잔고 부족: ${formatKRW(beforeBalance)} < ${formatKRW(krwAmount)}`
            );
            return null;
          }

          log(
            "info",
            `💰 매수 시도 ${attempt}/${maxRetries}: ${formatKRW(krwAmount)}`
          );

          const order = await executeWithRetry(async () => {
            return await upbitAPI.marketBuy(market, krwAmount);
          }, "매수 주문");

          dashboard.logEvent("INFO", `매수 주문 전송: ${order.uuid}`);

          const filledOrder = await this.waitForOrderFill(order.uuid, 15000);

          if (!filledOrder || filledOrder.state !== "done") {
            throw new Error("주문 체결 실패");
          }

          await sleep(3000);
          const currency = market.split("-")[1];
          const position = await upbitAPI.getCoinBalance(currency);

          if (position.balance === 0) {
            log("error", "❌ 매수 후 수량 0 - 재시도 필요");
            if (attempt < maxRetries) {
              await sleep(2000);
              continue;
            }
            throw new Error("매수 완료 후 수량 확인 실패");
          }

          const executedPrice =
            parseFloat(filledOrder.executed_volume) > 0
              ? parseFloat(filledOrder.price) /
                parseFloat(filledOrder.executed_volume)
              : position.avgBuyPrice;

          log(
            "success",
            `✅ 매수 체결 확인: ${position.balance.toFixed(8)} ${currency}`
          );
          log("info", `   평균가: ${formatKRW(position.avgBuyPrice)}`);
          log("info", `   체결가: ${formatKRW(executedPrice)}`);

          dashboard.logEvent("SUCCESS", `매수 완료 (${formatKRW(krwAmount)})`);

          return {
            success: true,
            uuid: order.uuid,
            executedVolume: position.balance,
            avgPrice: position.avgBuyPrice,
            executedPrice: executedPrice,
            order: filledOrder,
          };
        } catch (error) {
          log(
            "error",
            `매수 실패 (${attempt}/${maxRetries}): ${error.message}`
          );
          dashboard.logEvent("ERROR", `매수 실패: ${error.message}`);

          if (attempt >= maxRetries) {
            log("error", "❌ 매수 최종 실패");
            return null;
          }

          await sleep(1000);
        }
      }
    } finally {
      this.isBuying = false;
    }

    return null;
  }

  /**
   * ✅ 긴급 수정: 매도 실행 (에러 처리 강화)
   */
  async executeSell(
    market,
    volume,
    reason = null,
    reasonText = null,
    profitRate = 0
  ) {
    const displayReasonText = reasonText || reason || "매도";

    log("warn", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    log("warn", `🚨 executeSell 호출됨!`);
    log("warn", `   사유: ${displayReasonText}`);
    log("warn", `   수익률: ${formatPercent(profitRate)}`);
    log("warn", `   isSelling: ${this.isSelling}`);
    log("warn", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    if (this.isSelling) {
      log("warn", "⚠️ 매도 진행 중 - 중복 요청 무시");
      return null;
    }

    const timeSinceLastSell = Date.now() - this.lastSellTime;
    if (reason === "STOP_LOSS" || reason === "TAKE_PROFIT") {
      log("warn", `🚨 ${displayReasonText} - 즉시 실행 (간격 무시)`);
    } else if (timeSinceLastSell < 3000) {
      log("warn", `⚠️ 매도 간격 부족: ${timeSinceLastSell}ms`);
      return null;
    }

    this.isSelling = true;
    this.sellStartTime = Date.now();
    this.lastSellTime = Date.now();

    const maxRetries = 3;
    let attempt = 0;

    try {
      while (attempt < maxRetries) {
        attempt++;

        try {
          const adjustedVolume = this.adjustVolumeToTickSize(volume);

          dashboard.addSellAttempt(
            reason,
            displayReasonText,
            null,
            "",
            profitRate
          );

          log(
            "info",
            `💸 매도 시도 ${attempt}/${maxRetries}: ${adjustedVolume} ${market}`
          );

          // ✅ 실제 보유량 확인
          const currency = market.split("-")[1];
          const currentPosition = await upbitAPI.getCoinBalance(currency);

          if (currentPosition.balance === 0) {
            log("warn", "⚠️ 매도할 수량이 없음 - 이미 매도된 상태");
            dashboard.addSellAttempt(
              reason,
              displayReasonText,
              true,
              "이미 매도됨",
              profitRate
            );
            return {
              success: true,
              alreadySold: true,
            };
          }

          const sellVolume = Math.min(adjustedVolume, currentPosition.balance);

          log("info", `   보유: ${currentPosition.balance.toFixed(8)}`);
          log("info", `   매도: ${sellVolume.toFixed(8)}`);

          const order = await executeWithRetry(async () => {
            return await upbitAPI.marketSell(market, sellVolume);
          }, "매도 주문");

          dashboard.logEvent("INFO", `매도 주문 전송: ${order.uuid}`);

          const filledOrder = await this.waitForOrderFill(order.uuid, 15000);

          if (!filledOrder || filledOrder.state !== "done") {
            throw new Error("주문 체결 실패");
          }

          await sleep(3000);
          const afterPosition = await upbitAPI.getCoinBalance(currency);

          if (afterPosition.balance > 0) {
            const remaining = afterPosition.balance;
            log(
              "warn",
              `⚠️ 매도 후 잔여 수량: ${remaining.toFixed(8)} ${currency}`
            );

            if (remaining >= 0.00001) {
              log("info", "추가 매도 시도...");
              await sleep(2000);
              try {
                const cleanupOrder = await upbitAPI.marketSell(
                  market,
                  remaining
                );
                await this.waitForOrderFill(cleanupOrder.uuid, 10000);
                log("success", "잔여 수량 정리 완료");
              } catch (cleanupError) {
                log("warn", `잔여 수량 정리 실패: ${cleanupError.message}`);
              }
            }
          }

          dashboard.addSellAttempt(
            reason,
            displayReasonText,
            true,
            "",
            profitRate
          );

          log("success", `✅ 매도 체결 확인: UUID ${order.uuid}`);
          dashboard.logEvent(
            "SUCCESS",
            `매도 완료 (${displayReasonText}, 수익률: ${formatPercent(
              profitRate
            )})`
          );

          return {
            success: true,
            uuid: order.uuid,
            executedVolume: sellVolume,
            order: filledOrder,
          };
        } catch (error) {
          log(
            "error",
            `매도 실패 (${attempt}/${maxRetries}): ${error.message}`
          );

          // ✅ 400 에러 시 실제 포지션 확인
          if (error.message.includes("400") || error.response?.status === 400) {
            log("warn", "⚠️ 400 에러 발생 - 실제 포지션 확인 중...");
            await sleep(2000);

            const currency = market.split("-")[1];
            const checkPosition = await upbitAPI.getCoinBalance(currency);

            if (checkPosition.balance === 0) {
              log("success", "✅ 이미 매도 완료된 상태 확인");
              dashboard.addSellAttempt(
                reason,
                displayReasonText,
                true,
                "400 에러 후 확인됨",
                profitRate
              );
              return {
                success: true,
                alreadySold: true,
              };
            } else {
              log(
                "warn",
                `⚠️ 아직 보유 중: ${checkPosition.balance.toFixed(8)}`
              );
            }
          }

          dashboard.addSellAttempt(
            reason,
            displayReasonText,
            false,
            error.message,
            profitRate
          );

          if (attempt >= maxRetries) {
            dashboard.logEvent("ERROR", `매도 최종 실패: ${error.message}`);
            return null;
          }

          await sleep(1000);
        }
      }
    } finally {
      log("debug", "🔓 isSelling 플래그 해제");
      this.isSelling = false;
    }

    return null;
  }

  /**
   * ✅ 개선된 주문 체결 대기
   */
  async waitForOrderFill(uuid, timeout = 15000) {
    const startTime = Date.now();
    let lastState = null;
    let checkCount = 0;

    while (Date.now() - startTime < timeout) {
      try {
        checkCount++;
        const order = await upbitAPI.getOrder(uuid);

        if (order.state !== lastState) {
          log("debug", `[${checkCount}] 주문 상태: ${order.state}`);
          lastState = order.state;
        }

        if (order.state === "done") {
          log("success", `✅ 주문 체결 완료 (${checkCount}회 확인)`);
          return order;
        }

        if (order.state === "cancel") {
          throw new Error("주문이 취소되었습니다");
        }

        if (order.state === "wait") {
          await sleep(1000);
          continue;
        }

        if (order.state === "watch") {
          await sleep(500);
          continue;
        }

        await sleep(500);
      } catch (error) {
        if (checkCount % 5 === 0) {
          log("warn", `주문 확인 중 에러: ${error.message}`);
        }
        await sleep(1000);
      }
    }

    log("error", `❌ 주문 체결 타임아웃 (${timeout}ms 초과)`);

    try {
      const finalCheck = await upbitAPI.getOrder(uuid);
      if (finalCheck.state === "done") {
        log("warn", "타임아웃 직후 체결 확인됨");
        return finalCheck;
      }
    } catch (error) {
      // 무시
    }

    throw new Error(`주문 체결 타임아웃 (${timeout}ms 초과)`);
  }

  adjustVolumeToTickSize(volume) {
    return Math.floor(volume * 100000000) / 100000000;
  }

  async getAvailableKRW() {
    const balance = await executeWithRetry(async () => {
      return await upbitAPI.getBalance("KRW");
    }, "KRW 잔고 조회");

    return balance;
  }

  async getCoinPosition(market) {
    const currency = market.split("-")[1];

    const position = await executeWithRetry(async () => {
      return await upbitAPI.getCoinBalance(currency);
    }, `${currency} 포지션 조회`);

    return position;
  }

  calculateBuyAmount(krwBalance) {
    if (krwBalance < 5000) {
      log("warn", `잔고 부족: ${formatKRW(krwBalance)} (최소 5000원 필요)`);
      return 0;
    }

    const buyAmount = Math.floor(krwBalance - 50);

    log(
      "info",
      `💰 매수 금액: ${formatKRW(buyAmount)} (잔고: ${formatKRW(krwBalance)})`
    );
    return buyAmount;
  }

  async getCurrentPrice(market) {
    const ticker = await executeWithRetry(async () => {
      return await upbitAPI.getTicker(market);
    }, "현재가 조회");

    return ticker.trade_price;
  }

  async cancelOrder(uuid) {
    try {
      log("warn", `주문 취소 시도: ${uuid}`);
      const result = await upbitAPI.cancelOrder(uuid);
      log("success", "주문 취소 완료");
      return result;
    } catch (error) {
      log("error", `주문 취소 실패: ${error.message}`);
      return null;
    }
  }
}

export default new TradeExecutor();
