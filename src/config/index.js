// src/config/index.js
// 환경설정 로더 (승률 우선 전략)

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
    targetTradesMin: num("TARGET_TRADES_MIN", 3),
    targetTradesMax: num("TARGET_TRADES_MAX", 5),
  },

  strat: {
    // 손익
    TP: num("TP", 0.006),
    SL: num("SL", 0.009),
    FEE: num("FEE", 0.0005),
    SLIP: num("SLIP", 0.0003),

    // ATR
    ATR_PERIOD: num("ATR_PERIOD", 14),
    ATR_P_LO: num("ATR_P_LO", 0.45),
    ATR_P_HI: num("ATR_P_HI", 0.85),
    MIN_ATR_PCT: num("MIN_ATR_PCT", 0.045),

    // RVOL
    RVOL_BASE_MIN: num("RVOL_BASE_MIN", 120),
    MIN_RVOL: num("MIN_RVOL", 1.8),

    // 추세
    TREND_EMA_FAST: num("TREND_EMA_FAST", 20),
    TREND_EMA_SLOW: num("TREND_EMA_SLOW", 50),
    TREND_EMA_RATIO_MIN: num("TREND_EMA_RATIO_MIN", 1.005),
    REQUIRE_VWAP_ABOVE: bool("REQUIRE_VWAP_ABOVE", true),
    VWAP_MARGIN_MIN: num("VWAP_MARGIN_MIN", 0.002),
    REQUIRE_1M_UPTREND: bool("REQUIRE_1M_UPTREND", true),
    MIN_1M_MOMENTUM: num("MIN_1M_MOMENTUM", 0.0008),

    // 오더북
    MAX_SPREAD_TICKS: num("MAX_SPREAD_TICKS", 1),
    MIN_IMB: num("MIN_IMB", 0.35),
    MIN_BEST_BID_SHARE: num("MIN_BEST_BID_SHARE", 0.65),

    // RSI
    RSI_MIN: num("RSI_MIN", 48),
    RSI_MAX: num("RSI_MAX", 68),
    RSI_OPTIMAL_MIN: num("RSI_OPTIMAL_MIN", 52),
    RSI_OPTIMAL_MAX: num("RSI_OPTIMAL_MAX", 62),

    // 확률
    MIN_PROB_ENTRY: num("MIN_PROB_ENTRY", 0.78),
    PROB_BUFFER: num("PROB_BUFFER", 0.08),

    // 청산
    TIMEOUT_SEC: num("TIMEOUT_SEC", 300),
    STALL_SEC: num("STALL_SEC", 150),
    BE_TRIGGER: num("BE_TRIGGER", 0.003),
    BE_OFFSET: num("BE_OFFSET", 0.0008),
    TRAIL_PCT: num("TRAIL_PCT", 0.0015),
  },

  partial: {
    ENABLED: bool("PARTIAL_TAKE_ENABLED", true),
    TAKE_AT: num("PARTIAL_TAKE_AT", 0.004),
    TAKE_RATIO: num("PARTIAL_TAKE_RATIO", 0.5),
  },

  limits: {
    TRADING_HOURS_ENABLED: bool("TRADING_HOURS_ENABLED", true),
    TRADING_HOURS_START: num("TRADING_HOURS_START", 9),
    TRADING_HOURS_END: num("TRADING_HOURS_END", 23),
    AVOID_WEEKENDS: bool("AVOID_WEEKENDS", true),
    MAX_CONSECUTIVE_LOSSES: num("MAX_CONSECUTIVE_LOSSES", 2),
    COOLDOWN_AFTER_LOSS_MINUTES: num("COOLDOWN_AFTER_LOSS_MINUTES", 60),
    MAX_DAILY_LOSSES: num("MAX_DAILY_LOSSES", 3),
    DAILY_LOSS_LIMIT_PCT: num("DAILY_LOSS_LIMIT_PCT", 0.015),
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
