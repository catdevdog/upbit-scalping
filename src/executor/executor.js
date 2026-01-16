// src/executor/executor.js
// 주문 실행 + 포지션 관리 + 부분 익절

import * as fs from "node:fs";
import { tickSizeFromOrderbook, roundToTick } from "../util/tick.js";
import { CFG } from "../config/index.js";
import * as Upbit from "../api/upbitAdapter.js";
import { appendTrade } from "../monitor/tradeLog.js";
import { appendOrderEvent } from "../monitor/orderEvents.js";
import { nowKSTString } from "../util/math.js";
import { PartialTakeProfitManager } from "./partialTakeProfit.js";

const trimVolumeNumber = (value) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  const pow = 1e8;
  const floored = Math.floor(num * pow) / pow;
  return Number(floored.toFixed(8));
};

const roundKRW = (value) => {
  if (!Number.isFinite(value)) return 0;
  return Number(value.toFixed(8));
};

const formatVolumeString = (value) => {
  const num = trimVolumeNumber(value);
  const fixed = num.toFixed(8);
  const trimmed = fixed.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
  return trimmed === "" ? "0" : trimmed;
};

const sumTrades = (trades = []) => {
  let volume = 0;
  let notional = 0;
  for (const t of trades) {
    const v = Number(t?.volume ?? t?.trade_volume) || 0;
    const p = Number(t?.price ?? t?.trade_price) || 0;
    volume += v;
    notional += v * p;
  }
  return { volume, notional };
};

export class Executor {
  constructor(risk) {
    this.risk = risk;
    this.position = null;
    // LIVE 모드에서는 잔고 동기화 전까지 모의자본을 쓰지 않도록 0으로 시작
    // (refreshBalance 실패 시 가상잔고로 실매매가 나가는 사고 방지)
    this.krw = this.paperMode() ? CFG.paper.krw : 0;
    this.pnlKRW = 0;
    this.orderHistory = [];
    this.lastError = null;
    this._lastBalanceSync = 0;
    this.accountInfo = null;
    this.baseHoldings = null;
    this.pendingEntry = false;
    this._positionSeq = 0;

    // 부분 익절 매니저 추가
    this.partialMgr = new PartialTakeProfitManager();
    this.pendingPartialTake = null;
  }

  CANCEL_REPLACE_MS = 1000;
  MAX_REPLACE = 3;

  paperMode() {
    return CFG.run.paper || !Upbit.hasKeys();
  }

  _pushOrderLog(evt) {
    if (!evt) return;
    const log = {
      ts: evt.ts ?? nowKSTString(),
      type: evt.type,
      market: evt.market ?? CFG.run.market,
      price: evt.price,
      volume: evt.volume,
      err: evt.err,
      msg: evt.msg,
    };
    this.orderHistory.push(log);
    if (this.orderHistory.length > 50) this.orderHistory.shift();
  }

  async _accumulateOrderFill(orderId, agg) {
    if (!orderId || !agg) return null;
    if (agg.orderIds?.has?.(orderId)) return null;
    try {
      const detail = await Upbit.getOrderDetail(orderId);
      const trades = sumTrades(detail?.trades);
      if (trades.volume > 0 && trades.notional > 0) {
        agg.volume += trimVolumeNumber(trades.volume);
        agg.notional += trades.notional;
        agg.volume = trimVolumeNumber(agg.volume);
        agg.orderIds.add(orderId);
        return trades;
      }
    } catch (_) {}
    agg.orderIds.add(orderId);
    return null;
  }

  _updateBaseHoldings(market, balance = 0, locked = 0) {
    const baseCurrency = market?.split?.("-")?.[1];
    if (!baseCurrency) return;
    const cleanBalance = trimVolumeNumber(balance);
    const cleanLocked = trimVolumeNumber(locked);
    this.baseHoldings = {
      currency: baseCurrency,
      balance: cleanBalance,
      locked: cleanLocked,
      total: cleanBalance + cleanLocked,
    };
  }

