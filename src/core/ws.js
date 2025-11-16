// ESM
import WebSocket from "ws";

/**
 * Upbit WebSocket multiplexer
 * - channels: 'orderbook', 'trade' (public only)
 * - codes: e.g., ['KRW-BTC']
 * - onMessage: ({ type, code, payload, lagMs }) => void
 */
export function connectUpbitWS({ codes, onMessage, heartbeatSec = 20 }) {
  const url = "wss://api.upbit.com/websocket/v1";
  let ws;
  let alive = false;
  let hb;

  function open() {
    ws = new WebSocket(url, { perMessageDeflate: false });

    ws.on("open", () => {
      alive = true;
      // ticket is arbitrary
      const ticket = { ticket: `scalper-${Date.now()}` };
      const payload = [
        ticket,
        { type: "orderbook", codes, isOnlyRealtime: true },
        { type: "trade", codes, isOnlyRealtime: true },
      ];
      ws.send(Buffer.from(JSON.stringify(payload)));

      // heartbeat using ws ping (Upbit tolerates TCP keepalives; ws ping is safe)
      hb = setInterval(() => {
        try {
          if (ws?.readyState === WebSocket.OPEN) ws.ping();
        } catch (_) {}
      }, heartbeatSec * 1000);
    });

    ws.on("pong", () => (alive = true));

    ws.on("message", (buf) => {
      try {
        const msg = JSON.parse(buf.toString());
        const now = Date.now();
        const ts = msg?.timestamp ?? msg?.trade_timestamp ?? now;
        const lagMs = Math.max(0, now - Number(ts));
        const type = msg?.type; // 'orderbook' | 'trade' | 'ticker'
        const code = msg?.code;
        onMessage?.({ type, code, payload: msg, lagMs });
      } catch (e) {
        // ignore malformed
      }
    });

    ws.on("close", () => cleanupAndReconnect());
    ws.on("error", () => cleanupAndReconnect());
  }

  function cleanupAndReconnect() {
    try {
      clearInterval(hb);
    } catch (_) {}
    try {
      ws?.close();
    } catch (_) {}
    setTimeout(open, 1000);
  }

  open();

  return {
    close: () => {
      try {
        clearInterval(hb);
      } catch (_) {}
      try {
        ws?.terminate();
      } catch (_) {}
    },
  };
}

/** Minimal ring buffer for latest snapshots */
export class MarketSnapshot {
  constructor() {
    this.trade = null; // last trade
    this.orderbook = null; // last orderbook
    this.wsLagMs = 0;
  }
  update({ type, payload, lagMs }) {
    if (type === "trade") this.trade = payload;
    if (type === "orderbook") this.orderbook = payload;
    this.wsLagMs = lagMs;
  }
}
