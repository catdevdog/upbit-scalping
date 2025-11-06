// ATR% 계산(정규화 캔들 {o,h,l,c,v,t}) + 분위수 게이트

import { percentile } from "../util/math.js";

export function atrPercent(candles, period = 14) {
  if (!candles || candles.length < period + 1) return NaN;
  const arr = candles.slice(0, period + 1).reverse(); // oldest→newest
  const trs = [];
  let prevClose = arr[0].c;
  for (let i = 1; i < arr.length; i++) {
    const { h, l } = arr[i];
    const tr = Math.max(
      h - l,
      Math.abs(h - prevClose),
      Math.abs(l - prevClose)
    );
    trs.push(tr);
    prevClose = arr[i].c;
  }
  const atr = trs.reduce((a, b) => a + b, 0) / trs.length;
  const lastClose = arr[arr.length - 1].c;
  return Number.isFinite(lastClose) && lastClose > 0
    ? (atr / lastClose) * 100
    : NaN;
}

export function atrSeriesPercent(candles, period = 14, lookback = 240) {
  const n = Math.min(candles.length - (period + 1), lookback);
  if (n <= 0) return [];
  const out = [];
  for (let i = 0; i < n; i++) out.push(atrPercent(candles.slice(i)));
  return out;
}

export function atrBandGate(
  atrPct,
  historyArr,
  pLo = 0.4,
  pHi = 0.9,
  hardMin = 0.08
) {
  if (!Number.isFinite(atrPct) || !historyArr?.length)
    return { pass: false, lo: NaN, hi: NaN };
  const lo = Math.max(percentile(historyArr, pLo), hardMin);
  const hi = percentile(historyArr, pHi);
  return { pass: atrPct >= lo && atrPct <= hi, lo, hi };
}
