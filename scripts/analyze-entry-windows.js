/**
 * 진입 조건 완성 시각(한국시간) 분포 분석기 — 레이트리밋 안전 버전
 * - 1분/5분 캔들만으로 ATR/RVOL/Trend/VWAP/p≥p* 재현
 * - OB(호가)는 과거 복원이 어려워 옵션으로 무시 가능(--ignore-ob=true 권장)
 * - 업비트 429 방지: RPS 스로틀 + 429/5xx 지수 백오프 + Retry-After 준수
 *
 * 사용 예:
 *   node scripts/analyze-entry-windows.js --days=14 --ignore-ob=true --rps=4
 * 환경변수(.env 가능):
 *   ANALYZE_DAYS=14
 *   ANALYZE_IGNORE_OB=true
 *   ANALYZE_RPS=4
 */

import fs from "fs";
import path from "path";

// ── 간단 .env 로더
(function loadEnv() {
  const p = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    if (!line || line.trim().startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    )
      v = v.slice(1, -1);
    if (!(k in process.env)) process.env[k] = v;
  }
})();

const getArg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] ?? "true" : null;
};
const num = (k, d) => Number(process.env[k] ?? d);

const MARKET = process.env.MARKET || "KRW-BTC";
const DAYS = Number(process.env.ANALYZE_DAYS ?? getArg("--days") ?? 14);
const IGN_OB =
  String(process.env.ANALYZE_IGNORE_OB ?? getArg("--ignore-ob") ?? "true") ===
  "true";
const RPS = Number(process.env.ANALYZE_RPS ?? getArg("--rps") ?? 4); // 보수적으로 4 rps 권장

// 봇과 동일 기본 파라미터
const CFG = {
  TP: num("TP", 0.006),
  SL: num("SL", 0.005),
  FEE: num("FEE", 0.001),
  SLIP: num("SLIP", 0.0005),
  ATR_PERIOD: num("ATR_PERIOD", 14),
  ATR_P_LO: num("ATR_P_LO", 0.4),
  ATR_P_HI: num("ATR_P_HI", 0.9),
  MIN_ATR_PCT: num("MIN_ATR_PCT", 0.08),
  RVOL_BASE_MIN: num("RVOL_BASE_MIN", 120),
  MIN_RVOL: num("MIN_RVOL", 1.5),
  TREND_EMA_FAST: num("TREND_EMA_FAST", 20),
  TREND_EMA_SLOW: num("TREND_EMA_SLOW", 50),
  REQUIRE_VWAP_ABOVE: (process.env.REQUIRE_VWAP_ABOVE ?? "true") === "true",
};

// ── 유틸
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const avg = (a) => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);
const sigmoid = (z) => 1 / (1 + Math.exp(-z));

// EMA(오래된→최근)
function ema(seriesOldToNew, period) {
  if (!seriesOldToNew.length) return NaN;
  const k = 2 / (period + 1);
  let prev = seriesOldToNew[0];
  for (let i = 1; i < seriesOldToNew.length; i++)
    prev = seriesOldToNew[i] * k + prev * (1 - k);
  return prev;
}
// VWAP(캔들 최신→과거, window분)
function vwap(cNewToOld, window = 120) {
  const arr = cNewToOld.slice(0, window);
  let pv = 0,
    vv = 0;
  for (const c of arr) {
    const tp = (c.h + c.l + c.c) / 3;
    const vol = Number(c.v) || 0;
    pv += tp * vol;
    vv += vol;
  }
  return vv > 0 ? pv / vv : NaN;
}
// ATR% 시퀀스(오래된→최근)
function atrPctSeries(cNewToOld, period = 14) {
  const out = [];
  for (let i = cNewToOld.length - 1; i > 0; i--) {
    const prevC = cNewToOld[i];
    const atrs = [];
    for (let j = 0; j < period && i - j - 1 >= 0; j++) {
      const cur = cNewToOld[i - j - 1];
      const nxt = cNewToOld[i - j];
      const tr = Math.max(
        cur.h - cur.l,
        Math.abs(cur.h - nxt.c),
        Math.abs(cur.l - nxt.c)
      );
      atrs.push((tr / cur.c) * 100);
    }
    if (atrs.length === period) out.push(avg(atrs));
  }
  return out;
}
function quantile(arr, q) {
  if (!arr.length) return NaN;
  const a = arr.slice().sort((x, y) => x - y);
  const p = (a.length - 1) * q;
  const b = Math.floor(p),
    r = p - b;
  if (b + 1 < a.length) return a[b] + r * (a[b + 1] - a[b]);
  return a[b];
}

