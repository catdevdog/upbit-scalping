import axios from "axios";
import auth from "./auth.js";

const BASE_URL = "https://api.upbit.com/v1";

class UpbitAPI {
  constructor() {
    this.client = axios.create({
      baseURL: BASE_URL,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }

  // 공개 API (인증 불필요)
  async getTicker(market) {
    const response = await this.client.get("/ticker", {
      params: { markets: market },
    });
    return response.data[0];
  }

  /**
   * ✅ 캔들 데이터 조회 (count 검증 강화)
   */
  async getCandles(market, count = 200, unit = "days", minutes = null) {
    // ✅ CRITICAL: count 값 검증 및 보정
    let safeCount = count;

    // 1. 숫자 타입 확인
    if (typeof count !== "number") {
      console.error(
        `❌ [getCandles] count가 숫자가 아님: ${typeof count}, 값: ${count}`
      );
      safeCount = 200;
    }
    // 2. NaN/Infinity 확인
    else if (!Number.isFinite(count)) {
      console.error(`❌ [getCandles] count가 유효하지 않음: ${count}`);
      safeCount = 200;
    }
    // 3. 음수 확인
    else if (count < 1) {
      console.error(`❌ [getCandles] count가 음수 또는 0: ${count}`);
      safeCount = 200;
    }
    // 4. 최대값 확인 (Upbit 제한: 200)
    else if (count > 200) {
      console.warn(`⚠️ [getCandles] count가 너무 큼: ${count} → 200으로 제한`);
      safeCount = 200;
    } else {
      // 정수로 반올림
      safeCount = Math.floor(count);
    }

    // 디버그 로그 (count 변환 시에만)
    if (safeCount !== count) {
      console.warn(
        `🔧 [getCandles] count 보정: ${count} → ${safeCount} (market: ${market}, unit: ${unit}, minutes: ${minutes})`
      );
    }

    let endpoint = "";
    let params = { market, count: safeCount };

    if (unit === "minutes") {
      endpoint = `/candles/minutes/${minutes}`;
    } else if (unit === "days") {
      endpoint = "/candles/days";
    } else if (unit === "weeks") {
      endpoint = "/candles/weeks";
    } else if (unit === "months") {
      endpoint = "/candles/months";
    }

    try {
      const response = await this.client.get(endpoint, { params });
      return response.data;
    } catch (error) {
      // API 에러 상세 로깅
      if (error.response) {
        console.error(`❌ [getCandles] API 에러:`, {
          status: error.response.status,
          data: error.response.data,
          params: params,
          endpoint: endpoint,
        });
      }
      throw error;
    }
  }

  async getOrderbook(market) {
    const response = await this.client.get("/orderbook", {
      params: { markets: market },
    });
    return response.data[0];
  }

  async getTrades(market, count = 100) {
    // ✅ count 검증
    const safeCount = Math.max(1, Math.min(500, Math.floor(count || 100)));

    const response = await this.client.get("/trades/ticks", {
      params: { market, count: safeCount },
    });
    return response.data;
  }

  // 인증 필요 API
  async getAccounts() {
    const headers = auth.getAuthHeaders();
    const response = await this.client.get("/accounts", { headers });
    return response.data;
  }

  async getBalance(currency = "KRW") {
    const accounts = await this.getAccounts();
    const account = accounts.find((acc) => acc.currency === currency);
    return account ? parseFloat(account.balance) : 0;
  }

  async getCoinBalance(currency) {
    const accounts = await this.getAccounts();
    const account = accounts.find((acc) => acc.currency === currency);

    if (!account) {
      return {
        balance: 0,
        locked: 0,
        avg_buy_price: 0,
        avg_buy_price_modified: false,
        unit_currency: "KRW",
      };
    }

    return {
      balance: parseFloat(account.balance),
      locked: parseFloat(account.locked),
      avg_buy_price: parseFloat(account.avg_buy_price),
      avg_buy_price_modified: account.avg_buy_price_modified || false,
      unit_currency: account.unit_currency,
    };
  }

  async marketBuy(market, price) {
    const headers = auth.getAuthHeaders({
      market,
      side: "bid",
      price: price.toString(),
      ord_type: "price",
    });

    const response = await this.client.post(
      "/orders",
      {
        market,
        side: "bid",
        price: price.toString(),
        ord_type: "price",
      },
      { headers }
    );

    return response.data;
  }

  async marketSell(market, volume) {
    const headers = auth.getAuthHeaders({
      market,
      side: "ask",
      volume: volume.toString(),
      ord_type: "market",
    });

    const response = await this.client.post(
      "/orders",
      {
        market,
        side: "ask",
        volume: volume.toString(),
        ord_type: "market",
      },
      { headers }
    );

    return response.data;
  }

  async getOrder(uuid) {
    const headers = auth.getAuthHeaders({ uuid });

    const response = await this.client.get("/order", {
      headers,
      params: { uuid },
    });

    return response.data;
  }

  async cancelOrder(uuid) {
    const headers = auth.getAuthHeaders({ uuid });

    const response = await this.client.delete("/order", {
      headers,
      params: { uuid },
    });

    return response.data;
  }
}

export default new UpbitAPI();
