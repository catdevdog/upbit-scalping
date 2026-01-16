// src/strategy/highWinRateEntry.js
// 승률 우선 진입 조건 - 모든 필터를 통과해야만 진입

import { clamp, logistic } from "../util/math.js";
import { CFG } from "../config/index.js";

/**
 * 승률 우선 진입 조건 체크
 * @returns {pass: boolean, reason: string, confidence: number}
 */
export function checkHighWinRateEntry(params) {
  const {
    // 가격 & 추세
    currentPrice,
    emaFast,
    emaSlow,
    vwap,

    // 변동성 & 거래량
    atrPct,
    atrLo,
    atrHi,
    rvol,

    // 호가창
    orderbook,

    // 모멘텀
    rsi,

    // 1분봉 추세
    candles1m,

    // 확률
    probability,
    pStar,
  } = params;

  const checks = [];
  let totalScore = 0;
  const weights = {
    trend: 0.25, // 추세 25%
    volatility: 0.15, // 변동성 15%
    volume: 0.15, // 거래량 15%
    orderbook: 0.25, // 호가창 25%
    momentum: 0.2, // 모멘텀 20%
  };

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 1. 추세 필터 (가장 중요)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  // 1-1. 5분 EMA 상승 추세
  const trendEmaRatioMin = Number(process.env.TREND_EMA_RATIO_MIN || 1.005);
  const emaRatio = emaFast / Math.max(emaSlow, 1);
  const emaPass = emaFast > emaSlow && emaRatio >= trendEmaRatioMin;

  if (!emaPass) {
    return {
      pass: false,
      reason: `EMA 추세 부족: ${emaFast.toFixed(0)} / ${emaSlow.toFixed(
        0
      )} = ${emaRatio.toFixed(4)} (최소 ${trendEmaRatioMin} 필요)`,
      confidence: 0,
      detail: checks,
    };
  }
  checks.push({ name: "EMA 추세", pass: true, score: 1.0 });

  // 1-2. VWAP 상회
  const vwapMarginMin = Number(process.env.VWAP_MARGIN_MIN || 0.002);
  const vwapMargin = (currentPrice - vwap) / vwap;
  const vwapPass = Number.isFinite(vwap) && vwapMargin >= vwapMarginMin;

  if (CFG.strat.REQUIRE_VWAP_ABOVE && !vwapPass) {
    return {
      pass: false,
      reason: `VWAP 미달: 현재 ${currentPrice.toLocaleString()} vs VWAP ${vwap?.toFixed?.(
        0
      )} (격차 ${(vwapMargin * 100).toFixed(2)}%, 최소 ${(
        vwapMarginMin * 100
      ).toFixed(2)}% 필요)`,
      confidence: 0,
      detail: checks,
    };
  }
  checks.push({ name: "VWAP 상회", pass: true, score: 1.0 });

  // 1-3. 1분봉 단기 상승 추세 (신규)
  const require1mUptrend = process.env.REQUIRE_1M_UPTREND === "true";
  const min1mMomentum = Number(process.env.MIN_1M_MOMENTUM || 0.0008);

  if (require1mUptrend && candles1m?.length >= 5) {
    const recent5 = candles1m.slice(0, 5); // 최신 5개
    const allRising = recent5.every((c, i) => {
      if (i === recent5.length - 1) return true;
      return c.c >= recent5[i + 1].c;
    });

    const momentum5m = (recent5[0].c - recent5[4].c) / recent5[4].c;
    const momentumPass = momentum5m >= min1mMomentum;

    if (!allRising || !momentumPass) {
      return {
        pass: false,
        reason: `1분봉 추세 부족: 최근 5분 ${
          allRising ? "상승" : "하락 포함"
        }, 모멘텀 ${(momentum5m * 100).toFixed(3)}% (최소 ${(
          min1mMomentum * 100
        ).toFixed(2)}% 필요)`,
        confidence: 0,
        detail: checks,
      };
    }
  }
  checks.push({ name: "1분 추세", pass: true, score: 1.0 });

  totalScore += weights.trend;

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 2. 변동성 필터
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  const atrPass =
    Number.isFinite(atrPct) &&
    atrPct >= Number(process.env.MIN_ATR_PCT || 0.045) &&
    atrPct >= atrLo &&
    atrPct <= atrHi;

  if (!atrPass) {
    return {
      pass: false,
      reason: `ATR 부적합: 현재 ${atrPct?.toFixed?.(
        3
      )}% [범위 ${atrLo?.toFixed?.(3)}% ~ ${atrHi?.toFixed?.(3)}%]`,
      confidence: 0,
      detail: checks,
    };
  }
  checks.push({ name: "ATR", pass: true, score: 1.0 });
  totalScore += weights.volatility;

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 3. 거래량 필터
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  const minRvol = Number(process.env.MIN_RVOL || 1.8);
  const rvolPass = rvol >= minRvol;

  if (!rvolPass) {
    return {
      pass: false,
      reason: `거래량 부족: 현재 ${rvol.toFixed(2)}x (최소 ${minRvol.toFixed(
        2
      )}x 필요)`,
      confidence: 0,
      detail: checks,
    };
  }

  // 거래량 점수: 1.8x = 0.7점, 2.5x+ = 1.0점
  const rvolScore = clamp((rvol - minRvol) / (2.5 - minRvol), 0, 1) * 0.3 + 0.7;
  checks.push({ name: "RVOL", pass: true, score: rvolScore });
  totalScore += weights.volume * rvolScore;

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 4. 호가창 필터 (매우 중요)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  const { spreadTicks, imbalance, bestBidShare } = orderbook;
  const maxSpread = Number(process.env.MAX_SPREAD_TICKS || 1);
  const minImb = Number(process.env.MIN_IMB || 0.35);
  const minBestBid = Number(process.env.MIN_BEST_BID_SHARE || 0.65);

  const spreadPass = spreadTicks <= maxSpread;
  const imbPass = imbalance >= minImb;
  const bestBidPass = bestBidShare >= minBestBid;

  if (!spreadPass) {
    return {
      pass: false,
      reason: `스프레드 과대: ${spreadTicks}틱 (최대 ${maxSpread}틱)`,
      confidence: 0,
      detail: checks,
    };
  }

  if (!imbPass) {
    return {
      pass: false,
      reason: `호가 불균형 부족: ${(imbalance * 100).toFixed(1)}% (최소 ${(
        minImb * 100
      ).toFixed(1)}% 필요)`,
      confidence: 0,
      detail: checks,
    };
  }

  if (!bestBidPass) {
    return {
      pass: false,
      reason: `최우선 매수 비중 부족: ${(bestBidShare * 100).toFixed(
        1
      )}% (최소 ${(minBestBid * 100).toFixed(1)}% 필요)`,
      confidence: 0,
      detail: checks,
    };
  }

  // 호가창 종합 점수
  const obScore =
    (spreadPass ? 0.3 : 0) +
    clamp((imbalance - minImb) / (0.5 - minImb), 0, 1) * 0.4 +
    clamp((bestBidShare - minBestBid) / (0.85 - minBestBid), 0, 1) * 0.3;
  checks.push({ name: "호가창", pass: true, score: obScore });
  totalScore += weights.orderbook * obScore;

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 5. 모멘텀 필터 (RSI)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  const rsiMin = Number(process.env.RSI_MIN || 48);
  const rsiMax = Number(process.env.RSI_MAX || 68);
  const rsiOptMin = Number(process.env.RSI_OPTIMAL_MIN || 52);
  const rsiOptMax = Number(process.env.RSI_OPTIMAL_MAX || 62);

  const rsiInRange = rsi >= rsiMin && rsi <= rsiMax;
  const rsiOptimal = rsi >= rsiOptMin && rsi <= rsiOptMax;

  if (!rsiInRange) {
    return {
      pass: false,
      reason: `RSI 범위 이탈: ${rsi.toFixed(1)} (허용 ${rsiMin}-${rsiMax})`,
      confidence: 0,
      detail: checks,
    };
  }

  // RSI 점수: 최적 구간이면 1.0, 경계면 0.6
  const rsiScore = rsiOptimal ? 1.0 : 0.6;
  checks.push({ name: "RSI", pass: true, score: rsiScore });
  totalScore += weights.momentum * rsiScore;

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 6. 최종 확률 검증
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  const minProbEntry = Number(process.env.MIN_PROB_ENTRY || 0.78);
  const probBuffer = Number(process.env.PROB_BUFFER || 0.08);
  const requiredProb = Math.max(minProbEntry, pStar + probBuffer);

  const probPass = probability >= requiredProb;

  if (!probPass) {
    return {
      pass: false,
      reason: `확률 부족: p=${(probability * 100).toFixed(1)}% < 요구값 ${(
        requiredProb * 100
      ).toFixed(1)}% (p*=${(pStar * 100).toFixed(1)}% + 버퍼 ${(
        probBuffer * 100
      ).toFixed(1)}%)`,
      confidence: 0,
      detail: checks,
    };
  }

  checks.push({ name: "확률", pass: true, score: 1.0 });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 최종 판정
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  const confidence = totalScore; // 0~1 사이 값

  return {
    pass: true,
    reason: "모든 조건 충족",
    confidence,
    detail: checks,
    summary: {
      trend: `EMA ${emaRatio.toFixed(3)}, VWAP +${(vwapMargin * 100).toFixed(
        2
      )}%`,
      volatility: `ATR ${atrPct?.toFixed?.(3)}%`,
      volume: `RVOL ${rvol.toFixed(2)}x`,
      orderbook: `Spread ${spreadTicks}T, Imb ${(imbalance * 100).toFixed(
        1
      )}%, BidShare ${(bestBidShare * 100).toFixed(1)}%`,
      momentum: `RSI ${rsi.toFixed(1)}`,
      probability: `p=${(probability * 100).toFixed(1)}% (요구 ${(
        requiredProb * 100
      ).toFixed(1)}%)`,
    },
  };
}

