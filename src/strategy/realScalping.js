// 스코어→확률 p, 비용 임계치 p*

import { logistic, clamp } from "../util/math.js";
import { DERIVED } from "../config/index.js";
const nz = (x) => (Number.isFinite(x) ? x : 0);

export function buildSignal({ rsi, vol, ob, candle }) {
  const w = { rsi: 0.2, vol: 0.25, ob: 0.4, candle: 0.15 };
  const s =
    w.rsi * nz(rsi) + w.vol * nz(vol) + w.ob * nz(ob) + w.candle * nz(candle);
  const z = (s - 0.5) * 5;
  return clamp(logistic(z), 0, 1);
}

export function shouldEnter(p) {
  // Use derived p* from config (global single source)
  const th = DERIVED?.pRequired ?? 0;
  return { pass: nz(p) >= th, pStar: th };
}
