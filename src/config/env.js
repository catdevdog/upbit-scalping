import dotenv from "dotenv";
dotenv.config();

class Config {
  constructor() {
    this.validate();
  }

  validate() {
    const required = ["UPBIT_ACCESS_KEY", "UPBIT_SECRET_KEY", "MARKET"];
    for (const key of required) {
      if (!process.env[key]) {
        throw new Error(`환경변수 ${key}가 설정되지 않았습니다.`);
      }
    }
  }

  get(key, defaultValue = null) {
    return process.env[key] || defaultValue;
  }

  getNumber(key, defaultValue = 0) {
    return Number(process.env[key]) || defaultValue;
  }

  getBoolean(key, defaultValue = false) {
    const value = process.env[key];
    if (value === undefined) return defaultValue;
    return value === "true";
  }

  // === API 인증 ===
  get UPBIT_ACCESS_KEY() {
    return this.get("UPBIT_ACCESS_KEY");
  }
  get UPBIT_SECRET_KEY() {
    return this.get("UPBIT_SECRET_KEY");
  }

  // === 거래 설정 ===
  get MARKET() {
    return this.get("MARKET");
  }
  get TRADE_CHECK_INTERVAL() {
    return this.getNumber("TRADE_CHECK_INTERVAL", 5000);
  }
  get RISK_CHECK_INTERVAL() {
    return this.getNumber("RISK_CHECK_INTERVAL", 1000);
  }

  // === 투자 설정 ===
  get INVESTMENT_RATIO() {
    return this.getNumber("INVESTMENT_RATIO", 0.999);
  }
  get MIN_KRW_RESERVE() {
    return this.getNumber("MIN_KRW_RESERVE", 5000);
  }

  // === ✅ Dust 처리 ===
  get DUST_THRESHOLD_KRW() {
    return this.getNumber("DUST_THRESHOLD_KRW", 100);
  }
  get AUTO_IGNORE_DUST() {
    return this.getBoolean("AUTO_IGNORE_DUST", true);
  }

  // === ✅ 수수료 상수 (업비트 기준) ===
  get UPBIT_MAKER_FEE() {
    return 0.05; // 0.05%
  }
  get UPBIT_TAKER_FEE() {
    return 0.05; // 0.05%
  }
  get UPBIT_TOTAL_FEE() {
    return this.UPBIT_MAKER_FEE + this.UPBIT_TAKER_FEE; // 0.1%
  }

  // === 전략 활성화 (스캘핑 전용) ===
  get STRATEGY_RSI() {
    return this.getBoolean("STRATEGY_RSI", true);
  }
  get STRATEGY_VOLUME() {
    return this.getBoolean("STRATEGY_VOLUME", true);
  }
  get STRATEGY_ORDERBOOK() {
    return this.getBoolean("STRATEGY_ORDERBOOK", false);
  }
  get STRATEGY_CANDLE() {
    return this.getBoolean("STRATEGY_CANDLE", true);
  }

  // === 스캘핑 모드 (고정) ===
  get STRATEGY_MODE() {
    return "aggressive";
  }

  // === 진입 설정 ===
  get ENTRY_SCORE_THRESHOLD() {
    return this.getNumber("ENTRY_SCORE_THRESHOLD", 40);
  }
  get MIN_SIGNALS() {
    return this.getNumber("MIN_SIGNALS", 1);
  }

  // === 시장 필터 ===
  get MARKET_FILTER_ENABLED() {
    return this.getBoolean("MARKET_FILTER_ENABLED", true);
  }
  get MARKET_FAVORABLE_THRESHOLD() {
    return this.getNumber("MARKET_FAVORABLE_THRESHOLD", 50);
  }
  get BLOCK_HIGH_VOLATILITY() {
    return this.getBoolean("BLOCK_HIGH_VOLATILITY", true);
  }
  get VOLATILITY_THRESHOLD() {
    return this.getNumber("VOLATILITY_THRESHOLD", 2.0);
  }

