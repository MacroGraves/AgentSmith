const MySQL = require('promise-mysql');
const Utils = require('./Utils.js');

/**
 * Decision Database Module
 * Persists and retrieves decision chain of thought from database
 */
class DecisionDB {
  constructor() {
    this.connection = null;
    this.tableName = 'gpt_decisions';
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
      console.log('Decision DB initialized');
      return true;
    } catch (error) {
      console.error('Failed to initialize Decision DB:', error.message);
      return false;
    }
  }

  /**
   * Create decisions table if it doesn't exist
   * @returns {Promise<void>}
   */
  async CreateTable() {
    try {
      const sql = `
        CREATE TABLE IF NOT EXISTS ${this.tableName} (
          id VARCHAR(255) PRIMARY KEY,
          timestamp DATETIME NOT NULL,
          query LONGTEXT NOT NULL,
          chain JSON NOT NULL,
          actions JSON,
          market_analysis JSON,
          status VARCHAR(32) DEFAULT 'completed',
          loop_id VARCHAR(255),
          next_decision_id VARCHAR(255),
          result_summary TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_timestamp (timestamp),
          INDEX idx_status (status),
          INDEX idx_loop_id (loop_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `;

      await this._query(sql);
      console.log(`Table '${this.tableName}' ready`);

      // Create auto loops table
      await this._CreateAutoLoopsTable();
    } catch (error) {
      if (!error.message.includes('already exists')) {
        throw error;
      }
    }
  }

  /**
   * Create auto loops tracking table
   * @returns {Promise<void>}
   * @private
   */
  async _CreateAutoLoopsTable() {
    try {
      const sql = `
        CREATE TABLE IF NOT EXISTS gpt_auto_loops (
          id VARCHAR(255) PRIMARY KEY,
          initial_prompt LONGTEXT NOT NULL,
          status VARCHAR(32) DEFAULT 'running',
          decision_count INT DEFAULT 0,
          start_time DATETIME NOT NULL,
          end_time DATETIME,
          final_outcome LONGTEXT,
          config JSON,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_status (status),
          INDEX idx_start_time (start_time)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `;

      await this._query(sql);
    } catch (error) {
      if (!error.message.includes('already exists')) {
        throw error;
      }
    }
  }

  /**
   * Save decision to database
   * @param {Object} decision - Decision object from GPT.Process()
   * @returns {Promise<boolean>}
   */
  async SaveDecision(decision) {
    try {
      if (!decision || !decision.id) {
        throw new Error('Invalid decision object');
      }

      // Extract actions from chain
      const actionsArray = decision.chain
        ?.find((c) => c.step === 'act')?.actions || [];

      const sql = `
        INSERT INTO ${this.tableName} (id, timestamp, query, chain, actions, market_analysis, status)
        VALUES (?, ?, ?, ?, ?, ?, 'completed')
        ON DUPLICATE KEY UPDATE
          updated_at = CURRENT_TIMESTAMP
      `;

      const values = [
        decision.id,
        decision.timestamp,
        decision.query,
        JSON.stringify(decision.chain),
        JSON.stringify(actionsArray),
        JSON.stringify(decision.marketAnalysis || null),
      ];

      await this._query(sql, values);
      return true;
    } catch (error) {
      console.error('Failed to save decision:', error.message);
      return false;
    }
  }

  /**
   * Retrieve decision by ID
   * @param {string} decisionId
   * @returns {Promise<Object|null>}
   */
  async GetDecision(decisionId) {
    try {
      const sql = `SELECT * FROM ${this.tableName} WHERE id = ?`;
      const results = await this._query(sql, [decisionId]);

      if (results.length === 0) return null;

      const row = results[0];
      return {
        id: row.id,
        timestamp: row.timestamp,
        query: row.query,
        chain: JSON.parse(row.chain),
        actions: JSON.parse(row.actions || '[]'),
        marketAnalysis: row.market_analysis ? JSON.parse(row.market_analysis) : null,
        status: row.status,
      };
    } catch (error) {
      console.error('Failed to retrieve decision:', error.message);
      return null;
    }
  }

  /**
   * Get decisions by action type
   * @param {string} actionType - e.g., 'query', 'buy', 'sell'
   * @param {number} limit - Max results (default: 20)
   * @returns {Promise<Array>}
   */
  async GetDecisionsByAction(actionType, limit = 20) {
    try {
      const sql = `
        SELECT * FROM ${this.tableName}
        WHERE JSON_CONTAINS(actions, JSON_OBJECT('action', ?))
        ORDER BY timestamp DESC
        LIMIT ?
      `;

      const results = await this._query(sql, [actionType, limit]);

      return results.map((row) => ({
        id: row.id,
        timestamp: row.timestamp,
        query: row.query,
        actions: JSON.parse(row.actions || '[]'),
        status: row.status,
      }));
    } catch (error) {
      console.error('Failed to retrieve decisions by action:', error.message);
      return [];
    }
  }

  /**
   * Get recent decisions
   * @param {number} limit - Max results (default: 20)
   * @param {number} offset - Offset for pagination (default: 0)
   * @returns {Promise<Array>}
   */
  async GetRecentDecisions(limit = 20, offset = 0) {
    try {
      const sql = `
        SELECT id, timestamp, query, actions, status
        FROM ${this.tableName}
        ORDER BY timestamp DESC
        LIMIT ? OFFSET ?
      `;

      const results = await this._query(sql, [limit, offset]);

      return results.map((row) => ({
        id: row.id,
        timestamp: row.timestamp,
        query: row.query,
        actions: JSON.parse(row.actions || '[]'),
        status: row.status,
      }));
    } catch (error) {
      console.error('Failed to retrieve recent decisions:', error.message);
      return [];
    }
  }

  /**
   * Query decisions by time range
   * @param {Date} startTime
   * @param {Date} endTime
   * @returns {Promise<Array>}
   */
  async GetDecisionsByTimeRange(startTime, endTime) {
    try {
      const sql = `
        SELECT id, timestamp, query, actions, status
        FROM ${this.tableName}
        WHERE timestamp BETWEEN ? AND ?
        ORDER BY timestamp DESC
      `;

      const results = await this._query(sql, [startTime, endTime]);

      return results.map((row) => ({
        id: row.id,
        timestamp: row.timestamp,
        query: row.query,
        actions: JSON.parse(row.actions || '[]'),
        status: row.status,
      }));
    } catch (error) {
      console.error('Failed to retrieve decisions by time range:', error.message);
      return [];
    }
  }

  /**
   * Count total decisions
   * @returns {Promise<number>}
   */
  async CountDecisions() {
    try {
      const sql = `SELECT COUNT(*) as count FROM ${this.tableName}`;
      const results = await this._query(sql);
      return results[0].count;
    } catch (error) {
      console.error('Failed to count decisions:', error.message);
      return 0;
    }
  }

  /**
   * Save or update an auto loop session
   * @param {string} loopId - Unique loop identifier
   * @param {object} loopData - { initialPrompt, status, decisionCount, endTime, finalOutcome, config }
   * @returns {Promise<boolean>}
   */
  async SaveAutoLoop(loopId, loopData) {
    try {
      const { initialPrompt, status = 'running', decisionCount = 0, endTime = null, finalOutcome = null, config = {} } = loopData;

      const sql = `
        INSERT INTO gpt_auto_loops (id, initial_prompt, status, decision_count, start_time, end_time, final_outcome, config)
        VALUES (?, ?, ?, ?, NOW(), ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          status = VALUES(status),
          decision_count = VALUES(decision_count),
          end_time = VALUES(end_time),
          final_outcome = VALUES(final_outcome),
          config = VALUES(config)
      `;

      await this._query(sql, [
        loopId,
        initialPrompt,
        status,
        decisionCount,
        endTime,
        finalOutcome,
        JSON.stringify(config),
      ]);

      return true;
    } catch (error) {
      console.error('Failed to save auto loop:', error.message);
      return false;
    }
  }

  /**
   * Get auto loop details
   * @param {string} loopId - Loop identifier
   * @returns {Promise<object|null>}
   */
  async GetAutoLoop(loopId) {
    try {
      const sql = `SELECT * FROM gpt_auto_loops WHERE id = ?`;
      const results = await this._query(sql, [loopId]);

      if (results.length === 0) {
        return null;
      }

      const row = results[0];
      return {
        id: row.id,
        initialPrompt: row.initial_prompt,
        status: row.status,
        decisionCount: row.decision_count,
        startTime: row.start_time,
        endTime: row.end_time,
        finalOutcome: row.final_outcome,
        config: JSON.parse(row.config || '{}'),
        createdAt: row.created_at,
      };
    } catch (error) {
      console.error('Failed to retrieve auto loop:', error.message);
      return null;
    }
  }

  /**
   * Get auto loops filtered by status
   * @param {string} status - 'running', 'completed', 'failed', 'timeout', etc.
   * @param {number} limit - Maximum results (default 50)
   * @returns {Promise<Array>}
   */
  async GetAutoLoopsByStatus(status, limit = 50) {
    try {
      const sql = `
        SELECT * FROM gpt_auto_loops
        WHERE status = ?
        ORDER BY start_time DESC
        LIMIT ?
      `;

      const results = await this._query(sql, [status, limit]);

      return results.map((row) => ({
        id: row.id,
        initialPrompt: row.initial_prompt,
        status: row.status,
        decisionCount: row.decision_count,
        startTime: row.start_time,
        endTime: row.end_time,
        finalOutcome: row.final_outcome,
        config: JSON.parse(row.config || '{}'),
      }));
    } catch (error) {
      console.error('Failed to retrieve auto loops by status:', error.message);
      return [];
    }
  }

  /**
   * Get decisions for a specific loop
   * @param {string} loopId - Loop identifier
   * @param {number} limit - Maximum results (default 100)
   * @returns {Promise<Array>}
   */
  async GetLoopDecisions(loopId, limit = 100) {
    try {
      const sql = `
        SELECT * FROM ${this.tableName}
        WHERE loop_id = ?
        ORDER BY timestamp ASC
        LIMIT ?
      `;

      const results = await this._query(sql, [loopId, limit]);

      return results.map((row) => ({
        id: row.id,
        timestamp: row.timestamp,
        query: row.query,
        chain: JSON.parse(row.chain || '[]'),
        actions: JSON.parse(row.actions || '[]'),
        status: row.status,
        nextDecisionId: row.next_decision_id,
      }));
    } catch (error) {
      console.error('Failed to retrieve loop decisions:', error.message);
      return [];
    }
  }

  /**
   * Close database connection
   * @returns {boolean}
   */
  Close() {
    if (this.connection) {
      this.connection.end();
      this.connection = null;
    }
    return true;
  }
}

module.exports = DecisionDB;
