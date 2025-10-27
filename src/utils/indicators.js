/**
 * ✅ 기술적 지표 계산 라이브러리 (VWAP, ATR 추가)
 */

/**
 * RSI (Relative Strength Index) 계산
 */
export function calculateRSI(candles, period = 14) {
  if (candles.length < period + 1) {
    return 50; // 기본값
  }

  const changes = [];
  for (let i = 0; i < candles.length - 1; i++) {
    changes.push(candles[i].trade_price - candles[i + 1].trade_price);
  }

  let gains = 0;
  let losses = 0;

  for (let i = 0; i < period; i++) {
    if (changes[i] > 0) {
      gains += changes[i];
    } else {
      losses += Math.abs(changes[i]);
    }
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period; i < changes.length; i++) {
    const change = changes[i];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;
  const rsi = 100 - 100 / (1 + rs);

  return rsi;
}

/**
 * 볼린저 밴드 계산
 */
export function calculateBollingerBands(candles, period = 20, stdDev = 2) {
  if (candles.length < period) {
    return null;
  }

  const prices = candles.slice(0, period).map((c) => c.trade_price);
  const sma = prices.reduce((sum, price) => sum + price, 0) / period;

  const squaredDiffs = prices.map((price) => Math.pow(price - sma, 2));
  const variance = squaredDiffs.reduce((sum, diff) => sum + diff, 0) / period;
  const standardDeviation = Math.sqrt(variance);

  return {
    upper: sma + standardDeviation * stdDev,
    middle: sma,
    lower: sma - standardDeviation * stdDev,
  };
}

/**
 * 이동평균 계산
 */
export function calculateMA(candles, period) {
  if (candles.length < period) return null;

  const prices = candles.slice(0, period).map((c) => c.trade_price);
  return prices.reduce((sum, price) => sum + price, 0) / period;
}

/**
 * 변동성 계산 (표준편차 기반)
 */
export function calculateVolatility(candles, period = 20) {
  if (candles.length < period) {
    return 0;
  }

  const prices = candles.slice(0, period).map((c) => c.trade_price);
  const mean = prices.reduce((sum, price) => sum + price, 0) / period;

  const squaredDiffs = prices.map((price) => Math.pow(price - mean, 2));
  const variance = squaredDiffs.reduce((sum, diff) => sum + diff, 0) / period;
  const stdDev = Math.sqrt(variance);

  // 변동성을 평균 가격 대비 퍼센트로 변환
  const volatilityPercent = (stdDev / mean) * 100;

  return volatilityPercent;
}

/**
 * ✅ VWAP (Volume Weighted Average Price) 계산
 * 거래량 가중 평균가 - 돌파/되돌림 판단에 사용
 */
export function calculateVWAP(candles) {
  if (candles.length === 0) return null;

  let totalVolume = 0;
  let totalVolumePrice = 0;

  for (const candle of candles) {
    const typicalPrice =
      (candle.high_price + candle.low_price + candle.trade_price) / 3;
    const volume = candle.candle_acc_trade_volume;

    totalVolumePrice += typicalPrice * volume;
    totalVolume += volume;
  }

  if (totalVolume === 0) return null;

  return totalVolumePrice / totalVolume;
}

/**
 * ✅ ATR (Average True Range) 계산
 * 변동성 측정 - 진입 필터로 사용
 * @param {Array} candles - 캔들 데이터
 * @param {number} period - 기간 (기본 14)
 * @returns {number} ATR 값 (퍼센트)
 */
export function calculateATR(candles, period = 14) {
  if (!candles || candles.length < period + 1) return 0;

  // 오래된 → 최신 정렬
  const arr = [...candles].sort(
    (a, b) =>
      new Date(a.candle_date_time_kst).getTime() -
      new Date(b.candle_date_time_kst).getTime()
  );

  // TR% = TR / prevClose × 100
  const trPct = [];
  for (let i = 1; i < arr.length; i++) {
    const cur = arr[i];
    const prev = arr[i - 1];
    const H = cur.high_price;
    const L = cur.low_price;
    const Cprev = prev.trade_price;
    const TR = Math.max(H - L, Math.abs(H - Cprev), Math.abs(L - Cprev));
    trPct.push((TR / Cprev) * 100);
  }

  // 초기값: 가장 오래된 구간부터 period개 평균
  let atr = trPct.slice(0, period).reduce((s, v) => s + v, 0) / period;

  // Wilder 평활
  for (let i = period; i < trPct.length; i++) {
    atr = atr + (trPct[i] - atr) / period;
  }

  return Number.isFinite(atr) ? atr : 0; // % 값
}

// 스캘핑용 단기
export function calculateShortATR(candles) {
  return calculateATR(candles, 5);
}

/**
 * EMA (지수 이동평균) 계산
 */
export function calculateEMA(candles, period) {
  if (candles.length < period) return null;

  const prices = candles.map((c) => c.trade_price);
  const multiplier = 2 / (period + 1);

  // 첫 EMA는 SMA
  let ema = prices.slice(0, period).reduce((sum, p) => sum + p, 0) / period;

  // 이후 EMA 계산
  for (let i = period; i < prices.length; i++) {
    ema = (prices[i] - ema) * multiplier + ema;
  }

  return ema;
}

/**
 * ✅ VWAP 이격도 계산 (퍼센트)
 */
export function calculateVWAPDeviation(currentPrice, vwap) {
  if (!vwap || vwap === 0) return 0;
  return ((currentPrice - vwap) / vwap) * 100;
}

/**
 * ✅ 지지/저항 레벨 계산
 */
export function calculateSupportResistance(candles, period = 20) {
  if (candles.length < period) return null;

  const recentCandles = candles.slice(0, period);
  const highs = recentCandles.map((c) => c.high_price);
  const lows = recentCandles.map((c) => c.low_price);

  return {
    resistance: Math.max(...highs),
    support: Math.min(...lows),
  };
}

/**
 * ✅ 상대거래량 (RVOL) 계산
 * RVOL = 현재 거래량 / N일 평균 거래량
 */
export function calculateRVOL(currentVolume, historicalCandles) {
  if (!historicalCandles || historicalCandles.length === 0) {
    return 1.0;
  }

  const avgVolume =
    historicalCandles.reduce((sum, c) => sum + c.candle_acc_trade_volume, 0) /
    historicalCandles.length;

  if (avgVolume === 0) return 1.0;

  return currentVolume / avgVolume;
}
