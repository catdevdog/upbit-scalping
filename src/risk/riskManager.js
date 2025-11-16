// 리스크/사이징: ATR% 높을수록 비중 축소, KRW 기준

export class Risk {
  constructor({ minSize = 5000, maxSize = Number.POSITIVE_INFINITY } = {}) {
    this.minSize = minSize;
    this.maxSize = maxSize;
  }
  allocateKRW({ krwBalance }) {
    const usable = Math.floor(Math.max(0, krwBalance));
    if (usable <= 0) return 0;
    const capped = Math.min(this.maxSize, usable);
    if (capped < this.minSize) return capped; // 호출 측에서 최소체결 확인
    return capped;
  }
}
