// 업비트 레이트리미터 v2.0 (초단타 안전 버전)
// - 429 응답 시 자동 백오프
// - 분당 제한 추가 (Quotation 600/min)
// - 사용량 모니터링

export class TokenBucket {
  constructor(rps, burst = rps, rpm = null) {
    this.capacity = burst;
    this.tokens = burst;
    this.refill = rps;
    this.last = Date.now();

    // 분당 제한 (선택)
    this.rpm = rpm;
    this.minuteCounter = 0;
    this.minuteStart = Date.now();

    // 통계
    this.total429 = 0;
    this.totalCalls = 0;
  }

  async take() {
    this.totalCalls++;

    // 분당 제한 체크
    if (this.rpm) {
      const now = Date.now();
      if (now - this.minuteStart > 60000) {
        // 1분 경과 → 리셋
        this.minuteCounter = 0;
        this.minuteStart = now;
      }
      if (this.minuteCounter >= this.rpm) {
        // 분당 제한 초과 → 대기
        const waitMs = 60000 - (now - this.minuteStart);
        if (waitMs > 0) {
          console.warn(
            `⏳ RPM 제한 도달, ${Math.ceil(waitMs / 1000)}초 대기...`
          );
          await new Promise((r) => setTimeout(r, waitMs));
          this.minuteCounter = 0;
          this.minuteStart = Date.now();
        }
      }
      this.minuteCounter++;
    }

    // 토큰 버킷
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

  report429() {
    this.total429++;
  }

  getStats() {
    return {
      totalCalls: this.totalCalls,
      total429: this.total429,
      rate429: this.total429 / Math.max(1, this.totalCalls),
      currentTokens: this.tokens.toFixed(2),
      minuteUsage: this.rpm ? `${this.minuteCounter}/${this.rpm}` : "N/A",
    };
  }
}

// 초단타용 버킷 (Quotation 그룹에 RPM 제한 추가)
export const buckets = {
  orderbook: new TokenBucket(10, 10, 600), // 10 rps, 600 rpm
  trades: new TokenBucket(10, 10, 600),
  candles: new TokenBucket(10, 10, 600),
  markets: new TokenBucket(10, 10, 600),
  exchange: new TokenBucket(30, 30), // 30 rps, RPM 제한 없음
};

export function parseRemaining(val) {
  if (!val) return null;
  const group = /group=([^;]+)/.exec(val)?.[1];
  const sec = Number(/sec=(\d+)/.exec(val)?.[1] ?? NaN);
  const min = Number(/min=(\d+)/.exec(val)?.[1] ?? NaN);
  return { group, sec, min };
}

// ultra helpers: Remaining-Req 파싱(간단형) 및 헤더 기반 백오프
export function parseRemainingReq(header) {
  if (!header) return { sec: null, min: null };
  const sec = Number(/sec=(\d+)/.exec(header)?.[1] ?? NaN);
  const min = Number(/min=(\d+)/.exec(header)?.[1] ?? NaN);
  return {
    sec: Number.isFinite(sec) ? sec : null,
    min: Number.isFinite(min) ? min : null,
  };
}

export async function maybeBackoffByHeader(headers) {
  const rr = headers?.get?.("Remaining-Req") ?? headers?.["remaining-req"];
  const { sec } = parseRemainingReq(rr);
  if (sec == null) return;
  if (sec <= 2) await sleep(300);
  else if (sec <= 4) await sleep(150);
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 통계 리포트 (디버깅용)
export function reportBucketStats() {
  console.log("\n📊 API 사용량 통계:");
  for (const [name, bucket] of Object.entries(buckets)) {
    const stats = bucket.getStats();
    console.log(
      `  ${name.padEnd(12)} ${stats.totalCalls} 호출, 429: ${
        stats.total429
      } (${(stats.rate429 * 100).toFixed(2)}%), 토큰: ${
        stats.currentTokens
      }, 분당: ${stats.minuteUsage}`
    );
  }
  console.log("");
}

// 주기적 리포트 (선택)
if (process.env.RATE_LIMIT_REPORT === "true") {
  setInterval(reportBucketStats, 60000); // 1분마다
}
