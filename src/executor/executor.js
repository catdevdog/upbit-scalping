import { roundToTick } from "../util/tick.js";
import { CFG } from "../config/index.js";
import * as Upbit from "../api/upbitAdapter.js";
import { appendTrade } from "../monitor/tradeLog.js";
import { nowKSTString } from "../util/math.js";

export class Executor {
  constructor(risk) {
    this.risk = risk;
    this.position = null;
    this.krw = CFG.paper.krw;
    this.pnlKRW = 0;
  }
  paperMode() {
    return CFG.run.paper || !Upbit.hasKeys();
  }
  sync() {}

  async enterLong({ price, atrPct, market = CFG.run.market }) {
    if (this.position) return { ok: false, reason: "이미 포지션 존재" };
    const sizeKRW = this.risk.allocateKRW({
      krwBalance: this.krw,
      SLpct: CFG.strat.SL,
      atrPct,
    });
    if (sizeKRW < 5000) return { ok: false, reason: "최소주문금액 미달" };

    if (this.paperMode()) {
      const p = roundToTick(price);
      const size = sizeKRW / p;
      this.position = {
        side: "LONG",
        entry: p,
        sizeKRW,
        size,
        tp: p * (1 + CFG.strat.TP),
        sl: p * (1 - CFG.strat.SL),
        entryTs: Date.now(),
        movedToBE: false,
        trailHigh: p,
      };
      this.krw -= sizeKRW;
      appendTrade({
        type: "ENTRY",
        ts: nowKSTString(),
        market,
        side: "LONG",
        price: p,
        size,
        sizeKRW,
      });
      return { ok: true, paper: true, price: p };
    }

    // 실거래: 시장가 매수(KRW 금액). 체결가/수량은 응답에서 계산.
    const res = await Upbit.placeMarketBuyKRW({ market, krw: sizeKRW });
    let filledVol = 0,
      notional = 0;
    for (const t of res.trades || []) {
      const vol = Number(t.volume || 0),
        pr = Number(t.price || 0);
      filledVol += vol;
      notional += vol * pr;
    }
    const entry = filledVol > 0 ? notional / filledVol : price;
    const size = filledVol > 0 ? filledVol : sizeKRW / entry;

    this.position = {
      side: "LONG",
      entry,
      sizeKRW,
      size,
      tp: entry * (1 + CFG.strat.TP),
      sl: entry * (1 - CFG.strat.SL),
      entryTs: Date.now(),
      movedToBE: false,
      trailHigh: entry,
    };
    appendTrade({
      type: "ENTRY",
      ts: nowKSTString(),
      market,
      side: "LONG",
      price: entry,
      size,
      sizeKRW,
      orderId: res.uuid,
    });
    return { ok: true, paper: false, price: entry, orderId: res.uuid };
  }

  updateStops(last) {
    if (!this.position || this.position.side !== "LONG") return;
    const p = this.position;
    p.trailHigh = Math.max(p.trailHigh, last);
    if (!p.movedToBE && last >= p.entry * (1 + CFG.strat.BE_TRIGGER)) {
      p.sl = Math.max(p.sl, p.entry * (1 + CFG.strat.BE_OFFSET));
      p.movedToBE = true;
    }
    p.sl = Math.max(p.sl, p.trailHigh * (1 - CFG.strat.TRAIL_PCT));
  }