// ── 업비트 공용 HTTP(스로틀+백오프)
const BASE = "https://api.upbit.com/v1";
const MIN_INTERVAL_MS = Math.ceil(1000 / Math.max(1, RPS));
let _lastFetchTs = 0;

async function throttledFetch(url, opts, attempt = 0) {
  // 스로틀
  const since = Date.now() - _lastFetchTs;
  if (since < MIN_INTERVAL_MS) await sleep(MIN_INTERVAL_MS - since);

  const res = await fetch(url, {
    headers: { accept: "application/json" },
    ...(opts || {}),
  });
  _lastFetchTs = Date.now();

  if (res.status === 429 || res.status >= 500) {
    // Retry-After 우선, 없으면 지수 백오프
    const ra = Number(res.headers.get("Retry-After"));
    const base = Number.isFinite(ra) ? ra * 1000 : 500 * Math.pow(1.8, attempt);
    const jitter = 100 + Math.random() * 200;
    const wait = Math.min(10_000, base + jitter);
    if (attempt < 8) {
      await sleep(wait);
      return throttledFetch(url, opts, attempt + 1);
    }
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${url} (retry exceeded): ${text}`);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${url}: ${text}`);
  }
  return res.json();
}

// 캔들 페이지네이션(최신→과거). 200개씩 안전하게 요청.
async function fetchCandles(unit, market, needed) {
  const out = [];
  let to = null;
  while (out.length < needed) {
    const remain = needed - out.length;
    const count = Math.min(200, remain);
    const url = new URL(`${BASE}/candles/minutes/${unit}`);
    url.searchParams.set("market", market);
    url.searchParams.set("count", String(count));
    if (to) url.searchParams.set("to", to);
    const rows = await throttledFetch(url.toString());
    if (!Array.isArray(rows) || rows.length === 0) break;

    out.push(
      ...rows.map((c) => ({
        o: +c.opening_price,
        h: +c.high_price,
        l: +c.low_price,
        c: +c.trade_price,
        v: +c.candle_acc_trade_volume,
        t: c.timestamp, // epoch ms (UTC)
      }))
    );

    // 다음 페이지를 위해 커서 갱신(직전 캔들보다 1ms 이전)
    const last = rows[rows.length - 1];
    to = new Date(last.timestamp - 1).toISOString();

    // 추가 완충 대기(429 예방). RPS와 별개로 페이지 사이 슬립.
    await sleep(Math.max(120, MIN_INTERVAL_MS));
  }
  return out;
}

