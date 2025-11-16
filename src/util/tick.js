/**
 * tickSizeFromOrderbook: 인접 호가간 가격 차이의 최빈값으로 tick 추정
 * Upbit KRW 마켓은 구간별 호가단위가 다르므로 정책 테이블 대신 실시간 추정.
 */
export function tickSizeFromOrderbook(orderbookMsg) {
  try {
    const units = orderbookMsg?.orderbook_units;
    if (!Array.isArray(units) || units.length < 2) return null;
    const asks = units.map((u) => Number(u.ask_price)).sort((a, b) => a - b);
    const diffs = [];
    for (let i = 1; i < Math.min(asks.length, 15); i++) {
      const d = +(asks[i] - asks[i - 1]).toFixed(10);
      if (d > 0) diffs.push(d);
    }
    if (!diffs.length) return null;
    // mode
    const freq = new Map();
    for (const d of diffs) freq.set(d, (freq.get(d) || 0) + 1);
    let best = null,
      cnt = -1;
    for (const [d, c] of freq.entries())
      if (c > cnt) {
        best = d;
        cnt = c;
      }
    return best;
  } catch {
    return null;
  }
}

export function roundToTick(price, tick, side) {
  // If an explicit tick is provided, use it (used for inferred tick sizes)
  if (tick && Number.isFinite(price)) {
    // Use asymmetric rounding: bids round down, asks round up to improve
    // order placement aggressiveness control.
    if (side === "bid") {
      const n = Math.floor(price / tick);
      return +(n * tick).toFixed(10);
    }
    if (side === "ask") {
      const n = Math.ceil(price / tick);
      return +(n * tick).toFixed(10);
    }
    const n = Math.round(price / tick);
    return +(n * tick).toFixed(10);
  }
  // Fallback: use KRW market tick table
  const step = krwTickSize(price);
  return Math.round(price / step) * step;
}

export function krwTickSize(price) {
  if (price >= 1000000) return 1000;
  if (price >= 500000) return 500;
  if (price >= 100000) return 100;
  if (price >= 50000) return 50;
  if (price >= 10000) return 10;
  if (price >= 5000) return 5;
  if (price >= 1000) return 1;
  if (price >= 100) return 1;
  if (price >= 10) return 0.1;
  if (price >= 1) return 0.01;
  if (price >= 0.1) return 0.001;
  if (price >= 0.01) return 0.0001;
  if (price >= 0.001) return 0.00001;
  if (price >= 0.0001) return 0.000001;
  if (price >= 0.00001) return 0.0000001;
  return 0.00000001;
}

// (roundToTick above covers both explicit tick and krw-table rounding)

export function spreadTicks(bid1, ask1) {
  const step = krwTickSize((bid1 + ask1) / 2);
  return Math.round((ask1 - bid1) / step);
}
