const MySQL = require('promise-mysql');
const Utils = require('./Utils.js');

/**
 * Trade Database Module
 * Persists and retrieves trade history (buy/sell orders executed on Binance)
 */
class TradeDB {
  constructor() {
    this.connection = null;
    this.tableName = 'History';
  }

  /** Auto-reconnecting query wrapper */
  async _query(sql, values) {
    return Utils.SafeQuery(MySQL, this, sql, values);
  }

  /**
   * Initialize database connection
   * @returns {Promise<boolean>}
   */
  async Initialize() {
    try {
      this.connection = await Utils.Connection(MySQL, this.connection);
      await this.CreateTable();
      console.log('[TradeDB] Initialized');
      return true;
    } catch (error) {
      console.error('[TradeDB] Initialization failed:', error.message);
      return false;
    }
  }

  /**
   * Create trading history table if it doesn't exist
   * @returns {Promise<void>}
   */
  async CreateTable() {
    try {
      const sql = `
        CREATE TABLE IF NOT EXISTS ${this.tableName} (
          id VARCHAR(255) PRIMARY KEY COMMENT 'Unique trade ID (UUID)',
          order_id VARCHAR(255) UNIQUE COMMENT 'Binance Order ID',
          pair VARCHAR(20) NOT NULL COMMENT 'Trading pair (e.g., LTCUSDT)',
          action VARCHAR(10) NOT NULL COMMENT 'BUY or SELL',
          quantity DECIMAL(20, 8) NOT NULL COMMENT 'Amount of asset traded',
          price DECIMAL(20, 8) NOT NULL COMMENT 'Price per unit',
          total_value DECIMAL(20, 8) NOT NULL COMMENT 'Total value (quantity * price)',
          entry_price DECIMAL(20, 8) COMMENT 'Entry price (for sell orders, the entry price of corresponding buy)',
          profit_loss DECIMAL(20, 8) COMMENT 'Profit/loss amount in USDT',
          profit_loss_percent DECIMAL(10, 4) COMMENT 'Profit/loss percentage',
          timestamp DATETIME NOT NULL COMMENT 'When trade was executed',
          loop_id VARCHAR(255) COMMENT 'Associated autonomous loop ID',
          decision_id VARCHAR(255) COMMENT 'Associated GPT decision ID',
          status VARCHAR(32) DEFAULT 'completed' COMMENT 'Trade status (pending, completed, failed, cancelled)',
          notes TEXT COMMENT 'Additional notes about the trade',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_timestamp (timestamp DESC),
          INDEX idx_action (action),
          INDEX idx_pair (pair),
          INDEX idx_loop_id (loop_id),
          INDEX idx_status (status)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `;

      await this._query(sql);
      console.log('[TradeDB] Table ready');
    } catch (error) {
      if (!error.message.includes('already exists')) {
        throw error;
      }
    }
  }

  /**
   * Save executed trade to database
   * @param {Object} trade - Trade execution object
   * @param {string} trade.id - Unique trade ID
   * @param {string} trade.orderId - Binance Order ID
   * @param {string} trade.action - BUY or SELL
   * @param {number} trade.quantity - Amount traded
   * @param {number} trade.price - Price per unit
   * @param {string} trade.pair - Trading pair
   * @param {string} trade.loopId - Associated loop ID
   * @param {string} trade.decisionId - Associated decision ID
   * @returns {Promise<boolean>}
   */
  async SaveTrade(trade) {
    try {
      if (!trade || !trade.id || !trade.action || !trade.quantity || !trade.price) {
        throw new Error('Invalid trade object: missing required fields');
      }

      const totalValue = trade.quantity * trade.price;

      const sql = `
        INSERT INTO ${this.tableName} (
          id, order_id, pair, action, quantity, price, total_value,
          entry_price, profit_loss, profit_loss_percent,
          timestamp, loop_id, decision_id, status, notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          status = VALUES(status),
          updated_at = CURRENT_TIMESTAMP
      `;

      const values = [
        trade.id,
        trade.orderId || null,
        trade.pair || 'LTCUSDT',
        trade.action.toUpperCase(),
        trade.quantity,
        trade.price,
        totalValue,
        trade.entryPrice || null,
        trade.profitLoss || null,
        trade.profitLossPercent || null,
        trade.timestamp || new Date(),
        trade.loopId || null,
        trade.decisionId || null,
        trade.status || 'completed',
        trade.notes || null,
      ];

      await this._query(sql, values);
      return true;
    } catch (error) {
      console.error('[TradeDB] Failed to save trade:', error.message);
      return false;
    }
  }

