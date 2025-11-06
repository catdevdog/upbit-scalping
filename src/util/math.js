// 공용 수학/통계·표시 유틸

export const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
export const logistic = (x) => 1 / (1 + Math.exp(-x));

export function percentile(arr, p) {
  if (!arr?.length) return NaN;
  const a = [...arr].sort((x, y) => x - y);
  const idx = Math.round((a.length - 1) * clamp(p, 0, 1));
  return a[idx];
}

export function nowKSTString() {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date());
}
