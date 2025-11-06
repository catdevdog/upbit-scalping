// 메인 루프: 추세 필터 + 본절/트레일링/타임아웃 적용

import { CFG } from "./config/index.js";
import * as Upbit from "./api/upbitAdapter.js";
import { atrPercent, atrSeriesPercent, atrBandGate } from "./indicators/atr.js";
import { ema } from "./indicators/ema.js";
import { vwap } from "./indicators/vwap.js";
import { analyzeOrderbook } from "./market/orderbook.js";
import { clamp, nowKSTString } from "./util/math.js";
import { buildSignal, shouldEnter } from "./strategy/realScalping.js";
import { Risk } from "./risk/riskManager.js";
import { Executor } from "./executor/executor.js";
import { renderDashboard, initTTY } from "./monitor/logger.js";
import { readExits } from "./monitor/tradeLog.js";

process.on("uncaughtException", (e) =>
  console.error(`❌ Uncaught: ${e?.message}`)
);
process.on("unhandledRejection", (e) =>
  console.error(`❌ UnhandledRejection: ${e}`)
);

async function main() {
  initTTY(); // ← 최초 1회
  const risk = new Risk();
  const exe = new Executor(risk);

  while (true) {
    const t0 = Date.now();
    try {
      // 데이터
      const [ob, trades, candles1m, candles5m] = await Promise.all([
        Upbit.getOrderbook(CFG.run.market),
        Upbit.getTrades(CFG.run.market, 60),
        Upbit.getMinuteCandles(1, CFG.run.market, 240),
        Upbit.getMinuteCandles(5, CFG.run.market, 240),
      ]);
      const last =
        Number(trades?.[0]?.trade_price) || Number(candles1m?.[0]?.c);
      if (!Number.isFinite(last)) throw new Error("가격 수신 실패");

      // 지표: ATR(1m), RVOL(1m)
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

      // RSI 간단
      const closes = candles1m.map((c) => c.c).slice(0, 60);
      const diffs = [];
      for (let i = 1; i < closes.length; i++)
        diffs.push(closes[i - 1] - closes[i]);
      const gains = diffs.filter((x) => x > 0).reduce((a, b) => a + b, 0) / 14;
      const losses =
        Math.abs(diffs.filter((x) => x < 0).reduce((a, b) => a + b, 0)) / 14;
      const rs = losses === 0 ? 100 : gains / Math.max(1e-9, losses);
      const rsi = 100 - 100 / (1 + rs);

      // === 상위 추세 필터 ===
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

      const vwapVal = vwap(candles1m, 120); // 최근 120분
      const aboveVWAP = Number.isFinite(vwapVal) ? last >= vwapVal : false;

      // 스코어
      const rsiScore = clamp((rsi - 45) / 20, 0, 1);
      const volScore = clamp(
        (rvol - CFG.strat.MIN_RVOL) / (2.5 - CFG.strat.MIN_RVOL),
        0,
        1
      );
      const obScore = clamp(
        obm.bestBidShare >= 0.6 &&
          obm.imbalance >= CFG.strat.MIN_IMB &&
          obm.spreadTicks <= CFG.strat.MAX_SPREAD_TICKS
          ? 1
          : 0.2 + 0.6 * clamp((obm.imbalance - 0.1) / 0.4, 0, 1),
        0,
        1
      );
      const candleScore = Number.isFinite(atrPct)
        ? clamp((atrPct - 0.1) / 0.3, 0, 1)
        : 0;

      // 의사결정
      const p = buildSignal({
        rsi: rsiScore,
        vol: volScore,
        ob: obScore,
        candle: candleScore,
      });
      const dec = shouldEnter(band.pass ? p : 0, {
        TP: CFG.strat.TP,
        SL: CFG.strat.SL,
        FEE: CFG.strat.FEE,
        SLIP: CFG.strat.SLIP,
      });

      const trendGate =
        trendPass && (!CFG.strat.REQUIRE_VWAP_ABOVE || aboveVWAP);
      const canEnterNow = !exe.position && band.pass && dec.pass && trendGate;

      // 포지션 관리: 본절/트레일링 → 가격 청산 → 시간 청산
      if (exe.position) {
        exe.updateStops(last);
        const exit1 = exe.maybeExitByPrice(last);
        if (!exit1) {
          exe.maybeExitByTime(Date.now(), last);
        }
      }

      if (canEnterNow) {
        await exe.enterLong({ price: last, atrPct });
      }

      // 부족/남은 값
      const deficits = [];
      if (!trendPass)
        deficits.push(
          `추세 부족: EMA${CFG.strat.TREND_EMA_FAST} ≤ EMA${
            CFG.strat.TREND_EMA_SLOW
          } (${Math.round(emaFast)} ≤ ${Math.round(emaSlow)})`
        );
      if (
        CFG.strat.REQUIRE_VWAP_ABOVE &&
        !aboveVWAP &&
        Number.isFinite(vwapVal)
      ) {
        const gap = ((vwapVal - last) / vwapVal) * 100;
        deficits.push(
          `VWAP 아래: 현재 ${last.toLocaleString()} < VWAP ${Math.round(
            vwapVal
          ).toLocaleString()} (격차 ${gap.toFixed(2)}%)`
        );
      }
      if (
        !band.pass &&
        Number.isFinite(atrPct) &&
        Number.isFinite(band.lo) &&
        Number.isFinite(band.hi)
      ) {
        if (atrPct < band.lo)
          deficits.push(
            `ATR 부족: 현재 ${atrPct.toFixed(3)}% → 최소 ${band.lo.toFixed(
              3
            )}% (＋${(band.lo - atrPct).toFixed(3)}%)`
          );
        if (atrPct > band.hi)
          deficits.push(
            `ATR 과열: 현재 ${atrPct.toFixed(3)}% → 최대 ${band.hi.toFixed(
              3
            )}% (－${(atrPct - band.hi).toFixed(3)}%)`
          );
      }
      if (rvol < CFG.strat.MIN_RVOL)
        deficits.push(
          `거래량 부족: 현재 ${rvol.toFixed(
            2
          )}x → 최소 ${CFG.strat.MIN_RVOL.toFixed(2)}x (＋${(
            CFG.strat.MIN_RVOL - rvol
          ).toFixed(2)}x)`
        );
      if (obm.spreadTicks > CFG.strat.MAX_SPREAD_TICKS)
        deficits.push(
          `스프레드 과대: 현재 ${obm.spreadTicks}틱 → 최대 ${
            CFG.strat.MAX_SPREAD_TICKS
          }틱 (－${obm.spreadTicks - CFG.strat.MAX_SPREAD_TICKS}틱)`
        );
      if (!(band.pass && dec.pass)) {
        const need = Math.max(0, (dec.pStar - p) * 100);
        if (need > 0)
          deficits.push(
            `확률 부족: 현재 ${(p * 100).toFixed(1)}% → 최소 ${(
              dec.pStar * 100
            ).toFixed(1)}% (＋${need.toFixed(1)}%)`
          );
      }

      // 승률/최근 체결
      const { exits, stats } = readExits();
      const lastTrades = exits.slice(-10);

      // 미실현손익·보유시간
      const unrealized = exe.position
        ? { pnlKRW: (last - exe.position.entry) * exe.position.size }
        : { pnlKRW: 0 };
      const aliveSec = exe.position
        ? Math.floor((Date.now() - exe.position.entryTs) / 1000)
        : 0;

      // 대시보드
      renderDashboard({
        title: "업비트 스캘핑 Bot v2.2",
        time: nowKSTString(),
        market: CFG.run.market,
        mode: CFG.run.paper ? "PAPER" : "LIVE",
        price: last,

        // Trend/VWAP
        trend: {
          pass: trendGate,
          emaFast,
          emaSlow,
          fastP: CFG.strat.TREND_EMA_FAST,
          slowP: CFG.strat.TREND_EMA_SLOW,
          vwap: vwapVal,
          aboveVWAP,
        },

        // 지표/스코어
        atrPct,
        atrLo: band.lo,
        atrHi: band.hi,
        atrPass: band.pass,
        rvol,
        rvolMin: CFG.strat.MIN_RVOL,
        obm,
        scores: {
          rsi: rsiScore,
          vol: volScore,
          ob: obScore,
          candle: candleScore,
        },

        // 의사결정
        p,
        pStar: dec.pStar,
        canEnter: canEnterNow,

        // 포지션·성과
        position: exe.position,
        unrealized,
        aliveSec,
        timeoutSec: CFG.strat.TIMEOUT_SEC,

        // 체결/통계/부족치
        lastTrades,
        stats,
        deficits,
        showGlossary: CFG.ui.showGlossary,
      });

      // 슬립
      const dt = Date.now() - t0;
      await new Promise((r) =>
        setTimeout(r, Math.max(0, CFG.run.intervalMs - dt))
      );
    } catch (e) {
      renderDashboard({
        title: "업비트 스캘핑 Bot v2.2",
        time: nowKSTString(),
        market: CFG.run.market,
        mode: CFG.run.paper ? "PAPER" : "LIVE",
        price: 0,
        trend: {
          pass: false,
          emaFast: 0,
          emaSlow: 0,
          fastP: CFG.strat.TREND_EMA_FAST,
          slowP: CFG.strat.TREND_EMA_SLOW,
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
        scores: { rsi: 0, vol: 0, ob: 0, candle: 0 },
        p: 0,
        pStar: 0,
        canEnter: false,
        position: null,
        unrealized: { pnlKRW: 0 },
        aliveSec: 0,
        timeoutSec: CFG.strat.TIMEOUT_SEC,
        lastTrades: [],
        stats: { wins: 0, losses: 0, winrate: 0, pnl: 0, trades: 0 },
        deficits: [`루프 오류: ${e?.message}`],
        showGlossary: CFG.ui.showGlossary,
      });
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

main();
