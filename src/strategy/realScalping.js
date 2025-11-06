// 스코어→확률 p, 비용 임계치 p*

import { logistic, clamp } from "../util/math.js";
const nz = (x) => (Number.isFinite(x) ? x : 0);

export function buildSignal({ rsi, vol, ob, candle }) {
  const w = { rsi: 0.25, vol: 0.25, ob: 0.3, candle: 0.2 };
  const s =
    w.rsi * nz(rsi) + w.vol * nz(vol) + w.ob * nz(ob) + w.candle * nz(candle);
  const z = (s - 0.5) * 6;
  return clamp(logistic(z), 0, 1);
}

export const pStar = ({ TP, SL, FEE, SLIP }) => (SL + FEE + SLIP) / (TP + SL);

export function shouldEnter(p, cfg) {
  const th = pStar(cfg);
  return { pass: nz(p) >= th, pStar: th };
}
