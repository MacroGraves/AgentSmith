/**
 * Metrics — Performance Tracking for Trading Bot
 *
 * Tracks:
 *   - Win rate (% of profitable sells)
 *   - Total P/L (cumulative USDT)
 *   - Max drawdown (largest peak-to-trough loss)
 *   - Average hold time (time between buy and corresponding sell)
 *   - Sharpe ratio (risk-adjusted return)
 *   - Per-pair performance breakdown
 *
 * Data sourced from TradeDB (History table) + realtime session tracking.
 */

class Metrics {
  constructor() {
    // Realtime session counters (reset on restart)
    this.session = {
      startTime: Date.now(),
      tradesExecuted: 0,
      buys: 0,
      sells: 0,
      wins: 0,
      losses: 0,
      totalProfitUSDT: 0,
      totalLossUSDT: 0,
      peakBalance: 0,
      maxDrawdown: 0,
      maxDrawdownPercent: 0,
      consecutiveWins: 0,
      consecutiveLosses: 0,
      maxConsecutiveWins: 0,
      maxConsecutiveLosses: 0,
      pairStats: new Map(), // pair → { buys, sells, wins, losses, profit }
      returns: [],          // Array of individual trade return %s for Sharpe calc
    };
  }

  // ─── Record Events ──────────────────────────────────────────────────────

  /**
   * Record a buy execution
   * @param {string} pair
   * @param {number} quantity
   * @param {number} price
   * @param {number} [currentBalance] - Total USDT balance after buy
   */
  recordBuy(pair, quantity, price, currentBalance = null) {
    this.session.tradesExecuted++;
    this.session.buys++;

    const stats = this._getPairStats(pair);
    stats.buys++;
    stats.lastBuyPrice = price;
    stats.lastBuyTime = Date.now();

    if (currentBalance && currentBalance > this.session.peakBalance) {
      this.session.peakBalance = currentBalance;
    }

    console.log(`[Metrics] BUY recorded: ${pair} ${quantity} @ $${price.toFixed(4)}`);
  }

  /**
   * Record a sell execution with P/L
   * @param {string} pair
   * @param {number} quantity
   * @param {number} price
   * @param {number} profitLoss - P/L in USDT
   * @param {number} profitLossPercent - P/L as percentage
   * @param {number} [currentBalance] - Total USDT balance after sell
   */
  recordSell(pair, quantity, price, profitLoss, profitLossPercent, currentBalance = null) {
    this.session.tradesExecuted++;
    this.session.sells++;

    const stats = this._getPairStats(pair);
    stats.sells++;

    if (profitLoss >= 0) {
      this.session.wins++;
      this.session.totalProfitUSDT += profitLoss;
      this.session.consecutiveWins++;
      this.session.consecutiveLosses = 0;
      stats.wins++;
      stats.totalProfit += profitLoss;
      if (this.session.consecutiveWins > this.session.maxConsecutiveWins) {
        this.session.maxConsecutiveWins = this.session.consecutiveWins;
      }
    } else {
      this.session.losses++;
      this.session.totalLossUSDT += Math.abs(profitLoss);
      this.session.consecutiveLosses++;
      this.session.consecutiveWins = 0;
      stats.losses++;
      stats.totalLoss += Math.abs(profitLoss);
      if (this.session.consecutiveLosses > this.session.maxConsecutiveLosses) {
        this.session.maxConsecutiveLosses = this.session.consecutiveLosses;
      }
    }

    // Track return for Sharpe ratio
    if (profitLossPercent !== undefined && profitLossPercent !== null) {
      this.session.returns.push(profitLossPercent);
    }

    // Calculate hold time if we have the buy time
    if (stats.lastBuyTime) {
      const holdMs = Date.now() - stats.lastBuyTime;
      stats.holdTimes.push(holdMs);
      stats.lastBuyTime = null;
    }

    // Drawdown tracking
    if (currentBalance) {
      if (currentBalance > this.session.peakBalance) {
        this.session.peakBalance = currentBalance;
      }
      const drawdown = this.session.peakBalance - currentBalance;
      const drawdownPercent = this.session.peakBalance > 0 ? (drawdown / this.session.peakBalance) * 100 : 0;
      if (drawdown > this.session.maxDrawdown) {
        this.session.maxDrawdown = drawdown;
        this.session.maxDrawdownPercent = drawdownPercent;
      }
    }

    const emoji = profitLoss >= 0 ? '✅' : '❌';
    console.log(`[Metrics] SELL recorded: ${pair} ${emoji} $${profitLoss.toFixed(4)} (${profitLossPercent.toFixed(2)}%)`);
  }

  // ─── Calculations ───────────────────────────────────────────────────────

