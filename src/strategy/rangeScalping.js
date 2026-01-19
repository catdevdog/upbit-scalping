// src/strategy/rangeScalping.js
// 레인지(횡보장) 스캘핑 전략 - 볼린저밴드 기반 평균회귀
// [v4.3] RSI 조건 완화 - BB 위치가 핵심, RSI는 보조 확인

/**
 * 레인지 진입 조건 체크
 * [v4.3 변경] RSI 조건 대폭 완화 - 횡보장에서 RSI가 극단값을 보이기 어려움
 *
 * @param {number} price - 현재가
 * @param {{upper: number, lower: number, middle: number}} bb - 볼린저밴드
 * @param {number} rsi - RSI 값
 * @param {object} config - 설정
 * @returns {{pass: boolean, side: string, reason: string, target: number, confidence: number}}
 */
export function checkRangeEntry(price, bb, rsi, config = {}) {
  const rsiOversold = config.rsiOversold ?? 48; // 완화: 35 → 48
  const rsiOverbought = config.rsiOverbought ?? 52; // 완화: 65 → 52
  const bbMargin = config.bbMargin ?? 0.003; // BB 밴드 0.3% 여유

  // 유효성 검사
  if (!Number.isFinite(price) || !bb || !Number.isFinite(rsi)) {
    return {
      pass: false,
      side: null,
      reason: "데이터 부족",
      target: null,
      confidence: 0,
    };
  }

  if (!Number.isFinite(bb.lower) || !Number.isFinite(bb.upper)) {
    return {
      pass: false,
      side: null,
      reason: "BB 계산 불가",
      target: null,
      confidence: 0,
    };
  }

  const bbWidth = (bb.upper - bb.lower) / bb.middle; // BB 폭 (%)
  const pricePosition = (price - bb.lower) / (bb.upper - bb.lower); // 0=하단, 1=상단

  // [핵심 변경] BB 하단 근접만으로 진입 가능, RSI는 신뢰도 조정
  const lowerThreshold = bb.lower * (1 + bbMargin);

  if (price <= lowerThreshold) {
    // BB 하단 근접 → 기본 진입 허용
    let confidence = 0.6; // 기본 신뢰도 60%
    let reason = `BB하단 근접 (가격위치: ${(pricePosition * 100).toFixed(1)}%)`;

    // RSI가 낮으면 신뢰도 상승 (보너스)
    if (rsi < rsiOversold) {
      confidence = 0.85;
      reason = `BB하단 + RSI(${rsi.toFixed(1)}) 과매도`;
    } else if (rsi < 50) {
      confidence = 0.7;
      reason = `BB하단 + RSI(${rsi.toFixed(1)}) 중립↓`;
    }

    // BB 폭이 좁으면 (횡보 강함) 신뢰도 상승
    if (bbWidth < 0.02) {
      // BB 폭 2% 미만
      confidence = Math.min(1, confidence + 0.1);
      reason += ` | BB폭 ${(bbWidth * 100).toFixed(2)}%(좁음)`;
    }

    return {
      pass: true,
      side: "BUY",
      reason,
      target: bb.middle,
      confidence,
      pricePosition,
      bbWidth,
    };
  }

  // BB 상단 근접 → 청산 시그널 (숏은 안 함)
  const upperThreshold = bb.upper * (1 - bbMargin);
  if (price >= upperThreshold) {
    let reason = `BB상단 근접 (가격위치: ${(pricePosition * 100).toFixed(1)}%)`;
    if (rsi > rsiOverbought) {
      reason = `BB상단 + RSI(${rsi.toFixed(1)}) 과매수`;
    }

    return {
      pass: false,
      side: "SELL_SIGNAL",
      reason,
      target: bb.middle,
      confidence: 0,
      pricePosition,
      bbWidth,
    };
  }

  // 중간 영역 → 진입 안 함
  return {
    pass: false,
    side: null,
    reason: `BB 중간 영역 (가격위치: ${(pricePosition * 100).toFixed(1)}%)`,
    target: null,
    confidence: 0,
    pricePosition,
    bbWidth,
  };
}

/**
 * 레인지 청산 조건 체크
 * @param {number} entryPrice - 진입가
 * @param {number} currentPrice - 현재가
 * @param {number} entryTime - 진입 시간 (ms)
 * @param {{middle: number}} bb - 볼린저밴드
 * @param {object} config - 설정
 * @returns {{shouldExit: boolean, reason: string}}
 */
export function checkRangeExit(
  entryPrice,
  currentPrice,
  entryTime,
  bb,
  config = {}
) {
  const tpPct = config.tpPct ?? 0.004; // 0.4%
  const slPct = config.slPct ?? 0.0025; // 0.25%
  const timeoutMs = (config.timeoutSec ?? 600) * 1000; // 10분

  if (!Number.isFinite(entryPrice) || !Number.isFinite(currentPrice)) {
    return { shouldExit: false, reason: "" };
  }

  const pnlPct = (currentPrice - entryPrice) / entryPrice;
  const elapsed = Date.now() - entryTime;

  // TP 도달
  if (pnlPct >= tpPct) {
    return {
      shouldExit: true,
      reason: `TP 도달 (+${(pnlPct * 100).toFixed(2)}%)`,
    };
  }

  // BB 중심선 도달 (목표)
  if (bb && Number.isFinite(bb.middle) && currentPrice >= bb.middle) {
    return {
      shouldExit: true,
      reason: `BB 중심선 도달 (${bb.middle.toFixed(0)})`,
    };
  }

  // SL 도달
  if (pnlPct <= -slPct) {
    return {
      shouldExit: true,
      reason: `SL 도달 (${(pnlPct * 100).toFixed(2)}%)`,
    };
  }

  // 타임아웃
  if (elapsed >= timeoutMs) {
    return {
      shouldExit: true,
      reason: `타임아웃 (${Math.floor(elapsed / 60000)}분)`,
    };
  }

  return { shouldExit: false, reason: "" };
}

/**
 * 레인지 모드 p* 계산
 * @param {number} tp - TP 비율
 * @param {number} sl - SL 비율
 * @param {number} fee - 수수료
 * @param {number} slip - 슬리피지
 * @returns {number} 손익분기 승률
 */
export function calcRangePStar(tp, sl, fee = 0.0005, slip = 0.0003) {
  const roundTripCost = 2 * (fee + slip);
  const tpNet = tp - roundTripCost;
  const slNet = sl + roundTripCost;

  if (tpNet <= 0 || slNet <= 0) return 1; // 불가능
  return slNet / (tpNet + slNet);
}