// ── 메인
(async function run() {
  const need1m = DAYS * 24 * 60 + 300; // 여유 버퍼
  const need5m = Math.ceil(need1m / 5) + 50;

  // 동시 호출 대신 순차 호출(부하 반감)
  const c1m = await fetchCandles(1, MARKET, need1m);
  const c5m = await fetchCandles(5, MARKET, need5m);

  if (c1m.length < 400 || c5m.length < 200) throw new Error("캔들 부족");

  const hours = Array(24).fill(0);
  const dows = Array(7).fill(0);
  let prevPass = false;

  // ATR 분위수(최근 180분)
  const atrSeq = atrPctSeries(c1m, CFG.ATR_PERIOD); // 오래된→최근
  const atrLast180 = atrSeq.slice(-180);
  const lo = quantile(atrLast180, CFG.ATR_P_LO);
  const hi = quantile(atrLast180, CFG.ATR_P_HI);

  for (let i = 0; i < c1m.length - 300; i++) {
    // 분석 윈도우
    const win1m = c1m.slice(i, i + 200); // 최신 200개(최신→과거)
    const win5m = c5m.slice((i / 5) | 0, ((i / 5) | 0) + 200);

    const last = win1m[0].c;

    // ATR%
    const atrSeries = atrPctSeries(win1m, CFG.ATR_PERIOD);
    const atrPct = atrSeries.length ? atrSeries[atrSeries.length - 1] : NaN;
    const atrPass =
      Number.isFinite(atrPct) &&
      atrPct >= CFG.MIN_ATR_PCT &&
      atrPct >= lo &&
      atrPct <= hi;

    // RVOL
    const vols = win1m.map((c) => c.v);
    const rvol =
      avg(vols.slice(0, 5)) /
      Math.max(1e-9, avg(vols.slice(0, CFG.RVOL_BASE_MIN)));
    const rvolPass = rvol >= CFG.MIN_RVOL;

    // Trend(5m EMA) + VWAP(1m)
    const closes5 = win5m
      .map((x) => x.c)
      .slice()
      .reverse(); // 오래된→최근
    const emaFast = ema(closes5, CFG.TREND_EMA_FAST);
    const emaSlow = ema(closes5, CFG.TREND_EMA_SLOW);
    const trendPass =
      Number.isFinite(emaFast) && Number.isFinite(emaSlow) && emaFast > emaSlow;

    const vwapVal = vwap(win1m, 120);
    const aboveVWAP = Number.isFinite(vwapVal) ? last >= vwapVal : false;
    const trendGate = trendPass && (!CFG.REQUIRE_VWAP_ABOVE || aboveVWAP);

    // 간이 시그널 → p
    const closes = win1m.map((c) => c.c).slice(0, 60);
    const diffs = [];
    for (let k = 1; k < closes.length; k++)
      diffs.push(closes[k - 1] - closes[k]);
    const gains = diffs.filter((x) => x > 0).reduce((a, b) => a + b, 0) / 14;
    const losses =
      Math.abs(diffs.filter((x) => x < 0).reduce((a, b) => a + b, 0)) / 14;
    const rs = losses === 0 ? 100 : gains / Math.max(1e-9, losses);
    const rsi = 100 - 100 / (1 + rs);

    const rsiScore = clamp((rsi - 45) / 20, 0, 1);
    const volScore = clamp((rvol - CFG.MIN_RVOL) / (2.5 - CFG.MIN_RVOL), 0, 1);
    const candleScore = Number.isFinite(atrPct)
      ? clamp((atrPct - 0.1) / 0.3, 0, 1)
      : 0;
    const obScore = IGN_OB ? 1 : 0.5;

    const z =
      1.2 * rsiScore + 1.0 * volScore + 1.1 * obScore + 0.9 * candleScore - 2.0;
    const p = sigmoid(z);
    const pStar = (CFG.SL + CFG.FEE + CFG.SLIP) / (CFG.TP + CFG.SL);

    const pass =
      atrPass &&
      rvolPass &&
      trendGate &&
      p >= pStar &&
      (IGN_OB || obScore >= 0.7);

    // 직전 미충족 → 이번 충족 시점 기록
    if (!prevPass && pass) {
      const tsUTC = win1m[0].t;
      const tsKST = new Date(tsUTC + 9 * 3600 * 1000);
      const hr = tsKST.getUTCHours();
      const dow = tsKST.getUTCDay(); // 0=일
      hours[hr]++;
      dows[dow]++;
    }
    prevPass = pass;
  }

  // 출력
  const total = hours.reduce((s, x) => s + x, 0) || 1;
  const bar = (n, m) => "█".repeat(Math.round((n / Math.max(1, m)) * 30)) || "";
  const maxH = Math.max(...hours, 1);

  console.log(
    "\n══════════════════════════════════════════════════════════════════════════════"
  );
  console.log(
    `📊 조건 "최초 완성" 시간대 분포 (KST, 최근 ${DAYS}일, OB ${
      IGN_OB ? "무시" : "포함"
    })  [${MARKET}]`
  );
  console.log(
    "──────────────────────────────────────────────────────────────────────────────"
  );

  for (let h = 0; h < 24; h++) {
    const n = hours[h];
    const pct = ((n / total) * 100).toFixed(1).padStart(5, " ");
    console.log(
      `${String(h).padStart(2, "0")}:00  ${pct}%  ${bar(n, maxH)}  (${n})`
    );
  }

  const maxD = Math.max(...dows, 1);
  const totD = dows.reduce((s, x) => s + x, 0) || 1;
  console.log("\n🗓 요일 분포 (0=일,6=토):");
  console.log(
    dows
      .map(
        (n, i) =>
          `${i}:${((n / totD) * 100).toFixed(1)}% ${bar(n, maxD)} (${n})`
      )
      .join("\n")
  );

  const ranked = hours
    .map((n, h) => ({ h, n }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 3);
  console.log(
    "\n🏆 상위 시간대(KST): " +
      ranked.map((r) => `${String(r.h).padStart(2, "0")}:00`).join(", ")
  );
  console.log(
    "══════════════════════════════════════════════════════════════════════════════\n"
  );
})().catch((e) => {
  console.error("분석 실패:", e?.message || e);
  process.exit(1);
});