  async refreshBalance(force = false, market = CFG.run.market) {
    if (this.paperMode()) {
      this.accountInfo = {
        balance: this.krw,
        locked: 0,
        available: this.krw,
        unit: "KRW",
      };
      this.baseHoldings = null;
      return;
    }

    const now = Date.now();
    if (!force && now - this._lastBalanceSync < 5000) return;

    try {
      const accounts = await Upbit.getAccounts();

      // 로그 파일에 기록
      // const logPath = "./logs/balance.log";
      // const timestamp = new Date().toISOString();
      // fs.appendFileSync(logPath, `\n[${timestamp}] 계좌 조회 성공\n`);
      // fs.appendFileSync(logPath, JSON.stringify(accounts, null, 2) + "\n");

      const krwAcc = accounts?.find?.((a) => a.currency === "KRW");
      if (krwAcc) {
        const balance = Number(krwAcc.balance) || 0;
        const locked = Number(krwAcc.locked) || 0;

        // fs.appendFileSync(logPath, `KRW: ${balance} (잠금: ${locked})\n`);

        if (Number.isFinite(balance)) this.krw = Math.max(0, balance);
        this.accountInfo = {
          balance,
          locked,
          available: this.krw,
          unit: "KRW",
        };
      } else {
        // fs.appendFileSync(logPath, "ERROR: KRW 계좌 없음\n");
      }

      const baseCurrency = market?.split?.("-")?.[1];
      if (baseCurrency) {
        const baseAcc = accounts?.find?.((a) => a.currency === baseCurrency);
        const balance = Number(baseAcc?.balance) || 0;
        const locked = Number(baseAcc?.locked) || 0;
        this._updateBaseHoldings(market, balance, locked);
      } else {
        this.baseHoldings = null;
      }
    } catch (e) {
      console.error("\n❌❌❌ 계좌 조회 실패! ❌❌❌");
      console.error("에러:", e?.message || e);
      console.error("상세:", e);
      console.error("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

      this._pushOrderLog({
        type: "balance_sync_error",
        err: String(e?.message ?? e),
      });
    } finally {
      this._lastBalanceSync = now;
    }
  }

  accountSnapshot(lastPrice) {
    const pos = this.position;
    const positionValue = pos ? pos.size * (lastPrice ?? pos.entry) : 0;
    return {
      balanceKRW: this.krw,
      lockedKRW: this.accountInfo?.locked ?? 0,
      baseHoldings: this.baseHoldings,
      positionValue,
      equityKRW: this.krw + positionValue,
      realizedKRW: this.pnlKRW,
      hasKeys: Upbit.hasKeys(),
      balanceSyncedAt: this._lastBalanceSync,
      mode: this.paperMode() ? "PAPER" : "LIVE",
    };
  }

  hasOpenExposure() {
    if (this.position) return true;
    if (this.pendingEntry) return true;
    if (this.accountInfo?.locked && this.accountInfo.locked > 0.0001)
      return true;
    if (this.baseHoldings?.total && this.baseHoldings.total > 1e-8) return true;
    return false;
  }

  reconcileExposure(lastPrice, market = CFG.run.market) {
    if (!Number.isFinite(lastPrice) || lastPrice <= 0) return;
    const baseTotal = this.baseHoldings?.total ?? 0;
    if (!this.position) {
      if (baseTotal <= 1e-8) return;
      const size = trimVolumeNumber(baseTotal);
      if (size <= 0) return;
      const entry = lastPrice;
      const sizeKRW = entry * size;
      const positionId = ++this._positionSeq;
      const beFloorPct = Math.max(
        CFG.strat.BE_OFFSET,
        CFG.strat.FEE * 2 + CFG.strat.SLIP
      );
      this.position = {
        id: positionId,
        side: "LONG",
        entry,
        sizeKRW,
        size,
        tp: entry * (1 + CFG.strat.TP),
        sl: entry * (1 - CFG.strat.SL),
        entryTs: Date.now(),
        movedToBE: false,
        trailHigh: entry,
        resumed: true,
        entryFeeKRW: 0,
        context: null,
        breakEvenPrice: entry * (1 + beFloorPct),
        beFloorPct,
      };
      this._pushOrderLog({
        type: "resume_position",
        market,
        volume: size,
        msg: "보유 자산 감지로 포지션 재구성",
      });
      return;
    }

    if (baseTotal <= 1e-8) return;
    const adjSize = trimVolumeNumber(baseTotal);
    if (Math.abs(this.position.size - adjSize) > 1e-8) {
      this.position.size = adjSize;
      this.position.sizeKRW = adjSize * this.position.entry;
    }
  }

  async enterLong({ price, atrPct, market = CFG.run.market, context = null }) {
    if (this.position) return { ok: false, reason: "이미 포지션 존재" };
    if (this.pendingEntry) return { ok: false, reason: "매수 진행중" };
    if (this.hasOpenExposure())
      return { ok: false, reason: "보유 포지션/주문 존재" };

    // 사이징: 잔고% 상한 + (옵션) 손절폭(SL%) 기반 리스크 고정
    let sizeKRW = this.risk.allocateKRW({
      krwBalance: this.krw,
      slPct: CFG.strat.SL,
    });
    if (sizeKRW < 5000) return { ok: false, reason: "최소주문금액 미달" };

    if (!this.paperMode()) {
      const feeBuffer = 1 + CFG.strat.FEE + CFG.strat.SLIP;
      const maxSpend = Math.max(0, this.krw / Math.max(feeBuffer, 1e-6));
      sizeKRW = Math.min(sizeKRW, maxSpend);
      if (sizeKRW < 5000)
        return { ok: false, reason: "가용자금 부족(수수료 반영)" };
    }

    this.pendingEntry = true;
    try {
      if (this.paperMode()) {
        const p = roundToTick(price);
        const size = trimVolumeNumber(sizeKRW / p);
        if (size <= 0) return { ok: false, reason: "최소 체결수량 미달" };
        const spendKRW = size * p;
        this._establishPosition({
          market,
          entry: p,
          size,
          spendKRW,
          orderId: null,
          context,
        });
        return { ok: true, paper: true, price: p };
      }

      const snap = Upbit.ensureWS(market);
      const firstOb = snap.orderbook ?? (await Upbit.getOrderbook(market));
      let tick = tickSizeFromOrderbook(firstOb) || 1;
      const initialAsk =
        Number(firstOb?.orderbook_units?.[0]?.ask_price) || price;
      const initialBid =
        Number(firstOb?.orderbook_units?.[0]?.bid_price) || price;
      const initialSpreadTicks = tick
        ? Math.round(Math.abs(initialAsk - initialBid) / tick)
        : 0;
      let rawQuote = Math.min(initialAsk, price);
      if (initialSpreadTicks > CFG.strat.MAX_SPREAD_TICKS) {
        rawQuote = Math.max(initialBid, rawQuote - tick);
      }
      let quote = roundToTick(rawQuote, tick, "bid");

      let attempt = 0;
      let lastOrder = null;
      const fillAgg = { volume: 0, notional: 0, orderIds: new Set() };
      let remainingKRW = sizeKRW;

      while (attempt <= this.MAX_REPLACE && remainingKRW >= 1000) {
        const volRaw = remainingKRW / quote;
        const vol = trimVolumeNumber(volRaw);
        if (vol <= 0) break;
        const volStr = formatVolumeString(vol);

        try {
          lastOrder = await Upbit.placeLimitBuy({
            market,
            price: quote,
            volume: volStr,
          });
          appendOrderEvent({
            type: "placed",
            uuid: lastOrder?.uuid,
            market,
            side: "bid",
            price: quote,
            volume: vol,
          });
        } catch (e) {
          const errMsg = String(e);
          appendOrderEvent({
            type: "place_failed",
            market,
            side: "bid",
            price: quote,
            volume: vol,
            err: errMsg,
          });
          this._pushOrderLog({
            type: "place_failed",
            market,
            price: quote,
            volume: vol,
            err: errMsg,
          });
          const intendedKRW = Math.max(0, Math.floor(remainingKRW));
          const res = await Upbit.placeMarketBuyKRW({
            market,
            krw: intendedKRW,
          });
          appendOrderEvent({
            type: "market_fallback",
            market,
            side: "bid",
            krw: intendedKRW,
            orderId: res?.uuid,
          });
          this._pushOrderLog({
            type: "market_fallback",
            market,
            msg: `limit 실패 후 시장가 매수 전환 (KRW ${Math.round(
              intendedKRW
            ).toLocaleString()})`,
          });

          let { volume: filledVol, notional } = sumTrades(res?.trades);
          if ((!filledVol || !notional) && res?.uuid) {
            try {
              const detail = await Upbit.getOrderDetail(res.uuid);
              const agg = sumTrades(detail?.trades);
              if (agg.volume > 0) {
                filledVol = agg.volume;
                notional = agg.notional;
              }
            } catch (_) {}
          }

          const fallbackTrade =
            snap.trade ?? (await Upbit.getTrades(market, 1))?.[0];
          const defaultEntry = Number(fallbackTrade?.trade_price) || price;
          const entry = filledVol > 0 ? notional / filledVol : defaultEntry;
          const volForPos =
            filledVol > 0 ? filledVol : intendedKRW / Math.max(entry, 1e-9);
          const notionalForPos = notional > 0 ? notional : volForPos * entry;
          fillAgg.volume += trimVolumeNumber(volForPos);
          fillAgg.volume = trimVolumeNumber(fillAgg.volume);
          fillAgg.notional += notionalForPos;
          if (res?.uuid) fillAgg.orderIds.add(res.uuid);
          remainingKRW = Math.max(0, sizeKRW - fillAgg.notional);
          this._setPositionAfterFill({
            market,
            entry,
            filledVol: fillAgg.volume,
            notional: fillAgg.notional,
            orderId: res?.uuid,
            context,
          });
          return { ok: true, paper: false, price: entry, orderId: res?.uuid };
        }

        const filled = await this._awaitFillOrReplace(
          lastOrder?.uuid,
          async () => {
            attempt += 1;
            return attempt <= this.MAX_REPLACE;
          },
          async () => {
            const ob2 = snap.orderbook ?? (await Upbit.getOrderbook(market));
            tick = tickSizeFromOrderbook(ob2) || tick;
            const ask = Number(ob2?.orderbook_units?.[0]?.ask_price) || quote;
            const bid = Number(ob2?.orderbook_units?.[0]?.bid_price) || ask;
            const spreadT = tick ? Math.round(Math.abs(ask - bid) / tick) : 0;
            let rq = ask;
            if (spreadT > CFG.strat.MAX_SPREAD_TICKS)
              rq = Math.max(bid, ask - tick);
            quote = roundToTick(rq, tick, "bid");
            return quote;
          },
          market,
          quote,
          "bid",
          vol,
          fillAgg
        );

        if (filled) {
          let entry = quote;
          let volumeFilled = vol;
          let notionalFilled = vol * quote;
          try {
            await this._accumulateOrderFill(lastOrder?.uuid, fillAgg);
          } catch (_) {}
          if (fillAgg.volume > 0 && fillAgg.notional > 0) {
            volumeFilled = fillAgg.volume;
            notionalFilled = fillAgg.notional;
            entry = notionalFilled / volumeFilled;
          } else {
            try {
              const detail = await Upbit.getOrderDetail(lastOrder?.uuid);
              const agg = sumTrades(detail?.trades);
              if (agg.volume > 0) {
                volumeFilled = agg.volume;
                notionalFilled = agg.notional;
                entry = agg.notional / agg.volume;
                fillAgg.volume += trimVolumeNumber(agg.volume);
                fillAgg.volume = trimVolumeNumber(fillAgg.volume);
                fillAgg.notional += agg.notional;
                fillAgg.orderIds.add(lastOrder?.uuid);
              }
            } catch (_) {}
          }

          if (!Number.isFinite(entry) || entry <= 0) {
            const trade = snap.trade ?? (await Upbit.getTrades(market, 1))?.[0];
            entry = Number(trade?.trade_price) || quote;
          }

          remainingKRW = Math.max(0, sizeKRW - fillAgg.notional);

          this._setPositionAfterFill({
            market,
            entry,
            filledVol: volumeFilled,
            notional: notionalFilled,
            orderId: lastOrder?.uuid,
            context,
          });
          appendOrderEvent({
            type: "filled",
            uuid: lastOrder?.uuid,
            market,
            price: entry,
            volume: trimVolumeNumber(volumeFilled),
          });
          return {
            ok: true,
            paper: false,
            price: entry,
            orderId: lastOrder?.uuid,
          };
        }

        remainingKRW = Math.max(0, sizeKRW - fillAgg.notional);
        if (remainingKRW < 5000) break;
      }

      // [Bugfix] 리밋 주문이 살아있는 상태에서 시장가 주문이 나가면 이중매수 위험.
      // 루프 종료 후 남은 주문이 있다면 반드시 취소 시도.
      if (lastOrder && !fillAgg.orderIds.has(lastOrder.uuid)) {
        try {
          await Upbit.cancelOrder(lastOrder.uuid);
          // 취소 후 혹시 체결되었는지 확인하여 remainingKRW 업데이트 하면 좋지만,
          // 최소한 이중 주문(Live Limit + Market)은 방지됨.
        } catch (_) {}
      }

      if (remainingKRW > 0) {
        const intendedKRW = Math.max(0, Math.floor(remainingKRW));
        const res = await Upbit.placeMarketBuyKRW({
          market,
          krw: intendedKRW,
        });
        let { volume: filledVol, notional } = sumTrades(res?.trades);
        if ((!filledVol || !notional) && res?.uuid) {
          try {
            const detail = await Upbit.getOrderDetail(res.uuid);
            const agg = sumTrades(detail?.trades);
            if (agg.volume > 0) {
              filledVol = agg.volume;
              notional = agg.notional;
            }
          } catch (_) {}
        }
        const fallbackTrade =
          snap.trade ?? (await Upbit.getTrades(market, 1))?.[0];
        const defaultEntry = Number(fallbackTrade?.trade_price) || price;
        const entry = filledVol > 0 ? notional / filledVol : defaultEntry;
        const volForPos =
          filledVol > 0 ? filledVol : intendedKRW / Math.max(entry, 1e-9);
        const notionalForPos = notional > 0 ? notional : volForPos * entry;
        fillAgg.volume += trimVolumeNumber(volForPos);
        fillAgg.volume = trimVolumeNumber(fillAgg.volume);
        fillAgg.notional += notionalForPos;
        if (res?.uuid) fillAgg.orderIds.add(res.uuid);
        remainingKRW = Math.max(0, sizeKRW - fillAgg.notional);
        this._setPositionAfterFill({
          market,
          entry,
          filledVol: fillAgg.volume,
          notional: fillAgg.notional,
          orderId: res?.uuid,
          context,
        });
        return { ok: true, paper: false, price: entry, orderId: res?.uuid };
      }
    } catch (e) {
      this.lastError = {
        ts: nowKSTString(),
        message: e?.message ?? String(e),
        stack: e?.stack,
      };
      this._pushOrderLog({
        type: "enter_error",
        err: this.lastError.message,
        msg: this.lastError.stack,
      });
      throw e;
    } finally {
      this.pendingEntry = false;
    }
  }

  _establishPosition({ market, entry, size, spendKRW, orderId, context }) {
    const cleanSize = trimVolumeNumber(size);
    if (!Number.isFinite(entry) || entry <= 0 || cleanSize <= 0) return;
    const spendRaw =
      Number.isFinite(spendKRW) && spendKRW > 0 ? spendKRW : cleanSize * entry;
    const spend = roundKRW(spendRaw);
    const entryFee = roundKRW(spend * CFG.strat.FEE);
    const tsEpoch = Date.now();
    const tsISO = new Date(tsEpoch).toISOString();
    const ctx = context ? { ...context } : undefined;
    const positionId = ++this._positionSeq;
    const atrPctRaw = Number(ctx?.atrPct);
    const atrFrac =
      Number.isFinite(atrPctRaw) && atrPctRaw > 0 ? atrPctRaw / 100 : NaN;
    const feeBase = CFG.strat.FEE + CFG.strat.SLIP;
    const beFloorPct = Math.max(
      feeBase,
      Number.isFinite(atrFrac) ? atrFrac * 0.6 : 0,
      CFG.strat.BE_OFFSET
    );
    const breakEvenPrice = entry * (1 + beFloorPct);

    this.position = {
      id: positionId,
      side: "LONG",
      entry,
      sizeKRW: spend,
      size: cleanSize,
      tp: entry * (1 + CFG.strat.TP),
      sl: entry * (1 - CFG.strat.SL),
      entryTs: tsEpoch,
      movedToBE: false,
      trailHigh: entry,
      entryFeeKRW: entryFee,
      context: ctx,
      breakEvenPrice,
      beFloorPct,
    };

    this._updateBaseHoldings(market, cleanSize, 0);
    this.krw = Math.max(0, roundKRW(this.krw - spend - entryFee));

    const entryEvent = {
      type: "ENTRY",
      ts: nowKSTString(),
      tsISO,
      tsEpoch,
      entryTs: tsEpoch,
      market,
      side: "LONG",
      price: entry,
      size: cleanSize,
      sizeKRW: spend,
      feeKRW: entryFee,
      orderId,
      positionId,
    };
    if (Number.isFinite(beFloorPct)) entryEvent.beFloorPct = beFloorPct;
    if (ctx) entryEvent.ctx = ctx;
    appendTrade(entryEvent);
  }

  _setPositionAfterFill({
    market,
    entry,
    filledVol,
    notional,
    orderId,
    context,
  }) {
    const baseVol =
      filledVol > 0 ? filledVol : notional / Math.max(entry, 1e-9);
    const size = trimVolumeNumber(baseVol);
    if (size <= 0) return;
    const spendKRW =
      Number.isFinite(notional) && notional > 0 ? notional : size * entry;
    this._establishPosition({
      market,
      entry,
      size,
      spendKRW,
      orderId,
      context,
    });
  }

  async _awaitFillOrReplace(
    uuid,
    shouldReplace,
    reprice,
    market,
    quote,
    side,
    vol,
    agg
  ) {
    const t0 = Date.now();
    const snap = Upbit.ensureWS(market);
    while (Date.now() - t0 < this.CANCEL_REPLACE_MS) {
      try {
        const tr = snap?.trade;
        if (tr) {
          const tp = Number(tr.trade_price ?? tr.price ?? 0);
          if (Number.isFinite(tp)) {
            const triggered = side === "bid" ? tp <= quote : tp >= quote;
            if (triggered) {
              try {
                const order = await Upbit.getOrder(uuid);
                if (!order) return true;
              } catch (_) {}
            }
          }
        }
      } catch (_) {}
      await sleep(100);
    }

    if (await shouldReplace()) {
      if (agg) {
        try {
          await this._accumulateOrderFill(uuid, agg);
        } catch (_) {}
      }
      try {
        await Upbit.cancelOrder(uuid);
        appendOrderEvent({ type: "canceled", uuid, market });
        this._pushOrderLog({
          type: "canceled",
          market,
          msg: `주문 ${uuid} 취소됨`,
        });
      } catch (e) {
        const errMsg = String(e);
        appendOrderEvent({ type: "cancel_failed", uuid, market, err: errMsg });
        this._pushOrderLog({
          type: "cancel_failed",
          market,
          err: errMsg,
        });
      }
      await reprice();
      return false;
    }

    return false;
  }

  updateStops(last) {
    if (!this.position || this.position.side !== "LONG") return;
    const p = this.position;
    const feeFloorPct = Math.max(
      CFG.strat.FEE * 2 + CFG.strat.SLIP,
      CFG.strat.BE_OFFSET
    );
    const beTriggerPct = Math.max(CFG.strat.BE_TRIGGER, feeFloorPct + 0.0002);
    p.beFloorPct = feeFloorPct;
    p.breakEvenPrice = p.entry * (1 + feeFloorPct);

    p.trailHigh = Math.max(p.trailHigh ?? p.entry, last);
    if (!p.movedToBE && last >= p.entry * (1 + beTriggerPct)) {
      p.sl = Math.max(p.sl, p.breakEvenPrice);
      p.movedToBE = true;
    }

    const trailStop = p.trailHigh * (1 - CFG.strat.TRAIL_PCT);
    if (p.movedToBE) {
      p.sl = Math.max(p.sl, trailStop, p.breakEvenPrice);
    } else {
      p.sl = Math.max(p.sl, trailStop);
    }

    // 부분 익절 체크 (신규)
    const partial = this.partialMgr.checkPartialTake(this.position, last);
    if (partial) {
      this.pendingPartialTake = partial;
    }
  }

  async maybeExitByPrice(last, market = CFG.run.market) {
    if (!this.position) return null;

    // 부분 익절 우선 처리 (신규)
    if (this.pendingPartialTake) {
      const partial = this.pendingPartialTake;
      this.pendingPartialTake = null;

      const positionSizeBefore = this.position.size;
      const entryFeeTotalBefore = Number(this.position.entryFeeKRW) || 0;
      const ratio =
        positionSizeBefore > 0 ? partial.size / positionSizeBefore : 0;
      const entryFeePortion = roundKRW(entryFeeTotalBefore * ratio);
      const exitNotionalRaw = partial.price * partial.size;
      const exitFeeKRW = roundKRW(exitNotionalRaw * CFG.strat.FEE);
      const gross = roundKRW(
        (partial.price - this.position.entry) * partial.size
      );
      const net = roundKRW(gross - entryFeePortion - exitFeeKRW);
      const netDepositKRW = roundKRW(exitNotionalRaw - exitFeeKRW);

      console.log(`💰 ${partial.message}`);

      if (!this.paperMode()) {
        const res = await Upbit.placeMarketSell({
          market,
          volume: partial.size,
        });
      }

      // 부분익절 정산: PAPER는 내부 KRW 반영, LIVE는 실계좌가 있으므로 PnL만 누적
      if (this.paperMode()) {
        this.krw = roundKRW(Math.max(0, this.krw + netDepositKRW));
      }
      this.pnlKRW = roundKRW(this.pnlKRW + net);

      appendTrade({
        type: "PARTIAL_EXIT",
        ts: nowKSTString(),
        tsISO: new Date().toISOString(),
        tsEpoch: Date.now(),
        market,
        side: "LONG",
        reason: "PARTIAL_TAKE",
        exit: partial.price,
        entry: this.position.entry,
        size: partial.size,
        pnlKRW: net,
        pnlGrossKRW: gross,
        feesKRW: roundKRW(entryFeePortion + exitFeeKRW),
        feeEntryKRW: entryFeePortion,
        feeExitKRW: exitFeeKRW,
        exitNotionalKRW: roundKRW(exitNotionalRaw),
      });

      // 포지션 업데이트
      this.position = this.partialMgr.updateAfterPartial(
        this.position,
        partial
      );

      // 남은 포지션에 엔트리 수수료를 비례 차감해 반영
      if (this.position) {
        this.position.entryFeeKRW = roundKRW(
          Math.max(0, entryFeeTotalBefore - entryFeePortion)
        );
        this._updateBaseHoldings(market, this.position.size, 0);
      }
      return null; // 아직 전체 청산 아님
    }

    const { size, tp, sl } = this.position;

    const executeLiveExit = async (reason) => {
      const res = await Upbit.placeMarketSell({ market, volume: size });
      let notional = 0;
      let vol = 0;
      for (const t of res.trades || []) {
        const v = Number(t?.volume ?? t?.trade_volume) || 0;
        const pr = Number(t?.price ?? t?.trade_price) || 0;
        notional += v * pr;
        vol += v;
      }
      const exitPrice = vol > 0 ? notional / vol : last;
      const realizedKRW = vol > 0 ? notional : exitPrice * size;
      return this.finalizeExit({
        reason,
        exitPrice,
        realizedKRW,
        orderId: res?.uuid,
        market,
      });
    };

    if (last >= tp) {
      if (this.paperMode()) {
        return this.finalizeExit({
          reason: "TP",
          exitPrice: tp,
          realizedKRW: size * tp,
          market,
        });
      }
      return executeLiveExit("TP");
    }

    if (last <= sl) {
      if (this.paperMode()) {
        return this.finalizeExit({
          reason: "SL",
          exitPrice: sl,
          realizedKRW: size * sl,
          market,
        });
      }
      return executeLiveExit("SL");
    }

    return null;
  }

  maybeExitByTime(nowTs, last, market = CFG.run.market) {
    if (!this.position) return null;
    const { size, entryTs, movedToBE, entry } = this.position;
    const alive = (nowTs - entryTs) / 1000;
    const stallSec = CFG.strat.STALL_SEC;
    const feeFloorPct = Math.max(
      CFG.strat.BE_OFFSET,
      CFG.strat.FEE + CFG.strat.SLIP
    );
    const bePrice = this.position.entry * (1 + feeFloorPct);

    if (
      Number.isFinite(stallSec) &&
      stallSec > 0 &&
      alive >= stallSec &&
      !movedToBE &&
      Number.isFinite(bePrice) &&
      last < bePrice
    ) {
      if (this.paperMode()) {
        return this.finalizeExit({
          reason: "STALL",
          exitPrice: last,
          realizedKRW: size * last,
          market,
        });
      }
      return this.forceExit(last, "STALL", market);
    }

    const timeoutSec = CFG.strat.TIMEOUT_SEC;
    if (alive >= timeoutSec) {
      if (this.paperMode()) {
        return this.finalizeExit({
          reason: "TIMEOUT",
          exitPrice: last,
          realizedKRW: size * last,
          market,
        });
      }
      return this.forceExit(last, "TIMEOUT", market);
    }
    return null;
  }

  forceExit(last, reason = "FORCE", market = CFG.run.market) {
    if (!this.position) return null;
    const { size } = this.position;
    if (this.paperMode()) {
      return this.finalizeExit({
        reason,
        exitPrice: last,
        realizedKRW: size * last,
        market,
      });
    }

    return Upbit.placeMarketSell({ market, volume: size }).then((res) => {
      let notional = 0;
      let vol = 0;
      for (const t of res.trades || []) {
        const v = Number(t?.volume ?? t?.trade_volume) || 0;
        const pr = Number(t?.price ?? t?.trade_price) || 0;
        notional += v * pr;
        vol += v;
      }
      const exitPrice = vol > 0 ? notional / vol : last;
      const realizedKRW = vol > 0 ? notional : exitPrice * size;
      return this.finalizeExit({
        reason,
        exitPrice,
        realizedKRW,
        orderId: res?.uuid,
        market,
      });
    });
  }

  finalizeExit({
    reason,
    exitPrice,
    realizedKRW,
    orderId,
    market = CFG.run.market,
  }) {
    if (!this.position) return null;
    const {
      id: positionId,
      entry,
      size,
      entryFeeKRW = 0,
      entryTs,
      trailHigh,
      movedToBE,
      context,
      breakEvenPrice,
      beFloorPct,
    } = this.position;
    const safeExitPrice = Number.isFinite(exitPrice) ? exitPrice : entry;
    const exitNotionalRaw = size * safeExitPrice;
    const exitFeeKRW = roundKRW(exitNotionalRaw * CFG.strat.FEE);
    const exitNotional = roundKRW(exitNotionalRaw);
    const totalFees = roundKRW(entryFeeKRW + exitFeeKRW);
    const gross = roundKRW((safeExitPrice - entry) * size);
    const net = roundKRW(gross - totalFees);
    const netDepositKRW = roundKRW(exitNotionalRaw - exitFeeKRW);
    const exitTsEpoch = Date.now();
    const exitTsISO = new Date(exitTsEpoch).toISOString();
    const holdSec = Number.isFinite(entryTs)
      ? Math.max(0, Math.round((exitTsEpoch - entryTs) / 1000))
      : undefined;
    const mfePct =
      Number.isFinite(trailHigh) && Number.isFinite(entry) && entry > 0
        ? (trailHigh - entry) / entry
        : undefined;
    const entryCtx = context ? { ...context } : undefined;

    if (this.paperMode()) {
      this.krw += netDepositKRW;
    } else if (Number.isFinite(realizedKRW)) {
      this.krw += roundKRW(Math.max(0, realizedKRW - exitFeeKRW));
    } else {
      this.krw += netDepositKRW;
    }

    this.pnlKRW += net;
    const exitEvent = {
      type: "EXIT",
      ts: nowKSTString(),
      tsISO: exitTsISO,
      tsEpoch: exitTsEpoch,
      exitTs: exitTsEpoch,
      market,
      side: "LONG",
      reason,
      exit: safeExitPrice,
      entry,
      size,
      pnlKRW: net,
      pnlGrossKRW: gross,
      feesKRW: totalFees,
      feeEntryKRW: entryFeeKRW,
      feeExitKRW: exitFeeKRW,
      orderId,
      positionId,
      holdSec,
      entryTs,
      trailHigh,
      movedToBE,
      mfePct,
      exitNotionalKRW: exitNotional,
      breakEvenPrice,
      beFloorPct,
    };

    // 부분 익절 정보 포함 (신규)
    if (this.position.partialTakePrice) {
      exitEvent.partialTakePrice = this.position.partialTakePrice;
      exitEvent.partialTakeSize = this.position.partialTakeSize;
      exitEvent.partialTakePnL = this.position.partialTakePnL;
    }

    if (entryCtx) exitEvent.entryCtx = entryCtx;
    appendTrade(exitEvent);

    // 부분 익절 매니저 리셋 (신규)
    this.partialMgr.reset();
    this.position = null;
    this._updateBaseHoldings(market, 0, 0);
    return { reason, retKRW: net, feesKRW: totalFees };
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
