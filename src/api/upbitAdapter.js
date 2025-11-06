// 업비트 REST (시세 + 실거래) — JWT 서명 포함
import crypto from "crypto";
import { buckets } from "../core/rateLimiter.js";
import { KEYS } from "../config/index.js";

const BASE = "https://api.upbit.com/v1";

// ===== 공용(시세) =====
async function httpGet(path, params, bucket) {
  const qs = params
    ? "?" +
      new URLSearchParams(
        Object.fromEntries(
          Object.entries(params).filter(
            ([, v]) => v !== undefined && v !== null
          )
        )
      )
    : "";
  await bucket.take();
  const res = await fetch(BASE + path + qs);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${path}`);
  return res.json();
}

export async function getOrderbook(market) {
  return (
    await httpGet("/orderbook", { markets: market }, buckets.orderbook)
  )[0];
}
export async function getTrades(market, count = 50) {
  return httpGet("/trades/ticks", { market, count }, buckets.trades);
}
export async function getMinuteCandles(unit, market, count = 200) {
  const raw = await httpGet(
    `/candles/minutes/${unit}`,
    { market, count },
    buckets.candles
  );
  return raw.map((c) => ({
    o: +c.opening_price,
    h: +c.high_price,
    l: +c.low_price,
    c: +c.trade_price,
    v: +c.candle_acc_trade_volume,
    t: c.candle_date_time_kst || c.timestamp,
  }));
}

// ===== 인증 유틸 =====
const b64u = (buf) =>
  Buffer.from(buf)
    .toString("base64")
    .replace(/=+/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
function signJWT(payload, secret) {
  const header = { alg: "HS256", typ: "JWT" };
  const data = `${b64u(JSON.stringify(header))}.${b64u(
    JSON.stringify(payload)
  )}`;
  const sig = crypto
    .createHmac("sha256", secret)
    .update(data)
    .digest("base64")
    .replace(/=+/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return `${data}.${sig}`;
}
function qsFrom(body) {
  // 업비트는 본문을 "쿼리 문자열 형태"로 해시. 키 정렬로 결정적 생성.
  const entries = Object.entries(body)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => [k, String(v)]);
  entries.sort(([a], [b]) => a.localeCompare(b));
  return new URLSearchParams(entries).toString();
}
async function httpPrivate(path, method, body) {
  await buckets.exchange.take();
  const query = body ? qsFrom(body) : "";
  const hash = crypto.createHash("sha512").update(query, "utf8").digest("hex");
  const jwt = signJWT(
    {
      access_key: KEYS.access,
      nonce: crypto.randomUUID(),
      query_hash: hash,
      query_hash_alg: "SHA512",
    },
    KEYS.secret
  );
  const res = await fetch(BASE + path, {
    method,
    headers: {
      Authorization: `Bearer ${jwt}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${path}: ${text}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ===== 주문 함수 =====
// KRW 시장가 매수: KRW 금액으로 즉시 체결
export async function placeMarketBuyKRW({ market, krw }) {
  const body = {
    market,
    side: "bid",
    ord_type: "price",
    price: String(Math.floor(krw)),
  };
  return httpPrivate("/orders", "POST", body);
}
// 시장가 매도: 보유 수량으로 즉시 매도
export async function placeMarketSell({ market, volume }) {
  const body = {
    market,
    side: "ask",
    ord_type: "market",
    volume: String(volume),
  };
  return httpPrivate("/orders", "POST", body);
}
// 지정가 매수(원하면 사용)
export async function placeLimitBuy({ market, price, volume }) {
  const body = {
    market,
    side: "bid",
    ord_type: "limit",
    price: String(price),
    volume: String(volume),
  };
  return httpPrivate("/orders", "POST", body);
}

export async function getOpenOrders({ market } = {}) {
  // GET /orders/open 은 쿼리도 해시 포함
  const params = market ? { market } : {};
  const query = new URLSearchParams(params).toString();
  const hash = crypto.createHash("sha512").update(query, "utf8").digest("hex");
  const jwt = signJWT(
    {
      access_key: KEYS.access,
      nonce: crypto.randomUUID(),
      query_hash: hash,
      query_hash_alg: "SHA512",
    },
    KEYS.secret
  );

  await buckets.exchange.take();
  const res = await fetch(`${BASE}/orders/open${query ? `?${query}` : ""}`, {
    headers: { Authorization: `Bearer ${jwt}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} /orders/open`);
  return res.json();
}

export const hasKeys = () => Boolean(KEYS.access && KEYS.secret);
