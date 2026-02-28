const MySQL = require('promise-mysql');
const Utils = require('./Utils.js');
const Settings = require('./Settings.js');

/**
 * Cranks Safety System — Annihilation Prevention
 *
 * Cascading profit tracker that permanently locks profits into USDC.
 * All values are in REAL USDT amounts (not abstract points).
 *
 * Each coin has 4 ratchets [R0, R1, R2, R3] and a baseAmount:
 *   R0: Active zone — this is the MockBalance the bot can trade with
 *   R1: Safety tier 1 — profits saved from trading, cannot be used
 *   R2: Safety tier 2 — deeper safety cushion
 *   R3: PERMANENT LOCKUP — converts to USDC and is NEVER touched again
 *
 * baseAmount = first buy cost. This is the cascade unit size.
 * Cascade RIGHT at 100%: when R[i] >= 2 × baseAmount, overflow baseAmount to R[i+1].
 * Losses cascade LEFT from R1-R2 to cover R0 deficit (NEVER from R3).
 * When R3 >= baseAmount → lock baseAmount as USDC → excluded from trading forever.
 *
 * MockBalance = sum of R0 across all coins = max the bot is allowed to trade with.
 * Example: $30 base, cranks [30, 30, 0, 0] → real balance $60, MockBalance = $30.
 *          cranks [30, 30, 30, 30] → R3 triggers, lock $30 USDC, usable balance = $90.
 */
class Cranks {
  constructor(binanceExchange) {
    this.binance = binanceExchange;
    this.connection = null;
    this.tableName = 'Cranks';
    this.coins = {};
    this.totalLockedUSDC = 0;
  }

  /** Auto-reconnecting query wrapper */
  async _query(sql, values) {
    return Utils.SafeQuery(MySQL, this, sql, values);
  }

  /**
   * Initialize: create DB table and load existing crank state
   * @returns {Promise<boolean>}
   */
  async Initialize() {
    try {
      this.connection = await Utils.Connection(MySQL, this.connection);
      await this._createTable();
      await this._loadFromDB();
      const mockBal = this.getMockBalance();
      const mockBalStr = mockBal === Infinity ? 'unlimited (no cascades yet)' : `$${mockBal.toFixed(2)}`;
      console.log(`[Cranks] Initialized — ${Object.keys(this.coins).length} coins tracked, MockBalance: ${mockBalStr}, $${this.totalLockedUSDC.toFixed(2)} USDC locked`);
      return true;
    } catch (error) {
      console.error('[Cranks] Initialization failed:', error.message);
      return false;
    }
  }

  /**
   * Create the cranks persistence table (with base_amount column)
   * @private
   */
  async _createTable() {
    const sql = `
      CREATE TABLE IF NOT EXISTS ${this.tableName} (
        coin VARCHAR(20) PRIMARY KEY COMMENT 'Coin ticker (e.g. LTC, BTC, UNI)',
        base_amount DECIMAL(20, 4) NOT NULL DEFAULT 0 COMMENT 'First buy cost in USDT — cascade unit size',
        crank_0 DECIMAL(20, 4) NOT NULL DEFAULT 0 COMMENT 'R0: active trading zone (USDT)',
        crank_1 DECIMAL(20, 4) NOT NULL DEFAULT 0 COMMENT 'R1: safety tier 1 (USDT)',
        crank_2 DECIMAL(20, 4) NOT NULL DEFAULT 0 COMMENT 'R2: safety tier 2 (USDT)',
        crank_3 DECIMAL(20, 4) NOT NULL DEFAULT 0 COMMENT 'R3: permanent lockup zone (USDT)',
        locked_usdc DECIMAL(20, 4) NOT NULL DEFAULT 0 COMMENT 'Total USDC permanently locked from this coin',
        conversions INT NOT NULL DEFAULT 0 COMMENT 'Number of USDC lockup events',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `;
    try {
      await this._query(sql);
      // Migration: add base_amount column if table already exists without it
      try {
        await this._query(`ALTER TABLE ${this.tableName} ADD COLUMN base_amount DECIMAL(20, 4) NOT NULL DEFAULT 0 AFTER coin`);
        console.log('[Cranks] Migrated: added base_amount column');
      } catch (e) {
        // Column already exists — that's fine
        if (!e.message.includes('Duplicate column') && !e.message.includes('already exists')) {
          console.warn('[Cranks] Migration note:', e.message);
        }
      }
    } catch (error) {
      if (!error.message.includes('already exists')) throw error;
    }
  }