  /**
   * Get all trades for a given pair
   * @param {string} pair - Trading pair (e.g., LTCUSDT)
   * @returns {Promise<Array>}
   */
  async GetTradesForPair(pair = 'LTCUSDT') {
    try {
      const sql = `
        SELECT * FROM ${this.tableName}
        WHERE pair = ?
        ORDER BY timestamp DESC
      `;
      const results = await this._query(sql, [pair]);
      return results || [];
    } catch (error) {
      console.error('[TradeDB] Failed to get trades:', error.message);
      return [];
    }
  }

  /**
   * Get the most recent trades across all pairs
   * @param {number} count - Number of trades to return
   * @returns {Promise<Array>}
   */
  async GetRecentTrades(count = 10) {
    try {
      const sql = `
        SELECT * FROM ${this.tableName}
        ORDER BY timestamp DESC
        LIMIT ?
      `;
      const results = await this._query(sql, [count]);
      return results || [];
    } catch (error) {
      console.error('[TradeDB] Failed to get recent trades:', error.message);
      return [];
    }
  }

  /**
   * Get trade statistics for today
   * @param {string} pair - Trading pair
   * @returns {Promise<Object>}
   */
  async GetDailyStats(pair = 'LTCUSDT') {
    try {
      const sql = `
        SELECT
          COUNT(*) as total_trades,
          SUM(CASE WHEN action = 'BUY' THEN 1 ELSE 0 END) as buy_count,
          SUM(CASE WHEN action = 'SELL' THEN 1 ELSE 0 END) as sell_count,
          SUM(CASE WHEN action = 'SELL' THEN profit_loss ELSE 0 END) as total_profit_loss,
          AVG(CASE WHEN action = 'SELL' THEN profit_loss_percent ELSE NULL END) as avg_profit_loss_percent,
          MIN(price) as min_price,
          MAX(price) as max_price
        FROM ${this.tableName}
        WHERE pair = ? AND DATE(timestamp) = CURDATE()
      `;
      const results = await this._query(sql, [pair]);
      return results[0] || {};
    } catch (error) {
      console.error('[TradeDB] Failed to get daily stats:', error.message);
      return {};
    }
  }

  /**
   * Get recent open positions (buys without matching sells)
   * @param {string} pair - Trading pair
   * @returns {Promise<Array>}
   */
  async GetOpenPositions(pair = 'LTCUSDT') {
    try {
      const sql = `
        SELECT * FROM ${this.tableName}
        WHERE pair = ? AND action = 'BUY'
        AND id NOT IN (
          SELECT buy_id FROM (
            SELECT b.id as buy_id FROM ${this.tableName} b
            INNER JOIN ${this.tableName} s ON b.id = s.entry_price
            WHERE b.pair = ? AND b.action = 'BUY' AND s.action = 'SELL'
          ) AS matched
        )
        ORDER BY timestamp DESC
      `;
      const results = await this._query(sql, [pair, pair]);
      return results || [];
    } catch (error) {
      console.error('[TradeDB] Failed to get open positions:', error.message);
      return [];
    }
  }

  /**
   * Calculate profit/loss for a sell price given entry price
   * @param {number} entryPrice - Buy price
   * @param {number} exitPrice - Sell price
   * @param {number} quantity - Amount traded
   * @returns {Object} - {profitLoss, profitLossPercent}
   */
  static CalculateProfitLoss(entryPrice, exitPrice, quantity = 1) {
    const profitLoss = (exitPrice - entryPrice) * quantity;
    const profitLossPercent = ((exitPrice - entryPrice) / entryPrice) * 100;
    return {
      profitLoss,
      profitLossPercent,
    };
  }

  /**
   * Close database connection
   */
  async Close() {
    if (this.connection) {
      await this.connection.end();
    }
  }
}

module.exports = TradeDB;
