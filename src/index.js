// src/index.js
// 메인 루프: 승률 우선 전략 + 캔들 캐싱 최적화

import { CFG } from "./config/index.js";
import * as Upbit from "./api/upbitAdapter.js";
import { atrPercent, atrSeriesPercent, atrBandGate } from "./indicators/atr.js";
import { ema } from "./indicators/ema.js";
import { vwap } from "./indicators/vwap.js";
import { analyzeOrderbook } from "./market/orderbook.js";
import { clamp, nowKSTString } from "./util/math.js";
import { buildSignal, shouldEnter } from "./strategy/realScalping.js";
import {
  checkHighWinRateEntry,
  checkTradingHours,
  checkConsecutiveLosses,
  checkDailyLimits,
} from "./strategy/highWinRateEntry.js";
import { Risk } from "./risk/riskManager.js";
import { Executor } from "./executor/executor.js";
import { renderDashboard, initTTY } from "./monitor/dashboard.js";
import { readExits } from "./monitor/tradeLog.js";

process.on("uncaughtException", (e) =>
  console.error(`❌ Uncaught: ${e?.message}`)
);
process.on("unhandledRejection", (e) =>
  console.error(`❌ UnhandledRejection: ${e}`)
);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 캔들 캐싱 변수 (API 호출 99% 감소)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
let candles1mCache = null;
let candles5mCache = null;
let lastCandle1mUpdate = 0;
let lastCandle5mUpdate = 0;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 일일 거래 건수 추적 (목표: 10~15건)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
let todayTradeCount = 0;
// 업비트(한국) 기준 일자(KST)로 리셋되도록 날짜 키를 KST로 계산
const kstDateKey = () =>
  new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);

let lastResetDate = kstDateKey(); // YYYY-MM-DD (KST)

function resetDailyCounter() {
  const currentDate = kstDateKey();
  if (currentDate !== lastResetDate) {
    console.log(`\n🔄 일일 카운터 리셋: ${lastResetDate} → ${currentDate}`);
    console.log(`   어제 거래: ${todayTradeCount}건\n`);
    todayTradeCount = 0;
    lastResetDate = currentDate;
  }
}