/**
 * 시간대 필터
 */
export function checkTradingHours() {
  const enabled = process.env.TRADING_HOURS_ENABLED === "true";
  if (!enabled) return { pass: true };

  const now = new Date();
  const kstOffset = 9 * 60; // UTC+9
  const kstTime = new Date(now.getTime() + kstOffset * 60 * 1000);
  const hour = kstTime.getUTCHours();
  const day = kstTime.getUTCDay(); // 0=일요일

  const start = Number(process.env.TRADING_HOURS_START || 9);
  const end = Number(process.env.TRADING_HOURS_END || 23);

  // 시간대 체크
  if (hour < start || hour >= end) {
    return {
      pass: false,
      reason: `거래 시간 외: 현재 ${hour}시 (허용 ${start}-${end}시)`,
    };
  }

  // 주말 체크
  const avoidWeekends = process.env.AVOID_WEEKENDS === "true";
  if (avoidWeekends) {
    // 토요일 12시 이후 ~ 일요일 종일 제외
    if (day === 0 || (day === 6 && hour >= 12)) {
      return {
        pass: false,
        reason: "주말 거래 제한",
      };
    }
  }

  return { pass: true };
}

/**
 * 연속 손실 체크
 */
export function checkConsecutiveLosses(recentTrades) {
  const maxConsec = Number(process.env.MAX_CONSECUTIVE_LOSSES || 2);
  const cooldownMin = Number(process.env.COOLDOWN_AFTER_LOSS_MINUTES || 60);

  if (!recentTrades?.length) return { pass: true };

  // 최근 연속 손실 카운트
  let consecLosses = 0;
  let lastLossTime = null;

  for (const trade of recentTrades) {
    if (Number(trade.pnlKRW) < 0) {
      consecLosses++;
      if (!lastLossTime) lastLossTime = trade.exitTs || trade.tsEpoch;
    } else {
      break; // 승리가 나오면 카운트 리셋
    }
  }

  if (consecLosses >= maxConsec && lastLossTime) {
    const cooldownMs = cooldownMin * 60 * 1000;
    const elapsed = Date.now() - lastLossTime;

    if (elapsed < cooldownMs) {
      const remainMin = Math.ceil((cooldownMs - elapsed) / 60000);
      return {
        pass: false,
        reason: `${consecLosses}연패 후 휴식: ${remainMin}분 남음`,
      };
    }
  }

  return { pass: true };
}

