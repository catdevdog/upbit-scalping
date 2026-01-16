// src/config/index.js
// 환경설정 로더 (승률 우선 전략 - 개선 버전)

import fs from "fs";
import path from "path";

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

export const CFG = {
  run: {
    market: env("MARKET", "KRW-BTC"),
    intervalMs: num("INTERVAL_MS", 500),
    paper: bool("PAPER", true),
    targetTradesMin: num("TARGET_TRADES_MIN", 1), // Low frequency: min 1 trade
    targetTradesMax: num("TARGET_TRADES_MAX", 3), // Low frequency: max 3 trades
  },

  // 리스크/사이징 (수익률(복리) 안정화를 위해 올인 방지)
  risk: {
    // 1회 진입에 사용할 잔고 상한 비율 (예: 0.9 = 90% - Low Freq)
    positionPctMax: num("POSITION_PCT_MAX", 0.9),
    // 트레이드당 허용 손실 비율 (예: 0.005 = 0.5%). 0이면 비활성
    riskPctPerTrade: num("RISK_PCT_PER_TRADE", 0),
    // 최소 주문 금액(KRW)
    minSize: num("MIN_ORDER_KRW", 5000),
    // 절대 상한(KRW). 0이면 무제한
    maxSize: num("MAX_ORDER_KRW", 0),
  },

  strat: {
    // 손익 (저빈도 수익 지향: 1:2 손익비)
    TP: num("TP", 0.045), // Target 4.5%
    SL: num("SL", 0.02), // Stop Loss 2.0%
    FEE: num("FEE", 0.0005),
    SLIP: num("SLIP", 0.0003),

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

    // 청산 (저빈도 수익 지향)
    TIMEOUT_SEC: num("TIMEOUT_SEC", 21600), // 6 hours
    STALL_SEC: num("STALL_SEC", 3600), // 1 hour stall check
    BE_TRIGGER: num("BE_TRIGGER", 0.003),
    BE_OFFSET: num("BE_OFFSET", 0.0008),
    TRAIL_PCT: num("TRAIL_PCT", 0.0012), // ✅ 0.0015 → 0.0012
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
    timeSplit: bool("ML_TIME_SPLIT", true),
    useOrderbookFeatures: bool("ML_USE_OB_FEATURES", true),
    modelPathOb: env("ML_MODEL_PATH_OB", "./logs/ml_model_ob.json"),
    obRequired: bool("ML_OB_REQUIRED", true),
    tp: num("ML_TP", num("TP", 0.045)),
    sl: num("ML_SL", num("SL", 0.02)),
    tpAtrMult: num("ML_TP_ATR_MULT", 2.2),
    slAtrMult: num("ML_SL_ATR_MULT", 2.8),
    tpMin: num("ML_TP_MIN", 0.003),
    tpMax: num("ML_TP_MAX", 0.02),
    slMin: num("ML_SL_MIN", 0.004),
    slMax: num("ML_SL_MAX", 0.03),
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
    // 신규: 손실 여부와 무관하게, 진입 간 최소 간격(저빈도 운용용)
    MIN_ENTRY_GAP_MINUTES: num("MIN_ENTRY_GAP_MINUTES", 0),
    MAX_CONSECUTIVE_LOSSES: num("MAX_CONSECUTIVE_LOSSES", 2),
    COOLDOWN_AFTER_LOSS_MINUTES: num("COOLDOWN_AFTER_LOSS_MINUTES", 20),
    MAX_DAILY_LOSSES: num("MAX_DAILY_LOSSES", 20),
    DAILY_LOSS_LIMIT_PCT: num("DAILY_LOSS_LIMIT_PCT", 0.1),
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

// 파생값: 손익분기 승률
export const DERIVED = {
  pRequired:
    (CFG.strat.SL + CFG.strat.FEE + CFG.strat.SLIP) /
    (CFG.strat.TP + CFG.strat.SL),
};
