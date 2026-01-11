// src/index.js
// 메인 루프: 승률 우선 전략

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

async function main() {
  initTTY();
  const risk = new Risk();
  const exe = new Executor(risk);
  await exe.refreshBalance(true, CFG.run.market);

  const snap = Upbit.ensureWS(CFG.run.market);

  while (true) {
    const t0 = Date.now();
    try {
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      // 데이터 수집
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      const ob = snap.orderbook ?? (await Upbit.getOrderbook(CFG.run.market));
      const trades = snap.trade
        ? [snap.trade]
        : await Upbit.getTrades(CFG.run.market, 60);
      const candles1m = await Upbit.getMinuteCandles(1, CFG.run.market, 240);
      const candles5m = await Upbit.getMinuteCandles(5, CFG.run.market, 240);

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
        .reverse(); // oldest→newest
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

      const dec = shouldEnter(probRaw, null); // pStar는 DERIVED 사용

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
      // 진입 체크 (승률 우선)
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      let canEnterNow = false;
      let blockReason = null;
      const hasExposure = exe.hasOpenExposure();

      if (!hasExposure) {
        // 거래 로그 분석
        const { exits: allExits } = readExits();
        const recentExits = allExits.slice(-10);
        const nowStr = nowKSTString();
        const todayKey = nowStr.slice(0, 10);
        const todayExits = allExits.filter(
          (e) => typeof e.ts === "string" && e.ts.slice(0, 10) === todayKey
        );

        // 시간대/연속손실/일일제한 체크
        const timeCheck = checkTradingHours();
        const consecCheck = checkConsecutiveLosses(recentExits);
        const dailyCheck = checkDailyLimits(todayExits);

        if (!timeCheck.pass) {
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

        await exe.enterLong({
          price: last,
          atrPct,
          context: entryCtx,
        });
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
        mode: CFG.run.paper ? "PAPER" : "LIVE",
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

        systemLog: sysLog,
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
        mode: CFG.run.paper ? "PAPER" : "LIVE",
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
        systemLog: [{ ts: nowKSTString(), msg: e?.stack ?? String(e) }],
      });
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

main();
