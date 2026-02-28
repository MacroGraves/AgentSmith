/**
 * StopLoss — Trailing Profit Protector for Spot Trading
 *
 * Since AgentSmith is spot trading with MARKET orders, traditional stop-losses
 * can't be placed as exchange orders. Instead, this module monitors positions
 * in the trading loop and triggers sell signals when price retraces from a peak.
 *
 * KEY RULE (user mandate): "All profit must supersede the stop-loss."
 * → Stop-loss ONLY activates AFTER profit has been achieved.
 * → It acts as a trailing profit protector, not a loss limiter.
 * → If position is at a loss or breakeven, stop-loss is dormant.
 *
 * Flow:
 *   1. Buy recorded → entry price stored, high-water = entry
 *   2. Price rises above entry + activation threshold → stop-loss ARMED
 *   3. Price continues rising → high-water tracks upward
 *   4. Price retraces from high-water by trailPercent → SELL signal emitted
 *   5. Sell must still pass MinProfitPercentToSell gate in AutoTrader
 */

const Settings = require('./Settings.js');

class StopLoss {
  constructor() {
    // Map<pair, { entryPrice, highWater, armed, quantity }>
    this.positions = new Map();
  }

  /**
   * Register a new position (call after a BUY executes)
   * @param {string} pair - e.g. 'LTCUSDT'
   * @param {number} entryPrice
   * @param {number} quantity
   */
  track(pair, entryPrice, quantity) {
    this.positions.set(pair, {
      entryPrice,
      highWater: entryPrice,
      armed: false,
      quantity,
      trackedAt: Date.now(),
    });
    console.log(`[StopLoss] Tracking ${pair}: entry $${entryPrice.toFixed(4)}, qty ${quantity}`);
  }

  /**
   * Remove position tracking (call after a SELL executes)
   * @param {string} pair
   */
  untrack(pair) {
    if (this.positions.has(pair)) {
      console.log(`[StopLoss] Untracked ${pair}`);
      this.positions.delete(pair);
    }
  }

  /**
   * Check current price against tracked positions.
   * Returns a sell signal if trailing stop is triggered.
   *
   * @param {string} pair
   * @param {number} currentPrice
   * @returns {{ triggered: boolean, reason: string, entryPrice: number, highWater: number, currentPL: number } | null}
   */
  check(pair, currentPrice) {
    const pos = this.positions.get(pair);
    if (!pos) return null;

    const { entryPrice, highWater } = pos;

    // Settings (with sensible defaults matching the user's conservative approach)
    const stopLossSettings = Settings.Trading?.Rules?.StopLoss || {};
    const activationPercent = stopLossSettings.ActivationPercent || 3.0;   // Arm after 3% profit
    const trailPercent = stopLossSettings.TrailPercent || 2.0;             // Sell if retraces 2% from peak
    const enabled = stopLossSettings.Enabled !== false;                     // Enabled by default

    if (!enabled) return null;

    const profitFromEntry = ((currentPrice - entryPrice) / entryPrice) * 100;

    // Update high-water mark
    if (currentPrice > highWater) {
      pos.highWater = currentPrice;
    }

    // Arm the stop-loss once activation threshold is reached
    // RULE: Profit supersedes stop-loss — NEVER arm while at a loss or breakeven
    if (!pos.armed && profitFromEntry >= activationPercent) {
      pos.armed = true;
      console.log(`[StopLoss] ${pair} ARMED at $${currentPrice.toFixed(4)} (${profitFromEntry.toFixed(2)}% profit, activation: ${activationPercent}%)`);
    }

    // If not armed, stop-loss is dormant — let normal trading continue
    if (!pos.armed) return null;

    // Check for retrace from high-water
    const retraceFromPeak = ((pos.highWater - currentPrice) / pos.highWater) * 100;
    const currentPLFromEntry = profitFromEntry;

    if (retraceFromPeak >= trailPercent) {
      // Only trigger if we'd still be profitable (profit supersedes)
      if (currentPLFromEntry > 0) {
        const reason = `Trailing stop triggered: retraced ${retraceFromPeak.toFixed(2)}% from peak $${pos.highWater.toFixed(4)} (threshold: ${trailPercent}%). Still profitable at ${currentPLFromEntry.toFixed(2)}%.`;
        console.log(`[StopLoss] ${pair} TRIGGERED — ${reason}`);
        return {
          triggered: true,
          reason,
          entryPrice,
          highWater: pos.highWater,
          currentPL: currentPLFromEntry,
          quantity: pos.quantity,
        };
      } else {
        // Price retraced past entry — stop-loss disarms (profit supersedes)
        pos.armed = false;
        console.log(`[StopLoss] ${pair} DISARMED — retraced to ${currentPLFromEntry.toFixed(2)}% (below entry). Profit supersedes stop-loss.`);
        return null;
      }
    }

    return null;
  }

  /**
   * Get status of all tracked positions
   * @returns {Object[]}
   */
  getStatus() {
    const result = [];
    for (const [pair, pos] of this.positions.entries()) {
      result.push({
        pair,
        entryPrice: pos.entryPrice,
        highWater: pos.highWater,
        armed: pos.armed,
        quantity: pos.quantity,
        trackedSince: new Date(pos.trackedAt).toISOString(),
      });
    }
    return result;
  }

  /**
   * Check if any pair has an active (armed) stop-loss
   * @returns {boolean}
   */
  hasArmedPositions() {
    for (const pos of this.positions.values()) {
      if (pos.armed) return true;
    }
    return false;
  }
}

module.exports = new StopLoss();
