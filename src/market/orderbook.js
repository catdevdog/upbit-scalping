// 오더북 지표: 스프레드틱·불균형·베스트호가 점유

import { krwTickSize } from "../util/tick.js";

export function analyzeOrderbook(ob, depth = 10) {
  const u = ob?.orderbook_units?.slice?.(0, depth) ?? [];
  if (!u.length)
    return {
      spreadTicks: Infinity,
      imbalance: 0,
      bestBidShare: 0,
      bid1: NaN,
      ask1: NaN,
    };

  const bid1 = u[0].bid_price;
  const ask1 = u[0].ask_price;
  const mid = (bid1 + ask1) / 2;
  const step = krwTickSize(mid);
  const spreadTicks = Math.round((ask1 - bid1) / step);

  let bidNotional = 0,
    askNotional = 0;
  for (const x of u) {
    bidNotional += x.bid_size * x.bid_price;
    askNotional += x.ask_size * x.ask_price;
  }
  const imbalance = (bidNotional - askNotional) / (bidNotional + askNotional); // -1..1
  const bestBidShare = (u[0].bid_size * bid1) / bidNotional;

  return { spreadTicks, imbalance, bestBidShare, bid1, ask1 };
}
