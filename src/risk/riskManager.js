// 리스크/사이징: ATR% 높을수록 비중 축소, KRW 기준

import { clamp } from "../util/math.js";

export class Risk {
  constructor({ baseRisk = 0.02, minSize = 5000, maxSize = 1000000 } = {}) {
    this.baseRisk = baseRisk;
    this.minSize = minSize;
    this.maxSize = maxSize;
  }
  sizeByAtr(atrPct) {
    if (!Number.isFinite(atrPct)) return 0.0;
    return clamp(1.4 - atrPct / 0.25, 0.4, 1.0); // 0.08~0.35% 선호
  }
  allocateKRW({ krwBalance, SLpct, atrPct }) {
    const riskBudget = krwBalance * this.baseRisk;
    let size = riskBudget / Math.max(SLpct, 0.0001);
    size *= this.sizeByAtr(atrPct);
    return clamp(
      Math.floor(size),
      this.minSize,
      Math.min(this.maxSize, krwBalance)
    );
  }
}
