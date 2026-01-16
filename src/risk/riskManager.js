// 리스크/사이징: ATR% 높을수록 비중 축소, KRW 기준

export class Risk {
  constructor({
    minSize = 5000,
    maxSize = Number.POSITIVE_INFINITY,
    positionPctMax = 0.2,
    riskPctPerTrade = 0,
  } = {}) {
    this.minSize = minSize;
    this.maxSize = maxSize;
    this.positionPctMax = positionPctMax;
    this.riskPctPerTrade = riskPctPerTrade;
  }

  allocateKRW({ krwBalance, slPct }) {
    const usable = Math.floor(Math.max(0, krwBalance));
    if (usable <= 0) return 0;

    const pct = Number(this.positionPctMax);
    const pctCap =
      Number.isFinite(pct) && pct > 0 && pct <= 1
        ? Math.floor(usable * pct)
        : usable;

    const absCap =
      Number.isFinite(this.maxSize) && this.maxSize > 0
        ? Math.floor(this.maxSize)
        : usable;

    let target = Math.min(usable, pctCap, absCap);

    const riskPct = Number(this.riskPctPerTrade);
    const sl = Number(slPct);
    if (
      Number.isFinite(riskPct) &&
      riskPct > 0 &&
      riskPct <= 1 &&
      Number.isFinite(sl) &&
      sl > 0
    ) {
      const riskKRW = usable * riskPct;
      const byRisk = Math.floor(riskKRW / sl);
      target = Math.min(target, byRisk);
    }

    if (target < this.minSize) return target; // 호출 측에서 최소체결 확인
    return target;
  }
}
