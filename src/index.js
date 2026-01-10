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
import { deriveWinBiasTargets } from "./core/winBiasOptimizer.js";

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
  await exe.refreshBalance(true, CFG.run.market);
  const gateStats = {
    attempts: 0,
    gatingPass: 0,
    entries: 0,
    atrFail: 0,
    rvolFail: 0,
    spreadFail: 0,
    probFail: 0,
    trendFail: 0,
    momentumUsed: 0,
  };

  const snap = Upbit.ensureWS(CFG.run.market);
  let lastWinBias = null;
  while (true) {
    const t0 = Date.now();
    try {
      // 데이터: WS 스냅샷 우선 사용 (ultra loop)
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
      const winBias = deriveWinBiasTargets({
        atrPct,
        rvol,
        spreadTicks: obm.spreadTicks,
        imbalance: obm.imbalance,
        feePct: CFG.strat.FEE,
        slipPct: CFG.strat.SLIP,
        base: {
          minRvol: CFG.strat.MIN_RVOL,
          maxSpreadTicks: CFG.strat.MAX_SPREAD_TICKS,
          minImb: CFG.strat.MIN_IMB,
          stallSec: CFG.strat.STALL_SEC,
          timeoutSec: CFG.strat.TIMEOUT_SEC,
        },
      });
      lastWinBias = winBias;
      const dynRvolMin = winBias.minRvol ?? CFG.strat.MIN_RVOL;
      const dynSpreadTicks =
        winBias.maxSpreadTicks ?? CFG.strat.MAX_SPREAD_TICKS;
      const dynMinImb = winBias.minImb ?? CFG.strat.MIN_IMB;

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

      const closeNow = Number(candles1m?.[0]?.c);
      const closePrev = Number(candles1m?.[1]?.c);
      const closePrev3 = Number(candles1m?.[3]?.c);
      const priceDelta1 =
        Number.isFinite(closeNow) && Number.isFinite(closePrev) && closePrev > 0
          ? (closeNow - closePrev) / closePrev
          : 0;
      const momentumSlope =
        Number.isFinite(closeNow) &&
        Number.isFinite(closePrev3) &&
        closePrev3 > 0
          ? (closeNow - closePrev3) / closePrev3
          : 0;
      const atrTightMin = Math.max(CFG.strat.MIN_ATR_PCT + 0.015, 0.05);
      const atrTightPass = Number.isFinite(atrPct) && atrPct >= atrTightMin;
      const rsiStrong = Number.isFinite(rsi) && rsi >= 60;
      const fastMomentum = priceDelta1 >= 0.001 || momentumSlope >= 0.0015;
      const risingAcceleration =
        fastMomentum && priceDelta1 >= momentumSlope * 0.7;
      const lossMomentum =
        Number.isFinite(momentumSlope) && Number.isFinite(priceDelta1)
          ? momentumSlope <= priceDelta1 * 0.3
          : false;

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
      let volScore;
      if (rvol >= 1.9) volScore = 1;
      else if (rvol >= 1.6)
        volScore = 0.7 + clamp((rvol - 1.6) / 0.3, 0, 1) * 0.3;
      else if (rvol >= 1.3)
        volScore = 0.4 + clamp((rvol - 1.3) / 0.3, 0, 1) * 0.3;
      else volScore = clamp((rvol - 1.0) / 0.3, 0, 1) * 0.4;
      const obScore = clamp(
        obm.bestBidShare >= 0.6 &&
          obm.imbalance >= dynMinImb &&
          obm.spreadTicks <= dynSpreadTicks
          ? 1
          : 0.2 + 0.6 * clamp((obm.imbalance - dynMinImb + 0.05) / 0.4, 0, 1),
        0,
        1
      );
      const candleScore = Number.isFinite(atrPct)
        ? clamp((atrPct - 0.1) / 0.3, 0, 1)
        : 0;

      // 의사결정
      const probRaw = buildSignal({
        rsi: rsiScore,
        vol: volScore,
        ob: obScore,
        candle: candleScore,
      });
      const rvolPass = rvol >= dynRvolMin;
      const spreadPass = obm.spreadTicks <= dynSpreadTicks;
      const gatingPass = band.pass && rvolPass && spreadPass;
      const dec = shouldEnter(gatingPass ? probRaw : 0, winBias.pRequired);

      const trendGate =
        trendPass && (!CFG.strat.REQUIRE_VWAP_ABOVE || aboveVWAP);
      const hasExposure = exe.hasOpenExposure();
      const evaluatingEntry = !hasExposure;
      const probBuffer = Math.min(0.98, dec.pStar + 0.05);
      const momentumProb = Math.min(0.98, dec.pStar + 0.02);
      const momentumStrong =
        obScore >= 0.9 &&
        rvol >= dynRvolMin + 0.3 &&
        atrTightPass &&
        (rsiStrong || fastMomentum) &&
        risingAcceleration &&
        momentumSlope >= 0.0015;
      const trendStrengthPass =
        trendGate &&
        !lossMomentum &&
        (fastMomentum || risingAcceleration || momentumSlope >= 0.0012);
      const momentumOverride =
        !trendGate && gatingPass && momentumStrong && probRaw >= momentumProb;
      const passesTrendOrMomentum = trendStrengthPass || momentumOverride;
      const trendProbBump = fastMomentum || risingAcceleration ? 0.02 : 0.04;
      const requiredProb = trendStrengthPass
        ? Math.min(0.98, Math.max(probBuffer, dec.pStar + trendProbBump))
        : probBuffer;
      const probPass =
        dec.pass &&
        ((trendStrengthPass && probRaw >= requiredProb) ||
          (!trendGate && probRaw >= probBuffer) ||
          momentumOverride);
      const canEnterNow =
        evaluatingEntry && gatingPass && probPass && passesTrendOrMomentum;

      if (evaluatingEntry) {
        gateStats.attempts += 1;
        if (!band.pass) gateStats.atrFail += 1;
        else if (!rvolPass) gateStats.rvolFail += 1;
        else if (!spreadPass) gateStats.spreadFail += 1;
        else {
          gateStats.gatingPass += 1;
          if (!passesTrendOrMomentum) gateStats.trendFail += 1;
          else if (!probPass) gateStats.probFail += 1;
        }
      }

      // 포지션 관리: 본절/트레일링 → 가격 청산 → 시간 청산
      if (exe.position) {
        exe.updateStops(last);
        const exit1 = await exe.maybeExitByPrice(last);
        if (!exit1) {
          await exe.maybeExitByTime(Date.now(), last);
        }
      }

      if (canEnterNow) {
        const entryCtx = {
          atrPct,
          atrLo: band.lo,
          atrHi: band.hi,
          atrTightMin,
          atrTightPass,
          atrPass: band.pass,
          rvol,
          rvolPass,
          spreadTicks: obm.spreadTicks,
          spreadPass,
          prob: probRaw,
          pStar: dec.pStar,
          probPass,
          probBuffer,
          requiredProb,
          trendStrengthPass,
          trendPass,
          trendGate,
          momentumOverride,
          momentumProb,
          momentumStrong,
          rsi,
          rsiStrong,
          priceDelta1,
          momentumSlope,
          fastMomentum,
          risingAcceleration,
          lossMomentum,
          trendMomentumAligned: trendStrengthPass,
          gatingPass,
          rsiScore,
          volScore,
          obScore,
          candleScore,
          imbalance: obm.imbalance,
          bestBidShare: obm.bestBidShare,
          aboveVWAP,
          timeoutSec: winBias.timeoutSec ?? CFG.strat.TIMEOUT_SEC,
          stallSec: winBias.stallSec ?? CFG.strat.STALL_SEC,
          targets: {
            tpPct: winBias.tpPct,
            slPct: winBias.slPct,
            stallSec: winBias.stallSec,
            timeoutSec: winBias.timeoutSec,
            minRvol: dynRvolMin,
            maxSpreadTicks: dynSpreadTicks,
            minImb: dynMinImb,
            pRequired: winBias.pRequired,
          },
          winBias,
          price: last,
        };
        const entryRes = await exe.enterLong({
          price: last,
          atrPct,
          context: entryCtx,
        });
        if (entryRes?.ok) {
          gateStats.entries += 1;
          if (!trendGate && momentumOverride) gateStats.momentumUsed += 1;
        }
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
      if (!rvolPass)
        deficits.push(
          `거래량 부족: 현재 ${rvol.toFixed(2)}x → 최소 ${dynRvolMin.toFixed(
            2
          )}x (＋${(dynRvolMin - rvol).toFixed(2)}x)`
        );
      if (!spreadPass)
        deficits.push(
          `스프레드 과대: 현재 ${
            obm.spreadTicks
          }틱 → 최대 ${dynSpreadTicks}틱 (－${
            obm.spreadTicks - dynSpreadTicks
          }틱)`
        );
      if (gatingPass && !probPass) {
        const targetProb = trendGate ? requiredProb : probBuffer;
        const need = Math.max(0, (targetProb - probRaw) * 100);
        if (need > 0)
          deficits.push(
            `확률 부족: 현재 ${(probRaw * 100).toFixed(1)}% → 최소 ${(
              targetProb * 100
            ).toFixed(1)}% (＋${need.toFixed(1)}%)`
          );
      }
      if (!passesTrendOrMomentum) {
        if (!trendGate)
          deficits.push(
            `추세 필터 미충족: 모멘텀 예외 조건(ATR ≥ ${(
              atrTightMin * 100
            ).toFixed(2)}bp, OB ≥ 0.90, RVOL ≥ ${(dynRvolMin + 0.3).toFixed(
              2
            )}x, RSI ≥ 60, 가속도 양호)을 만족하지 못함`
          );
        if (!atrTightPass && !trendGate)
          deficits.push(
            `모멘텀 예외 차단: ATR ${
              atrPct?.toFixed?.(3) ?? "NaN"
            }% → 최소 ${atrTightMin.toFixed(3)}% 필요`
          );
        if (!(obScore >= 0.9) && !trendGate)
          deficits.push(
            `모멘텀 예외 차단: 오더북 스코어 ${obScore.toFixed(
              2
            )} → 최소 0.90 필요`
          );
        if (!trendStrengthPass && trendGate)
          deficits.push(
            `추세 진입 보류: 속도 부족 (Δ1=${(priceDelta1 * 100).toFixed(
              2
            )}bp, slope=${(momentumSlope * 100).toFixed(2)}bp, 가속 ${
              risingAcceleration ? "충족" : "부족"
            })`
          );
        if (!momentumOverride && !trendGate)
          deficits.push(
            `모멘텀 예외 거부: 상승 가속도 부족 (Δ1=${(
              priceDelta1 * 100
            ).toFixed(2)}bp, slope=${(momentumSlope * 100).toFixed(
              2
            )}bp, 요구 확률 ${(momentumProb * 100).toFixed(1)}%)`
          );
      }

      // 승률/최근 체결
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

      // 최근 오류/시스템 이벤트
      const sysLog = [];
      if (exe.lastError) {
        sysLog.push({ ts: exe.lastError.ts, msg: exe.lastError.message });
      }

      const account = exe.accountSnapshot(last);
      if (exe.orderHistory?.length) {
        for (const evt of exe.orderHistory.slice(-10)) {
          const msg = evt.err || evt.msg || evt.type || "event";
          sysLog.push({ ts: evt.ts, msg });
        }
      }

      // 미실현손익·보유시간
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

      // 대시보드
      renderDashboard({
        title: "업비트 스캘핑 Bot v3.0",
        time: nowStr,
        market: CFG.run.market,
        mode: CFG.run.paper ? "PAPER" : "LIVE",
        price: last,
        dynamicTargets:
          exe.position?.context?.targets ?? winBias ?? lastWinBias,

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
        rvolMin: dynRvolMin,
        obm,
        scores: {
          rsi: rsiScore,
          vol: volScore,
          ob: obScore,
          candle: candleScore,
        },

        // 의사결정
        p: probRaw,
        pStar: dec.pStar,
        canEnter: canEnterNow,
        filters: {
          atr: band.pass,
          rvol: rvolPass,
          spread: spreadPass,
          gatingPass,
        },
        gateStats,
        daily,

        // 포지션·성과
        position: exe.position,
        unrealized,
        aliveSec,
        timeoutSec:
          exe.position?.timeoutSec ??
          winBias.timeoutSec ??
          CFG.strat.TIMEOUT_SEC,

        // 체결/통계/부족치
        lastTrades,
        stats,
        deficits,
        showGlossary: CFG.ui.showGlossary,
        systemLog: sysLog,
        account,
      });

      // 슬립
      const dt = Date.now() - t0;
      await new Promise((r) =>
        setTimeout(r, Math.max(0, CFG.run.intervalMs - dt))
      );
    } catch (e) {
      renderDashboard({
        title: "업비트 스캘핑 Bot v3.0",
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
        rvolMin: lastWinBias?.minRvol ?? CFG.strat.MIN_RVOL,
        obm: { imbalance: 0, spreadTicks: 0, bid1: 0, ask1: 0 },
        scores: { rsi: 0, vol: 0, ob: 0, candle: 0 },
        p: 0,
        pStar: 0,
        canEnter: false,
        gateStats,
        position: null,
        unrealized: { pnlKRW: 0, pnlPct: 0 },
        aliveSec: 0,
        dynamicTargets: exe.position?.context?.targets ?? lastWinBias,
        timeoutSec:
          exe.position?.timeoutSec ??
          lastWinBias?.timeoutSec ??
          CFG.strat.TIMEOUT_SEC,
        lastTrades: [],
        stats: { wins: 0, losses: 0, winrate: 0, pnl: 0, trades: 0 },
        deficits: [`루프 오류: ${e?.message}`],
        showGlossary: CFG.ui.showGlossary,
        systemLog: [{ ts: nowKSTString(), msg: e?.stack ?? String(e) }],
      });
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

main();
