// src/index.js
// 메인 루프: 승률 우선 전략 + 캔들 캐싱 최적화 + 듀얼 모드 (TREND/RANGE)

import { CFG, DERIVED, PATHS } from "./config/index.js";
import fs from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import * as Upbit from "./api/upbitAdapter.js";
import { atrPercent, atrSeriesPercent, atrBandGate } from "./indicators/atr.js";
import { ema } from "./indicators/ema.js";
import { vwap } from "./indicators/vwap.js";
import { bollingerBands } from "./indicators/bollinger.js";
import { analyzeOrderbook } from "./market/orderbook.js";
import { ModeDetector } from "./market/modeDetector.js";
import { clamp, nowKSTString } from "./util/math.js";
import {
  checkTradingHours,
  checkConsecutiveLosses,
  checkDailyLimits,
} from "./strategy/highWinRateEntry.js";
import { checkRangeEntry, calcRangePStar } from "./strategy/rangeScalping.js";
import { Risk } from "./risk/riskManager.js";
import { Executor } from "./executor/executor.js";
import { renderDashboard, initTTY } from "./monitor/dashboard.js";
import { getTradeStats } from "./monitor/tradeLog.js";
import {
  buildFeatureVector,
  buildFeatureVectorWithOrderbook,
} from "./ml/features.js";
import { loadModel, predictProbability } from "./ml/model.js";

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
let lastProbLogTs = 0;
let lastProbLogP = NaN;
let lastProbLogPStar = NaN;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 일일 거래 건수 추적 (목표: 10~15건)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
let todayTradeCount = 0;
let todayRangeTradeCount = 0; // 레인지 모드 일일 거래 수
let rangeConsecutiveLosses = 0; // 레인지 모드 연속 손실
// 업비트(한국) 기준 일자(KST)로 리셋되도록 날짜 키를 KST로 계산
const kstDateKey = () =>
  new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);

let lastResetDate = kstDateKey(); // YYYY-MM-DD (KST)

// 모드 감지기 초기화
const modeDetector = new ModeDetector({
  trendThreshold: CFG.range?.ATR_TREND_THRESHOLD ?? 1.2,
  rangeThreshold: CFG.range?.ATR_RANGE_THRESHOLD ?? 0.8,
  lookbackPeriod: CFG.range?.ATR_LOOKBACK ?? 30,
  cooldownSec: CFG.range?.MODE_COOLDOWN_SEC ?? 300,
});

function resetDailyCounter() {
  const currentDate = kstDateKey();
  if (currentDate !== lastResetDate) {
    console.log(`\n🔄 일일 카운터 리셋: ${lastResetDate} → ${currentDate}`);
    console.log(
      `   어제 거래: ${todayTradeCount}건 (레인지: ${todayRangeTradeCount}건)\n`
    );
    todayTradeCount = 0;
    todayRangeTradeCount = 0;
    rangeConsecutiveLosses = 0;
    lastResetDate = currentDate;
  }
}

