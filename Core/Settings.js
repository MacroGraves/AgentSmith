/**
 * Settings Loader — AgentSmith
 * 
 * Loads configuration from multiple MySQL tables and exposes it
 * as a unified nested object.
 * 
 * Table routing:
 *   Settings table  → Trading.*, OnRestart.*, System.*, GPT.* (dot-notation keys)
 *   Secrets  table  → {service}.{key} where key is Token, API_Key, API_Secret, etc.
 *   Discord  table  → Discord.{key}
 *   Binance  table  → Binance.{key}  (+ other exchange tables)
 * 
 * Usage:
 *   const Settings = require('./Core/Settings');
 *   await Settings.Load();
 *   const val = Settings.Get('Trading.Rules.MinimumTradeValue');
 *   const obj = Settings.Trading;
 *   await Settings.Set('Trading.Rules.MinimumTradeValue', 10);
 */

const MySQL = require('promise-mysql');
const Config = require('../MySQL.json');

// Tables that have their own dedicated key/value store
const SERVICE_TABLES = ['Discord', 'Binance', 'Kraken', 'KuCoin', 'UniSwap', 'PancakeSwap', 'Raydium'];

// Full dot-notation keys that route to the Secrets table
const SECRET_KEYS = new Set([
  'Discord.Token',
  'Binance.API_Key', 'Binance.API_Secret',
  'OpenAI.API_Key',
  'Kraken.API_Key', 'Kraken.API_Secret',
  'KuCoin.API_Key', 'KuCoin.API_Secret',
]);

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
   * Load all settings from every source table into memory
   * @returns {Promise<boolean>}
   */
  async Load() {
    try {
      this._flat = {};
      this._nested = {};

      // 1. Settings table — keys are full dot-notation
      const settingsRows = await this._query('SELECT `key`, `value` FROM Settings');
      for (const row of (settingsRows || [])) {
        this._store(row.key, row.value);
      }

      // 2. Secrets table — composite key (service, key) → {service}.{key}
      try {
        const secretRows = await this._query('SELECT `key`, `value`, `service` FROM Secrets');
        for (const row of (secretRows || [])) {
          const fullKey = `${row.service}.${row.key}`;
          this._store(fullKey, row.value);
        }
      } catch (_) { /* Secrets table may not exist yet */ }

      // 3. Service tables (Discord, Binance, exchanges) — key → {Table}.{key}
      for (const table of SERVICE_TABLES) {
        try {
          const rows = await this._query(`SELECT \`key\`, \`value\` FROM \`${table}\``);
          for (const row of (rows || [])) {
            const fullKey = `${table}.${row.key}`;
            this._store(fullKey, row.value);
          }
        } catch (_) { /* Table may not exist yet */ }
      }

      this._loaded = true;
      return true;
    } catch (error) {
      console.error('[Settings] Failed to load from database:', error.message);
      return false;
    }
  }

  /**
   * Parse a JSON-encoded DB value and store in flat + nested caches
   * @private
   */
  _store(key, rawValue) {
    let parsed;
    try { parsed = JSON.parse(rawValue); } catch (_) { parsed = rawValue; }
    this._flat[key] = parsed;
    this._setNested(key, parsed);
  }

  // ─── Get / Set ──────────────────────────────────────────────────────────

  /**
   * Get a setting by dot-notation key
   * @param {string} key
   * @param {*} defaultValue
   * @returns {*}
   */
  Get(key, defaultValue = undefined) {
    if (key in this._flat) return this._flat[key];
    return defaultValue;
  }

  /**
   * Set a setting value — routes to the correct table automatically
   * @param {string} key - Dot-notation key
   * @param {*} value
   * @param {string} [category]
   * @returns {Promise<boolean>}
   */
  async Set(key, value, category = null) {
    try {
      const jsonValue = JSON.stringify(value);
      const topLevel = key.split('.')[0];
      const subKey = key.split('.').slice(1).join('.');

      if (SECRET_KEYS.has(key)) {
        // → Secrets table (composite PK: service + key)
        await this._query(
          `INSERT INTO Secrets (\`key\`, \`value\`, service) VALUES (?, ?, ?)
           ON DUPLICATE KEY UPDATE \`value\` = VALUES(\`value\`), updated_at = CURRENT_TIMESTAMP`,
          [subKey, jsonValue, topLevel]
        );
      } else if (SERVICE_TABLES.includes(topLevel) && subKey) {
        // → Dedicated service table (Discord, Binance, etc.)
        await this._query(
          `INSERT INTO \`${topLevel}\` (\`key\`, \`value\`) VALUES (?, ?)
           ON DUPLICATE KEY UPDATE \`value\` = VALUES(\`value\`), updated_at = CURRENT_TIMESTAMP`,
          [subKey, jsonValue]
        );
      } else {
        // → Settings table (full dot-notation key)
        const cat = category || topLevel;
        await this._query(
          `INSERT INTO Settings (\`key\`, \`value\`, category) VALUES (?, ?, ?)
           ON DUPLICATE KEY UPDATE \`value\` = VALUES(\`value\`), updated_at = CURRENT_TIMESTAMP`,
          [key, jsonValue, cat]
        );
      }

      // Update in-memory cache
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

  /**
   * Get all flat key/value pairs (for listing all settings)
   * @returns {Object}
   */
  GetAll() {
    return { ...this._flat };
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
