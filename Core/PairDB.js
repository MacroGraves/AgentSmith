const MySQL = require('promise-mysql');
const Utils = require('./Utils.js');

/**
 * Pair Database Module
 * Tracks trading pair analysis history and performance metrics
 */
class PairDB {
  constructor() {
    this.connection = null;
    this.tableName = 'Pairs';
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
      console.log('[PairDB] Initialized');
      return true;
    } catch (error) {
      console.error('[PairDB] Initialization failed:', error.message);
      return false;
    }
  }

  /**
   * Create pairs tracking table
   * @returns {Promise<void>}
   */
  async CreateTable() {
    try {
      const sql = `
        CREATE TABLE IF NOT EXISTS ${this.tableName} (
          id VARCHAR(50) PRIMARY KEY COMMENT 'Trading pair (e.g., LTCUSDT)',
          base_asset VARCHAR(20) NOT NULL COMMENT 'Base asset (e.g., LTC)',
          quote_asset VARCHAR(20) NOT NULL COMMENT 'Quote asset (e.g., USDT)',
          last_checked DATETIME COMMENT 'Last analysis timestamp',
          last_action VARCHAR(50) COMMENT 'Last action taken (BUY/SELL/WAIT)',
          volatility DECIMAL(10, 4) COMMENT '24h price volatility percentage',
          volume_24h DECIMAL(20, 2) COMMENT '24h trading volume in quote asset',
          price_change_24h DECIMAL(10, 4) COMMENT '24h price change percentage',
          trend VARCHAR(20) COMMENT 'Current trend (UPTREND/DOWNTREND/NEUTRAL)',
          score DECIMAL(10, 4) COMMENT 'Pair viability score (0-100)',
          enabled BOOLEAN DEFAULT true COMMENT 'Whether to include in trading rotation',
          notes TEXT COMMENT 'Analysis notes',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_last_checked (last_checked),
          INDEX idx_enabled (enabled),
          INDEX idx_score (score DESC)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `;

      await this._query(sql);
      console.log('[PairDB] Table ready');
    } catch (error) {
      if (!error.message.includes('already exists')) {
        throw error;
      }
    }
  }

  /**
   * Add or update a trading pair
   * @param {string} pair - Trading pair (e.g., LTCUSDT)
   * @param {Object} data - Pair data
   * @returns {Promise<boolean>}
   */
  async UpdatePair(pair, data = {}) {
    try {
      const [baseAsset, quoteAsset] = pair.match(/(.+?)([A-Z]{2,})$/);
      
      const sql = `
        INSERT INTO ${this.tableName} (
          id, base_asset, quote_asset, last_checked, volatility, 
          volume_24h, price_change_24h, trend, score, notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          last_checked = NOW(),
          volatility = VALUES(volatility),
          volume_24h = VALUES(volume_24h),
          price_change_24h = VALUES(price_change_24h),
          trend = VALUES(trend),
          score = VALUES(score),
          notes = VALUES(notes),
          updated_at = CURRENT_TIMESTAMP
      `;

      const values = [
        pair,
        data.baseAsset || baseAsset,
        data.quoteAsset || quoteAsset,
        new Date(),
        data.volatility || null,
        data.volume24h || null,
        data.priceChange24h || null,
        data.trend || null,
        data.score || 0,
        data.notes || null,
      ];

      await this._query(sql, values);
      return true;
    } catch (error) {
      console.error('[PairDB] Failed to update pair:', error.message);
      return false;
    }
  }

  /**
   * Initialize a pair without updating last_checked timestamp
   * Used during startup to populate pairs without marking them as "checked"
   * @param {string} pair - Trading pair
   * @param {Object} data - Pair initialization data
   * @returns {Promise<boolean>}
   */
  async InitializePair(pair, data = {}) {
    try {
      const [baseAsset, quoteAsset] = pair.match(/(.+?)([A-Z]{2,})$/);
      
      // Insert pair if not exists, don't update last_checked for existing pairs
      const checkSql = `SELECT id FROM ${this.tableName} WHERE id = ?`;
      const existing = await this._query(checkSql, [pair]);
      
      if (existing.length > 0) {
        // Pair already exists, don't update last_checked
        return true;
      }
      
      // Pair doesn't exist, insert with no last_checked (NULL = never checked)
      const insertSql = `
        INSERT INTO ${this.tableName} (
          id, base_asset, quote_asset, notes
        ) VALUES (?, ?, ?, ?)
      `;

      const values = [
        pair,
        data.baseAsset || baseAsset,
        data.quoteAsset || quoteAsset,
        data.notes || 'Common trading pair - auto-discovered',
      ];

      await this._query(insertSql, values);
      return true;
    } catch (error) {
      console.error('[PairDB] Failed to initialize pair:', error.message);
      return false;
    }
  }

  /**
   * Update pair metrics (score, volatility, etc) WITHOUT touching last_checked
   * Used during analysis to update scores without marking the pair as "checked"
   * @param {string} pair - Trading pair
   * @param {Object} data - Metrics data
   * @returns {Promise<boolean>}
   */
  async UpdatePairMetrics(pair, data = {}) {
    try {
      const sql = `
        UPDATE ${this.tableName}
        SET
          volatility = ?,
          volume_24h = ?,
          price_change_24h = ?,
          trend = ?,
          score = ?,
          notes = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `;

      const values = [
        data.volatility || null,
        data.volume24h || null,
        data.priceChange24h || null,
        data.trend || null,
        data.score || 0,
        data.notes || null,
        pair,
      ];

      await this._query(sql, values);
      return true;
    } catch (error) {
      console.error('[PairDB] Failed to update pair metrics:', error.message);
      return false;
    }
  }

  /**
   * Get pair by ID
   * @param {string} pair - Trading pair
   * @returns {Promise<Object|null>}
   */
  async GetPair(pair) {
    try {
      const sql = `SELECT * FROM ${this.tableName} WHERE id = ?`;
      const results = await this._query(sql, [pair]);
      return results[0] || null;
    } catch (error) {
      console.error('[PairDB] Failed to get pair:', error.message);
      return null;
    }
  }

  /**
   * Get all enabled pairs sorted by score
   * @returns {Promise<Array>}
   */
  async GetAllPairs(sortBy = 'score') {
    try {
      const sql = `
        SELECT * FROM ${this.tableName}
        WHERE enabled = true
        ORDER BY ${sortBy} DESC
      `;
      const results = await this._query(sql);
      return results || [];
    } catch (error) {
      console.error('[PairDB] Failed to get all pairs:', error.message);
      return [];
    }
  }

  /**
   * Get pairs not checked in last N minutes
   * @param {number} minutesAgo - Minutes since last check
   * @returns {Promise<Array>}
   */
  async GetUncheckedPairs(minutesAgo = 60) {
    try {
      const sql = `
        SELECT * FROM ${this.tableName}
        WHERE enabled = true
        AND (last_checked IS NULL OR last_checked < DATE_SUB(NOW(), INTERVAL ? MINUTE))
        ORDER BY last_checked ASC, score DESC
      `;
      const results = await this._query(sql, [minutesAgo]);
      return results || [];
    } catch (error) {
      console.error('[PairDB] Failed to get unchecked pairs:', error.message);
      return [];
    }
  }

  /**
   * Record action on a pair
   * @param {string} pair - Trading pair
   * @param {string} action - Action taken (BUY/SELL/WAIT)
   * @returns {Promise<boolean>}
   */
  async RecordAction(pair, action) {
    try {
      const sql = `
        UPDATE ${this.tableName}
        SET last_action = ?, last_checked = NOW(), updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `;
      await this._query(sql, [action.toUpperCase(), pair]);
      return true;
    } catch (error) {
      console.error('[PairDB] Failed to record action:', error.message);
      return false;
    }
  }

  /**
   * Calculate score for a pair based on metrics
   * Higher score = better trading opportunity
   * @param {Object} metrics - Pair metrics
   * @returns {number} - Score 0-100
   */
  static CalculateScore(metrics) {
    let score = 0;

    // --- Volatility (0-25 pts) ---
    // Ideal range is 1.5-8%. Too low = no opportunity, too high = risky
    const vol = Math.abs(metrics.volatility || 0);
    if (vol >= 1.5 && vol <= 8) {
      // Peak score at ~4% volatility
      score += 25 * (1 - Math.abs(vol - 4) / 4);
    } else if (vol > 8 && vol <= 15) {
      score += 8; // High vol = some opportunity but risky
    } else if (vol > 0.5 && vol < 1.5) {
      score += 5; // Low but not zero
    }

    // --- Volume (0-25 pts) ---
    // Use logarithmic scale for smoother differentiation
    const volume = metrics.volume24h || 0;
    if (volume > 0) {
      const volLog = Math.log10(volume);
      // $10K = 4, $100K = 5, $1M = 6, $10M = 7, $100M = 8
      score += Math.min(Math.max((volLog - 4) * 6.25, 0), 25);
    }

    // --- Price movement magnitude (0-20 pts) ---
    // Stronger moves = more opportunity, with diminishing returns
    const priceChange = Math.abs(metrics.priceChange24h || 0);
    if (priceChange > 0.5) {
      score += Math.min(priceChange * 2.5, 20);
    }

    // --- Trend direction (0-20 pts) ---
    // Downtrends are best for buying, uptrends for selling existing
    if (metrics.trend === 'DOWNTREND') {
      score += 20; // Best for buying opportunities
    } else if (metrics.trend === 'UPTREND') {
      score += 12; // Good for selling existing positions
    } else {
      score += 4; // Neutral - some base value
    }

    // --- Recency penalty (0-10 pts) ---
    // Freshly analyzed data is more valuable
    if (metrics.dataAge !== undefined) {
      // dataAge in minutes; 0 = fresh (10pts), >60 = stale (0pts)
      score += Math.max(10 - (metrics.dataAge / 6), 0);
    } else {
      score += 5; // Unknown age gets mid value
    }

    return Math.min(Math.max(score, 0), 100);
  }

  /**
   * Close connection
   */
  async Close() {
    if (this.connection) {
      await this.connection.end();
    }
  }
}

module.exports = PairDB;