  /**
   * Load all crank data from DB into memory
   * @private
   */
  async _loadFromDB() {
    try {
      const rows = await this._query(`SELECT * FROM ${this.tableName}`);
      this.totalLockedUSDC = 0;
      for (const row of (rows || [])) {
        this.coins[row.coin] = {
          baseAmount: parseFloat(row.base_amount) || 0,
          values: [
            parseFloat(row.crank_0),
            parseFloat(row.crank_1),
            parseFloat(row.crank_2),
            parseFloat(row.crank_3),
          ],
          lockedUSDC: parseFloat(row.locked_usdc),
          conversions: parseInt(row.conversions),
        };
        this.totalLockedUSDC += parseFloat(row.locked_usdc);
        // Warn about legacy data (old abstract-points system with baseAmount = 0)
        if (!parseFloat(row.base_amount)) {
          console.warn(`[Cranks] Legacy data for ${row.coin}: base_amount=0. Will be overwritten on next buy.`);
        }
      }
    } catch (error) {
      console.warn('[Cranks] Failed to load from DB:', error.message);
    }
  }

  /**
   * Persist a coin's crank state to DB
   * @private
   */
  async _saveToDB(coinName) {
    const coin = this.coins[coinName];
    if (!coin) return;
    try {
      const sql = `
        INSERT INTO ${this.tableName} (coin, base_amount, crank_0, crank_1, crank_2, crank_3, locked_usdc, conversions)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          base_amount = VALUES(base_amount),
          crank_0 = VALUES(crank_0),
          crank_1 = VALUES(crank_1),
          crank_2 = VALUES(crank_2),
          crank_3 = VALUES(crank_3),
          locked_usdc = VALUES(locked_usdc),
          conversions = VALUES(conversions),
          updated_at = CURRENT_TIMESTAMP
      `;
      await this._query(sql, [
        coinName,
        coin.baseAmount,
        coin.values[0], coin.values[1], coin.values[2], coin.values[3],
        coin.lockedUSDC || 0,
        coin.conversions || 0,
      ]);
    } catch (error) {
      console.warn(`[Cranks] DB save failed for ${coinName}: ${error.message}`);
    }
  }

  /**
   * Create cranks for a new coin on first buy
   * baseAmount = buy cost in USDT — this becomes the cascade unit size.
   * R0 starts at baseAmount (the capital at risk).
   * @param {string} coinName - Coin ticker (e.g. "UNI")
   * @param {number} initialAmountUSD - Cost of the first buy in USDT
   */
  create(coinName, initialAmountUSD) {
    // Allow overwriting legacy entries (baseAmount = 0 from old abstract-points system)
    if (this.coins[coinName] && this.coins[coinName].baseAmount > 0) return; // Already exists with real USD base
    this.coins[coinName] = {
      baseAmount: initialAmountUSD,
      values: [initialAmountUSD, 0, 0, 0],
      lockedUSDC: (this.coins[coinName]?.lockedUSDC) || 0,
      conversions: (this.coins[coinName]?.conversions) || 0,
    };
    console.log(`[Cranks] Created ${coinName}: base=$${initialAmountUSD.toFixed(2)}, [${this.coins[coinName].values.map(v => '$' + v.toFixed(2)).join(' → ')}]`);
    this._saveToDB(coinName).catch(e => console.warn(`[Cranks] DB save failed: ${e.message}`));
  }

