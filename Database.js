/**
 * Database Schema Creator — AgentSmith
 * 
 * Programmatic replacement for Database.sql.
 * Creates all tables, indexes, views, and constraints from scratch.
 * Safe to run repeatedly — uses CREATE TABLE IF NOT EXISTS.
 * 
 * Usage:
 *   node Database.js          — Create all tables
 *   node Database.js --nuke   — Drop ALL tables and recreate from scratch
 *   node Database.js --seed   — Create tables + seed default Settings
 * 
 * Table Map (old → new):
 *   gpt_action_log      → Actions
 *   gpt_auto_loops       → Loops
 *   gpt_decisions        → Decisions
 *   gpt_market_snapshots → Snapshots
 *   trading_cranks       → Cranks
 *   trading_history      → History
 *   trading_pairs        → Pairs
 *   (new)                → Settings
 *   transactions         → REMOVED
 *   wallets              → REMOVED
 */

const MySQL = require('promise-mysql');
const Config = require('./MySQL.json');

// ─── Table Definitions ──────────────────────────────────────────────────────

const Tables = {

  Settings: `
    CREATE TABLE IF NOT EXISTS Settings (
      \`key\` VARCHAR(128) PRIMARY KEY COMMENT 'Dot-notation key e.g. Trading.Rules.MinimumTradeValue',
      \`value\` TEXT NOT NULL COMMENT 'JSON-encoded value',
      \`category\` VARCHAR(64) NOT NULL COMMENT 'Top-level grouping: Binance, Trading, OnRestart, Discord, etc.',
      \`description\` VARCHAR(255) DEFAULT NULL COMMENT 'Human-readable description',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_category (category)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      COMMENT='Application configuration — replaces Settings.json'
  `,

  Decisions: `
    CREATE TABLE IF NOT EXISTS Decisions (
      id VARCHAR(255) PRIMARY KEY COMMENT 'Unique decision UUID',
      \`timestamp\` DATETIME NOT NULL COMMENT 'When decision was made',
      \`query\` LONGTEXT NOT NULL COMMENT 'Original query/prompt that triggered decision',
      chain JSON NOT NULL COMMENT 'Array of [think, validate, act, reflect] steps with full reasoning',
      actions JSON DEFAULT NULL COMMENT 'Parsed action objects extracted from act step',
      market_analysis JSON DEFAULT NULL,
      \`status\` VARCHAR(32) DEFAULT 'completed' COMMENT 'completed, pending, failed',
      loop_id VARCHAR(255) DEFAULT NULL COMMENT 'Link to parent loop if part of autonomous session',
      next_decision_id VARCHAR(255) DEFAULT NULL COMMENT 'Link to sequential next decision for chain tracking',
      result_summary TEXT DEFAULT NULL COMMENT 'Summary of decision outcomes and action results',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_timestamp (\`timestamp\`),
      INDEX idx_status (\`status\`),
      INDEX idx_loop_id (loop_id),
      INDEX idx_created (created_at),
      INDEX fk_next_decision (next_decision_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      COMMENT='Persistent storage for all GPT decisions with full chain-of-thought'
  `,

  Loops: `
    CREATE TABLE IF NOT EXISTS Loops (
      id VARCHAR(255) PRIMARY KEY COMMENT 'Unique loop/session UUID',
      initial_prompt LONGTEXT NOT NULL COMMENT 'The starting prompt that initiated the loop',
      \`status\` VARCHAR(32) DEFAULT 'running' COMMENT 'running, completed, failed, timeout, paused',
      decision_count INT DEFAULT 0 COMMENT 'Total decisions made in this loop',
      start_time DATETIME NOT NULL COMMENT 'When loop started',
      end_time DATETIME DEFAULT NULL COMMENT 'When loop ended (NULL if still running)',
      final_outcome LONGTEXT DEFAULT NULL COMMENT 'Summary of loop results and final action taken',
      config JSON DEFAULT NULL COMMENT 'Configuration used for this loop: maxIterations, timeoutMs, etc.',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_status (\`status\`),
      INDEX idx_start_time (start_time),
      INDEX idx_end_time (end_time),
      INDEX idx_created (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      COMMENT='Session tracking for autonomous AutoProcess loops'
  `,

  Actions: `
    CREATE TABLE IF NOT EXISTS Actions (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY COMMENT 'Auto-increment log entry ID',
      decision_id VARCHAR(255) NOT NULL COMMENT 'Foreign key to Decisions',
      action_type VARCHAR(64) NOT NULL COMMENT 'Type of action: buy, sell, query, wait, complete, etc.',
      execution_status VARCHAR(32) DEFAULT 'pending' COMMENT 'pending, executing, completed, failed',
      execution_result JSON DEFAULT NULL COMMENT 'Result of action execution',
      execution_time DATETIME DEFAULT NULL COMMENT 'When action actually executed',
      duration_ms INT DEFAULT NULL COMMENT 'How long execution took in milliseconds',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_decision_id (decision_id),
      INDEX idx_action_type (action_type),
      INDEX idx_status (execution_status),
      INDEX idx_execution_time (execution_time),
      INDEX idx_created (created_at),
      CONSTRAINT fk_actions_decision FOREIGN KEY (decision_id) REFERENCES Decisions(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      COMMENT='Execution audit trail for all GPT-decided actions'
  `,

  Snapshots: `
    CREATE TABLE IF NOT EXISTS Snapshots (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY COMMENT 'Auto-increment ID',
      decision_id VARCHAR(255) DEFAULT NULL COMMENT 'Associated decision',
      symbol VARCHAR(32) DEFAULT NULL COMMENT 'Trading pair: LTCUSDT, BTCUSDT, etc.',
      price DECIMAL(18, 8) DEFAULT NULL COMMENT 'Asset price at snapshot time',
      balance DECIMAL(18, 8) DEFAULT NULL COMMENT 'Available balance',
      market_data JSON DEFAULT NULL COMMENT 'Full market data used for decision',
      snapshot_time DATETIME NOT NULL COMMENT 'When snapshot was taken',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_decision_id (decision_id),
      INDEX idx_symbol (symbol),
      INDEX idx_snapshot_time (snapshot_time),
      CONSTRAINT fk_snapshots_decision FOREIGN KEY (decision_id) REFERENCES Decisions(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      COMMENT='Market data snapshots captured with each decision for replay/analysis'
  `,

  Cranks: `
    CREATE TABLE IF NOT EXISTS Cranks (
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
      COMMENT='Cranks safety system — cascading profit lockup'
  `,

  History: `
    CREATE TABLE IF NOT EXISTS History (
      id VARCHAR(255) PRIMARY KEY COMMENT 'Unique trade ID (UUID)',
      order_id VARCHAR(255) DEFAULT NULL UNIQUE COMMENT 'Binance Order ID',
      pair VARCHAR(20) NOT NULL COMMENT 'Trading pair (e.g., LTCUSDT)',
      action VARCHAR(10) NOT NULL COMMENT 'BUY or SELL',
      quantity DECIMAL(20, 8) NOT NULL COMMENT 'Amount of asset traded',
      price DECIMAL(20, 8) NOT NULL COMMENT 'Price per unit',
      total_value DECIMAL(20, 8) NOT NULL COMMENT 'Total value (quantity * price)',
      entry_price DECIMAL(20, 8) DEFAULT NULL COMMENT 'Entry price (for sell orders)',
      profit_loss DECIMAL(20, 8) DEFAULT NULL COMMENT 'Profit/loss amount in USDT',
      profit_loss_percent DECIMAL(10, 4) DEFAULT NULL COMMENT 'Profit/loss percentage',
      \`timestamp\` DATETIME NOT NULL COMMENT 'When trade was executed',
      loop_id VARCHAR(255) DEFAULT NULL COMMENT 'Associated autonomous loop ID',
      decision_id VARCHAR(255) DEFAULT NULL COMMENT 'Associated GPT decision ID',
      \`status\` VARCHAR(32) DEFAULT 'completed' COMMENT 'pending, completed, failed, cancelled',
      notes TEXT DEFAULT NULL COMMENT 'Additional notes about the trade',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_timestamp (\`timestamp\`),
      INDEX idx_action (action),
      INDEX idx_pair (pair),
      INDEX idx_loop_id (loop_id),
      INDEX idx_status (\`status\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      COMMENT='Executed trade history'
  `,

  Pairs: `
    CREATE TABLE IF NOT EXISTS Pairs (
      id VARCHAR(50) PRIMARY KEY COMMENT 'Trading pair (e.g., LTCUSDT)',
      base_asset VARCHAR(20) NOT NULL COMMENT 'Base asset (e.g., LTC)',
      quote_asset VARCHAR(20) NOT NULL COMMENT 'Quote asset (e.g., USDT)',
      last_checked DATETIME DEFAULT NULL COMMENT 'Last analysis timestamp',
      last_action VARCHAR(50) DEFAULT NULL COMMENT 'Last action taken (BUY/SELL/WAIT)',
      volatility DECIMAL(10, 4) DEFAULT NULL COMMENT '24h price volatility percentage',
      volume_24h DECIMAL(20, 2) DEFAULT NULL COMMENT '24h trading volume in quote asset',
      price_change_24h DECIMAL(10, 4) DEFAULT NULL COMMENT '24h price change percentage',
      trend VARCHAR(20) DEFAULT NULL COMMENT 'Current trend (UPTREND/DOWNTREND/NEUTRAL)',
      score DECIMAL(10, 4) DEFAULT NULL COMMENT 'Pair viability score (0-100)',
      enabled BOOLEAN DEFAULT true COMMENT 'Whether to include in trading rotation',
      notes TEXT DEFAULT NULL COMMENT 'Analysis notes',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_last_checked (last_checked),
      INDEX idx_enabled (enabled),
      INDEX idx_score (score DESC)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      COMMENT='Trading pair analysis and rotation tracking'
  `,
};

