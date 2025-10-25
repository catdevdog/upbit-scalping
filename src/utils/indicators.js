import { calculateAverage, calculateStdDev, toNumber } from "./helpers.js";

export function calculateMA(candles, period) {
  if (!candles || candles.length < period) return null;

  const prices = candles
    .slice(0, period)
    .map((c) => toNumber(c.trade_price, 0));
  return calculateAverage(prices);
}

export function calculateEMA(candles, period) {
  if (!candles || candles.length < period) return null;

  const k = 2 / (period + 1);
  let ema = calculateMA(candles.slice(-period), period);

  for (let i = candles.length - period - 1; i >= 0; i--) {
    const price = toNumber(candles[i].trade_price, 0);
    ema = price * k + ema * (1 - k);
  }

  return ema;
}

export function calculateRSI(candles, period = 14) {
  if (!candles || candles.length < period + 1) return null;

  let gains = 0;
  let losses = 0;

  for (let i = 0; i < period; i++) {
    const currentPrice = toNumber(candles[i].trade_price, 0);
    const prevPrice = toNumber(candles[i + 1].trade_price, 0);
    const change = currentPrice - prevPrice;

    if (change > 0) {
      gains += change;
    } else {
      losses += Math.abs(change);
    }
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;

  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;
  const rsi = 100 - 100 / (1 + rs);

  return rsi;
}

export function calculateBollingerBands(
  candles,
  period = 20,
  stdDevMultiplier = 2
) {
  if (!candles || candles.length < period) return null;

  const prices = candles
    .slice(0, period)
    .map((c) => toNumber(c.trade_price, 0));
  const ma = calculateAverage(prices);
  const stdDev = calculateStdDev(prices, ma);

  return {
    upper: ma + stdDev * stdDevMultiplier,
    middle: ma,
    lower: ma - stdDev * stdDevMultiplier,
    stdDev,
  };
}

export function calculateMACD(
  candles,
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9
) {
  if (!candles || candles.length < slowPeriod) return null;

  const fastEMA = calculateEMA(candles, fastPeriod);
  const slowEMA = calculateEMA(candles, slowPeriod);

  if (!fastEMA || !slowEMA) return null;

  const macd = fastEMA - slowEMA;

  return {
    macd,
    fastEMA,
    slowEMA,
  };
}

export function calculateVolatility(candles, period = 20) {
  if (!candles || candles.length < period) return null;

  const returns = [];
  for (let i = 0; i < period - 1; i++) {
    const currentPrice = toNumber(candles[i].trade_price, 0);
    const prevPrice = toNumber(candles[i + 1].trade_price, 0);

    if (prevPrice > 0) {
      const ret = (currentPrice - prevPrice) / prevPrice;
      returns.push(ret);
    }
  }

  if (returns.length === 0) return 0;

  return calculateStdDev(returns) * Math.sqrt(period);
}

export function findSupportResistance(candles, lookback = 30) {
  if (!candles || candles.length < lookback) return null;

  const recentCandles = candles.slice(0, lookback);
  const highs = recentCandles.map((c) => toNumber(c.high_price, 0));
  const lows = recentCandles.map((c) => toNumber(c.low_price, 0));

  return {
    resistance: Math.max(...highs),
    support: Math.min(...lows),
  };
}

export function detectCandlePattern(candles, count = 3) {
  if (!candles || candles.length < count) return null;

  const recent = candles.slice(0, count);

  let bullishCount = 0;
  let bearishCount = 0;
  const changes = [];

  for (const candle of recent) {
    const tradePrice = toNumber(candle.trade_price, 0);
    const openingPrice = toNumber(candle.opening_price, 0);

    if (openingPrice > 0) {
      const change = ((tradePrice - openingPrice) / openingPrice) * 100;
      changes.push(change);

      if (tradePrice > openingPrice) {
        bullishCount++;
      } else if (tradePrice < openingPrice) {
        bearishCount++;
      }
    }
  }

  return {
    consecutiveBullish: bullishCount === count,
    consecutiveBearish: bearishCount === count,
    changes,
    avgChange: calculateAverage(changes),
  };
}
