import { log } from "./helpers.js";

/**
 * 글로벌 데이터 캐시 매니저
 * API 호출 최적화를 위한 캐싱 시스템
 */
class DataCacheManager {
  constructor() {
    this.cache = new Map();

    // 데이터 타입별 최소 캐시 시간 (ms)
    this.minCacheTime = {
      ticker: 500, // 현재가: 0.5초
      candles_1m: 1000, // 1분봉: 1초
      candles_5m: 5000, // 5분봉: 5초
      orderbook: 1000, // 호가창: 1초
      accounts: 2000, // 계좌: 2초
      market_context: 60000, // 시장 상황: 1분
    };
  }

  /**
   * 캐시된 데이터 조회 또는 새로 가져오기
   */
  async get(key, fetcher, cacheTime = null) {
    const cached = this.cache.get(key);
    const now = Date.now();

    // 캐시 히트
    if (
      cached &&
      now - cached.timestamp < (cacheTime || this.getDefaultCacheTime(key))
    ) {
      log("debug", `[Cache HIT] ${key}`);
      return cached.data;
    }

    // 캐시 미스 - 새로 가져오기
    log("debug", `[Cache MISS] ${key}`);

    try {
      const data = await fetcher();
      this.cache.set(key, {
        data,
        timestamp: now,
      });
      return data;
    } catch (error) {
      // 에러 발생 시 오래된 캐시라도 반환
      if (cached) {
        log("warn", `[Cache] API 에러, 오래된 캐시 사용: ${key}`);
        return cached.data;
      }
      throw error;
    }
  }

  /**
   * 키에서 기본 캐시 시간 추론
   */
  getDefaultCacheTime(key) {
    if (key.includes("ticker")) return this.minCacheTime.ticker;
    if (key.includes("candles_1m")) return this.minCacheTime.candles_1m;
    if (key.includes("candles_5m")) return this.minCacheTime.candles_5m;
    if (key.includes("orderbook")) return this.minCacheTime.orderbook;
    if (key.includes("accounts")) return this.minCacheTime.accounts;
    if (key.includes("market_context")) return this.minCacheTime.market_context;
    return 1000; // 기본 1초
  }

  /**
   * 특정 키의 캐시 무효화
   */
  invalidate(key) {
    this.cache.delete(key);
    log("debug", `[Cache] 무효화: ${key}`);
  }

  /**
   * 패턴에 맞는 모든 캐시 무효화
   */
  invalidatePattern(pattern) {
    let count = 0;
    for (const key of this.cache.keys()) {
      if (key.includes(pattern)) {
        this.cache.delete(key);
        count++;
      }
    }
    log("debug", `[Cache] 패턴 무효화: ${pattern} (${count}개)`);
  }

  /**
   * 전체 캐시 초기화
   */
  clear() {
    this.cache.clear();
    log("info", "[Cache] 전체 초기화");
  }

  /**
   * 캐시 통계
   */
  getStats() {
    return {
      size: this.cache.size,
      keys: Array.from(this.cache.keys()),
    };
  }
}

export default new DataCacheManager();
