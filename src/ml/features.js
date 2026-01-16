// src/ml/features.js
// ML feature builder for candle-only signals

import { ema } from "../indicators/ema.js";
import { atrPercent } from "../indicators/atr.js";
import { vwap } from "../indicators/vwap.js";

const avg = (arr) =>
  arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0;

export function computeRsi(closes, period = 14) {
  if (!Array.isArray(closes) || closes.length < period + 1) return NaN;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }
  const rs = losses === 0 ? 100 : gains / Math.max(1e-9, losses);
  return 100 - 100 / (1 + rs);
}

export function buildFeatureVector({ candles1m, cfg }) {
  const windowSize = Number(cfg?.ml?.featureWindow ?? 120);
  if (!Array.isArray(candles1m) || candles1m.length < windowSize) return null;

  // candles1m is 최신→과거 순서
  const window = candles1m.slice(0, windowSize);
  const oldestFirst = window.slice().reverse();
  const closes = oldestFirst.map((c) => c.c);
  const last = closes[closes.length - 1];

  const emaFast = ema(closes, Number(cfg?.ml?.emaFast ?? 20));
  const emaSlow = ema(closes, Number(cfg?.ml?.emaSlow ?? 60));
  const emaRatio = emaSlow > 0 ? emaFast / emaSlow - 1 : NaN;

  const atrPct = atrPercent(window, Number(cfg?.strat?.ATR_PERIOD ?? 14));

  const rsi = computeRsi(closes, Number(cfg?.ml?.rsiPeriod ?? 14));

  const vwapVal = vwap(window, Number(cfg?.ml?.vwapPeriod ?? 120));
  const vwapDist =
    Number.isFinite(vwapVal) && vwapVal > 0 ? (last - vwapVal) / vwapVal : NaN;

  const vols = window.map((c) => c.v);
  const baseMin = Number(cfg?.strat?.RVOL_BASE_MIN ?? 120);
  const rvolBase = vols.slice(0, Math.min(baseMin, vols.length));
  const rvol =
    avg(vols.slice(0, Math.min(5, vols.length))) /
    Math.max(1e-9, avg(rvolBase));

  const ret1 =
    closes.length >= 2
      ? (last - closes[closes.length - 2]) / closes[closes.length - 2]
      : NaN;
  const ret5 =
    closes.length >= 6
      ? (last - closes[closes.length - 6]) / closes[closes.length - 6]
      : NaN;

  const featureNames = [
    "emaRatio",
    "atrPct",
    "rvol",
    "rsi",
    "vwapDist",
    "ret1",
    "ret5",
  ];

  const values = [emaRatio, atrPct, rvol, rsi, vwapDist, ret1, ret5];

  if (values.some((v) => !Number.isFinite(v))) return null;

  return {
    featureNames,
    values,
    meta: {
      last,
      emaFast,
      emaSlow,
      atrPct,
      rvol,
      rsi,
      vwapVal,
    },
  };
}

export function buildFeatureVectorWithOrderbook({ candles1m, cfg, orderbook }) {
  const base = buildFeatureVector({ candles1m, cfg });
  if (!base) return null;
  const ob = orderbook || {};
  const imbalance = Number(ob.imbalance);
  const spreadTicks = Number(ob.spreadTicks);
  const bestBidShare = Number(ob.bestBidShare);

  const featureNames = [
    ...base.featureNames,
    "imbalance",
    "spreadTicks",
    "bestBidShare",
  ];
  const values = [...base.values, imbalance, spreadTicks, bestBidShare];

  if (values.some((v) => !Number.isFinite(v))) return null;

  return {
    featureNames,
    values,
    meta: {
      ...base.meta,
      imbalance,
      spreadTicks,
      bestBidShare,
    },
  };
}

export function buildFeatureVectorFromSnapshot(snapshot, includeOrderbook) {
  if (!snapshot) return null;
  const emaFast = Number(snapshot.emaFast);
  const emaSlow = Number(snapshot.emaSlow);
  const emaRatio = emaSlow > 0 ? emaFast / emaSlow - 1 : NaN;
  const atrPct = Number(snapshot.atrPct);
  const rvol = Number(snapshot.rvol);
  const rsi = Number(snapshot.rsi);
  const vwapVal = Number(snapshot.vwap);
  const price = Number(snapshot.price);
  const vwapDist =
    Number.isFinite(vwapVal) && vwapVal > 0 ? (price - vwapVal) / vwapVal : NaN;
  const ret1 = Number(snapshot.ret1);
  const ret5 = Number(snapshot.ret5);

  const featureNames = [
    "emaRatio",
    "atrPct",
    "rvol",
    "rsi",
    "vwapDist",
    "ret1",
    "ret5",
  ];
  const values = [emaRatio, atrPct, rvol, rsi, vwapDist, ret1, ret5];

  if (includeOrderbook) {
    const imbalance = Number(snapshot.imbalance);
    const spreadTicks = Number(snapshot.spreadTicks);
    const bestBidShare = Number(snapshot.bestBidShare);
    featureNames.push("imbalance", "spreadTicks", "bestBidShare");
    values.push(imbalance, spreadTicks, bestBidShare);
  }

  if (values.some((v) => !Number.isFinite(v))) return null;

  return { featureNames, values };
}
