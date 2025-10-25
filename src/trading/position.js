import config from "../config/env.js";
import { log, formatKRW, formatPercent } from "../utils/helpers.js";

class PositionManager {
  constructor() {
    this.position = null;
    this.priceHistory = []; // ✅ 가격 이력 추적
  }

  hasPosition() {
    return this.position !== null && this.position.balance > 0;
  }

  getPosition() {
    return this.position;
  }

  openPosition(balance, avgBuyPrice, buyAmount) {
    this.position = {
      balance,
      avgBuyPrice,
      buyAmount,
      buyTime: new Date(),
      highestPrice: avgBuyPrice,
      additionalBuyCount: 0,
      totalInvested: buyAmount,
    };

    // ✅ 가격 이력 초기화
    this.priceHistory = [
      {
        price: avgBuyPrice,
        timestamp: Date.now(),
      },
    ];

    log("info", `📊 포지션 진입:`);
    log("info", `  - 평균 매수가: ${formatKRW(avgBuyPrice)}`);
    log("info", `  - 수량: ${balance}`);
    log("info", `  - 투자금: ${formatKRW(buyAmount)}`);
  }

  addToPosition(additionalBalance, newAvgPrice, additionalAmount) {
    if (!this.position) return;

    this.position.balance += additionalBalance;
    this.position.avgBuyPrice = newAvgPrice;
    this.position.additionalBuyCount += 1;
    this.position.totalInvested += additionalAmount;

    log("info", `🔼 추가 매수 ${this.position.additionalBuyCount}회:`);
    log("info", `  - 새 평균가: ${formatKRW(newAvgPrice)}`);
    log("info", `  - 총 수량: ${this.position.balance}`);
    log("info", `  - 총 투자금: ${formatKRW(this.position.totalInvested)}`);
  }

  updateHighestPrice(currentPrice) {
    if (!this.position) return;

    if (currentPrice > this.position.highestPrice) {
      this.position.highestPrice = currentPrice;
    }
  }

  /**
   * ✅ 실시간 가격 업데이트 (모멘텀 추적용)
   */
  updatePrice(currentPrice) {
    if (!this.position) return;

    this.priceHistory.push({
      price: currentPrice,
      timestamp: Date.now(),
    });

    // 최근 30초만 유지
    const cutoff = Date.now() - 30000;
    this.priceHistory = this.priceHistory.filter((p) => p.timestamp > cutoff);
  }

  /**
   * ✅ 모멘텀 소멸 체크 (최근 N초간 변화율)
   */
  checkMomentumLoss() {
    if (!this.position) return false;

    const period = config.MOMENTUM_CHECK_PERIOD * 1000; // 초 → 밀리초
    const cutoff = Date.now() - period;

    const recentPrices = this.priceHistory.filter((p) => p.timestamp >= cutoff);

    if (recentPrices.length < 3) return false; // 데이터 부족

    const firstPrice = recentPrices[0].price;
    const lastPrice = recentPrices[recentPrices.length - 1].price;
    const changeRate = Math.abs((lastPrice - firstPrice) / firstPrice) * 100;

    // 설정된 임계값 미만이면 모멘텀 소멸
    return changeRate < config.MOMENTUM_THRESHOLD;
  }

  /**
   * ✅ 최근 가격 변화율 조회 (N초 기준)
   */
  getPriceChangeRate(seconds = 10) {
    if (!this.position) return 0;

    const cutoff = Date.now() - seconds * 1000;
    const recentPrices = this.priceHistory.filter((p) => p.timestamp >= cutoff);

    if (recentPrices.length < 2) return 0;

    const firstPrice = recentPrices[0].price;
    const lastPrice = recentPrices[recentPrices.length - 1].price;

    return ((lastPrice - firstPrice) / firstPrice) * 100;
  }

  /**
   * ✅ 횡보 감지 (최근 N초간 고점/저점 범위)
   */
  isSideways(seconds = 30) {
    if (!this.position) return false;

    const cutoff = Date.now() - seconds * 1000;
    const recentPrices = this.priceHistory.filter((p) => p.timestamp >= cutoff);

    if (recentPrices.length < 5) return false;

    const prices = recentPrices.map((p) => p.price);
    const highest = Math.max(...prices);
    const lowest = Math.min(...prices);
    const range = ((highest - lowest) / lowest) * 100;

    // 범위가 0.1% 미만이면 횡보
    return range < 0.1;
  }

  /**
   * ✅ 보유 시간 (초)
   */
  getHoldingSeconds() {
    if (!this.position) return 0;
    return Math.floor((Date.now() - this.position.buyTime) / 1000);
  }

  closePosition(sellPrice, sellAmount) {
    if (!this.position) return null;

    const profit = sellAmount - this.position.totalInvested;
    const profitRate = (profit / this.position.totalInvested) * 100;

    log("info", `📤 포지션 청산:`);
    log("info", `  - 매도가: ${formatKRW(sellPrice)}`);
    log("info", `  - 매도금액: ${formatKRW(sellAmount)}`);
    log(
      "info",
      `  - 손익: ${formatKRW(profit)} (${formatPercent(profitRate)})`
    );

    const result = {
      ...this.position,
      sellPrice,
      sellAmount,
      sellTime: new Date(),
      profit,
      profitRate,
      holdingMinutes: Math.floor(
        (new Date() - this.position.buyTime) / 1000 / 60
      ),
      holdingSeconds: Math.floor((new Date() - this.position.buyTime) / 1000),
    };

    this.position = null;
    this.priceHistory = []; // ✅ 가격 이력 초기화

    return result;
  }

  canAddMore() {
    if (!this.position) return false;
    return this.position.additionalBuyCount < config.ADDITIONAL_BUY_MAX_COUNT;
  }

  getState() {
    return {
      hasPosition: this.hasPosition(),
      position: this.position,
      priceHistory: this.priceHistory, // ✅ 가격 이력도 저장
    };
  }

  loadState(state) {
    if (state && state.hasPosition && state.position) {
      this.position = {
        ...state.position,
        buyTime: new Date(state.position.buyTime),
      };

      // ✅ 가격 이력 복구 (있으면)
      if (state.priceHistory && Array.isArray(state.priceHistory)) {
        this.priceHistory = state.priceHistory;
      } else {
        // 없으면 현재가로 초기화
        this.priceHistory = [
          {
            price: this.position.avgBuyPrice,
            timestamp: Date.now(),
          },
        ];
      }

      log(
        "info",
        `📂 이전 포지션 복구: ${formatKRW(this.position.avgBuyPrice)}`
      );
    }
  }
}

export default new PositionManager();
