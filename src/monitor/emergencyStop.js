import config from "../config/env.js";
import upbitAPI from "../api/upbit.js";
import stateManager from "../logger/stateManager.js";
import { log, formatPercent } from "../utils/helpers.js";

class EmergencyMonitor {
  constructor() {
    this.consecutiveErrors = 0;
    this.lastSuccessTime = Date.now();
    this.initialPrice = null;
  }

  async checkEmergency(market) {
    if (!config.EMERGENCY_STOP_ENABLED) {
      return false;
    }

    try {
      // 1. 급락 감지
      const priceDropDetected = await this.checkPriceDrop(market);
      if (priceDropDetected) {
        return true;
      }

      // 2. 네트워크 타임아웃
      const timeoutDetected = this.checkNetworkTimeout();
      if (timeoutDetected) {
        return true;
      }

      // 3. 연속 API 에러
      const errorThresholdReached = this.checkErrorThreshold();
      if (errorThresholdReached) {
        return true;
      }

      // 성공 시 카운터 리셋
      this.consecutiveErrors = 0;
      this.lastSuccessTime = Date.now();

      return false;
    } catch (error) {
      this.consecutiveErrors++;
      log(
        "error",
        `비상 모니터 에러 (${this.consecutiveErrors}회): ${error.message}`
      );
      return false;
    }
  }

  async checkPriceDrop(market) {
    try {
      const ticker = await upbitAPI.getTicker(market);
      const currentPrice = ticker.trade_price;
      const changeRate = ticker.signed_change_rate * 100;

      // 초기 가격 설정
      if (!this.initialPrice) {
        this.initialPrice = currentPrice;
      }

      // 급락 감지
      if (changeRate <= config.EMERGENCY_PRICE_DROP_PERCENT) {
        this.triggerEmergency(`급락 감지: ${formatPercent(changeRate)}`);
        return true;
      }

      return false;
    } catch (error) {
      log("error", "가격 체크 실패", error.message);
      return false;
    }
  }

  checkNetworkTimeout() {
    const timeSinceSuccess = Date.now() - this.lastSuccessTime;

    if (timeSinceSuccess > config.EMERGENCY_NETWORK_TIMEOUT) {
      this.triggerEmergency(
        `네트워크 타임아웃: ${Math.floor(timeSinceSuccess / 1000)}초`
      );
      return true;
    }

    return false;
  }

  checkErrorThreshold() {
    if (this.consecutiveErrors >= config.EMERGENCY_API_ERROR_THRESHOLD) {
      this.triggerEmergency(`연속 API 에러 ${this.consecutiveErrors}회`);
      return true;
    }

    return false;
  }

  triggerEmergency(reason) {
    log("error", "🚨 ===== 비상 정지 =====");
    log("error", `사유: ${reason}`);
    log("error", "상태를 저장하고 프로그램을 종료합니다.");
    log("error", "======================");

    // 현재 상태 저장
    try {
      stateManager.saveState({
        emergencyStop: true,
        reason,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      log("error", "비상 상태 저장 실패", error.message);
    }

    // 프로그램 종료
    process.exit(1);
  }

  recordSuccess() {
    this.consecutiveErrors = 0;
    this.lastSuccessTime = Date.now();
  }

  recordError() {
    this.consecutiveErrors++;
  }
}

export default new EmergencyMonitor();