  /**
   * Add profit (in USDT) to a coin's cranks — cascades RIGHT toward permanent lockup
   * Cascade triggers at 100%: when R[i] >= 2 × baseAmount, overflow baseAmount to R[i+1].
   * @param {string} coinName - Coin ticker
   * @param {number} amountUSD - Dollar profit (e.g. $4.50 profit from selling)
   * @returns {Promise<Object|null>} - Conversion info if USDC lockup triggered, else null
   */
  async add(coinName, amountUSD) {
    if (!this.coins[coinName]) {
      console.warn(`[Cranks] Cannot add to ${coinName}: no cranks exist. Call create() on first buy.`);
      return null;
    }

    const coin = this.coins[coinName];
    coin.values[0] += amountUSD;

    // Auto-cascade RIGHT when any ratchet reaches 2 × baseAmount (100% gain)
    // Use a loop to handle multi-level cascades in a single add
    if (coin.baseAmount > 0) {
      const cascadeAt = 2 * coin.baseAmount;
      let cascaded = true;
      while (cascaded) {
        cascaded = false;
        for (let i = 0; i < 3; i++) {
          if (coin.values[i] >= cascadeAt) {
            coin.values[i] -= coin.baseAmount;
            coin.values[i + 1] += coin.baseAmount;
            cascaded = true;
          }
        }
      }
    }

    console.log(`[Cranks] ${coinName} +$${amountUSD.toFixed(2)}: [${coin.values.map(v => '$' + v.toFixed(2)).join(' → ')}]`);
    await this._saveToDB(coinName);

    // Check if R3 reached the lock trigger (baseAmount = one full cascade unit)
    // ConversionThreshold of 100 means lock when R3 >= 100% of baseAmount
    const thresholdPct = (Settings.Trading?.Cranks?.ConversionThreshold || 100) / 100;
    const lockTrigger = coin.baseAmount * thresholdPct;
    if (coin.baseAmount > 0 && coin.values[3] >= lockTrigger) {
      return await this._triggerConversion(coinName);
    }

    return null;
  }

  /**
   * Remove loss (in USDT) from a coin's cranks — pulls from R1/R2 if R0 goes negative (NEVER R3)
   * @param {string} coinName - Coin ticker
   * @param {number} amountUSD - Loss amount in dollars (positive number)
   */
  async remove(coinName, amountUSD) {
    if (!this.coins[coinName]) {
      console.log(`[Cranks] ${coinName} does not exist, skipping remove`);
      return;
    }

    const coin = this.coins[coinName];
    coin.values[0] -= amountUSD;

    // If R0 goes negative, pull deficit from R1, then R2 (NEVER from R3)
    for (let i = 1; i <= 2; i++) {
      if (coin.values[0] >= 0) break;
      const deficit = Math.abs(coin.values[0]);
      const pull = Math.min(deficit, coin.values[i]);
      coin.values[i] -= pull;
      coin.values[0] += pull;
    }

    console.log(`[Cranks] ${coinName} -$${amountUSD.toFixed(2)}: [${coin.values.map(v => '$' + v.toFixed(2)).join(' → ')}]`);
    await this._saveToDB(coinName);
  }

  /**
   * TRIGGER: Lock baseAmount as permanent USDC safety reserve
   * Called when R3 reaches the cascade unit (baseAmount).
   * The last ratchet means: convert to USDC and NEVER touch it again.
   * LockAmount = baseAmount (dynamic per coin, not from Settings).
   *
   * @param {string} coinName - Coin that triggered
   * @returns {Object|null} - { coinName, lockedAmount, totalLocked, conversions }
   * @private
   */
  async _triggerConversion(coinName) {
    try {
      const coin = this.coins[coinName];
      const lockAmount = coin.baseAmount; // Lock one cascade unit (= first buy cost)

      // Check available USDT to determine if we can actually lock this amount
      if (this.binance) {
        const balances = await this.binance.GetBalances();
        const freeUSDT = balances.USDT?.free || 0;
        const availableUSDT = freeUSDT - this.totalLockedUSDC;

        // Never lock more than 50% of remaining free balance
        if (lockAmount > availableUSDT * 0.50) {
          console.warn(`[Cranks] 🔒 USDC lockup triggered for ${coinName} but insufficient free USDT ($${availableUSDT.toFixed(2)} after locks, need $${lockAmount.toFixed(2)}). Deferring.`);
          return null;
        }
      }

      // Subtract the lock trigger amount from R3
      const thresholdPct = (Settings.Trading?.Cranks?.ConversionThreshold || 100) / 100;
      coin.values[3] -= coin.baseAmount * thresholdPct;
      coin.lockedUSDC = (coin.lockedUSDC || 0) + lockAmount;
      coin.conversions = (coin.conversions || 0) + 1;
      this.totalLockedUSDC += lockAmount;

      await this._saveToDB(coinName);

      console.log(`[Cranks] 🔒 ═══════════════════════════════════════════`);
      console.log(`[Cranks] 🔒 USDC LOCKUP #${coin.conversions} for ${coinName}`);
      console.log(`[Cranks] 🔒 Locked: $${lockAmount.toFixed(2)} USDC — converted, NEVER touch again`);
      console.log(`[Cranks] 🔒 Total locked across all coins: $${this.totalLockedUSDC.toFixed(2)} USDC`);
      console.log(`[Cranks] 🔒 ${coinName} ratchets: [${coin.values.map(v => '$' + v.toFixed(2)).join(' → ')}]`);
      console.log(`[Cranks] 🔒 ═══════════════════════════════════════════`);

      return {
        coinName,
        lockedAmount: lockAmount,
        totalLocked: this.totalLockedUSDC,
        conversions: coin.conversions,
      };
    } catch (error) {
      console.error(`[Cranks] Conversion failed for ${coinName}: ${error.message}`);
      return null;
    }
  }

