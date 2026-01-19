// src/config/index.js
// 환경설정 로더 (승률 우선 전략 - 개선 버전)

import fs from "fs";
import path from "path";

// ✅ 동적 슬리피지 계산 함수 (개선 6: 기본값 상향)
function calculateAvgSlippage(days = 7) {
  const slippagePath = path.resolve(process.cwd(), "./logs/slippage.jsonl");
  if (!fs.existsSync(slippagePath)) return 0.0008; // 기본값 0.08%로 상향

  try {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const lines = fs.readFileSync(slippagePath, "utf8").trim().split("\n");
    const recent = lines
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter((e) => e && e.ts >= cutoff && Number.isFinite(e.actualSlip));

    if (recent.length === 0) return 0.0008;

    // 95th percentile 계산
    const sorted = recent.map((e) => e.actualSlip).sort((a, b) => a - b);
    const p95Index = Math.floor(sorted.length * 0.95);
    const p95 = sorted[p95Index] ?? sorted[sorted.length - 1];

    // 95th percentile + 30% 버퍼 (개선 6)
    return Math.max(0.0005, Math.min(0.003, p95 * 1.3));
  } catch {
    return 0.0008; // 기본값 0.08%
  }
}

function loadDotenv() {
  try {
    const p = path.resolve(process.cwd(), ".env");
    if (!fs.existsSync(p)) return;
    const text = fs.readFileSync(p, "utf8");
    for (const line of text.split(/\r?\n/)) {
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
      else {
        const hash = v.indexOf("#");
        if (hash >= 0) v = v.slice(0, hash).trim();
      }
      if (!(k in process.env)) process.env[k] = v;
    }
  } catch {}
}
loadDotenv();

const env = (k, d) => process.env[k] ?? d;
const num = (k, d) => Number(env(k, d));
const bool = (k, d) => env(k, d) === "true";

// ✅ 동적 슬리피지 계산 (최근 7일 기준)
const dynamicSlip = calculateAvgSlippage(7);