// ─── Views ──────────────────────────────────────────────────────────────────

const Views = {

  vw_action_summary: `
    CREATE OR REPLACE VIEW vw_action_summary AS
    SELECT
      d.loop_id,
      a.action_type,
      COUNT(*) AS \`count\`,
      SUM(CASE WHEN a.execution_status = 'completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN a.execution_status = 'failed' THEN 1 ELSE 0 END) AS failed,
      AVG(a.duration_ms) AS avg_duration_ms
    FROM Actions a
    JOIN Decisions d ON a.decision_id = d.id
    GROUP BY d.loop_id, a.action_type
    ORDER BY d.loop_id, a.action_type
  `,

  vw_decision_chain: `
    CREATE OR REPLACE VIEW vw_decision_chain AS
    SELECT
      d.loop_id,
      d.id AS decision_id,
      d.\`timestamp\`,
      SUBSTR(d.\`query\`, 1, 100) AS query_preview,
      JSON_LENGTH(d.chain) AS chain_steps,
      IF(d.actions IS NOT NULL, JSON_LENGTH(d.actions), 0) AS action_count,
      IF(JSON_EXTRACT(d.chain, '$[2].actions') IS NOT NULL,
         JSON_EXTRACT(d.chain, '$[2].actions[0].action'), NULL) AS primary_action,
      d.result_summary
    FROM Decisions d
    ORDER BY d.loop_id, d.\`timestamp\`
  `,

  vw_loop_summary: `
    CREATE OR REPLACE VIEW vw_loop_summary AS
    SELECT
      l.id AS loop_id,
      l.initial_prompt,
      l.\`status\`,
      l.decision_count,
      l.start_time,
      l.end_time,
      TIMESTAMPDIFF(SECOND, l.start_time, COALESCE(l.end_time, CURRENT_TIMESTAMP)) AS duration_seconds,
      COUNT(d.id) AS actual_decisions,
      l.final_outcome
    FROM Loops l
    LEFT JOIN Decisions d ON l.id = d.loop_id
    GROUP BY l.id
    ORDER BY l.start_time DESC
  `,
};