  /**
   * Get total permanently locked USDC across all coins
   * This amount is EXCLUDED from trading balance — it can never be used again.
   * @returns {number} - Dollar amount of locked USDC
   */
  getLockedUSDC() {
    return this.totalLockedUSDC;
  }

  /**
   * Get the MockBalance — the maximum USDT the bot is allowed to trade with.
   * Returns Infinity (unrestricted) until the first crank is "turned" (a cascade event).
   * A cascade = profit overflowing from R0 into R1+. Once that happens, MockBalance = sum of R0.
   * Safety ratchets (R1, R2, R3) are protected capital and NOT included.
   * Example: cranks [30, 0, 0, 0] → no cascade yet → Infinity (100% available)
   *          cranks [30, 30, 0, 0] → cascade happened → MockBalance = 30 (R0 only)
   * @returns {number} - Dollar amount available for trading, or Infinity if no cranks have cascaded
   */
  getMockBalance() {
    const coins = Object.values(this.coins);
    if (coins.length === 0) return Infinity; // No cranks yet — don't restrict trading

    // Check if ANY crank has been "turned" (any R1, R2, or R3 > 0 means a cascade happened)
    let anyCascade = false;
    let totalR0 = 0;
    for (const coin of coins) {
      totalR0 += Math.max(0, coin.values[0]);
      if (coin.values[1] > 0 || coin.values[2] > 0 || coin.values[3] > 0 || (coin.lockedUSDC || 0) > 0) {
        anyCascade = true;
      }
    }

    // No cranks turned yet → trade with full balance (100%)
    if (!anyCascade) return Infinity;

    // Cranks have been turned → MockBalance = sum of R0 (protected capital excluded)
    return totalR0;
  }

  /**
   * Get crank status for a specific coin
   * @param {string} coinName - Coin ticker
   * @returns {Object|null} - { baseAmount, values, lockedUSDC, conversions } or null
   */
  getStatus(coinName) {
    return this.coins[coinName] || null;
  }

  /**
   * Get a formatted summary string for display in GPT context
   * @returns {string}
   */
  getSummary() {
    if (Object.keys(this.coins).length === 0) return '';

    let summary = `\nCranks Safety System (Annihilation Prevention):\n`;
    summary += `- Total USDC Permanently Locked: $${this.totalLockedUSDC.toFixed(2)} (converted, never touched again)\n`;

    for (const [coin, data] of Object.entries(this.coins)) {
      const total = data.values[0] + data.values[1] + data.values[2] + data.values[3];
      summary += `- ${coin}: [${data.values.map(v => '$' + v.toFixed(2)).join(' → ')}] base=$${data.baseAmount.toFixed(2)} | $${(data.lockedUSDC || 0).toFixed(2)} locked\n`;
    }

    return summary;
  }

  /**
   * Close DB connection
   */
  async Close() {
    if (this.connection) {
      try { await this.connection.end(); } catch (_) {}
    }
  }
}

module.exports = Cranks;
