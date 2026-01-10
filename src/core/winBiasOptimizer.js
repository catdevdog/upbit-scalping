import { clamp } from "../util/math.js";

const toNumber = (value, fallback = 0) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
};

const pctToFrac = (pct) => {
  if (!Number.isFinite(pct)) return NaN;
  return pct / 100;
};

const calcPRequired = (tpPct, slPct, feePct = 0, slipPct = 0) => {
  const tp = Math.max(0, Number(tpPct) || 0);
  const sl = Math.max(0, Number(slPct) || 0);
  const fee = Math.max(0, Number(feePct) || 0);
  const slip = Math.max(0, Number(slipPct) || 0);
  const denom = tp + sl;
  if (!Number.isFinite(denom) || denom <= 0) return 1;
  return clamp((sl + fee + slip) / denom, 0, 1);
};

/**
 * 스캘핑 특화: "승률 우선" 파라미터 자동 도출
 * - ATR, RVOL, 스프레드를 기반으로 TP/SL/타임아웃/필터를 동적으로 산출
 * - TP는 수수료·슬리피지 상쇄 후 최소값을 확보하고, SL은 TP 대비 3~5배로 설정
 */
export function deriveWinBiasTargets(params = {}) {
  const {
    atrPct,
    rvol,
    spreadTicks,
    imbalance,
    feePct,
    slipPct,
    base = {},
  } = params;

  const atrClean = clamp(toNumber(atrPct, 0.32), 0.03, 1.0);
  const atrFrac = pctToFrac(atrClean);
  const rv = clamp(toNumber(rvol, 1), 0.6, 3.5);
  const spreadT = Math.max(0, toNumber(spreadTicks, 1));
  const imb = clamp(toNumber(imbalance, 0.3), 0, 1);
  const fee = Math.max(0, toNumber(feePct, 0));
  const slip = Math.max(0, toNumber(slipPct, 0));
  const feeStack = fee + slip;

  const tpFloor = feeStack + 0.00025;
  const tpAtr = clamp((atrFrac || 0) * 0.75, 0, 0.0025);
  const tpPct = clamp(tpFloor + tpAtr, 0.0012, 0.0036);

  const rvAdj = rv >= 1.9 ? -0.25 : rv >= 1.6 ? -0.15 : rv <= 1.1 ? 0.15 : 0;
  const slBias = clamp(1.85 + rvAdj, 1.3, 2.05);
  const slPct = clamp(tpPct * slBias + feeStack * 0.1, tpPct * 1.3, 0.0055);

  const stallSec = clamp(
    Math.round(Math.max((tpPct / Math.max(atrFrac || 1e-4, 1e-4)) * 6.5, 6)),
    6,
    24
  );
  const timeoutSec = clamp(
    stallSec + 6 + Math.round(rv * 2),
    Math.min(stallSec + 8, 14),
    40
  );

  const minRvol = clamp(
    Math.max(base.minRvol ?? 1.15, 1.12 + (0.35 - Math.min(imb, 0.35)) * 0.2),
    1.12,
    1.65
  );
  const maxSpreadTicks = clamp(
    Math.round(
      spreadT <= 1
        ? Math.max(1, base.maxSpreadTicks ?? 1)
        : Math.min(base.maxSpreadTicks ?? 2, 2)
    ),
    1,
    2
  );
  const minImb = clamp(
    Math.max(base.minImb ?? 0.2, 0.2) + (rv >= 1.6 ? 0.08 : 0.04),
    0.2,
    0.4
  );

  const rawPRequired = calcPRequired(tpPct, slPct, fee, slip);
  const pRequired = clamp(rawPRequired, 0.55, 0.72);

  return {
    tpPct,
    slPct,
    stallSec,
    timeoutSec,
    minRvol,
    maxSpreadTicks,
    minImb,
    pRequired,
    notes: {
      atrPct: atrClean,
      rvol: rv,
      spreadTicks: spreadT,
    },
    base,
  };
}

export { calcPRequired };