  // 가격 기반 TP/SL: 실거래는 시장가 매도
  async maybeExitByPrice(last, market = CFG.run.market) {
    if (!this.position) return null;
    const { entry, size, tp, sl } = this.position;

    // TP
    if (last >= tp) {
      if (this.paperMode()) {
        const ret = (tp - entry) * size;
        this.pnlKRW += ret;
        this.krw += size * tp;
        this.position = null;
        appendTrade({
          type: "EXIT",
          ts: nowKSTString(),
          market,
          side: "LONG",
          reason: "TP",
          exit: tp,
          entry,
          size,
          pnlKRW: ret,
        });
        return { reason: "TP", retKRW: ret };
      }
      const res = await Upbit.placeMarketSell({ market, volume: size });
      let notional = 0,
        vol = 0;
      for (const t of res.trades || []) {
        const v = +t.volume || 0,
          pr = +t.price || 0;
        notional += v * pr;
        vol += v;
      }
      const exit = vol > 0 ? notional / vol : last;
      const ret = (exit - entry) * size;
      this.pnlKRW += ret;
      this.position = null;
      appendTrade({
        type: "EXIT",
        ts: nowKSTString(),
        market,
        side: "LONG",
        reason: "TP",
        exit,
        entry,
        size,
        pnlKRW: ret,
        orderId: res.uuid,
      });
      return { reason: "TP", retKRW: ret };
    }

    // SL
    if (last <= sl) {
      if (this.paperMode()) {
        const ret = (sl - entry) * size;
        this.pnlKRW += ret;
        this.krw += size * sl;
        this.position = null;
        appendTrade({
          type: "EXIT",
          ts: nowKSTString(),
          market,
          side: "LONG",
          reason: "SL",
          exit: sl,
          entry,
          size,
          pnlKRW: ret,
        });
        return { reason: "SL", retKRW: ret };
      }
      const res = await Upbit.placeMarketSell({ market, volume: size });
      let notional = 0,
        vol = 0;
      for (const t of res.trades || []) {
        const v = +t.volume || 0,
          pr = +t.price || 0;
        notional += v * pr;
        vol += v;
      }
      const exit = vol > 0 ? notional / vol : last;
      const ret = (exit - entry) * size;
      this.pnlKRW += ret;
      this.position = null;
      appendTrade({
        type: "EXIT",
        ts: nowKSTString(),
        market,
        side: "LONG",
        reason: "SL",
        exit,
        entry,
        size,
        pnlKRW: ret,
        orderId: res.uuid,
      });
      return { reason: "SL", retKRW: ret };
    }
    return null;
  }

  maybeExitByTime(nowTs, last, market = CFG.run.market) {
    if (!this.position) return null;
    const { entry, size, entryTs } = this.position;
    const alive = (nowTs - entryTs) / 1000;
    if (alive >= CFG.strat.TIMEOUT_SEC) {
      if (this.paperMode()) {
        const ret = (last - entry) * size;
        this.pnlKRW += ret;
        this.position = null;
        appendTrade({
          type: "EXIT",
          ts: nowKSTString(),
          market,
          side: "LONG",
          reason: "TIMEOUT",
          exit: last,
          entry,
          size,
          pnlKRW: ret,
        });
        return { reason: "TIMEOUT", retKRW: ret };
      }
      // 시장가 청산
      return this.forceExit(last, "TIMEOUT", market);
    }
    return null;
  }

  forceExit(last, reason = "FORCE", market = CFG.run.market) {
    if (!this.position) return null;
    const { entry, size } = this.position;
    if (this.paperMode()) {
      const ret = (last - entry) * size;
      this.pnlKRW += ret;
      this.position = null;
      appendTrade({
        type: "EXIT",
        ts: nowKSTString(),
        market,
        side: "LONG",
        reason,
        exit: last,
        entry,
        size,
        pnlKRW: ret,
      });
      return { reason, retKRW: ret };
    }
    // 실거래: 시장가 매도
    return Upbit.placeMarketSell({ market, volume: size }).then((res) => {
      let notional = 0,
        vol = 0;
      for (const t of res.trades || []) {
        const v = +t.volume || 0,
          pr = +t.price || 0;
        notional += v * pr;
        vol += v;
      }
      const exit = vol > 0 ? notional / vol : last;
      const ret = (exit - entry) * size;
      this.pnlKRW += ret;
      this.position = null;
      appendTrade({
        type: "EXIT",
        ts: nowKSTString(),
        market,
        side: "LONG",
        reason,
        exit,
        entry,
        size,
        pnlKRW: ret,
        orderId: res.uuid,
      });
      return { reason, retKRW: ret };
    });
  }
}
