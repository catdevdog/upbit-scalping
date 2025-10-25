import tradeLogger from "./tradeLogger.js";
import { log, formatPercent, calculateAverage } from "../utils/helpers.js";

class PerformanceTracker {
  calculateAverageProfitRate(tradeCount) {
    const trades = tradeLogger.getRecentTrades(tradeCount);

    if (trades.length === 0) {
      return {
        avgProfit: 0,
        totalTrades: 0,
        profitRates: [],
      };
    }

    const profitRates = trades.map((trade) => trade.profitRate);
    const avgProfit = calculateAverage(profitRates);

    return {
      avgProfit,
      totalTrades: trades.length,
      profitRates,
      minProfit: Math.min(...profitRates),
      maxProfit: Math.max(...profitRates),
    };
  }

  getPerformanceSummary() {
    const allTrades = tradeLogger.getAllTrades();

    if (allTrades.length === 0) {
      return {
        totalTrades: 0,
        winRate: 0,
        avgProfit: 0,
        totalProfit: 0,
      };
    }

    const profitRates = allTrades.map((t) => t.profitRate);
    const wins = allTrades.filter((t) => t.profit > 0).length;
    const losses = allTrades.filter((t) => t.profit < 0).length;

    return {
      totalTrades: allTrades.length,
      wins,
      losses,
      winRate: (wins / allTrades.length) * 100,
      avgProfit: calculateAverage(profitRates),
      totalProfit: tradeLogger.getTotalProfit(),
      maxProfit: Math.max(...profitRates),
      maxLoss: Math.min(...profitRates),
    };
  }

  printPerformanceSummary() {
    const summary = this.getPerformanceSummary();

    log("info", "");
    log("info", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    log("success", "📊 성과 요약");
    log("info", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    log("info", `📈 총 거래 횟수: ${summary.totalTrades}회`);
    log("success", `✅ 성공: ${summary.wins}회`);
    log("error", `❌ 실패: ${summary.losses}회`);
    log("info", `🎯 승률: ${formatPercent(summary.winRate)}`);
    log("info", `💰 평균 수익률: ${formatPercent(summary.avgProfit)}`);
    log("success", `📈 최대 수익률: ${formatPercent(summary.maxProfit)}`);
    log("error", `📉 최대 손실률: ${formatPercent(summary.maxLoss)}`);
    log("info", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
  }
}

export default new PerformanceTracker();