async function main() {
  initTTY();
  const probLogPath = path.resolve(PATHS.logDir, "probability.jsonl");
  try {
    fs.mkdirSync(PATHS.logDir, { recursive: true });
  } catch {}
  const risk = new Risk(CFG.risk);
  const exe = new Executor(risk);
  await exe.refreshBalance(true, CFG.run.market);
  const mlEnabled = CFG.ml?.enabled;
  const mlRegimeEnabled = CFG.ml?.regimeEnabled;
  let mlModel = mlEnabled ? loadModel(CFG.ml.modelPath) : null;
  let mlModelOb = mlEnabled ? loadModel(CFG.ml.modelPathOb) : null;
  let mlModelLow = mlRegimeEnabled ? loadModel(CFG.ml.modelPathLow) : null;
  let mlModelHigh = mlRegimeEnabled ? loadModel(CFG.ml.modelPathHigh) : null;

  const runScript = (scriptPath, args = []) =>
    new Promise((resolve, reject) => {
      const abs = path.resolve(process.cwd(), scriptPath);
      const proc = spawn(process.execPath, [abs, ...args], {
        stdio: "inherit",
        env: process.env,
      });
      proc.on("error", reject);
      proc.on("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`${scriptPath} 종료 코드 ${code}`));
      });
    });

  const startAutoRetrain = () => {
    if (!CFG.ml?.autoRetrain) return;
    const intervalHours = Number(CFG.ml.retrainIntervalHours ?? 24);
    const backfillDays = Number(CFG.ml.retrainBackfillDays ?? 7);
    const delayMin = Number(CFG.ml.retrainInitialDelayMin ?? 5);
    const intervalMs = Math.max(1, intervalHours) * 60 * 60 * 1000;
    const delayMs = Math.max(1, delayMin) * 60 * 1000;

    let running = false;
    const retrain = async () => {
      if (running) return;
      running = true;
      try {
        console.log("\n🔁 ML 재학습 시작...");
        await runScript("scripts/backfill-candles.js", [
          "--days",
          String(backfillDays),
        ]);

        // ✅ 워크포워드 검증 추가
        console.log("\n📊 워크포워드 검증 시작...");
        await runScript("scripts/walkforward-validate.js", ["--folds", "5"]);

        // 검증 결과 확인
        const wfResultPath = path.resolve(
          process.cwd(),
          "./logs/wf_results.json"
        );
        if (fs.existsSync(wfResultPath)) {
          const wfResults = JSON.parse(fs.readFileSync(wfResultPath, "utf8"));
          const avgWR = wfResults.avgWinrate ?? 0;
          const avgSharpe = wfResults.avgSharpe ?? 0;
          const pRequired = DERIVED.pRequired;

          console.log(
            `📊 워크포워드 결과: 승률 ${(avgWR * 100).toFixed(
              1
            )}%, Sharpe ${avgSharpe.toFixed(2)}`
          );
          console.log(
            `   요구사항: 승률 ≥ ${(pRequired * 100).toFixed(1)}%, Sharpe ≥ 1.0`
          );

          if (avgWR < pRequired || avgSharpe < 1.0) {
            console.error("❌ 워크포워드 실패 - 모델 업데이트 중단");
            console.error(
              `   현재: 승률 ${(avgWR * 100).toFixed(
                1
              )}%, Sharpe ${avgSharpe.toFixed(2)}`
            );
            return; // 모델 학습 스킵
          }
          console.log("✅ 워크포워드 검증 통과 - 모델 학습 진행");
        }

        // 검증 통과 시에만 모델 학습
        if (CFG.ml?.useOrderbookFeatures) {
          await runScript("scripts/train-ml-trades.js");
        } else if (CFG.ml?.regimeEnabled) {
          await runScript("scripts/train-ml-regime.js");
        } else {
          await runScript("scripts/train-ml-model.js");
        }
        console.log("✅ ML 재학습 완료\n");
      } catch (e) {
        console.error(`❌ ML 재학습 실패: ${e?.message}`);
      } finally {
        running = false;
      }
    };

    setTimeout(retrain, delayMs);
    setInterval(retrain, intervalMs);
  };

  startAutoRetrain();

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
  console.log("🚀 업비트 ML 인트라데이 봇 시작");
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

      // 볼린저밴드 (레인지 모드용)
      const bbPeriod = CFG.range?.BB_PERIOD ?? 20;
      const bbStdDev = CFG.range?.BB_STDDEV ?? 2;
      const bb = bollingerBands(candles1m, bbPeriod, bbStdDev);

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
      const ret1 =
        closes.length >= 2 ? (closes[0] - closes[1]) / closes[1] : NaN;
      const ret5 =
        closes.length >= 6 ? (closes[0] - closes[5]) / closes[5] : NaN;
      const emaRatio = emaSlow > 0 ? emaFast / emaSlow - 1 : NaN;
      const vwapDist =
        Number.isFinite(vwapVal) && vwapVal > 0
          ? (last - vwapVal) / vwapVal
          : NaN;

      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      // 시장 모드 판단 (TREND / RANGE / NEUTRAL)
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      const atrForMode = Number.isFinite(atrPct) ? atrPct : 0;
      const modeResult = modeDetector.update(atrForMode);
      const marketMode = modeResult.mode;

      // ML 확률 계산 (캔들 기반)
      if (mlEnabled && !mlRegimeEnabled) mlModel = loadModel(CFG.ml.modelPath);
      if (mlEnabled && CFG.ml?.useOrderbookFeatures) {
        mlModelOb = loadModel(CFG.ml.modelPathOb);
      }
      if (mlRegimeEnabled) {
        mlModelLow = loadModel(CFG.ml.modelPathLow);
        mlModelHigh = loadModel(CFG.ml.modelPathHigh);
      }

      const baseModel = mlRegimeEnabled ? mlModelLow || mlModelHigh : mlModel;
      const useObFeatures = CFG.ml?.useOrderbookFeatures && mlModelOb;
      const mlFeatures = useObFeatures
        ? buildFeatureVectorWithOrderbook({
            candles1m,
            cfg: CFG,
            orderbook: obm,
          })
        : baseModel
        ? buildFeatureVector({ candles1m, cfg: CFG })
        : null;

      const atrThreshold = Number(CFG.ml.regimeAtrThreshold ?? 0.06);
      const isHighVol = Number.isFinite(atrPct) && atrPct >= atrThreshold;
      const modelToUse = useObFeatures
        ? mlModelOb
        : mlRegimeEnabled
        ? isHighVol
          ? mlModelHigh
          : mlModelLow
        : mlModel;
      const minProbFloor = mlRegimeEnabled
        ? Number(isHighVol ? CFG.ml.minProbHigh : CFG.ml.minProbLow)
        : Number(CFG.ml.minProb ?? 0.58);

      const mlProb =
        modelToUse && mlFeatures
          ? predictProbability(
              modelToUse,
              mlFeatures.values,
              mlFeatures.featureNames
            )
          : NaN;
      const fee = Number(CFG.ml.fee ?? CFG.strat.FEE ?? 0);
      const slip = Number(CFG.ml.slip ?? CFG.strat.SLIP ?? 0);

      const atrFrac = Number.isFinite(atrPct) ? atrPct / 100 : NaN;
      const tpPctDyn = Number.isFinite(atrFrac)
        ? clamp(
            atrFrac * Number(CFG.ml.tpAtrMult ?? 2.2),
            Number(CFG.ml.tpMin),
            Number(CFG.ml.tpMax)
          )
        : Number(CFG.strat.TP ?? 0);
      const slPctDyn = Number.isFinite(atrFrac)
        ? clamp(
            atrFrac * Number(CFG.ml.slAtrMult ?? 2.8),
            Number(CFG.ml.slMin),
            Number(CFG.ml.slMax)
          )
        : Number(CFG.strat.SL ?? 0);

      // 왕복 비용 기준으로 p* 계산 일관성 유지
      const roundTripCost = 2 * (fee + slip);
      const tpNet = tpPctDyn - roundTripCost;
      const slNet = slPctDyn + roundTripCost;
      const pStarBase =
        Number.isFinite(tpNet) &&
        Number.isFinite(slNet) &&
        tpNet > 0 &&
        slNet > 0
          ? clamp(slNet / Math.max(1e-9, tpNet + slNet), 0, 1)
          : minProbFloor;
      const pStarBuffer = Number(CFG.ml?.probBuffer ?? 0);
      const pStar = CFG.ml?.dynamicPstar
        ? Math.max(minProbFloor, pStarBase + pStarBuffer)
        : minProbFloor;
      const probScale = Number.isFinite(mlProb)
        ? clamp((mlProb - pStar) / Math.max(1e-9, 1 - pStar), 0, 1)
        : 0;
      const ev = Number.isFinite(mlProb)
        ? mlProb * tpNet - (1 - mlProb) * slNet
        : -Infinity;
      const evCap = Number(CFG.ml.evCap ?? 0.01);
      const evScale = ev > 0 ? clamp(ev / Math.max(1e-9, evCap), 0, 1) : 0;
      const sizeMin = Number(CFG.ml.sizeMin ?? 0.2);
      const sizeMax = Number(CFG.ml.sizeMax ?? 1.0);
      const sizeScale = clamp(
        probScale * 0.5 + evScale * 0.5,
        sizeMin,
        sizeMax
      );
      const probRaw = mlProb;
      const dec = {
        pass: Number.isFinite(mlProb) && mlProb >= pStar,
        pStar,
      };

      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      // 확률(p) 변화 기록 (저빈도)
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      if (Number.isFinite(mlProb)) {
        const shouldLogProb =
          !Number.isFinite(lastProbLogP) ||
          !Number.isFinite(lastProbLogPStar) ||
          now - lastProbLogTs >= 60000 ||
          Math.abs(mlProb - lastProbLogP) >= 0.01 ||
          Math.abs(dec.pStar - lastProbLogPStar) >= 0.01;

        if (shouldLogProb) {
          const probLog = {
            ts: now,
            tsISO: new Date(now).toISOString(),
            market: CFG.run.market,
            p: mlProb,
            pStar: dec.pStar,
            ev,
            sizeScale,
            tpPct: tpPctDyn,
            slPct: slPctDyn,
            atrPct,
            rvol,
            rsi,
            emaRatio,
            vwapDist,
            wsLagMs: snap.wsLagMs,
          };

          fs.appendFile(probLogPath, JSON.stringify(probLog) + "\n", () => {});
          lastProbLogTs = now;
          lastProbLogP = mlProb;
          lastProbLogPStar = dec.pStar;
        }
      }

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
      // 수집/수익 모드 결정
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      function determineMode({ stats, modelPerf, todayExits, equityKRW }) {
        const recentWR = modelPerf?.winrate ?? 0.5;
        const recentCount = modelPerf?.count ?? 0;
        const pRequired = DERIVED.pRequired;

        // 1. 최근 20거래 실승률 < p* → 수집 모드
        if (recentCount >= 20 && recentWR < pRequired) {
          return {
            mode: "COLLECT",
            reason: `실승률 ${(recentWR * 100).toFixed(1)}% < p* ${(
              pRequired * 100
            ).toFixed(1)}%`,
          };
        }

        // 2. 오늘 2연패 이상 → 수집 모드
        const lastTwo = todayExits.slice(-2);
        if (lastTwo.length >= 2 && lastTwo.every((t) => Number(t.pnlKRW) < 0)) {
          return { mode: "COLLECT", reason: "금일 2연패" };
        }

        // 3. 일일 손실 -2% 초과 → 수집 모드
        const dailyPnL = todayExits.reduce(
          (s, e) => s + Number(e.pnlKRW || 0),
          0
        );
        const dailyPnLPct = dailyPnL / Math.max(1, equityKRW);
        if (dailyPnLPct < -0.02) {
          return {
            mode: "COLLECT",
            reason: `일일 손실 ${(dailyPnLPct * 100).toFixed(2)}%`,
          };
        }

        return { mode: "PROFIT", reason: "정상 운용" };
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
          // 거래 로그 분석 (메모리 캐시 사용)
          const { exits: allExits } = getTradeStats();
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
            if (!mlModel) {
              blockReason = "ML 모델 없음 (학습 후 모델 저장 필요)";
            } else if (!mlFeatures) {
              blockReason = "ML 피처 부족 (캔들 데이터 부족)";
            } else if (CFG.ml?.obRequired) {
              const obPass =
                obm.spreadTicks <= CFG.strat.MAX_SPREAD_TICKS &&
                obm.imbalance >= CFG.strat.MIN_IMB &&
                obm.bestBidShare >= CFG.strat.MIN_BEST_BID_SHARE;
              if (!obPass) {
                blockReason = `오더북 조건 미달: 스프레드 ${
                  obm.spreadTicks
                }틱, 불균형 ${(obm.imbalance * 100).toFixed(1)}%, 비드 ${(
                  obm.bestBidShare * 100
                ).toFixed(1)}%`;
              }
            }

            // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
            // 모드별 진입 조건 체크
            // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
            if (!blockReason) {
              if (marketMode === "TREND" || marketMode === "NEUTRAL") {
                // 트렌드/중립 모드: ML 확률 기반 (기존 로직)
                if (!dec.pass) {
                  blockReason = `[${marketMode}] ML 확률 부족: p=${(
                    probRaw * 100
                  ).toFixed(1)}% < 기준 ${(dec.pStar * 100).toFixed(1)}%`;
                } else {
                  canEnterNow = true;
                }
              } else if (marketMode === "RANGE" && CFG.range?.ENABLED) {
                // 레인지 모드: BB + RSI 기반
                const rangeMaxDaily = CFG.range?.MAX_DAILY_TRADES ?? 5;
                const rangeMaxConsecLoss =
                  CFG.range?.MAX_CONSECUTIVE_LOSSES ?? 2;

                if (todayRangeTradeCount >= rangeMaxDaily) {
                  blockReason = `[RANGE] 일일 한도 도달 (${todayRangeTradeCount}/${rangeMaxDaily})`;
                } else if (rangeConsecutiveLosses >= rangeMaxConsecLoss) {
                  blockReason = `[RANGE] 연속 손실 ${rangeConsecutiveLosses}회 - 당일 중단`;
                } else {
                  const rangeCheck = checkRangeEntry(last, bb, rsi, {
                    rsiOversold: CFG.range?.RSI_OVERSOLD ?? 35,
                    rsiOverbought: CFG.range?.RSI_OVERBOUGHT ?? 65,
                    bbMargin: CFG.range?.BB_MARGIN ?? 0.001,
                  });

                  if (rangeCheck.pass) {
                    canEnterNow = true;
                    blockReason = null; // 진입 허용
                  } else {
                    blockReason = `[RANGE] ${rangeCheck.reason}`;
                  }
                }
              }
            }
          }
        }
      }

      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      // 성과 통계 계산 (모드 결정용)
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      const { exits: allExitsForStats, stats } = getTradeStats();

      const perfSamples = allExitsForStats
        .filter((e) => Number.isFinite(e?.entryCtx?.prob))
        .slice(-200);
      const perfCount = perfSamples.length;
      let perfWin = 0;
      let perfPsum = 0;
      let perfBrier = 0;
      let perfLogLoss = 0;
      let perfScaleSum = 0;
      for (const e of perfSamples) {
        const p = Math.min(1, Math.max(0, Number(e.entryCtx.prob)));
        const y = Number(e.pnlKRW) > 0 ? 1 : 0;
        perfWin += y;
        perfPsum += p;
        perfBrier += (p - y) ** 2;
        const pClip = Math.min(1 - 1e-9, Math.max(1e-9, p));
        perfLogLoss += -(y * Math.log(pClip) + (1 - y) * Math.log(1 - pClip));
        if (Number.isFinite(e.entryCtx.sizeScale))
          perfScaleSum += e.entryCtx.sizeScale;
      }
      const modelPerf = perfCount
        ? {
            count: perfCount,
            winrate: perfWin / perfCount,
            avgProb: perfPsum / perfCount,
            brier: perfBrier / perfCount,
            logLoss: perfLogLoss / perfCount,
            avgSizeScale: perfScaleSum / perfCount,
          }
        : null;

      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      // 진입 실행 (수집/수익 모드 분리)
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      const nowStr = nowKSTString();
      const todayKey = nowStr.slice(0, 10);
      const todayExitsForMode = allExitsForStats.filter(
        (e) => typeof e.ts === "string" && e.ts.slice(0, 10) === todayKey
      );

      const modeInfo = determineMode({
        stats,
        modelPerf,
        todayExits: todayExitsForMode,
        equityKRW: exe.accountSnapshot(last)?.equityKRW,
      });

      if (modeInfo.mode === "COLLECT") {
        // 📊 데이터 수집 모드: 랜덤 샘플링 (10% 확률)
        const shouldSample =
          Math.random() < 0.1 &&
          !hasExposure &&
          todayTradeCount < CFG.run.targetTradesMax;

        if (shouldSample) {
          console.log(`\n📊 수집 모드: ${modeInfo.reason} - 샘플링 진입\n`);

          const entryCtx = {
            atrPct,
            atrLo: band.lo,
            atrHi: band.hi,
            rvol,
            rsi,
            ret1,
            ret5,
            emaRatio,
            vwapDist,
            prob: probRaw,
            pStar: dec.pStar,
            emaFast,
            emaSlow,
            vwap: vwapVal,
            aboveVWAP,
            imbalance: obm.imbalance,
            spreadTicks: obm.spreadTicks,
            bestBidShare: obm.bestBidShare,
            tpPct: tpPctDyn,
            slPct: slPctDyn,
            price: last,
            mode: "COLLECT",
          };

          const entryResult = await exe.enterLong({
            price: last,
            atrPct,
            context: { ...entryCtx, sizeScale: 0.2 },
            sizeScale: 0.2, // 소량 (20%)
            slPctOverride: slPctDyn,
          });

          if (entryResult?.ok) {
            todayTradeCount++;
            console.log(
              `\n✅ 수집 모드 진입 성공! 오늘 ${todayTradeCount}/${CFG.run.targetTradesMax}건째 거래\n`
            );
          }
        }
      } else {
        // 💰 수익 모드: 기존 로직 (엄격한 진입 조건)
        if (canEnterNow) {
          const entryCtx = {
            atrPct,
            atrLo: band.lo,
            atrHi: band.hi,
            rvol,
            rsi,
            ret1,
            ret5,
            emaRatio,
            vwapDist,
            prob: probRaw,
            pStar: dec.pStar,
            emaFast,
            emaSlow,
            vwap: vwapVal,
            aboveVWAP,
            imbalance: obm.imbalance,
            spreadTicks: obm.spreadTicks,
            bestBidShare: obm.bestBidShare,
            tpPct: tpPctDyn,
            slPct: slPctDyn,
            price: last,
            mode: "PROFIT",
          };

          const entryResult = await exe.enterLong({
            price: last,
            atrPct,
            context: { ...entryCtx, sizeScale },
            sizeScale,
            slPctOverride: slPctDyn,
          });

          // 진입 성공 시 카운터 증가
          if (entryResult?.ok) {
            todayTradeCount++;
            console.log(
              `\n✅ 수익 모드 진입 성공! 오늘 ${todayTradeCount}/${CFG.run.targetTradesMax}건째 거래\n`
            );
          }
        }

        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        // 레인지 모드 진입 (별도 처리)
        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        if (
          !hasExposure &&
          marketMode === "RANGE" &&
          canEnterNow &&
          CFG.range?.ENABLED
        ) {
          const rangeTP = CFG.range?.TP ?? 0.004;
          const rangeSL = CFG.range?.SL ?? 0.0025;
          const rangePositionPct = CFG.range?.POSITION_PCT ?? 0.1;
          const rangePStar = calcRangePStar(rangeTP, rangeSL, fee, slip);

          const rangeCtx = {
            atrPct,
            rvol,
            rsi,
            bb: { upper: bb.upper, lower: bb.lower, middle: bb.middle },
            prob: probRaw,
            pStar: rangePStar,
            tpPct: rangeTP,
            slPct: rangeSL,
            price: last,
            mode: "RANGE",
            marketMode,
            atrRatio: modeResult.atrRatio,
          };

          const rangeResult = await exe.enterLong({
            price: last,
            atrPct,
            context: { ...rangeCtx, sizeScale: rangePositionPct },
            sizeScale: rangePositionPct,
            slPctOverride: rangeSL,
            tpPctOverride: rangeTP,
            timeoutOverride: CFG.range?.TIMEOUT_SEC ?? 600,
          });

          if (rangeResult?.ok) {
            todayTradeCount++;
            todayRangeTradeCount++;
            console.log(
              `\n✅ 레인지 모드 진입! BB하단 + RSI=${rsi.toFixed(1)} | ` +
                `오늘 레인지 ${todayRangeTradeCount}건, 전체 ${todayTradeCount}건\n`
            );
          }
        }
      }

      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      // 일일 성과 계산 (대시보드용)
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      const daily = {
        trades: todayExitsForMode.length,
        wins: todayExitsForMode.filter((e) => Number(e.pnlKRW) > 0).length,
        losses: todayExitsForMode.filter((e) => Number(e.pnlKRW) <= 0).length,
        pnl: todayExitsForMode.reduce((s, e) => s + Number(e.pnlKRW || 0), 0),
      };

      const lastTrades = allExitsForStats.slice(-10);
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
        mode: modeInfo.mode,
        modeReason: modeInfo.reason,

        // 시장 모드 정보 (TREND/RANGE/NEUTRAL)
        marketMode,
        marketModeReason: modeResult.reason,
        atrRatio: modeResult.atrRatio,
        bb: {
          upper: bb.upper,
          lower: bb.lower,
          middle: bb.middle,
          bandwidth: bb.bandwidth,
        },
        rangeEnabled: CFG.range?.ENABLED,
        todayRangeTradeCount,

        position: exe.position,
        unrealized,
        aliveSec,
        timeoutSec: CFG.strat.TIMEOUT_SEC,

        lastTrades,
        stats,
        daily,
        modelPerf,

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