async function main() {
  initTTY();
  const risk = new Risk(CFG.risk);
  const exe = new Executor(risk);
  await exe.refreshBalance(true, CFG.run.market);

  // 모드/키/잔고 진단 로그 (1회)
  console.log(
    `\n🔎 MODE: CFG.run.paper=${
      CFG.run.paper
    } | hasKeys=${Upbit.hasKeys()} | exe.paperMode()=${exe.paperMode()} | exe.krw=${
      exe.krw
    }\n`
  );

  // WebSocket 연결 시작
  const snap = Upbit.ensureWS(CFG.run.market);

  console.log("━".repeat(80));
  console.log("🚀 업비트 스캘핑 봇 시작");
  console.log(
    `📊 목표 거래: ${CFG.run.targetTradesMin}~${CFG.run.targetTradesMax}건/일`
  );
  console.log(`💰 목표 수익: 0.8%+ / 일`);
  console.log(`⚡ WebSocket: 활성화`);
  console.log(`📦 캔들 캐싱: 활성화 (API 99% 절감)`);
  console.log("━".repeat(80) + "\n");

  while (true) {
    const t0 = Date.now();
    try {
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      // 일일 카운터 리셋 체크
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      resetDailyCounter();

      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      // 데이터 수집 (WebSocket + 스마트 캐싱)
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      const now = Date.now();

      // 호가창: WebSocket 우선, fallback REST API
      const ob = snap.orderbook ?? (await Upbit.getOrderbook(CFG.run.market));

      // 체결가: WebSocket 우선, fallback REST API
      const trades = snap.trade
        ? [snap.trade]
        : await Upbit.getTrades(CFG.run.market, 60);

      // 1분 캔들: 1분마다만 갱신 (60초 캐싱)
      if (now - lastCandle1mUpdate > 60000 || !candles1mCache) {
        candles1mCache = await Upbit.getMinuteCandles(1, CFG.run.market, 240);
        lastCandle1mUpdate = now;
      }
      const candles1m = candles1mCache;

      // 5분 캔들: 5분마다만 갱신 (300초 캐싱)
      if (now - lastCandle5mUpdate > 300000 || !candles5mCache) {
        candles5mCache = await Upbit.getMinuteCandles(5, CFG.run.market, 240);
        lastCandle5mUpdate = now;
      }
      const candles5m = candles5mCache;

      const last =
        Number(trades?.[0]?.trade_price) || Number(candles1m?.[0]?.c);
      if (!Number.isFinite(last)) throw new Error("가격 수신 실패");

      await exe.refreshBalance(false, CFG.run.market);
      exe.reconcileExposure(last, CFG.run.market);

      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      // 지표 계산
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      const atrPct = atrPercent(candles1m, CFG.strat.ATR_PERIOD);
      const atrHist = atrSeriesPercent(candles1m, CFG.strat.ATR_PERIOD, 180);
      const band = atrBandGate(
        atrPct,
        atrHist,
        CFG.strat.ATR_P_LO,
        CFG.strat.ATR_P_HI,
        CFG.strat.MIN_ATR_PCT
      );

      const obm = analyzeOrderbook(ob, 10);

      const vols = candles1m.map((c) => c.v);
      const avg = (a) => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);
      const rvol =
        avg(vols.slice(0, 5)) /
        Math.max(1e-9, avg(vols.slice(0, CFG.strat.RVOL_BASE_MIN)));

      // 추세: 5분 EMA
      const closes5 = candles5m
        .map((c) => c.c)
        .slice()
        .reverse();
      const emaFast = ema(closes5, CFG.strat.TREND_EMA_FAST);
      const emaSlow = ema(closes5, CFG.strat.TREND_EMA_SLOW);
      const trendPass =
        Number.isFinite(emaFast) &&
        Number.isFinite(emaSlow) &&
        emaFast > emaSlow;

      // VWAP
      const vwapVal = vwap(candles1m, 120);
      const aboveVWAP = Number.isFinite(vwapVal) ? last >= vwapVal : false;

      // RSI
      const closes = candles1m.map((c) => c.c).slice(0, 60);
      const diffs = [];
      for (let i = 1; i < closes.length; i++)
        diffs.push(closes[i - 1] - closes[i]);
      const gains = diffs.filter((x) => x > 0).reduce((a, b) => a + b, 0) / 14;
      const losses =
        Math.abs(diffs.filter((x) => x < 0).reduce((a, b) => a + b, 0)) / 14;
      const rs = losses === 0 ? 100 : gains / Math.max(1e-9, losses);
      const rsi = 100 - 100 / (1 + rs);

      // 스코어
      const rsiScore = clamp((rsi - 45) / 20, 0, 1);
      let volScore;
      if (rvol >= 1.9) volScore = 1;
      else if (rvol >= 1.6)
        volScore = 0.7 + clamp((rvol - 1.6) / 0.3, 0, 1) * 0.3;
      else if (rvol >= 1.3)
        volScore = 0.4 + clamp((rvol - 1.3) / 0.3, 0, 1) * 0.3;
      else volScore = clamp((rvol - 1.0) / 0.3, 0, 1) * 0.4;

      const obScore = clamp(
        obm.bestBidShare >= 0.6 &&
          obm.imbalance >= CFG.strat.MIN_IMB &&
          obm.spreadTicks <= CFG.strat.MAX_SPREAD_TICKS
          ? 1
          : 0.2 +
              0.6 *
                clamp((obm.imbalance - CFG.strat.MIN_IMB + 0.05) / 0.4, 0, 1),
        0,
        1
      );

      const candleScore = Number.isFinite(atrPct)
        ? clamp((atrPct - 0.1) / 0.3, 0, 1)
        : 0;

      const probRaw = buildSignal({
        rsi: rsiScore,
        vol: volScore,
        ob: obScore,
        candle: candleScore,
      });

      const dec = shouldEnter(probRaw, null);

      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      // 포지션 관리 (기존 포지션 먼저 처리)
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      if (exe.position) {
        exe.updateStops(last);
        const exit1 = await exe.maybeExitByPrice(last);
        if (!exit1) {
          await exe.maybeExitByTime(Date.now(), last);
        }
      }

      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      // 진입 체크 (승률 우선 + 거래 건수 제어)
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      let canEnterNow = false;
      let blockReason = null;
      const hasExposure = exe.hasOpenExposure();

      if (!hasExposure) {
        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        // 일일 거래 건수 제한 체크 (최우선)
        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        if (todayTradeCount >= CFG.run.targetTradesMax) {
          blockReason = `일일 목표 달성 (${todayTradeCount}/${CFG.run.targetTradesMax}건)`;
        } else {
          // 거래 로그 분석
          const { exits: allExits } = readExits();
          const recentExits = allExits.slice(-10);
          const nowStr = nowKSTString();
          const todayKey = nowStr.slice(0, 10);
          const todayExits = allExits.filter(
            (e) => typeof e.ts === "string" && e.ts.slice(0, 10) === todayKey
          );

          // ✅ 저빈도 운용용: 진입 간 최소 간격(손실 여부 무관)
          const minGapMin = Number(CFG.limits.MIN_ENTRY_GAP_MINUTES) || 0;
          if (minGapMin > 0 && recentExits.length) {
            const lastExit = recentExits[recentExits.length - 1];
            const lastExitTs = Number(lastExit.exitTs ?? lastExit.tsEpoch) || 0;
            const elapsedMs = Date.now() - lastExitTs;
            const minGapMs = minGapMin * 60 * 1000;
            if (lastExitTs > 0 && elapsedMs < minGapMs) {
              const remainMin = Math.ceil((minGapMs - elapsedMs) / 60000);
              blockReason = `최소 진입 간격 대기: ${remainMin}분 남음`;
            }
          }

          // 시간대/연속손실/일일제한 체크
          const timeCheck = checkTradingHours();
          const consecCheck = checkConsecutiveLosses(recentExits);
          const equityKRW = exe.accountSnapshot(last)?.equityKRW;
          const dailyCheck = checkDailyLimits(todayExits, equityKRW);

          if (blockReason) {
            // MIN_ENTRY_GAP_MINUTES 에 의해 이미 차단됨
          } else if (!timeCheck.pass) {
            blockReason = timeCheck.reason;
          } else if (!consecCheck.pass) {
            blockReason = consecCheck.reason;
          } else if (!dailyCheck.pass) {
            blockReason = dailyCheck.reason;
          } else {
            // 승률 우선 진입 조건 종합 체크
            const entryCheck = checkHighWinRateEntry({
              currentPrice: last,
              emaFast,
              emaSlow,
              vwap: vwapVal,
              atrPct,
              atrLo: band.lo,
              atrHi: band.hi,
              rvol,
              orderbook: obm,
              rsi,
              candles1m,
              probability: probRaw,
              pStar: dec.pStar,
            });

            if (entryCheck.pass) {
              canEnterNow = true;
            } else {
              blockReason = entryCheck.reason;
            }
          }
        }
      }

      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      // 진입 실행
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      if (canEnterNow) {
        const entryCtx = {
          atrPct,
          atrLo: band.lo,
          atrHi: band.hi,
          rvol,
          rsi,
          prob: probRaw,
          pStar: dec.pStar,
          emaFast,
          emaSlow,
          vwap: vwapVal,
          aboveVWAP,
          imbalance: obm.imbalance,
          spreadTicks: obm.spreadTicks,
          bestBidShare: obm.bestBidShare,
          price: last,
        };

        const entryResult = await exe.enterLong({
          price: last,
          atrPct,
          context: entryCtx,
        });

        // 진입 성공 시 카운터 증가
        if (entryResult?.ok) {
          todayTradeCount++;
          console.log(
            `\n✅ 진입 성공! 오늘 ${todayTradeCount}/${CFG.run.targetTradesMax}건째 거래\n`
          );
        }
      }

      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      // 성과/로그
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      const { exits, stats } = readExits();
      const nowStr = nowKSTString();
      const todayKey = nowStr.slice(0, 10);
      const todayExits = exits.filter(
        (e) => typeof e.ts === "string" && e.ts.slice(0, 10) === todayKey
      );
      const daily = {
        trades: todayExits.length,
        wins: todayExits.filter((e) => Number(e.pnlKRW) > 0).length,
        losses: todayExits.filter((e) => Number(e.pnlKRW) <= 0).length,
        pnl: todayExits.reduce((s, e) => s + Number(e.pnlKRW || 0), 0),
      };

      const lastTrades = exits.slice(-10);
      const sysLog = [];
      if (exe.lastError) {
        sysLog.push({ ts: exe.lastError.ts, msg: exe.lastError.message });
      }

      // WebSocket 지연 시간 경고
      if (snap.wsLagMs > 100) {
        sysLog.push({
          ts: nowStr,
          msg: `⚠️ WebSocket 지연: ${snap.wsLagMs}ms`,
        });
      }

      const pnlKRW = exe.position
        ? (last - exe.position.entry) * exe.position.size
        : 0;
      const pnlPct =
        exe.position && exe.position.entry
          ? ((last - exe.position.entry) / exe.position.entry) * 100
          : 0;
      const unrealized = { pnlKRW, pnlPct };
      const aliveSec = exe.position
        ? Math.floor((Date.now() - exe.position.entryTs) / 1000)
        : 0;

      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      // 대시보드 렌더링
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      const account = exe.accountSnapshot(last);

      renderDashboard({
        time: nowStr,
        market: CFG.run.market,
        mode: exe.paperMode() ? "PAPER" : "LIVE",
        price: last,
        account,

        trend: {
          pass: trendPass,
          emaFast,
          emaSlow,
          vwap: vwapVal,
          aboveVWAP,
        },

        atrPct,
        atrLo: band.lo,
        atrHi: band.hi,
        atrPass: band.pass,

        rvol,
        rvolMin: CFG.strat.MIN_RVOL,

        obm,

        filters: {
          atr: band.pass,
          rvol: rvol >= CFG.strat.MIN_RVOL,
          spread: obm.spreadTicks <= CFG.strat.MAX_SPREAD_TICKS,
        },

        p: probRaw,
        pStar: dec.pStar,
        canEnter: canEnterNow,
        blockReason,

        position: exe.position,
        unrealized,
        aliveSec,
        timeoutSec: CFG.strat.TIMEOUT_SEC,

        lastTrades,
        stats,
        daily,

        // 거래 건수 정보 추가
        todayTradeCount,
        targetTradesMin: CFG.run.targetTradesMin,
        targetTradesMax: CFG.run.targetTradesMax,

        systemLog: sysLog,
        wsLag: snap.wsLagMs, // WebSocket 지연 시간
      });

      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      // 슬립
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      const dt = Date.now() - t0;
      await new Promise((r) =>
        setTimeout(r, Math.max(0, CFG.run.intervalMs - dt))
      );
    } catch (e) {
      const account = exe.accountSnapshot(exe.position?.entry ?? 0);

      renderDashboard({
        time: nowKSTString(),
        market: CFG.run.market,
        mode: exe.paperMode() ? "PAPER" : "LIVE",
        price: 0,
        account,
        trend: {
          pass: false,
          emaFast: 0,
          emaSlow: 0,
          vwap: NaN,
          aboveVWAP: false,
        },
        atrPct: NaN,
        atrLo: NaN,
        atrHi: NaN,
        atrPass: false,
        rvol: 0,
        rvolMin: CFG.strat.MIN_RVOL,
        obm: { imbalance: 0, spreadTicks: 0, bid1: 0, ask1: 0 },
        filters: { atr: false, rvol: false, spread: false },
        p: 0,
        pStar: 0,
        canEnter: false,
        blockReason: `루프 오류: ${e?.message}`,
        position: null,
        unrealized: { pnlKRW: 0, pnlPct: 0 },
        aliveSec: 0,
        timeoutSec: CFG.strat.TIMEOUT_SEC,
        lastTrades: [],
        stats: { wins: 0, losses: 0, winrate: 0, pnl: 0, trades: 0 },
        daily: null,
        todayTradeCount,
        targetTradesMin: CFG.run.targetTradesMin,
        targetTradesMax: CFG.run.targetTradesMax,
        systemLog: [{ ts: nowKSTString(), msg: e?.stack ?? String(e) }],
        wsLag: 0,
      });
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

main();