// ─── Default Settings Seed ──────────────────────────────────────────────────

const DefaultSettings = [
  // ── Binance ──
  { key: 'Binance.testnet',      value: false,       category: 'Binance',  description: 'Use Binance testnet' },
  { key: 'Binance.pair',         value: 'LTCUSDT',   category: 'Binance',  description: 'Default trading pair' },
  { key: 'Binance.baseAsset',    value: 'LTC',       category: 'Binance',  description: 'Base asset ticker' },
  { key: 'Binance.quoteAsset',   value: 'USDT',      category: 'Binance',  description: 'Quote asset ticker' },
  { key: 'Binance.quantity',     value: 0.1,          category: 'Binance',  description: 'Default order quantity' },
  { key: 'Binance.buyTarget',    value: 0.98,         category: 'Binance',  description: 'Buy target ratio' },
  { key: 'Binance.sellTarget',   value: 1.02,         category: 'Binance',  description: 'Sell target ratio' },
  { key: 'Binance.minNotional',  value: 10,           category: 'Binance',  description: 'Minimum notional value for orders' },

  // ── Trading Rules ──
  { key: 'Trading.Rules.MinimumTradeValue',                      value: 5,     category: 'Trading', description: 'Minimum trade value in USDT' },
  { key: 'Trading.Rules.BalanceRequirements.MinUSDTForBuy',      value: 5,     category: 'Trading', description: 'Minimum USDT balance to allow buying' },
  { key: 'Trading.Rules.BalanceRequirements.MinAssetValueForSell', value: 5,   category: 'Trading', description: 'Minimum asset value in USDT to allow selling' },
  { key: 'Trading.Rules.BalanceRequirements.PreservationPercent', value: 0.1,   category: 'Trading', description: 'Balance preservation buffer percentage' },
  { key: 'Trading.Rules.PositionSizing.GPTControlled',           value: true,  category: 'Trading', description: 'Let GPT control position sizing' },
  { key: 'Trading.Rules.PositionSizing.DefaultPercent',          value: 15,    category: 'Trading', description: 'Default position size percentage' },
  { key: 'Trading.Rules.PositionSizing.MinPercent',              value: 5,     category: 'Trading', description: 'Minimum position size percentage' },
  { key: 'Trading.Rules.PositionSizing.MaxPercent',              value: 20,    category: 'Trading', description: 'Maximum position size percentage (hard cap)' },
  { key: 'Trading.Rules.PositionSizing.SellPercentOfHolding',    value: 0.95,  category: 'Trading', description: 'Fraction of holding to sell' },
  { key: 'Trading.Rules.ProfitTargets.MinProfitPercentToSell',   value: 4,     category: 'Trading', description: 'Minimum profit % before selling is allowed' },
  { key: 'Trading.Rules.ProfitTargets.PreferredProfitPercent',   value: 6,     category: 'Trading', description: 'Preferred profit target %' },
  { key: 'Trading.Rules.ProfitTargets.TakeProfitAt',             value: 10,    category: 'Trading', description: 'Auto-take-profit threshold %' },
  { key: 'Trading.Rules.LossPrevention.MaxLossPercent',          value: -0.5,  category: 'Trading', description: 'Maximum tolerable loss percentage' },
  { key: 'Trading.Rules.LossPrevention.NeverSellBelow',          value: 'entry_price', category: 'Trading', description: 'Never sell below this reference' },
  { key: 'Trading.Rules.LossPrevention.StrictlyNoLosses',        value: true,  category: 'Trading', description: 'Hard block on any trade that would lose money' },
  { key: 'Trading.Rules.Timeframes.MinHoldMinutes',              value: 5,     category: 'Trading', description: 'Minimum hold time in minutes' },
  { key: 'Trading.Rules.Timeframes.MaxHoldDays',                 value: 30,    category: 'Trading', description: 'Maximum hold time in days' },
  { key: 'Trading.Rules.Timeframes.CheckIntervalSeconds',        value: 60,    category: 'Trading', description: 'Interval between checks in seconds' },

  // ── Trading Trend Thresholds ──
  { key: 'Trading.TrendThresholds.BuyOnlyInDowntrend',    value: false, category: 'Trading', description: 'Restrict buying to downtrends only' },
  { key: 'Trading.TrendThresholds.SellOnlyInUptrend',     value: true,  category: 'Trading', description: 'Restrict selling to uptrends only' },
  { key: 'Trading.TrendThresholds.MinVolatilityForTrade', value: 0.5,   category: 'Trading', description: 'Minimum volatility to consider trading' },
  { key: 'Trading.TrendThresholds.MaxVolatilityForTrade', value: 5.0,   category: 'Trading', description: 'Maximum volatility to consider trading' },

  // ── Trading Misc ──
  { key: 'Trading.Values_Only_Logging',         value: true,  category: 'Trading', description: 'Log only numerical values by default' },
  { key: 'Trading.Cranks.Enabled',              value: true,  category: 'Trading', description: 'Enable Cranks safety system' },
  { key: 'Trading.Cranks.ConversionThreshold',  value: 100,   category: 'Trading', description: 'USDC conversion threshold in dollars' },

  // ── Trading Test Mode ──
  { key: 'Trading.TestMode.Enabled',                   value: false, category: 'Trading', description: 'Enable test mode (no real trades)' },
  { key: 'Trading.TestMode.OverrideBalanceChecks',     value: false, category: 'Trading', description: 'Override balance checks in test mode' },
  { key: 'Trading.TestMode.OverrideProfitRequirements', value: false, category: 'Trading', description: 'Override profit requirements in test mode' },
  { key: 'Trading.TestMode.UseFullBalance',            value: false, category: 'Trading', description: 'Use full balance in test mode' },
  { key: 'Trading.TestMode.AllowSelling',              value: true,  category: 'Trading', description: 'Allow selling in test mode' },
  { key: 'Trading.TestMode.AllowBuying',               value: true,  category: 'Trading', description: 'Allow buying in test mode' },

  // ── Active Pairs ──
  { key: 'Trading.ActivePairs', value: [
    { pair: 'LTC/USDT', enabled: true, minTradeValue: 10, positionSizePercent: 80, minProfitPercentToSell: 4 }
  ], category: 'Trading', description: 'Active trading pairs configuration' },

  // ── OnRestart ──
  { key: 'OnRestart.Clear_Decisions', value: true,  category: 'OnRestart', description: 'Clear Decisions table on restart' },
  { key: 'OnRestart.Clear_Loops',     value: true,  category: 'OnRestart', description: 'Clear Loops table on restart' },
  { key: 'OnRestart.Clear_History',   value: true,  category: 'OnRestart', description: 'Clear History table on restart' },
  { key: 'OnRestart.Clear_Cranks',    value: true,  category: 'OnRestart', description: 'Clear Cranks table on restart' },
  { key: 'OnRestart.Sell_All',        value: false, category: 'OnRestart', description: 'Sell all open positions on restart' },

  // ── Discord ──
  { key: 'Discord.Enabled',          value: false, category: 'Discord', description: 'Enable Discord bot' },
  { key: 'Discord.ClientID',         value: '',    category: 'Discord', description: 'Discord application Client ID' },
  { key: 'Discord.GuildID',          value: '',    category: 'Discord', description: 'Discord server (guild) ID' },
  { key: 'Discord.Token',            value: '',    category: 'Discord', description: 'Discord bot token' },
  { key: 'Discord.Staff_Role',       value: '',    category: 'Discord', description: 'Staff role ID for permission checks' },
  { key: 'Discord.Warnings_Channel', value: '',    category: 'Discord', description: 'Channel ID for warning notifications' },
  { key: 'Discord.Status_Channel',   value: '',    category: 'Discord', description: 'Channel ID for status updates' },

  // ── System ──
  { key: 'System.Production', value: true, category: 'System', description: 'Production mode flag' },
  { key: 'System.Debug',      value: true, category: 'System', description: 'Debug mode flag' },
];