  // === 손절/익절 ===
  get STOP_LOSS_PERCENT() {
    return this.getNumber("STOP_LOSS_PERCENT", -0.8);
  }
  get TAKE_PROFIT_PERCENT() {
    return this.getNumber("TAKE_PROFIT_PERCENT", 0.8);
  }
  get QUICK_PROFIT_PERCENT() {
    return this.getNumber("QUICK_PROFIT_PERCENT", 0.5);
  }
  get TRAILING_STOP_ENABLED() {
    return this.getBoolean("TRAILING_STOP_ENABLED", true);
  }
  get TRAILING_STOP_PERCENT() {
    return this.getNumber("TRAILING_STOP_PERCENT", 0.25);
  }

  // === 시간 기반 청산 ===
  get MAX_HOLDING_TIME() {
    return this.getNumber("MAX_HOLDING_TIME", 180);
  }
  get PROFIT_TIME_LIMIT() {
    return this.getNumber("PROFIT_TIME_LIMIT", 120); // ✅ 90초 → 120초로 증가
  }
  get SIDEWAYS_TIME_LIMIT() {
    return this.getNumber("SIDEWAYS_TIME_LIMIT", 60);
  }

  // === ✅ 모멘텀 기반 청산 (수수료 고려 상향) ===
  get MOMENTUM_CHECK_PERIOD() {
    return this.getNumber("MOMENTUM_CHECK_PERIOD", 20);
  }
  get MOMENTUM_THRESHOLD() {
    return this.getNumber("MOMENTUM_THRESHOLD", 0.08);
  }
  get SIDEWAYS_EXIT_THRESHOLD() {
    // ✅ 0.25% → 0.5%로 상향 (수수료 0.1% 고려)
    return this.getNumber("SIDEWAYS_EXIT_THRESHOLD", 0.5);
  }
  get MIN_PROFIT_FOR_TIME_EXIT() {
    // ✅ 시간 기반 청산 최소 수익률 (수수료 + 최소 이익)
    return this.getNumber("MIN_PROFIT_FOR_TIME_EXIT", 0.4);
  }

  // === 역추세 감지 ===
  get REVERSE_SIGNAL_CHECK() {
    return this.getBoolean("REVERSE_SIGNAL_CHECK", true);
  }
  get RSI_OVERBOUGHT() {
    return this.getNumber("RSI_OVERBOUGHT", 70);
  }

  // === API 재시도 ===
  get API_RETRY_MAX_ATTEMPTS() {
    return this.getNumber("API_RETRY_MAX_ATTEMPTS", 5);
  }
  get API_RETRY_DELAY() {
    return this.getNumber("API_RETRY_DELAY", 2000);
  }
  get API_RETRY_BACKOFF() {
    return this.getNumber("API_RETRY_BACKOFF", 2.0);
  }

  // === 비상 정지 ===
  get EMERGENCY_STOP_ENABLED() {
    return this.getBoolean("EMERGENCY_STOP_ENABLED", true);
  }
  get EMERGENCY_PRICE_DROP_PERCENT() {
    return this.getNumber("EMERGENCY_PRICE_DROP_PERCENT", -10);
  }
  get EMERGENCY_NETWORK_TIMEOUT() {
    return this.getNumber("EMERGENCY_NETWORK_TIMEOUT", 20000);
  }
  get EMERGENCY_API_ERROR_THRESHOLD() {
    return this.getNumber("EMERGENCY_API_ERROR_THRESHOLD", 10);
  }

  // === 로깅 ===
  get LOG_LEVEL() {
    return this.get("LOG_LEVEL", "info");
  }
  get LOG_TO_FILE() {
    return this.getBoolean("LOG_TO_FILE", true);
  }
  get LOG_CONSOLE_ENABLED() {
    return this.getBoolean("LOG_CONSOLE_ENABLED", true);
  }
}

export default new Config();
