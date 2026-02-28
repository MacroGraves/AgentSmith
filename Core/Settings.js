/**
 * Settings Loader — AgentSmith
 * 
 * Loads configuration from the MySQL Settings table and exposes it
 * as a nested object identical to the old Settings.json structure.
 * 
 * Usage:
 *   const Settings = require('./Core/Settings');
 *   await Settings.Load();            // Load all settings from DB
 *   const val = Settings.Get('Trading.Rules.MinimumTradeValue');  // 5
 *   const obj = Settings.Trading;     // Full nested object access
 *   await Settings.Set('Trading.Rules.MinimumTradeValue', 10);   // Update in DB
 */

const MySQL = require('promise-mysql');
const Config = require('../MySQL.json');

class Settings {
  constructor() {
    this._flat = {};    // { 'Trading.Rules.MinimumTradeValue': 5, ... }
    this._nested = {};  // { Trading: { Rules: { MinimumTradeValue: 5 } } }
    this._loaded = false;
    this._connection = null;
  }

  // ─── Connection ─────────────────────────────────────────────────────────

  async _getConnection() {
    if (this._connection) {
      try {
        await this._connection.ping();
        return this._connection;
      } catch (_) {
        this._connection = null;
      }
    }
    const isWindows = process.platform === 'win32';
    const opts = {
      user: Config.user,
      password: Config.password,
      database: Config.database,
    };
    if (isWindows) {
      opts.host = Config.host;
      opts.port = Config.port || 3306;
    } else {
      opts.socketPath = Config.socketPath;
    }
    this._connection = await MySQL.createConnection(opts);
    return this._connection;
  }

  async _query(sql, values) {
    const conn = await this._getConnection();
    return conn.query(sql, values);
  }

  // ─── Load ───────────────────────────────────────────────────────────────

  /**
   * Load all settings from MySQL into memory
   * @returns {Promise<boolean>}
   */
  async Load() {
    try {
      const rows = await this._query('SELECT `key`, `value` FROM Settings');
      this._flat = {};
      this._nested = {};

      for (const row of (rows || [])) {
        let parsed;
        try {
          parsed = JSON.parse(row.value);
        } catch (_) {
          parsed = row.value;
        }
        this._flat[row.key] = parsed;
        this._setNested(row.key, parsed);
      }

      this._loaded = true;
      return true;
    } catch (error) {
      console.error('[Settings] Failed to load from database:', error.message);
      return false;
    }
  }

  // ─── Get / Set ──────────────────────────────────────────────────────────

  /**
   * Get a setting by dot-notation key
   * @param {string} key - e.g. 'Trading.Rules.MinimumTradeValue'
   * @param {*} defaultValue - Fallback if key not found
   * @returns {*}
   */
  Get(key, defaultValue = undefined) {
    if (key in this._flat) return this._flat[key];
    return defaultValue;
  }

  /**
   * Set a setting value (updates DB and in-memory cache)
   * @param {string} key - Dot-notation key
   * @param {*} value - New value
   * @param {string} [category] - Category (auto-resolved from key if omitted)
   * @returns {Promise<boolean>}
   */
  async Set(key, value, category = null) {
    try {
      const cat = category || key.split('.')[0];
      const jsonValue = JSON.stringify(value);
      await this._query(
        `INSERT INTO Settings (\`key\`, \`value\`, category) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE \`value\` = VALUES(\`value\`), updated_at = CURRENT_TIMESTAMP`,
        [key, jsonValue, cat]
      );
      this._flat[key] = value;
      this._setNested(key, value);
      return true;
    } catch (error) {
      console.error(`[Settings] Failed to set ${key}:`, error.message);
      return false;
    }
  }

  /**
   * Get all settings for a category as a flat object
   * @param {string} category - e.g. 'Trading', 'Binance', 'Discord'
   * @returns {Object}
   */
  GetCategory(category) {
    const result = {};
    for (const [key, value] of Object.entries(this._flat)) {
      if (key.startsWith(category + '.')) {
        result[key] = value;
      }
    }
    return result;
  }

  // ─── Nested Object Access (Proxy) ──────────────────────────────────────

  /**
   * Build nested object path from dot-notation key
   * @private
   */
  _setNested(key, value) {
    const parts = key.split('.');
    let current = this._nested;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!(parts[i] in current) || typeof current[parts[i]] !== 'object' || current[parts[i]] === null) {
        current[parts[i]] = {};
      }
      current = current[parts[i]];
    }
    current[parts[parts.length - 1]] = value;
  }

  // ─── Property Accessors (backward-compatible with Settings.json structure) ──

  get Binance()  { return this._nested.Binance  || {}; }
  get Trading()  { return this._nested.Trading  || {}; }
  get OnRestart(){ return this._nested.OnRestart || {}; }
  get Discord()  { return this._nested.Discord  || {}; }
  get System()   { return this._nested.System   || {}; }

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  async Close() {
    if (this._connection) {
      try { this._connection.end(); } catch (_) {}
      this._connection = null;
    }
  }

  get isLoaded() { return this._loaded; }
}

// Singleton instance — all modules share the same settings object
module.exports = new Settings();