// ─── Execution ──────────────────────────────────────────────────────────────

async function GetConnection() {
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
  return MySQL.createConnection(opts);
}

/**
 * Drop all tables and views (nuclear option)
 */
async function NukeDatabase(conn) {
  console.log('[Database] NUKING all tables and views...');
  await conn.query('SET FOREIGN_KEY_CHECKS = 0');

  // Drop views first
  for (const name of Object.keys(Views)) {
    await conn.query(`DROP VIEW IF EXISTS ${name}`);
    console.log(`  Dropped view: ${name}`);
  }
  // Drop tables
  for (const name of Object.keys(Tables)) {
    await conn.query(`DROP TABLE IF EXISTS ${name}`);
    console.log(`  Dropped table: ${name}`);
  }
  // Drop legacy tables
  const legacyTables = [
    'gpt_action_log', 'gpt_auto_loops', 'gpt_decisions', 'gpt_market_snapshots',
    'trading_cranks', 'trading_history', 'trading_pairs', 'transactions', 'wallets'
  ];
  for (const name of legacyTables) {
    await conn.query(`DROP TABLE IF EXISTS ${name}`);
    console.log(`  Dropped legacy table: ${name}`);
  }
  // Drop legacy views
  const legacyViews = ['vw_action_summary', 'vw_decision_chain', 'vw_loop_summary'];
  for (const name of legacyViews) {
    await conn.query(`DROP VIEW IF EXISTS ${name}`);
  }

  await conn.query('SET FOREIGN_KEY_CHECKS = 1');
  console.log('[Database] Nuke complete.\n');
}

