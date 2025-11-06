// EMA 계산(배열은 oldest→newest 순서로 넣을 것)

export function ema(values, period) {
  if (!Array.isArray(values) || values.length === 0 || period <= 0) return NaN;
  const k = 2 / (period + 1);
  let prev = values[0];
  for (let i = 1; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
  }
  return prev;
}
