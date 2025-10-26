import upbitAPI from "../api/upbit.js";
import config from "../config/env.js";
import { executeWithRetry } from "../utils/retry.js";
import { log, formatKRW, formatPercent, sleep } from "../utils/helpers.js";
import dashboard from "../logger/dashboardLogger.js";
import cacheManager from "../utils/cache.js";

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

          // ✅ 캐시 무효화 후 조회
          cacheManager.invalidate(`position_${market}`);
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
   * ✅ 개선된 매도 실행 (에러 처리 강화)
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
      log("warn", `🚨 중요 매도 신호 (${displayReasonText})`);
    } else if (timeSinceLastSell < 5000) {
      log("warn", `⚠️ 매도 간격 부족: ${timeSinceLastSell}ms`);
      return null;
    }

    this.isSelling = true;
    this.sellStartTime = Date.now();
    this.lastSellTime = Date.now();

    const maxRetries = 3;
    let attempt = 0;

    try {
      const currency = market.split("-")[1];

      // ✅ 캐시 무효화 후 현재 포지션 확인
      cacheManager.invalidate(`position_${market}`);
      const beforePosition = await upbitAPI.getCoinBalance(currency);

      if (beforePosition.balance === 0) {
        log("warn", "⚠️ 매도할 수량 없음 (이미 매도됨)");
        return { alreadySold: true };
      }

      if (beforePosition.balance < volume * 0.99) {
        log(
          "warn",
          `⚠️ 실제 수량 ${beforePosition.balance.toFixed(
            8
          )} < 요청 ${volume.toFixed(8)}`
        );
        volume = beforePosition.balance;
      }

      const adjustedVolume = this.adjustVolumeToTickSize(volume);

      while (attempt < maxRetries) {
        attempt++;

        try {
          log("warn", `💸 매도 시도 ${attempt}/${maxRetries}`);
          log("info", `   수량: ${adjustedVolume.toFixed(8)} ${currency}`);
          log("info", `   사유: ${displayReasonText}`);

          const order = await executeWithRetry(async () => {
            return await upbitAPI.marketSell(market, adjustedVolume);
          }, "매도 주문");

          dashboard.logEvent("INFO", `매도 주문 전송: ${order.uuid}`);

          const filledOrder = await this.waitForOrderFill(order.uuid, 15000);

          if (!filledOrder || filledOrder.state !== "done") {
            throw new Error("주문 체결 실패");
          }

          log("success", "✅ 매도 주문 체결 완료");

          await sleep(3000);

          // ✅ 캐시 무효화 후 포지션 확인
          cacheManager.invalidate(`position_${market}`);
          const afterPosition = await upbitAPI.getCoinBalance(currency);

          if (afterPosition.balance > 0) {
            const valueKRW = afterPosition.balance * filledOrder.trade_price;

            if (valueKRW >= config.DUST_THRESHOLD_KRW) {
              log(
                "warn",
                `⚠️ 매도 후 잔여 수량 존재: ${afterPosition.balance.toFixed(
                  8
                )} (${formatKRW(valueKRW)})`
              );

              if (attempt < maxRetries) {
                log("warn", "재시도 중...");
                volume = afterPosition.balance;
                await sleep(2000);
                continue;
              } else {
                log(
                  "error",
                  "❌ 매도 후에도 잔여 수량 남음 (최대 재시도 초과)"
                );
              }
            } else {
              log("info", `✅ 매도 완료 (Dust ${formatKRW(valueKRW)} 무시)`);
            }
          }

          dashboard.logEvent("SUCCESS", `매도 완료 (${displayReasonText})`);

          return {
            success: true,
            uuid: order.uuid,
            order: filledOrder,
            alreadySold: false,
          };
        } catch (error) {
          log(
            "error",
            `매도 실패 (${attempt}/${maxRetries}): ${error.message}`
          );
          dashboard.logEvent("ERROR", `매도 실패: ${error.message}`);

          if (attempt >= maxRetries) {
            log("error", "❌ 매도 최종 실패");
            return null;
          }

          await sleep(1000);
        }
      }
    } finally {
      const elapsed = Date.now() - this.sellStartTime;
      log("info", `🔓 isSelling 플래그 해제 (${elapsed}ms 소요)`);
      this.isSelling = false;
    }

    return null;
  }

  async waitForOrderFill(uuid, timeout = 15000) {
    const startTime = Date.now();
    let checkCount = 0;

    while (Date.now() - startTime < timeout) {
      checkCount++;

      try {
        const order = await upbitAPI.getOrder(uuid);

        if (order.state === "done") {
          log("success", `✅ 주문 체결 완료 (${checkCount}회 확인)`);
          return order;
        }

        if (order.state === "cancel") {
          log("error", "❌ 주문 취소됨");
          return null;
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

  /**
   * ✅ 코인 포지션 조회 (캐싱 적용)
   */
  async getCoinPosition(market) {
    const currency = market.split("-")[1];

    // ✅ 2초 캐시 적용
    const position = await cacheManager.get(
      `position_${market}`,
      async () => {
        return await executeWithRetry(async () => {
          return await upbitAPI.getCoinBalance(currency);
        }, `${currency} 포지션 조회`);
      },
      2000 // 2초 캐시
    );

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

  /**
   * ✅ 현재가 조회 (캐싱 적용 - 0.5초)
   */
  async getCurrentPrice(market) {
    const ticker = await cacheManager.get(
      `ticker_${market}`,
      async () => {
        return await executeWithRetry(async () => {
          return await upbitAPI.getTicker(market);
        }, "현재가 조회");
      },
      500 // 0.5초 캐시
    );

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
