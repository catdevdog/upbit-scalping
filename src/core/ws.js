// ESM
import WebSocket from "ws";

/**
 * Upbit WebSocket multiplexer
 * - channels: 'orderbook', 'trade' (public only)
 * - codes: e.g., ['KRW-BTC']
 * - onMessage: ({ type, code, payload, lagMs }) => void
 */
export function connectUpbitWS({ codes, onMessage, heartbeatSec = 30 }) {
  const url = "wss://api.upbit.com/websocket/v1";
  let ws;
  let alive = false;
  let hb;
  let reconnectTimer;
  let isClosing = false;

  function open() {
    if (isClosing) return;

    try {
      ws = new WebSocket(url, { perMessageDeflate: false });

      ws.on("open", () => {
        alive = true;
        console.log("✅ WebSocket 연결됨");

        // ticket is arbitrary
        const ticket = { ticket: `scalper-${Date.now()}` };
        const payload = [
          ticket,
          { type: "orderbook", codes, isOnlyRealtime: true },
          { type: "trade", codes, isOnlyRealtime: true },
        ];
        ws.send(Buffer.from(JSON.stringify(payload)));

        // ✅ Ping-Pong 유지 (30초마다)
        clearInterval(hb);
        hb = setInterval(() => {
          try {
            if (ws?.readyState === WebSocket.OPEN) {
              ws.ping();
            } else if (!isClosing) {
              // 연결 끊김 감지 시 즉시 재연결
              console.warn("⚠️ WebSocket 상태 이상 - 재연결 시도");
              cleanupAndReconnect();
            }
          } catch (_) {}
        }, heartbeatSec * 1000);
      });

      ws.on("pong", () => {
        alive = true;
      });

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

      ws.on("close", (code, reason) => {
        if (!isClosing) {
          console.warn(`⚠️ WebSocket 단선 (${code}) - 5초 후 재연결...`);
          cleanupAndReconnect();
        }
      });

      ws.on("error", (err) => {
        if (!isClosing) {
          console.error("❌ WebSocket 오류:", err.message);
          cleanupAndReconnect();
        }
      });
    } catch (err) {
      console.error("❌ WebSocket 생성 실패:", err.message);
      cleanupAndReconnect();
    }
  }

  function cleanupAndReconnect() {
    if (isClosing) return;

    try {
      clearInterval(hb);
    } catch (_) {}
    try {
      clearTimeout(reconnectTimer);
    } catch (_) {}
    try {
      if (ws) {
        ws.removeAllListeners();
        ws.close();
      }
    } catch (_) {}

    // ✅ 5초 후 재연결
    reconnectTimer = setTimeout(() => {
      if (!isClosing) open();
    }, 5000);
  }

  open();

  return {
    close: () => {
      isClosing = true;
      try {
        clearInterval(hb);
      } catch (_) {}
      try {
        clearTimeout(reconnectTimer);
      } catch (_) {}
      try {
        if (ws) {
          ws.removeAllListeners();
          ws.terminate();
        }
      } catch (_) {}
      console.log("🔌 WebSocket 종료됨");
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