export const CFG = {
  run: {
    market: env("MARKET", "KRW-BTC"),
    intervalMs: num("INTERVAL_MS", 500),
    paper: bool("PAPER", true),
    targetTradesMin: num("TARGET_TRADES_MIN", 1), // Low frequency: min 1 trade
    targetTradesMax: num("TARGET_TRADES_MAX", 3), // Low frequency: max 3 trades
  },

  // 리스크/사이징 (개선 2: 포지션 비중 축소)
  risk: {
    // 1회 진입에 사용할 잔고 상한 비율 (개선 2: 90% → 25%로 축소)
    positionPctMax: num("POSITION_PCT_MAX", 0.25),
    // 트레이드당 허용 손실 비율 (개선 2: 1% 활성화)
    riskPctPerTrade: num("RISK_PCT_PER_TRADE", 0.01),
    // 최소 주문 금액(KRW)
    minSize: num("MIN_ORDER_KRW", 5000),
    // 절대 상한(KRW) (개선 2: 100만원 상한 추가)
    maxSize: num("MAX_ORDER_KRW", 1000000),
  },

  strat: {
    // 손익 (인트라데이에 적합한 수준)
    TP: num("TP", 0.008), // Target 0.8%
    SL: num("SL", 0.005), // Stop Loss 0.5% → p* = 38.5%
    FEE: num("FEE", 0.0005),
    SLIP: num("SLIP", dynamicSlip), // ✅ 동적 슬리피지 적용

    // ATR (완화)
    ATR_PERIOD: num("ATR_PERIOD", 14),
    ATR_P_LO: num("ATR_P_LO", 0.35), // ✅ 0.45 → 0.35
    ATR_P_HI: num("ATR_P_HI", 0.9), // ✅ 0.85 → 0.90
    MIN_ATR_PCT: num("MIN_ATR_PCT", 0.038), // ✅ 0.045 → 0.038

    // RVOL (완화)
    RVOL_BASE_MIN: num("RVOL_BASE_MIN", 90), // ✅ 120 → 90
    MIN_RVOL: num("MIN_RVOL", 1.5), // ✅ 1.8 → 1.5

    // 추세 (완화)
    TREND_EMA_FAST: num("TREND_EMA_FAST", 20),
    TREND_EMA_SLOW: num("TREND_EMA_SLOW", 50),
    TREND_EMA_RATIO_MIN: num("TREND_EMA_RATIO_MIN", 1.003), // ✅ 1.005 → 1.003
    REQUIRE_VWAP_ABOVE: bool("REQUIRE_VWAP_ABOVE", true),
    VWAP_MARGIN_MIN: num("VWAP_MARGIN_MIN", 0.0015), // ✅ 0.002 → 0.0015
    REQUIRE_1M_UPTREND: bool("REQUIRE_1M_UPTREND", false), // ✅ true → false (선택 조건으로)
    MIN_1M_MOMENTUM: num("MIN_1M_MOMENTUM", 0.0006), // ✅ 0.0008 → 0.0006

    // 오더북 (완화)
    MAX_SPREAD_TICKS: num("MAX_SPREAD_TICKS", 2), // ✅ 1 → 2
    MIN_IMB: num("MIN_IMB", 0.28), // ✅ 0.35 → 0.28
    MIN_BEST_BID_SHARE: num("MIN_BEST_BID_SHARE", 0.58), // ✅ 0.65 → 0.58

    // RSI (완화)
    RSI_MIN: num("RSI_MIN", 45), // ✅ 48 → 45
    RSI_MAX: num("RSI_MAX", 70), // ✅ 68 → 70
    RSI_OPTIMAL_MIN: num("RSI_OPTIMAL_MIN", 50), // ✅ 52 → 50
    RSI_OPTIMAL_MAX: num("RSI_OPTIMAL_MAX", 64), // ✅ 62 → 64

    // 확률 (완화)
    MIN_PROB_ENTRY: num("MIN_PROB_ENTRY", 0.72), // ✅ 0.78 → 0.72
    PROB_BUFFER: num("PROB_BUFFER", 0.06), // ✅ 0.08 → 0.06

    // 청산 (인트라데이에 적합)
    TIMEOUT_SEC: num("TIMEOUT_SEC", 1800), // 30분
    STALL_SEC: num("STALL_SEC", 600), // 10분
    BE_TRIGGER: num("BE_TRIGGER", 0.003), // 0.3% 도달 시 BE 이동
    BE_OFFSET: num("BE_OFFSET", 0.001), // BE는 진입가 +0.1%
    TRAIL_PCT: num("TRAIL_PCT", 0.002), // 트레일링 0.2%
  },

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 레인지 모드 설정 (횡보장 평균회귀 전략)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  range: {
    ENABLED: bool("RANGE_MODE_ENABLED", true),

    // 모드 판단 기준 (ATR 비율)
    ATR_TREND_THRESHOLD: num("MODE_ATR_TREND", 1.2), // 1.2배 이상 → TREND
    ATR_RANGE_THRESHOLD: num("MODE_ATR_RANGE", 1.0), // 1.0배 이하 → RANGE (완화: 0.8→1.0)
    ATR_LOOKBACK: num("MODE_ATR_LOOKBACK", 30), // 30봉 평균 기준
    MODE_COOLDOWN_SEC: num("MODE_COOLDOWN_SEC", 300), // 모드 전환 쿨다운 5분

    // 볼린저밴드 설정
    BB_PERIOD: num("RANGE_BB_PERIOD", 20),
    BB_STDDEV: num("RANGE_BB_STDDEV", 2),
    BB_MARGIN: num("RANGE_BB_MARGIN", 0.005), // BB 밴드 0.5% 여유 (완화)

    // RSI 기준 (완화: 35→40)
    RSI_OVERSOLD: num("RANGE_RSI_OVERSOLD", 40),
    RSI_OVERBOUGHT: num("RANGE_RSI_OVERBOUGHT", 60),

    // 손익 설정 (p* = 0.25/0.65 = 38.5%)
    TP: num("RANGE_TP", 0.004), // 0.4%
    SL: num("RANGE_SL", 0.0025), // 0.25%
    TIMEOUT_SEC: num("RANGE_TIMEOUT", 600), // 10분

    // 포지션 사이징 (보수적)
    POSITION_PCT: num("RANGE_POSITION_PCT", 0.1), // 10%

    // 일일 제한
    MAX_DAILY_TRADES: num("RANGE_MAX_DAILY_TRADES", 5),
    MAX_CONSECUTIVE_LOSSES: num("RANGE_MAX_CONSEC_LOSSES", 2),
  },

  ml: {
    enabled: bool("ML_ENABLED", true),
    modelPath: env("ML_MODEL_PATH", "./logs/ml_model.json"),
    regimeEnabled: bool("ML_REGIME_ENABLED", false),
    modelPathLow: env("ML_MODEL_PATH_LOW", "./logs/ml_model_low.json"),
    modelPathHigh: env("ML_MODEL_PATH_HIGH", "./logs/ml_model_high.json"),
    regimeAtrThreshold: num("ML_REGIME_ATR_THRESHOLD", 0.06),
    featureWindow: num("ML_FEATURE_WINDOW", 120),
    labelHorizonMin: num("ML_LABEL_HORIZON_MIN", 10),
    minProb: num("ML_MIN_PROB", 0.58),
    minProbLow: num("ML_MIN_PROB_LOW", 0.58),
    minProbHigh: num("ML_MIN_PROB_HIGH", 0.6),
    dynamicPstar: bool("ML_DYNAMIC_PSTAR", false),
    probBuffer: num("ML_PROB_BUFFER", 0),
    timeSplit: bool("ML_TIME_SPLIT", true),
    useOrderbookFeatures: bool("ML_USE_OB_FEATURES", true),
    modelPathOb: env("ML_MODEL_PATH_OB", "./logs/ml_model_ob.json"),
    obRequired: bool("ML_OB_REQUIRED", true),
    tp: num("ML_TP", num("TP", 0.008)), // 개선 1: 0.045 → 0.008
    sl: num("ML_SL", num("SL", 0.005)), // 개선 1: 0.02 → 0.005
    tpAtrMult: num("ML_TP_ATR_MULT", 1.5), // 개선 1: 2.2 → 1.5 (ATR의 1.5배)
    slAtrMult: num("ML_SL_ATR_MULT", 1.0), // 개선 1: 2.8 → 1.0 (ATR의 1배)
    tpMin: num("ML_TP_MIN", 0.004), // 개선 1: 0.003 → 0.004 (최소 0.4%)
    tpMax: num("ML_TP_MAX", 0.012), // 개선 1: 0.02 → 0.012 (최대 1.2%)
    slMin: num("ML_SL_MIN", 0.003), // 개선 1: 0.004 → 0.003 (최소 0.3%)
    slMax: num("ML_SL_MAX", 0.008), // 개선 1: 0.03 → 0.008 (최대 0.8%)
    emaFast: num("ML_EMA_FAST", 20),
    emaSlow: num("ML_EMA_SLOW", 60),
    rsiPeriod: num("ML_RSI_PERIOD", 14),
    vwapPeriod: num("ML_VWAP_PERIOD", 120),
    fee: num("ML_FEE", num("FEE", 0.0005)),
    slip: num("ML_SLIP", num("SLIP", 0.0003)),
    sizeMin: num("ML_SIZE_MIN", 0.2),
    sizeMax: num("ML_SIZE_MAX", 1.0),
    evCap: num("ML_EV_CAP", 0.01),
    autoRetrain: bool("ML_AUTO_RETRAIN", true),
    retrainIntervalHours: num("ML_RETRAIN_INTERVAL_HOURS", 24),
    retrainBackfillDays: num("ML_RETRAIN_BACKFILL_DAYS", 7),
    retrainInitialDelayMin: num("ML_RETRAIN_INITIAL_DELAY_MIN", 5),
  },

  partial: {
    ENABLED: bool("PARTIAL_TAKE_ENABLED", true),
    TAKE_AT: num("PARTIAL_TAKE_AT", 0.015),
    TAKE_RATIO: num("PARTIAL_TAKE_RATIO", 0.5),
  },

  limits: {
    TRADING_HOURS_ENABLED: bool("TRADING_HOURS_ENABLED", true),
    TRADING_HOURS_START: num("TRADING_HOURS_START", 9),
    TRADING_HOURS_END: num("TRADING_HOURS_END", 23),
    AVOID_WEEKENDS: bool("AVOID_WEEKENDS", true),
    // 개선 3: 최소 10분 간격 추가
    MIN_ENTRY_GAP_MINUTES: num("MIN_ENTRY_GAP_MINUTES", 10),
    // 개선 3: 2 → 3연패 후 휴식
    MAX_CONSECUTIVE_LOSSES: num("MAX_CONSECUTIVE_LOSSES", 3),
    // 개선 3: 20분 → 30분 휴식
    COOLDOWN_AFTER_LOSS_MINUTES: num("COOLDOWN_AFTER_LOSS_MINUTES", 30),
    // 개선 3: 20회 → 5회로 축소
    MAX_DAILY_LOSSES: num("MAX_DAILY_LOSSES", 5),
    // 개선 3: 10% → 2.5%로 축소
    DAILY_LOSS_LIMIT_PCT: num("DAILY_LOSS_LIMIT_PCT", 0.025),
  },

  log: {
    dir: env("LOG_DIR", "./logs"),
    tradeFile: env("TRADE_LOG", "trades.jsonl"),
  },

  paper: {
    krw: num("PAPER_KRW", 5000000),
  },

  ui: {
    showGlossary: bool("SHOW_GLOSSARY", false),
    useAltScreen: bool("USE_ALT_SCREEN", true),
    minRenderMs: num("MIN_RENDER_MS", 200),
  },
};

export const PATHS = {
  logDir: path.resolve(process.cwd(), CFG.log.dir),
  tradeLog: path.resolve(process.cwd(), CFG.log.dir, CFG.log.tradeFile),
};

export const KEYS = {
  access: env("UPBIT_ACCESS_KEY", ""),
  secret: env("UPBIT_SECRET_KEY", ""),
};

// 파생값: 손익분기 승률 (왕복 비용 2배 적용)
export const DERIVED = {
  pRequired:
    (CFG.strat.SL + 2 * (CFG.strat.FEE + CFG.strat.SLIP)) /
    (CFG.strat.TP + CFG.strat.SL + 2 * (CFG.strat.FEE + CFG.strat.SLIP)),
};