  /**
   * Calculate Sharpe ratio from session returns.
   * Uses 0% as the risk-free rate (crypto has none).
   * @returns {number}
   */
  _calcSharpe() {
    const returns = this.session.returns;
    if (returns.length < 2) return 0;

    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / (returns.length - 1);
    const stddev = Math.sqrt(variance);

    if (stddev === 0) return mean > 0 ? Infinity : 0;
    return mean / stddev;
  }

  /**
   * Calculate average hold time across all pairs
   * @returns {number} Average hold time in minutes
   */
  _calcAvgHoldTime() {
    let totalMs = 0;
    let count = 0;
    for (const stats of this.session.pairStats.values()) {
      for (const ht of stats.holdTimes) {
        totalMs += ht;
        count++;
      }
    }
    return count > 0 ? totalMs / count / 60000 : 0; // Convert to minutes
  }

  // ─── Reporting ──────────────────────────────────────────────────────────

  /**
   * Get full performance summary for /metrics command or API
   * @returns {Object}
   */
  getSummary() {
    const s = this.session;
    const totalSells = s.wins + s.losses;
    const winRate = totalSells > 0 ? (s.wins / totalSells) * 100 : 0;
    const netPL = s.totalProfitUSDT - s.totalLossUSDT;
    const uptimeMs = Date.now() - s.startTime;

    return {
      uptime: this._formatDuration(uptimeMs),
      totalTrades: s.tradesExecuted,
      buys: s.buys,
      sells: s.sells,
      wins: s.wins,
      losses: s.losses,
      winRate: winRate.toFixed(1) + '%',
      netProfitUSDT: netPL.toFixed(4),
      totalProfitUSDT: s.totalProfitUSDT.toFixed(4),
      totalLossUSDT: s.totalLossUSDT.toFixed(4),
      maxDrawdown: `$${s.maxDrawdown.toFixed(2)} (${s.maxDrawdownPercent.toFixed(1)}%)`,
      sharpeRatio: this._calcSharpe().toFixed(2),
      avgHoldTimeMin: this._calcAvgHoldTime().toFixed(1),
      maxConsecutiveWins: s.maxConsecutiveWins,
      maxConsecutiveLosses: s.maxConsecutiveLosses,
      pairBreakdown: this._getPairBreakdown(),
    };
  }

  /**
   * Get per-pair performance breakdown
   * @returns {Object[]}
   */
  _getPairBreakdown() {
    const result = [];
    for (const [pair, stats] of this.session.pairStats.entries()) {
      const sells = stats.wins + stats.losses;
      const winRate = sells > 0 ? (stats.wins / sells) * 100 : 0;
      const netPL = stats.totalProfit - stats.totalLoss;
      result.push({
        pair,
        buys: stats.buys,
        sells,
        wins: stats.wins,
        losses: stats.losses,
        winRate: winRate.toFixed(1) + '%',
        netPL: netPL.toFixed(4),
        avgHoldMin: stats.holdTimes.length > 0
          ? (stats.holdTimes.reduce((a, b) => a + b, 0) / stats.holdTimes.length / 60000).toFixed(1)
          : 'N/A',
      });
    }
    return result.sort((a, b) => parseFloat(b.netPL) - parseFloat(a.netPL));
  }

  /**
   * Get or create pair stats entry
   * @private
   */
  _getPairStats(pair) {
    if (!this.session.pairStats.has(pair)) {
      this.session.pairStats.set(pair, {
        buys: 0,
        sells: 0,
        wins: 0,
        losses: 0,
        totalProfit: 0,
        totalLoss: 0,
        holdTimes: [],
        lastBuyPrice: null,
        lastBuyTime: null,
      });
    }
    return this.session.pairStats.get(pair);
  }

  /**
   * Format milliseconds into human-readable duration
   * @private
   */
  _formatDuration(ms) {
    const hours = Math.floor(ms / 3600000);
    const mins = Math.floor((ms % 3600000) / 60000);
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m`;
  }

  /**
   * Reset all session metrics
   */
  reset() {
    this.session.startTime = Date.now();
    this.session.tradesExecuted = 0;
    this.session.buys = 0;
    this.session.sells = 0;
    this.session.wins = 0;
    this.session.losses = 0;
    this.session.totalProfitUSDT = 0;
    this.session.totalLossUSDT = 0;
    this.session.peakBalance = 0;
    this.session.maxDrawdown = 0;
    this.session.maxDrawdownPercent = 0;
    this.session.consecutiveWins = 0;
    this.session.consecutiveLosses = 0;
    this.session.maxConsecutiveWins = 0;
    this.session.maxConsecutiveLosses = 0;
    this.session.pairStats.clear();
    this.session.returns = [];
    console.log('[Metrics] Session metrics reset');
  }
}

module.exports = new Metrics();
