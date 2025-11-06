// VWAP 계산(캔들 최신순 배열 [{o,h,l,c,v,...}]을 받아 윈도우 내 누적 평균)
// 반환: 윈도우 전체 VWAP 값 하나

export function vwap(candles, window = 120) {
  if (!candles?.length) return NaN;
  const arr = candles.slice(0, window); // 최신순 일부
  let pv = 0,
    vv = 0;
  for (const c of arr) {
    const tp = (Number(c.h) + Number(c.l) + Number(c.c)) / 3;
    const vol = Number(c.v) || 0;
    pv += tp * vol;
    vv += vol;
  }
  return vv > 0 ? pv / vv : NaN;
}
