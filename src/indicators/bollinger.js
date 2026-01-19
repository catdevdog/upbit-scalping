// src/indicators/bollinger.js
// 볼린저밴드 계산기

/**
 * 볼린저밴드 계산
 * @param {Array} candles - 캔들 배열 [{c: close, ...}, ...] (최신이 앞)
 * @param {number} period - 기간 (기본 20)
 * @param {number} stdDev - 표준편차 배수 (기본 2)
 * @returns {{middle: number, upper: number, lower: number, bandwidth: number}}
 */
export function bollingerBands(candles, period = 20, stdDev = 2) {
  if (!candles || candles.length < period) {
    return { middle: NaN, upper: NaN, lower: NaN, bandwidth: NaN };
  }

  // 최근 period개의 종가
  const closes = candles.slice(0, period).map((c) => c.c);

  // 중심선 (SMA)
  const sum = closes.reduce((a, b) => a + b, 0);
  const middle = sum / period;

  // 표준편차
  const squaredDiffs = closes.map((c) => (c - middle) ** 2);
  const variance = squaredDiffs.reduce((a, b) => a + b, 0) / period;
  const std = Math.sqrt(variance);

  // 상단/하단 밴드
  const upper = middle + stdDev * std;
  const lower = middle - stdDev * std;

  // Bandwidth (밴드 폭 비율)
  const bandwidth = middle > 0 ? (upper - lower) / middle : 0;

  return { middle, upper, lower, bandwidth };
}

/**
 * 볼린저밴드 %B 계산 (현재가 위치)
 * @param {number} price - 현재가
 * @param {{upper: number, lower: number}} bb - 볼린저밴드
 * @returns {number} 0~1 사이 값 (0: 하단, 1: 상단)
 */
export function bollingerPercentB(price, bb) {
  if (!bb || !Number.isFinite(bb.upper) || !Number.isFinite(bb.lower)) {
    return NaN;
  }
  const range = bb.upper - bb.lower;
  if (range <= 0) return NaN;
  return (price - bb.lower) / range;
}

/**
 * 볼린저밴드 히스토리 계산 (bandwidth percentile용)
 * @param {Array} candles - 캔들 배열
 * @param {number} period - BB 기간
 * @param {number} lookback - 히스토리 길이
 * @returns {Array<number>} bandwidth 배열
 */
export function bandwidthHistory(candles, period = 20, lookback = 100) {
  const result = [];
  for (let i = 0; i < lookback && i + period <= candles.length; i++) {
    const bb = bollingerBands(candles.slice(i), period);
    if (Number.isFinite(bb.bandwidth)) {
      result.push(bb.bandwidth);
    }
  }
  return result;
}
