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

  async getCandles(market, count = 200, unit = "days", minutes = null) {
    let endpoint = "";
    let params = { market, count };

    if (unit === "minutes") {
      endpoint = `/candles/minutes/${minutes}`;
    } else if (unit === "days") {
      endpoint = "/candles/days";
    } else if (unit === "weeks") {
      endpoint = "/candles/weeks";
    } else if (unit === "months") {
      endpoint = "/candles/months";
    }

    const response = await this.client.get(endpoint, { params });
    return response.data;
  }

  async getOrderbook(market) {
    const response = await this.client.get("/orderbook", {
      params: { markets: market },
    });
    return response.data[0];
  }

  async getTrades(market, count = 100) {
    const response = await this.client.get("/trades/ticks", {
      params: { market, count },
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
    if (!account) return { balance: 0, avgBuyPrice: 0 };

    return {
      balance: parseFloat(account.balance),
      avgBuyPrice: parseFloat(account.avg_buy_price),
      locked: parseFloat(account.locked),
    };
  }

  async marketBuy(market, price) {
    const params = {
      market,
      side: "bid",
      price: price.toString(),
      ord_type: "price",
    };

    const headers = auth.getAuthHeaders(params);
    const response = await this.client.post("/orders", params, { headers });
    return response.data;
  }

  async marketSell(market, volume) {
    const params = {
      market,
      side: "ask",
      volume: volume.toString(),
      ord_type: "market",
    };

    const headers = auth.getAuthHeaders(params);
    const response = await this.client.post("/orders", params, { headers });
    return response.data;
  }

  async getOrder(uuid) {
    const params = { uuid };
    const headers = auth.getAuthHeaders(params);
    const response = await this.client.get("/order", { params, headers });
    return response.data;
  }

  async cancelOrder(uuid) {
    const params = { uuid };
    const headers = auth.getAuthHeaders(params);
    const response = await this.client.delete("/order", { params, headers });
    return response.data;
  }
}

export default new UpbitAPI();
