// src/executor/partialTakeProfit.js
import { CFG } from "../config/index.js";

export class PartialTakeProfitManager {
  constructor() {
    this.enabled = CFG.partial?.ENABLED ?? true;
    this.takeAt = CFG.partial?.TAKE_AT ?? 0.004;
    this.takeRatio = CFG.partial?.TAKE_RATIO ?? 0.5;
    this.partialTaken = false;
  }

  checkPartialTake(position, currentPrice) {
    if (!this.enabled) return null;
    if (this.partialTaken) return null;
    if (!position) return null;

    const { entry, size } = position;
    const profitPct = (currentPrice - entry) / entry;

    if (profitPct >= this.takeAt) {
      const partialSize = size * this.takeRatio;
      this.partialTaken = true;

      return {
        action: "PARTIAL_TAKE",
        size: partialSize,
        remainingSize: size - partialSize,
        price: currentPrice,
        profitPct,
        message: `부분 익절: ${(this.takeRatio * 100).toFixed(0)}% at +${(
          profitPct * 100
        ).toFixed(2)}%`,
      };
    }

    return null;
  }

  updateAfterPartial(position, partial) {
    if (!partial) return position;

    const newSL = position.entry * (1 + (CFG.strat.FEE * 2 + CFG.strat.SLIP));

    return {
      ...position,
      size: partial.remainingSize,
      sizeKRW: partial.remainingSize * position.entry,
      sl: Math.max(position.sl, newSL),
      partialTakePrice: partial.price,
      partialTakeSize: partial.size,
      partialTakePnL: (partial.price - position.entry) * partial.size,
    };
  }

  reset() {
    this.partialTaken = false;
  }
}
