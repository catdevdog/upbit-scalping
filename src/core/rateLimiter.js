// 업비트 그룹별 안전 토큰버킷(Quotation 10rps, Exchange 30rps)

export class TokenBucket {
  constructor(rps, burst = rps) {
    this.capacity = burst;
    this.tokens = burst;
    this.refill = rps;
    this.last = Date.now();
  }
  async take() {
    for (;;) {
      const now = Date.now();
      const dt = (now - this.last) / 1000;
      this.last = now;
      this.tokens = Math.min(this.capacity, this.tokens + dt * this.refill);
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
  }
}

export const buckets = {
  orderbook: new TokenBucket(10),
  trades: new TokenBucket(10),
  candles: new TokenBucket(10),
  markets: new TokenBucket(10),
  exchange: new TokenBucket(30),
};

export function parseRemaining(val) {
  if (!val) return null;
  const group = /group=([^;]+)/.exec(val)?.[1];
  const sec = Number(/sec=(\d+)/.exec(val)?.[1] ?? NaN);
  const min = Number(/min=(\d+)/.exec(val)?.[1] ?? NaN);
  return { group, sec, min };
}
