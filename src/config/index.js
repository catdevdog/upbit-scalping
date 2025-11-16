// 환경설정 및 상수 + .env 로더

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

export const CFG = {
  run: {
    market: env("MARKET", "KRW-BTC"),
    intervalMs: Number(env("INTERVAL_MS", "400")),
    paper: env("PAPER", "true") === "true",
    targetTradesMin: Number(env("TARGET_TRADES_MIN", "12")),
    targetTradesMax: Number(env("TARGET_TRADES_MAX", "25")),
  },
  strat: {
    TP: Number(env("TP", "0.0040")),
    SL: Number(env("SL", "0.0030")),
    FEE: Number(env("FEE", "0.0010")),
    SLIP: Number(env("SLIP", "0.0005")),
    ATR_PERIOD: Number(env("ATR_PERIOD", "14")),
    ATR_P_LO: Number(env("ATR_P_LO", "0.26")),
    ATR_P_HI: Number(env("ATR_P_HI", "0.85")),
    MIN_ATR_PCT: Number(env("MIN_ATR_PCT", "0.055")),
    RVOL_BASE_MIN: Number(env("RVOL_BASE_MIN", "120")),
    MIN_RVOL: Number(env("MIN_RVOL", "1.6")),
    MAX_SPREAD_TICKS: Number(env("MAX_SPREAD_TICKS", "2")),
    MIN_IMB: Number(env("MIN_IMB", "0.20")),

    // 우선순위 4개
    TREND_EMA_FAST: Number(env("TREND_EMA_FAST", "20")),
    TREND_EMA_SLOW: Number(env("TREND_EMA_SLOW", "50")),
    REQUIRE_VWAP_ABOVE: env("REQUIRE_VWAP_ABOVE", "false") === "true",
    TIMEOUT_SEC: Number(env("TIMEOUT_SEC", "80")),
    STALL_SEC: Number(env("STALL_SEC", "55")),
    BE_TRIGGER: Number(env("BE_TRIGGER", "0.0015")),
    BE_OFFSET: Number(env("BE_OFFSET", "0.0003")),
    TRAIL_PCT: Number(env("TRAIL_PCT", "0.0016")),
  },
  log: {
    dir: env("LOG_DIR", "./logs"),
    tradeFile: env("TRADE_LOG", "trades.jsonl"),
  },
  paper: {
    krw: Number(env("PAPER_KRW", "5000000")),
  },
  ui: {
    showGlossary: env("SHOW_GLOSSARY", "true") === "true",
    useAltScreen: env("USE_ALT_SCREEN", "true") === "true",
    minRenderMs: Number(env("MIN_RENDER_MS", "120")),
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

// 파생: 손익분기 승률 p* = (SL+FEE+SLIP)/(TP+SL)
export const DERIVED = {
  pRequired:
    (CFG.strat.SL + CFG.strat.FEE + CFG.strat.SLIP) /
    (CFG.strat.TP + CFG.strat.SL),
};
