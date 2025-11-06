// KRW 호가단위/라운딩

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

export function roundToTick(price) {
  const step = krwTickSize(price);
  return Math.round(price / step) * step;
}

export function spreadTicks(bid1, ask1) {
  const step = krwTickSize((bid1 + ask1) / 2);
  return Math.round((ask1 - bid1) / step);
}