/**
 * 일일 손실 제한
 */
export function checkDailyLimits(todayTrades) {
  const maxDailyLosses = Number(process.env.MAX_DAILY_LOSSES || 3);
  const dailyLossLimit = Number(process.env.DAILY_LOSS_LIMIT_PCT || 0.015);

  if (!todayTrades?.length) return { pass: true };

  // 오늘 손실 횟수
  const losses = todayTrades.filter((t) => Number(t.pnlKRW) < 0);
  if (losses.length >= maxDailyLosses) {
    return {
      pass: false,
      reason: `일일 손실 횟수 초과: ${losses.length}/${maxDailyLosses}회`,
    };
  }

  // 오늘 총 손실
  const totalPnL = todayTrades.reduce(
    (sum, t) => sum + Number(t.pnlKRW || 0),
    0
  );

  // ✅ 개선: 고정 초기자본 가정 대신 현재 총자산(equity) 기반으로 계산
  // equity가 전달되지 않거나 비정상이면 기존 5,000,000 KRW 가정으로 폴백
  const equityKRW = arguments.length >= 2 ? Number(arguments[1]) : NaN;
  const base =
    Number.isFinite(equityKRW) && equityKRW > 0 ? equityKRW : 5000000;
  const totalPnLPct = totalPnL / base;

  if (totalPnLPct <= -dailyLossLimit) {
    return {
      pass: false,
      reason: `일일 손실 한도 초과: ${(totalPnLPct * 100).toFixed(
        2
      )}% (한도 -${(dailyLossLimit * 100).toFixed(1)}%)`,
    };
  }

  return { pass: true };
}
