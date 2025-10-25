import fs from "fs";
import path from "path";
import { log, formatKRW, formatPercent } from "../utils/helpers.js";

const TRADES_FILE = "logs/trades.json";

class TradeLogger {
  constructor() {
    this.ensureLogDirectory();
    this.trades = this.loadTrades();
  }

  ensureLogDirectory() {
    const dir = path.dirname(TRADES_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  loadTrades() {
    try {
      if (fs.existsSync(TRADES_FILE)) {
        const data = fs.readFileSync(TRADES_FILE, "utf8");
        return JSON.parse(data);
      }
    } catch (error) {
      log("error", "거래 내역 로드 실패", error.message);
    }

    return [];
  }

  saveTrades() {
    try {
      fs.writeFileSync(TRADES_FILE, JSON.stringify(this.trades, null, 2));
    } catch (error) {
      log("error", "거래 내역 저장 실패", error.message);
    }
  }

  logTrade(trade) {
    const tradeRecord = {
      id: this.trades.length + 1,
      timestamp: new Date().toISOString(),
      ...trade,
    };

    this.trades.push(tradeRecord);
    this.saveTrades();

    log("info", `📝 거래 #${tradeRecord.id} 기록:`);
    log("info", `  - 매수가: ${formatKRW(trade.avgBuyPrice)}`);
    log("info", `  - 매도가: ${formatKRW(trade.sellPrice)}`);
    log(
      "info",
      `  - 손익: ${formatKRW(trade.profit)} (${formatPercent(
        trade.profitRate
      )})`
    );
    log("info", `  - 보유시간: ${trade.holdingMinutes}분`);
    log("info", `  - 이유: ${trade.reason}`);

    return tradeRecord;
  }

  getRecentTrades(count) {
    return this.trades.slice(-count);
  }

  getAllTrades() {
    return this.trades;
  }

  getTradeCount() {
    return this.trades.length;
  }

  getTotalProfit() {
    return this.trades.reduce((sum, trade) => sum + trade.profit, 0);
  }

  getWinRate() {
    if (this.trades.length === 0) return 0;

    const wins = this.trades.filter((t) => t.profit > 0).length;
    return (wins / this.trades.length) * 100;
  }
}

export default new TradeLogger();
