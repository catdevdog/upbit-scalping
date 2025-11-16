// 업비트 REST (429 자동 백오프 추가) v2.0
import crypto from "crypto";
import { buckets } from "../core/rateLimiter.js";
import { KEYS } from "../config/index.js";
import { connectUpbitWS, MarketSnapshot } from "../core/ws.js";
import { maybeBackoffByHeader } from "../core/rateLimiter.js";

const BASE = "https://api.upbit.com/v1";

// ===== 429 백오프 래퍼 =====
async function fetchWithBackoff(url, options, bucket, maxRetries = 3) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await bucket.take();
      const res = await fetch(url, options);

      // 429 Too Many Requests
      if (res.status === 429) {
        bucket.report429();

        const retryAfter = res.headers.get("Retry-After");
        const waitMs = retryAfter
          ? parseInt(retryAfter) * 1000
          : Math.min(10000, 500 * Math.pow(2, attempt)); // 지수 백오프

        if (attempt < maxRetries) {
          console.warn(
            `⚠️ 429 Too Many Requests, ${Math.ceil(
              waitMs / 1000
            )}초 대기... (시도 ${attempt + 1}/${maxRetries})`
          );
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        } else {
          throw new Error(
            `API 레이트리미트 초과 (429) - ${maxRetries}회 재시도 실패`
          );
        }
      }

      // 5xx 서버 오류 (일시적)
      if (res.status >= 500) {
        if (attempt < maxRetries) {
          const waitMs = 1000 * Math.pow(1.5, attempt);
          console.warn(
            `⚠️ 서버 오류 ${res.status}, ${Math.ceil(
              waitMs / 1000
            )}초 후 재시도...`
          );
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }
      }

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status} ${url}: ${text}`);
      }

      return res.json();
    } catch (err) {
      if (err.name === "TypeError" && err.message.includes("fetch")) {
        // 네트워크 오류
        if (attempt < maxRetries) {
          const waitMs = 1000 * Math.pow(1.5, attempt);
          console.warn(
            `⚠️ 네트워크 오류, ${Math.ceil(waitMs / 1000)}초 후 재시도...`
          );
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }
      }
      throw err;
    }
  }

  throw new Error(`최대 재시도 횟수 초과: ${url}`);
}

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

  return fetchWithBackoff(
    BASE + path + qs,
    {
      headers: { accept: "application/json" },
    },
    bucket
  );
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
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined || value === null) continue;
    params.append(key, String(value));
  }
  return params.toString();
}

const toNumberString = (value, decimals, mode = "floor") => {
  const num = Number(value);
  if (!Number.isFinite(num)) return String(value);
  if (decimals == null) return String(num);
  const pow = Math.pow(10, decimals);
  let adjusted;
  if (mode === "ceil") adjusted = Math.ceil(num * pow) / pow;
  else if (mode === "round") adjusted = Math.round(num * pow) / pow;
  else adjusted = Math.floor(num * pow) / pow;
  const fixed = adjusted.toFixed(decimals);
  const trimmed = fixed.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
  return trimmed === "" ? "0" : trimmed;
};

function normalizeOrderBody(body) {
  if (!body) return body;
  const normalized = {};
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined || value === null) continue;
    if (key === "volume") {
      normalized[key] = toNumberString(value, 8, "floor");
      continue;
    }
    if (key === "price" || key === "krw") {
      normalized[key] = toNumberString(value);
      continue;
    }
    normalized[key] = typeof value === "string" ? value : String(value);
  }
  return normalized;
}

async function httpPrivate(path, method, body) {
  const normalized = normalizeOrderBody(body);
  const query = normalized ? qsFrom(normalized) : "";
  const hashBase = normalized ? query : "";
  const hash = crypto
    .createHash("sha512")
    .update(hashBase, "utf8")
    .digest("hex");
  const jwt = signJWT(
    {
      access_key: KEYS.access,
      nonce: crypto.randomUUID(),
      query_hash: hash,
      query_hash_alg: "SHA512",
    },
    KEYS.secret
  );

  return fetchWithBackoff(
    BASE + path,
    {
      method,
      headers: {
        Authorization: `Bearer ${jwt}`,
        ...(normalized
          ? {
              "Content-Type":
                "application/x-www-form-urlencoded; charset=utf-8",
            }
          : {}),
      },
      body: normalized ? query : undefined,
    },
    buckets.exchange
  );
}

// ===== 주문 함수 =====
export async function placeMarketBuyKRW({ market, krw }) {
  const body = {
    market,
    side: "bid",
    ord_type: "price",
    price: String(Math.floor(krw)),
  };
  return httpPrivate("/orders", "POST", body);
}

export async function placeMarketSell({ market, volume }) {
  const body = {
    market,
    side: "ask",
    ord_type: "market",
    volume: String(volume),
  };
  return httpPrivate("/orders", "POST", body);
}

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

  return fetchWithBackoff(
    `${BASE}/orders/open${query ? `?${query}` : ""}`,
    {
      headers: { Authorization: `Bearer ${jwt}` },
    },
    buckets.exchange
  );
}

export const hasKeys = () => Boolean(KEYS.access && KEYS.secret);

export async function getAccounts() {
  if (!hasKeys()) throw new Error("API 키가 없습니다.");
  const jwt = signJWT(
    {
      access_key: KEYS.access,
      nonce: crypto.randomUUID(),
    },
    KEYS.secret
  );
  return fetchWithBackoff(
    `${BASE}/accounts`,
    {
      headers: { Authorization: `Bearer ${jwt}` },
    },
    buckets.exchange
  );
}

export async function getOrderDetail(uuid) {
  if (!hasKeys()) throw new Error("API 키가 없습니다.");
  if (!uuid) throw new Error("getOrderDetail: uuid 누락");
  const params = { uuid };
  const query = qsFrom(params);
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
  return fetchWithBackoff(
    `${BASE}/order?${query}`,
    {
      headers: { Authorization: `Bearer ${jwt}` },
    },
    buckets.exchange
  );
}

// --- WS snapshot + ultra wrappers ---
const snapshots = new Map();

export function ensureWS(market) {
  if (snapshots.has(market)) return snapshots.get(market);
  const snap = new MarketSnapshot();
  connectUpbitWS({
    codes: [market],
    onMessage: ({ type, payload, lagMs }) =>
      snap.update({ type, payload, lagMs }),
  });
  snapshots.set(market, snap);
  return snap;
}

async function withBackoff(fn) {
  const res = await fn();
  try {
    await maybeBackoffByHeader(res?.headers);
  } catch {}
  return res;
}

export async function orderbook(market) {
  const snap = ensureWS(market);
  if (snap.orderbook) return snap.orderbook;
  const res = await withBackoff(() => getOrderbook(market));
  return res;
}

export async function trades(market, count = 50) {
  const snap = ensureWS(market);
  if (snap.trade) return [snap.trade];
  const res = await withBackoff(() => getTrades(market, count));
  return res;
}

export async function placeOrder(params) {
  if (!params) throw new Error("missing params");
  const { market, side, price, volume, ord_type, krw } = params;
  if (ord_type === "limit")
    return withBackoff(() => placeLimitBuy({ market, price, volume }));
  if (ord_type === "price" || ord_type === "market" || krw) {
    if (side === "bid")
      return withBackoff(() =>
        placeMarketBuyKRW({ market, krw: krw ?? price })
      );
    if (side === "ask")
      return withBackoff(() => placeMarketSell({ market, volume }));
  }
  if (placeLimitBuy)
    return withBackoff(() => placeLimitBuy({ market, price, volume }));
  throw new Error("placeOrder: unsupported");
}

export async function getOrder(uuid) {
  try {
    const open = await withBackoff(() => getOpenOrders());
    return open.find((o) => o.uuid === uuid) ?? null;
  } catch (e) {
    return null;
  }
}

export async function cancelOrder(uuid) {
  // Cancel order via private DELETE /orders with body { uuid }
  if (!uuid) throw new Error("cancelOrder: missing uuid");
  return httpPrivate("/orders", "DELETE", { uuid });
}

export function getWsLagMs(market) {
  const snap = snapshots.get(market);
  return snap?.wsLagMs ?? null;
}