/**
 * Create all tables
 */
async function CreateTables(conn) {
  console.log('[Database] Creating tables...');
  // Order matters due to foreign keys: Decisions first, then Actions/Snapshots that reference it
  const ordered = ['Settings', 'Decisions', 'Loops', 'Actions', 'Snapshots', 'Cranks', 'History', 'Pairs'];
  for (const name of ordered) {
    try {
      await conn.query(Tables[name]);
      console.log(`  ✓ ${name}`);
    } catch (err) {
      if (err.message.includes('already exists')) {
        console.log(`  ○ ${name} (exists)`);
      } else {
        console.error(`  ✗ ${name}: ${err.message}`);
      }
    }
  }
  console.log('');
}

/**
 * Create all views
 */
async function CreateViews(conn) {
  console.log('[Database] Creating views...');
  for (const [name, sql] of Object.entries(Views)) {
    try {
      await conn.query(sql);
      console.log(`  ✓ ${name}`);
    } catch (err) {
      console.error(`  ✗ ${name}: ${err.message}`);
    }
  }
  console.log('');
}

/**
 * Seed default settings into Settings table
 */
async function SeedSettings(conn) {
  console.log('[Database] Seeding default settings...');
  let inserted = 0;
  let skipped = 0;

  for (const setting of DefaultSettings) {
    try {
      const jsonValue = JSON.stringify(setting.value);
      const sql = `
        INSERT INTO Settings (\`key\`, \`value\`, category, description)
        VALUES (?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          \`value\` = IF(\`value\` = VALUES(\`value\`), \`value\`, \`value\`),
          updated_at = updated_at
      `;
      const result = await conn.query(sql, [setting.key, jsonValue, setting.category, setting.description || null]);
      if (result.affectedRows > 0 && result.warningCount === 0) {
        inserted++;
      } else {
        skipped++;
      }
    } catch (err) {
      console.error(`  ✗ ${setting.key}: ${err.message}`);
    }
  }

  console.log(`  ${inserted} inserted, ${skipped} unchanged\n`);
}

/**
 * Main entry point
 */
async function Run() {
  const args = process.argv.slice(2);
  const doNuke = args.includes('--nuke');
  const doSeed = args.includes('--seed');

  let conn;
  try {
    conn = await GetConnection();
    console.log(`[Database] Connected to ${Config.database}@${Config.host || Config.socketPath}\n`);

    if (doNuke) {
      await NukeDatabase(conn);
    }

    await CreateTables(conn);
    await CreateViews(conn);

    // Always seed on --nuke or --seed
    if (doNuke || doSeed) {
      await SeedSettings(conn);
    }

    console.log('[Database] Schema setup complete.');
  } catch (err) {
    console.error('[Database] Fatal:', err.message);
    process.exit(1);
  } finally {
    if (conn) conn.end();
  }
}

// Export for programmatic use
module.exports = { GetConnection, NukeDatabase, CreateTables, CreateViews, SeedSettings, DefaultSettings, Tables, Views };

// Run if called directly
if (require.main === module) {
  Run().catch(console.error);
}
