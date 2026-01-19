// src/market/modeDetector.js
// 시장 모드 감지기 (TREND / RANGE / NEUTRAL)
// [v4.3] RANGE 모드 확대 - 대부분의 시장 상황에서 RANGE 진입 허용

import { percentile } from "../util/math.js";

/**
 * 시장 모드 감지기
 * ATR 비율 기반으로 TREND/RANGE/NEUTRAL 판단
 * [v4.3] RANGE 임계값 완화로 더 넓은 범위에서 횡보장 전략 허용
 */
export class ModeDetector {
  constructor(config = {}) {
    // ATR 비율 기준 [v4.3: 완화]
    this.trendThreshold = config.trendThreshold ?? 1.3; // 1.2 → 1.3 (TREND 축소)
    this.rangeThreshold = config.rangeThreshold ?? 1.1; // 0.8 → 1.1 (RANGE 확대)

    // 히스토리 설정
    this.lookbackPeriod = config.lookbackPeriod ?? 30;

    // 쿨다운 [v4.3: 단축]
    this.cooldownMs = (config.cooldownSec ?? 180) * 1000; // 5분 → 3분

    // 상태
    this.currentMode = "RANGE"; // [v4.3] 기본값을 RANGE로 변경
    this.lastModeChange = 0;
    this.atrHistory = [];
  }

  /**
   * ATR 히스토리 업데이트 및 모드 판단
   * @param {number} currentATR - 현재 ATR 값
   * @returns {{mode: string, atrRatio: number, reason: string}}
   */
  update(currentATR) {
    if (!Number.isFinite(currentATR) || currentATR <= 0) {
      return { mode: this.currentMode, atrRatio: NaN, reason: "ATR 무효" };
    }

    // 히스토리 추가
    this.atrHistory.push(currentATR);
    if (this.atrHistory.length > this.lookbackPeriod * 2) {
      this.atrHistory.shift();
    }

    // [v4.3] 히스토리 부족 시에도 RANGE 반환 (안전한 기본값)
    if (this.atrHistory.length < this.lookbackPeriod) {
      return {
        mode: "RANGE", // NEUTRAL → RANGE
        atrRatio: NaN,
        reason: `ATR 히스토리 부족 (${this.atrHistory.length}/${this.lookbackPeriod}) - 기본 RANGE`,
      };
    }

    const recentATRs = this.atrHistory.slice(-this.lookbackPeriod);
    const atrMA = recentATRs.reduce((a, b) => a + b, 0) / recentATRs.length;
    const atrRatio = currentATR / atrMA;

    // 쿨다운 체크
    const now = Date.now();
    if (now - this.lastModeChange < this.cooldownMs) {
      return {
        mode: this.currentMode,
        atrRatio,
        reason: `쿨다운 중 (${Math.ceil(
          (this.cooldownMs - (now - this.lastModeChange)) / 1000
        )}초 남음)`,
      };
    }

    // [v4.3] 모드 판단 - RANGE 우선
    let newMode = "RANGE"; // 기본값: RANGE
    let reason = "";

    if (atrRatio >= this.trendThreshold) {
      newMode = "TREND";
      reason = `ATR 비율 ${atrRatio.toFixed(2)} ≥ ${
        this.trendThreshold
      } (고변동성 → ML 모드)`;
    } else if (atrRatio <= this.rangeThreshold) {
      newMode = "RANGE";
      reason = `ATR 비율 ${atrRatio.toFixed(2)} ≤ ${
        this.rangeThreshold
      } (저변동성 → BB 모드)`;
    } else {
      // [v4.3] NEUTRAL도 RANGE로 처리 (더 적극적)
      newMode = "RANGE";
      reason = `ATR 비율 ${atrRatio.toFixed(2)} (중립 → RANGE로 처리)`;
    }

    // 모드 변경 시 쿨다운 시작
    if (newMode !== this.currentMode) {
      this.currentMode = newMode;
      this.lastModeChange = now;
    }

    return { mode: this.currentMode, atrRatio, reason };
  }

  /**
   * 현재 모드 반환
   */
  getMode() {
    return this.currentMode;
  }

  /**
   * 강제 모드 리셋
   */
  reset() {
    this.currentMode = "NEUTRAL";
    this.lastModeChange = 0;
    this.atrHistory = [];
  }
}

/**
 * 단순 모드 판단 함수 (클래스 없이 사용)
 * @param {number} currentATR - 현재 ATR
 * @param {number} avgATR - 평균 ATR
 * @param {number} trendThreshold - 트렌드 임계값 (기본 1.2)
 * @param {number} rangeThreshold - 레인지 임계값 (기본 0.8)
 * @returns {string} 'TREND' | 'RANGE' | 'NEUTRAL'
 */
export function detectModeSimple(
  currentATR,
  avgATR,
  trendThreshold = 1.2,
  rangeThreshold = 0.8
) {
  if (!Number.isFinite(currentATR) || !Number.isFinite(avgATR) || avgATR <= 0) {
    return "NEUTRAL";
  }

  const ratio = currentATR / avgATR;

  if (ratio >= trendThreshold) return "TREND";
  if (ratio <= rangeThreshold) return "RANGE";
  return "NEUTRAL";
}
