/*
Payment server for Swaps.to
*/
const BigNumber = require('bignumber.js');

// GPT Logging Toggle - Set to true for detailed API debug output, false for clean production output
const GPT_LOGGING = false; // Change to false to hide DEBUG_ logs and raw API responses

// CLI Arguments Parser
const args = process.argv.slice(2);
let cliConfig = {
  loop: false,
  count: null, // null = infinite loop (default for trading bot), or specific number
  test: false,
  fast: false, // Set to true with --fast flag to use 5 seconds instead of 5 minutes between iterations
  log: null,   // --log=all --log=gpt --log=numbers --log=pairs --log=logic --log=trading --log=gpt&numbers etc.
};

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--loop') {
    cliConfig.loop = true;
  } else if (args[i].startsWith('--count=')) {
    // Handle --count=2 format
    cliConfig.count = parseInt(args[i].substring(8), 10) || 1;
  } else if (args[i] === '--count' && args[i + 1]) {
    // Handle --count 2 format (space-separated)
    cliConfig.count = parseInt(args[i + 1], 10) || 1;
    i++;
  } else if (args[i] === '--test') {
    cliConfig.test = true;
  } else if (args[i] === '--fast') {
    cliConfig.fast = true; // 5 seconds between iterations instead of 5 minutes
  } else if (args[i].startsWith('--log=')) {
    // Handle --log=all,gpt,numbers,pairs,logic,trading format
    cliConfig.log = args[i].substring(6);
  } else if (args[i] === '--log' && args[i + 1]) {
    cliConfig.log = args[i + 1];
    i++;
  }
}

// Parse log configuration from --log flag
function ParseLogConfig(logString) {
  const config = {};
  if (!logString) return config;
  
  // Handle --log=all
  if (logString === 'all') {
    config.all = true;
    return config;
  }
  
  // Handle comma-separated or ampersand-separated log types: --log=gpt,numbers or --log=gpt&numbers
  const types = logString.split(/[,&]/);
  for (const type of types) {
    const trimmed = type.trim().toLowerCase();
    if (['gpt', 'pairs', 'numbers', 'logic', 'trading', 'loop'].includes(trimmed)) {
      config[trimmed] = true;
    }
  }
  
  return config;
}

if (cliConfig.log) {
  process.logConfig = ParseLogConfig(cliConfig.log);
  console.log(`[CLI] Log filters enabled: ${Object.keys(process.logConfig).join(', ')}`);
} else {
  process.logConfig = {};
}

BigNumber.config({
  ROUNDING_MODE: BigNumber.ROUND_DOWN,
  EXPONENTIAL_AT: 9 + 1,
});

const Core = require('./Wallet/Core.js');

const Settings = require('./Settings.json');

// Apply Settings.Trading.LogNumbers as default log filter if no CLI --log flag provided
if (!cliConfig.log && Settings.Trading?.Values_Only_Logging) {
  cliConfig.log = 'numbers';
  process.logConfig = ParseLogConfig(cliConfig.log);
  console.log(`[CLI] Log filters enabled (from Settings): ${Object.keys(process.logConfig).join(', ')}`);
}

const Utils = require('./Core/Utils.js');
const KeyManager = require('./Core/KeyManager.js');
const ExchangeDiscovery = require('./Core/ExchangeDiscovery.js');
const MarketAnalysis = require('./Core/MarketAnalysis.js');
const BinanceExchange = require('./Exchanges/CEX/Binance.js');
const GPTWrapper = require('./Core/GPT.js');
const DecisionDB = require('./Core/DecisionDB.js');
const TradeDB = require('./Core/TradeDB.js');
const PairDB = require('./Core/PairDB.js');
const PairSelector = require('./Core/PairSelector.js');
const AutoTrader = require('./Core/AutoTrader.js');
const Cranks = require('./Core/Cranks.js');
const MySQL = require('promise-mysql');
const fs = require('fs');
const path = require('path');

// Set the Values_Only_Logging flag globally FIRST before Logger or any logging happens
process.valuesOnlyLogging = Settings.Trading?.Values_Only_Logging || false;

// Setup file-based logging to output.log BEFORE Logger class
const logFile = path.join(__dirname, 'output.log');
const logStream = fs.createWriteStream(logFile, { flags: 'w' }); // 'w' mode: truncate on start

const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

// Check if Values_Only_Logging is enabled
const VALUES_ONLY_LOGGING = Settings.Trading?.Values_Only_Logging || false;
// ULTRA-STRICT: Only show ACTUAL trade execution messages (not pre-execution checks or constraints)
const TRADE_LOG_PATTERNS = /^(===\s+Log|\[LOOP\]|\[AUTOTRADER\] (Loop|Executing action|Final action|Autonomous|Action execution failed)|Buy order placed|Sell order placed|Order ID|Duration:|Starting|Completed|Ready for)/i;

console.log = function(...args) {
  // Check if last argument is a logType config object
  let logType = 'default';
  let logArgs = args;
  
  if (args.length > 0 && typeof args[args.length - 1] === 'object' && !Array.isArray(args[args.length - 1]) && args[args.length - 1].logType) {
    logType = args[args.length - 1].logType;
    logArgs = args.slice(0, -1);
  }
  
  const message = logArgs.map(arg => typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)).join(' ');
  
  // If --log= filters are set, they OVERRIDE Values_Only_Logging
  if (process.logConfig && Object.keys(process.logConfig).length > 0) {
    if (!_shouldLogMessage(message, logType)) {
      return; // Skip this message based on log filters
    }
  } else if (VALUES_ONLY_LOGGING && !TRADE_LOG_PATTERNS.test(message)) {
    // Otherwise, respect Values_Only_Logging if set
    return; // Skip ALL non-matching messages
  }
  
  logStream.write(message + '\n');
  originalLog.apply(console, logArgs);
};

console.error = function(...args) {
  // Errors are NEVER filtered — always log them
  let logArgs = args;
  
  if (args.length > 0 && typeof args[args.length - 1] === 'object' && !Array.isArray(args[args.length - 1]) && args[args.length - 1].logType) {
    logArgs = args.slice(0, -1);
  }
  
  const message = logArgs.map(arg => typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)).join(' ');
  
  logStream.write('[ERROR] ' + message + '\n');
  originalError.apply(console, logArgs);
};

console.warn = function(...args) {
  // Warnings are NEVER filtered — always log them
  let logArgs = args;
  
  if (args.length > 0 && typeof args[args.length - 1] === 'object' && !Array.isArray(args[args.length - 1]) && args[args.length - 1].logType) {
    logArgs = args.slice(0, -1);
  }
  
  const message = logArgs.map(arg => typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)).join(' ');
  
  logStream.write('[WARN] ' + message + '\n');
  originalWarn.apply(console, logArgs);
};

// Helper function to check if message matches log type
function _shouldLogMessage(message, logType) {
  const logConfig = process.logConfig || {};
  
  // If no filters are set, log everything
  if (!logConfig || Object.keys(logConfig).length === 0) return true;
  
  // If logAll is set, log everything
  if (logConfig.all) return true;
  
  // Always log critical trading messages regardless of filters
  if (message.includes('[LOOP]') || message.includes('[AUTOTRADER]') || message.includes('=== Log')) return true;
  
  // Check which log types are enabled and if message matches them
  let matchesFilter = false;
  
  if (logConfig.gpt && message.includes('[GPT]')) matchesFilter = true;
  if (logConfig.pairs && (message.includes('[PAIR]') || message.includes('[PAIR ROTATION]'))) matchesFilter = true;
  if (logConfig.numbers && (message.includes('[METRICS]'))) matchesFilter = true;
  if (logConfig.logic && (message.includes('[LOGIC]'))) matchesFilter = true;
  if (logConfig.trading && (message.includes('[AUTOTRADER]'))) matchesFilter = true;
  if (logConfig.loop && message.includes('[LOOP]')) matchesFilter = true;
  
  // Always log errors and warnings regardless of filters
  if (message.includes('[ERROR]') || message.includes('[WARN]') || message.includes('SyntaxError')) matchesFilter = true;
  
  return matchesFilter;
}

// NOW initialize Logger - after console.log override is in place
const Logger = require('./Core/Logger.js');
const logger = new Logger('output.log');

var Client = {
  Engine: null,
  Connection: null,
  Tick: null,
};

let Detected = [];

class PaymentProcessor {
  constructor() {
    this.connection = null;
    this.walletManager = null;
    this.processedTransactions = new Set(); // Track processed transactions
  }

  async initialize() {
    this.connection = await Utils.Connection(MySQL, this.connection);
    this.walletManager = await require('./Wallet/Users.js')();
    console.log('[Payment Server] Starting...');
  }

  async processDeposit(transaction, engine, coinType) {
    try {
      const txid = transaction.txid;
      const address = transaction.address;
      const amount = transaction.amount;
      const confirmations = transaction.confirmations;

      console.log(`Processing deposit: ${txid} to ${address} for ${amount} ${coinType} (${confirmations} confirmations)`);

      // Skip if already processed
      if (this.processedTransactions.has(txid)) {
        console.log(`Transaction ${txid} already processed, skipping`);
        return;
      }

      // Validate minimum confirmations
      if (confirmations < 1) {
        console.log(`Transaction ${txid} needs more confirmations (${confirmations}/1)`);
        return;
      }

      // Get user UUID by address
      const userUuid = await this.walletManager.Get_User_By_Address(address);
      if (!userUuid) {
        console.log(`No user found for address ${address}, skipping transaction ${txid}`);
        return;
      }

      // Check if transaction already exists in database
      const existingTx = await this.getTransactionByTxid(txid);
      if (existingTx && existingTx.status === 'Completed') {
        console.log(`Transaction ${txid} already completed, skipping`);
        this.processedTransactions.add(txid);
        return;
      }

      // Validate minimum deposit amount
      if (amount < 0.001) {
        console.log(`Deposit amount ${amount} ${coinType} is below minimum (0.001), skipping`);
        return;
      }

      // FIXED: Update user balance with specific transaction amount only
      const balanceUpdated = await this.walletManager.addBalance(
        userUuid,
        amount, // Use specific transaction amount
        { type: coinType.toUpperCase(), decimals: 8 },
      );

      if (!balanceUpdated) {
        console.error(`Failed to update balance for user ${userUuid}, amount: ${amount} ${coinType}`);
        return;
      }

      console.log(`Balance updated for user ${userUuid}: +${amount} ${coinType}`);

      // Record transaction in database
      const txRecorded = await this.recordTransaction(userUuid, address, amount, txid, coinType, transaction);

      if (txRecorded) {
        console.log(`Transaction ${txid} recorded successfully`);
        this.processedTransactions.add(txid);

        // Get username for logging
        const username = await this.walletManager.Get_Users_Name_By_UUID(userUuid);
        console.log(`Deposit processed: ${amount} ${coinType} for user ${username} (${userUuid})`);
      } else {
        console.error(`Failed to record transaction ${txid} in database`);
      }
    } catch (error) {
      console.error(`Error processing deposit for transaction ${transaction.txid}:`, error);
    }
  }
}

/*
 * Starts the Payment Server for each enabled coin in the configuration.
 * Iterates through Settings.Coins and starts the server for each enabled coin.
 * No parameters.
 * No return value.
 */
(async () => {
  console.log('[Payment Server] Starting...');
  
  // Add graceful shutdown handlers for Ctrl+C and other termination signals
  const handleShutdown = async (signal) => {
    console.log(`\n[Shutdown] Received ${signal}, initiating graceful shutdown...`);
    await GracefulShutdown();
  };
  
  process.on('SIGINT', () => handleShutdown('SIGINT'));
  process.on('SIGTERM', () => handleShutdown('SIGTERM'));

  // Global error handlers to prevent overnight crashes
  process.on('uncaughtException', (error) => {
    console.error(`[CRITICAL] Uncaught Exception: ${error.message}`);
    console.error(error.stack);
    // Don't exit — allow the trading loop to continue
  });
  process.on('unhandledRejection', (reason, promise) => {
    console.error(`[CRITICAL] Unhandled Promise Rejection: ${reason}`);
    if (reason?.stack) console.error(reason.stack);
    // Don't exit — allow the trading loop to continue
  });
  
  let coinCount = 0,
    maxCoins = Settings.Coins.length;
  let enabledCoinsCount = 0;
  
  for (const coinName in Settings.Coins) {
    coinCount++;
    const coinObject = Settings.Coins[coinName];
    if (coinObject.enabled) {
      enabledCoinsCount++;
      console.log(`[${coinObject.type.toUpperCase()}] Server Running.`);
      
      try {
        await Start(coinObject, coinCount === maxCoins);
      } catch (error) {
        console.error(`Error starting ${coinObject.type}:`, error);
      }
    }
  }

  // Check if any coins were enabled
  if (enabledCoinsCount === 0) {
    //console.error('[Payment Server] No coins enabled in Settings.json! Exiting.');
    //process.exit(1);
  }

  // Debug: Show what user modules are loaded
  console.log('Loaded user modules:', Object.keys(process.engine?.users || {}));

  // Test Binance Exchange connection
  console.log('\n[Binance] Testing Exchange Connection...');
  await TestBinanceConnection();

  // Test GPT Decision Tree Process
  console.log('\n[GPT] Testing Decision Tree Processor...');
  await TestGPTProcess();
  await GracefulShutdown();
})();

/**
 * Test Binance Exchange Connection
 * Load keys and verify API connectivity
 * @returns {Promise<void>}
 */
async function TestBinanceConnection() {
  try {
    // Load Binance keys
    const binanceKey = KeyManager.LoadBinanceKey();
    if (!binanceKey) {
      logger.error('[Binance] Failed to load keys from Binance.key');
      return;
    }

    // Validate keys
    if (!KeyManager.ValidateBinanceKey(binanceKey)) {
      logger.error('[Binance] Invalid or incomplete key configuration');
      return;
    }

    // Initialize Binance Exchange
    const binance = new BinanceExchange({
      apiKey: binanceKey.apiKey,
      apiSecret: binanceKey.apiSecret,
      testnet: Settings.Binance.testnet || false,
      pair: Settings.Binance.pair || 'LTCUSDT',
      baseAsset: Settings.Binance.baseAsset || 'LTC',
      quoteAsset: Settings.Binance.quoteAsset || 'USDT',
      quantity: Settings.Binance.quantity || 0.1,
      buyTarget: Settings.Binance.buyTarget || 0.98,
      sellTarget: Settings.Binance.sellTarget || 1.02,
    });

    // Initialize connection
    const initialized = await binance.Initialize(true);
    if (!initialized) {
      logger.error('[Binance] Failed to initialize exchange');
      return;
    }

    // Test: Get account balances
    const balances = await binance.GetBalances();
    if (Object.keys(balances).length === 0) {
      logger.warn('[Binance] No balances found');
    } else {
        // Log balances with either free > 0 or locked > 0
         for (const asset in balances) {
            if (balances[asset].free > 0 || balances[asset].locked > 0) {
                logger.log(`[Binance] Balance for ${asset}: Free: ${balances[asset].free}, Locked: ${balances[asset].locked}`);
            }
        }
    }

    // Test: Get current price
    const pair = binance.tradeConfig.pair;
    logger.log(`[Binance] Fetching ${pair} price...`);
    const currentPrice = await binance.GetPrice(pair);
    if (currentPrice > 0) {
      // Price logged successfully
    } else {
      logger.warn(`[Binance] Could not fetch price for ${pair}`);
    }

    // Test: Get exchange info
    logger.log(`[Binance] Fetching exchange info for ${pair}...`);
    const exchangeInfo = await binance.GetExchangeInfo(pair);
    if (exchangeInfo.baseAsset) {
      logger.log(`[Binance] Exchange info retrieved:`, {
        pair: `${exchangeInfo.baseAsset}/${exchangeInfo.quoteAsset}`,
        status: exchangeInfo.status,
      });
    } else {
      logger.warn(`[Binance] Could not fetch exchange info`);
    }

    // Store exchange instance globally for later use
    process.binance = binance;
    logger.log('[Binance] All tests passed! Exchange ready for trading.\n');
  } catch (error) {
    logger.error('[Binance] Test failed:', error.message);
  }
}

/**
 * Build trading context from current market state with viable actions
 * Assesses balance and determines what actions are possible
 * Applies Settings.json trading rules and constraints
 * @returns {Promise<string>} Context string with balance, price, and viable actions
 */
async function BuildTradingContext(pair = 'LTCUSDT') {
  try {
    if (!process.binance || !process.binance.isInitialized) {
      return null;
    }

    // Parse pair to get base and quote assets
    let baseAsset, quoteAsset;
    if (pair.endsWith('USDT')) {
      baseAsset = pair.substring(0, pair.length - 4);
      quoteAsset = 'USDT';
    } else if (pair.endsWith('USDC')) {
      baseAsset = pair.substring(0, pair.length - 4);
      quoteAsset = 'USDC';
    } else if (pair.endsWith('BNB')) {
      baseAsset = pair.substring(0, pair.length - 3);
      quoteAsset = 'BNB';
    } else if (pair.endsWith('BTC')) {
      baseAsset = pair.substring(0, pair.length - 3);
      quoteAsset = 'BTC';
    } else {
      baseAsset = pair.substring(0, pair.length - 4);
      quoteAsset = pair.substring(pair.length - 4);
    }

    const balances = await process.binance.GetBalances();
    const price = await process.binance.GetPrice(pair);
    
    // Load trading rules from Settings
    const tradingRules = Settings.Trading?.Rules || {};
    const balanceReqs = tradingRules.BalanceRequirements || { MinUSDTForBuy: 15, MinAssetValueForSell: 15 };
    const profitTargets = tradingRules.ProfitTargets || { MinProfitPercentToSell: 2 };
    const lossPrevention = tradingRules.LossPrevention || { StrictlyNoLosses: true };
    const testMode = Settings.Trading?.TestMode || { Enabled: false };
    
    const MIN_TRADE_VALUE = balanceReqs.MinUSDTForBuy || 15;

    // Build context from relevant balances
    const baseBalance = balances[baseAsset] || { free: 0, locked: 0 };
    const quoteBalance = balances[quoteAsset] || { free: 0, locked: 0 };

    // Cranks: locked USDC excluded, MockBalance caps trading budget (includes unallocated USDT)
    const cranksLockedUSDC = process.cranks ? process.cranks.getLockedUSDC() : 0;
    const realFreeUSDT = Math.max(0, quoteBalance.free - cranksLockedUSDC);
    const cranksMockBalance = process.cranks ? process.cranks.getMockBalance(realFreeUSDT) : Infinity;
    const effectiveQuoteFree = Math.min(realFreeUSDT, cranksMockBalance);

    // Fetch market analysis for trend context
    let trendContext = '';
    if (process.marketAnalysis) {
      try {
        const pairDisplay = `${baseAsset}/${quoteAsset}`;
        const marketAnalysis = await process.marketAnalysis.GetMarketAnalysis(pairDisplay, 24);
        logger.log(`[BuildTradingContext] Market analysis result:`, { trend: marketAnalysis.trend, strength: marketAnalysis.strength });
        if (marketAnalysis && marketAnalysis.trend !== 'UNKNOWN') {
          trendContext = `
Market Trend Analysis (Last 24 Hours) - ${pair}:
- Current Trend: ${marketAnalysis.trend}
- Price Strength: ${marketAnalysis.strength}
- 24h Change: ${marketAnalysis.change24h.percent}% (${marketAnalysis.change24h.price > 0 ? '+' : ''}${marketAnalysis.change24h.price.toFixed(2)})
- 24h High: $${marketAnalysis.historyData.high24h}
- 24h Low: $${marketAnalysis.historyData.low24h}
- 24h Average: $${marketAnalysis.historyData.avg24h}
- Volatility: ${marketAnalysis.volatility}%
- Trading Signal: ${marketAnalysis.recommendation}
`;
        } else {
          logger.log(`[BuildTradingContext] Market analysis returned UNKNOWN trend`);
        }
      } catch (error) {
        console.warn('[BuildTradingContext] Market analysis failed:', error.message);
      }
    }

    // Determine viable actions based on balance, price, and Settings constraints
    const viableActions = [];
    const constraintNotes = [];
    
    // Can SELL if (LTC balance * price) >= minimum SELL value (use FREE + LOCKED balance for selling)
    const minAssetValueForSell = balanceReqs.MinAssetValueForSell || 15;
    const totalBaseBalance = baseBalance.free + baseBalance.locked; // Include both free and locked for selling potential
    if (totalBaseBalance > 0) {
      const sellValue = totalBaseBalance * price;
      if (sellValue >= minAssetValueForSell) {
        viableActions.push(`SELL: VIABLE - You have ${totalBaseBalance} ${baseAsset} (${baseBalance.free} free, ${baseBalance.locked} locked), worth $${sellValue.toFixed(2)} at current price`);
      } else {
        viableActions.push(`SELL: NOT VIABLE (${totalBaseBalance} ${baseAsset} = $${sellValue.toFixed(2)}, minimum $${minAssetValueForSell} required)`);
        constraintNotes.push(`- Sell requires minimum $${minAssetValueForSell} in asset value (Settings.Trading.Rules.BalanceRequirements.MinAssetValueForSell)`);
      }
    } else {
      viableActions.push(`SELL: NOT POSSIBLE (no ${baseAsset} balance)`);
    }

    // Can BUY if USDT balance >= minimum BUY value (capped by MockBalance and minus locked USDC)
    const minUSDTForBuy = balanceReqs.MinUSDTForBuy || 15;
    const positionSizing = tradingRules.PositionSizing || { BuyPercentOfBalance: 0.3, MaxSingleTradePercent: 0.3 };
    const buyPercent = positionSizing.BuyPercentOfBalance || 0.3;
    const maxTradePercent = positionSizing.MaxSingleTradePercent || 0.3;
    const maxBuyUSDT = effectiveQuoteFree * Math.min(buyPercent, maxTradePercent);
    const cranksInfo = cranksLockedUSDC > 0 || cranksMockBalance < Infinity
      ? ` (MockBalance: $${cranksMockBalance.toFixed(2)}, $${cranksLockedUSDC.toFixed(2)} locked USDC)`
      : '';
    if (effectiveQuoteFree > 0) {
      if (maxBuyUSDT >= minUSDTForBuy) {
        const maxBuyQuantity = (maxBuyUSDT / price).toFixed(8);
        viableActions.push(`BUY: VIABLE - You have $${effectiveQuoteFree.toFixed(2)} ${quoteAsset} total budget${cranksInfo}, max buy $${maxBuyUSDT.toFixed(2)} (${(Math.min(buyPercent, maxTradePercent) * 100).toFixed(0)}% position limit), can buy up to ${maxBuyQuantity} ${baseAsset}`);
        constraintNotes.push(`- Position sizing: max ${(buyPercent * 100).toFixed(0)}% of balance per buy, max ${(maxTradePercent * 100).toFixed(0)}% per single trade (Settings.Trading.Rules.PositionSizing)`);
      } else if (effectiveQuoteFree >= minUSDTForBuy) {
        viableActions.push(`BUY: NOT VIABLE (position limit $${maxBuyUSDT.toFixed(2)} is below minimum $${minUSDTForBuy} trade size${cranksInfo})`);
        constraintNotes.push(`- Position sizing cap ($${maxBuyUSDT.toFixed(2)}) is below minimum trade value ($${minUSDTForBuy})`);
      } else {
        viableActions.push(`BUY: NOT VIABLE ($${effectiveQuoteFree.toFixed(2)} trading budget${cranksInfo}, minimum $${minUSDTForBuy} required)`);
        constraintNotes.push(`- Buy requires minimum $${minUSDTForBuy} USDT balance (Settings.Trading.Rules.BalanceRequirements.MinUSDTForBuy)`);
      }
    } else {
      viableActions.push(`BUY: NOT POSSIBLE (no trading budget${cranksInfo})`);
    }
    
    // Add profit requirement note
    constraintNotes.push(`- SELL requires minimum ${profitTargets.MinProfitPercentToSell || 2}% profit (Settings.Trading.Rules.ProfitTargets.MinProfitPercentToSell)`);
    
    // Add loss prevention note
    if (lossPrevention.StrictlyNoLosses) {
      constraintNotes.push(`- NEVER recommend SELL at a loss (Settings.Trading.Rules.LossPrevention.StrictlyNoLosses = true)`);
    }

    // Get available exchanges
    const exchangeInfo = ExchangeDiscovery.GetExchangesForPrompt();
    const exchangeSelection = ExchangeDiscovery.GetExchangeSelectionPrompt();

    // Look up entry price from TradeDB for open positions on this pair
    let positionContext = '';
    if (process.autoTrader?.tradeDB && totalBaseBalance > 0) {
      try {
        const recentTrades = await process.autoTrader.tradeDB.GetTradesForPair(pair);
        const recentBuys = recentTrades
          .filter(t => t.action === 'BUY')
          .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        
        if (recentBuys.length > 0) {
          const entryPrice = parseFloat(recentBuys[0].price);
          const entryQty = parseFloat(recentBuys[0].quantity);
          const currentPL = ((price - entryPrice) / entryPrice * 100);
          const plDollar = (price - entryPrice) * totalBaseBalance;
          
          positionContext = `
Open Position for ${baseAsset}:
- Entry Price: $${entryPrice.toFixed(4)} (bought ${entryQty} on ${new Date(recentBuys[0].timestamp).toISOString().split('T')[0]})
- Current Price: $${price.toFixed(4)}
- Unrealized P/L: ${currentPL >= 0 ? '+' : ''}${currentPL.toFixed(2)}% ($${plDollar >= 0 ? '+' : ''}${plDollar.toFixed(4)})
- ${currentPL >= 2 ? '✅ PROFIT TARGET MET - selling is allowed' : currentPL >= 0 ? '⚠️ PROFIT BELOW 2% TARGET - do NOT sell yet, wait for more profit' : '🛑 POSITION IS AT A LOSS - NEVER sell, wait for recovery'}
`;
        }
      } catch (err) {
        console.warn('[BuildTradingContext] Failed to retrieve entry price:', err.message);
      }
    }

    const context = `
Current Market State:
- Pair: ${baseAsset}/${quoteAsset}
- Current Price: $${price.toFixed(2)}
- ${baseAsset} Balance: ${baseBalance.free} available, ${baseBalance.locked} locked
- ${quoteAsset} Balance: ${quoteBalance.free.toFixed(2)} available, ${quoteBalance.locked.toFixed(2)} locked${cranksLockedUSDC > 0 || cranksMockBalance < Infinity ? `, MockBalance: $${effectiveQuoteFree.toFixed(2)} (trading budget), $${cranksLockedUSDC.toFixed(2)} USDC locked` : ''}

Viable Actions (from Settings.Trading.Rules):
${viableActions.map(a => `- ${a}`).join('\n')}

Trade Constraints:
${constraintNotes.map(n => n).join('\n')}${positionContext}${trendContext}${process.cranks ? process.cranks.getSummary() : ''}

${exchangeInfo}
${exchangeSelection}
`;

    return context.trim();
  } catch (error) {
    logger.error('Failed to build trading context:', error.message);
    return null;
  }
}

/**
 * Start trading with strategy prompt and current balance context
 * Applies hard constraints from Settings.json trading rules
 * System automatically assesses what actions are viable before sending to GPT
 * @param {string} strategyPrompt - What you want the system to do
 * @param {Object} config - Configuration
 */
async function StartTrading(strategyPrompt, config = {}) {
  try {
    // Use provided pair or default to LTCUSDT
    const tradingPair = config.pair || 'LTCUSDT';
    
    // Get current market context with viable action assessment
    const context = await BuildTradingContext(tradingPair);
    if (!context) {
      logger.error('[Trading] Failed to build market context');
      return { action: 'error', error: 'Failed to build context' };
    }

    // Load trading rules from Settings
    const tradingRules = Settings.Trading?.Rules || {};
    const balanceReqs = tradingRules.BalanceRequirements || { MinUSDTForBuy: 15, MinAssetValueForSell: 15 };
    const profitTargets = tradingRules.ProfitTargets || { MinProfitPercentToSell: 2 };
    const lossPrevention = tradingRules.LossPrevention || { StrictlyNoLosses: true };
    const minUSDTForBuy = balanceReqs.MinUSDTForBuy || 15;
    const minAssetValueForSell = balanceReqs.MinAssetValueForSell || 15;
    const minProfitPercent = profitTargets.MinProfitPercentToSell || 2;

    // Build full prompt with context and hard constraints
    let fullPrompt = `${strategyPrompt}

${context}

HARD CONSTRAINTS (Non-Negotiable - Enforced at Execution):
1. LOSS PREVENTION (CRITICAL):
   - NEVER EVER recommend SELL at a loss or breakeven
   - If current price is below or equal to entry price, MUST recommend WAIT
   - Only SELL if profit would be >= ${minProfitPercent}% (minimum 2%)
   - Capital preservation is the #1 priority

2. BUYING:
   - Only recommend BUY if it shows as VIABLE in "Viable Actions" above
   - Downtrends and dips ARE buying opportunities — look for entries, don't just wait
   - If insufficient balance ($${minUSDTForBuy}+ USDT needed), recommend WAIT
   - Use conservative position sizing (the system enforces max trade size automatically)
   
3. SELLING:
   - Only recommend SELL if it shows as VIABLE in "Viable Actions" above
   - Require >= ${minProfitPercent}% profit before selling
   - Strong uptrend = good exit point. Lock in profits when targets are met
   - If profit < ${minProfitPercent}%, recommend WAIT

4. GENERAL:
   - Follow market signals: UPTREND = sell opportunity, DOWNTREND = buy opportunity
   - Be decisive: markets move fast, take action when signals are clear
   - If you recommend WAIT, include a "seconds" field (30-600) for recheck timing
   - Return ONE action: buy, sell, wait, query, or complete`;

    logger.log('[Trading] Context Assessment:');
    if (typeof process !== 'undefined' && process.GPT_LOGGING) {
      logger.log(context);
    }
    logger.log('\n[Trading] Processing with strategy...\n');

    // Start autonomous trading
    const defaultConfig = {
      maxIterations: config.maxIterations || 5,
      timeoutMs: config.timeoutMs || 300000,
      executeActions: config.executeActions || false,
      pair: tradingPair,
    };

    const result = await process.autoTrader.StartAutonomousTrading(fullPrompt, defaultConfig);
    // Extract the final action from result (field is 'finalAction' from StartAutonomousTrading)
    return {
      ...result,
      action: result?.finalAction || 'wait',
    };
  } catch (error) {
    logger.error('[Trading] Error:', error.message);
    return { action: 'error', error: error.message };
  }
}

/**
 * Test GPT Decision Tree Processor
 * Demonstrates using the API-style trading with balance context
 * @returns {Promise<void>}
 */
async function TestGPTProcess() {
  try {
    // Check if OpenAI API key is available in .Keys/OpenAI.key
    const openAIKey = require('./Core/KeyManager.js').LoadOpenAIKey();
    if (!openAIKey) {
      logger.warn('[GPT] OpenAI.key not found in .Keys/. Skipping GPT tests.');
      return;
    }

    // Initialize Decision Database
    logger.log('[GPT] Testing Decision Tree Processor...');
    logger.log('OpenAI.key loaded successfully');
    logger.log('[GPT] Initializing Decision Database...');
    const decisionDB = new DecisionDB();
    const dbInitialized = await decisionDB.Initialize();

    if (!dbInitialized) {
      logger.warn('[GPT] Decision DB initialization failed');
    }

    // Create GPT wrapper instance (key loaded from .Keys/OpenAI.key)
    const gpt = new GPTWrapper();

    // Initialize GPT
    logger.log('[GPT] Initializing GPT Wrapper...');
    const initialized = await gpt.Initialize(true);

    if (!initialized) {
      logger.error('[GPT] Failed to initialize GPT Wrapper');
      return;
    }

    logger.log('[GPT] GPT Wrapper initialized');

    // Link DecisionDB to GPT for AutoProcess loop persistence
    if (dbInitialized) {
      gpt.SetDecisionDB(decisionDB);
      logger.log('[GPT] DecisionDB linked for AutoProcess persistence');
    }

    // Create database callback for persistence
    const dbCallback = async (decision) => {
      if (dbInitialized) {
        await decisionDB.SaveDecision(decision);
      }
    };

    // Store GPT instance globally for later use
    process.gpt = gpt;
    process.decisionDB = decisionDB;
    process.GPT_LOGGING = GPT_LOGGING; // Make logging flag accessible globally

    // Initialize MarketAnalysis for trend-aware trading decisions
    const marketAnalysis = new MarketAnalysis(process.binance);
    process.marketAnalysis = marketAnalysis;
    logger.log('[MarketAnalysis] Initialized for trend analysis\n');

    // Initialize Pair Selector for intelligent pair rotation
    const pairDB = new PairDB();
    const pairDBInitialized = await pairDB.Initialize();
    const pairSelector = new PairSelector(process.binance, pairDB);
    const pairSelectorInitialized = await pairSelector.Initialize();
    process.pairSelector = pairSelector;
    
    if (pairSelectorInitialized) {
      logger.log('[PairSelector] Initialized with intelligent pair rotation\n');
    }

    // Initialize AutoTrader to bridge GPT decisions with Binance trading
    if (process.binance && process.binance.isInitialized) {
      const tradeDB = new TradeDB();
      const tradeDBInitialized = await tradeDB.Initialize();
      
      // Initialize Cranks safety system (annihilation prevention)
      let cranks = null;
      if (Settings.Trading?.Cranks?.Enabled) {
        cranks = new Cranks(process.binance);
        const cranksInitialized = await cranks.Initialize();
        if (cranksInitialized) {
          process.cranks = cranks;
          logger.log('[Cranks] Safety system active \u2014 profits cascade toward permanent USDC lockup\n');
        }
      }

      const autoTrader = new AutoTrader(gpt, decisionDB, process.binance, tradeDB, cranks);
      process.autoTrader = autoTrader;
      logger.log('[AutoTrader] Initialized. Ready to accept trading commands.\n');

      // Example: Start trading with viable action assessment
      logger.log('[Testing] Starting autonomous trading with API...\n');
      
      // Support --count flag for finite iterations, or loop indefinitely
      // If --count is not specified, loop indefinitely (production mode)
      // If --count=N is specified, run exactly N times
      const isInfiniteLoop = cliConfig.count === null;
      const iterationCount = cliConfig.count || Infinity;
      let iterationNum = 0;
      let consecutiveErrors = 0;
      const maxConsecutiveErrors = 5; // Stop if 5 iterations fail in a row
      const loopStartTime = Date.now();
      let totalTrades = 0;
      
      while (iterationNum < iterationCount) {
        iterationNum++;

        let gptWaitSeconds = null;
        try {
          if (isInfiniteLoop) {
            logger.log(`\n[LOOP] Continuous operation - iteration ${iterationNum}`);
          } else if (iterationCount > 1) {
            logger.log(`\n[LOOP] Iteration ${iterationNum}/${iterationCount}`);
          }

          // Heartbeat: log health every 10 iterations
          if (iterationNum % 10 === 0) {
            const uptimeMin = ((Date.now() - loopStartTime) / 60000).toFixed(1);
            logger.log(`[HEARTBEAT] Uptime: ${uptimeMin}m | Iterations: ${iterationNum} | Trades: ${totalTrades} | Errors in a row: ${consecutiveErrors}`);
          }
        
          // Intelligently select which pair to trade
          const selectedPair = await pairSelector.SelectBestPair();
          logger.log(`[LOOP] Selected pair: ${selectedPair}`);
        
          let strategy = `Execute your trading strategy for ${selectedPair} with strict loss prevention: NEVER sell at a loss or breakeven. Only SELL if profit >= 2%. Actively look for entry points during dips and downtrends — these are buying opportunities. Be decisive: when the market gives a signal, act on it. Prioritize: (1) Capital Preservation, (2) Taking profitable entries on dips, (3) Selling at good profit targets. If you choose WAIT, include a "seconds" parameter (30-600) indicating how long before the market should be rechecked.`;
        
          const tradingResult = await StartTrading(
            strategy,
            {
              maxIterations: 3,
              timeoutMs: 60000,
              executeActions: true, // Execute actual trades
              pair: selectedPair, // Pass selected pair to trading engine
            }
          );
        
          // Record the action taken on this pair
          const actionTaken = tradingResult?.action || 'wait';
          gptWaitSeconds = tradingResult?.waitSeconds || null;
          await pairSelector.RecordAction(actionTaken);

          if (['buy', 'sell'].includes(actionTaken)) totalTrades++;
          consecutiveErrors = 0; // Reset on success

        } catch (iterationError) {
          consecutiveErrors++;
          logger.error(`[LOOP] Iteration ${iterationNum} failed: ${iterationError.message}`);
          if (iterationError.stack) logger.error(iterationError.stack);

          if (consecutiveErrors >= maxConsecutiveErrors) {
            logger.error(`[LOOP] ${maxConsecutiveErrors} consecutive failures — stopping to prevent further issues.`);
            break;
          }
          logger.log(`[LOOP] Continuing despite error (${consecutiveErrors}/${maxConsecutiveErrors} consecutive failures)`);
        }
        
        // Delay between loop iterations — use GPT's recommended wait or default
        if (iterationNum < iterationCount) {
          const defaultWaitMs = 150000; // 2.5 minutes default
          const minWaitMs = 30000;      // 30 seconds minimum
          const maxWaitMs = 600000;     // 10 minutes maximum
          let waitMs;
          if (cliConfig.fast) {
            waitMs = 5000;
          } else if (gptWaitSeconds) {
            waitMs = Math.min(Math.max(gptWaitSeconds * 1000, minWaitMs), maxWaitMs);
          } else {
            waitMs = defaultWaitMs;
          }
          const waitLabel = waitMs >= 60000 ? `${(waitMs / 60000).toFixed(1)} minutes` : `${(waitMs / 1000).toFixed(0)} seconds`;
          const source = gptWaitSeconds ? '(GPT recommended)' : '(default)';
          logger.log(`[LOOP] Waiting ${waitLabel} ${source} before next iteration...`);
          await new Promise(r => setTimeout(r, waitMs));
        }
      }
    }

    logger.log('\n[GPT] All tests passed! Decision Engine ready.\n');
  } catch (error) {
    logger.error('[GPT] Test failed:', error.message);
  }
}

/**
 * Gracefully close all resources and exit
 */
async function GracefulShutdown() {
  try {
    console.log('[Shutdown] Cleaning up resources...');

    // Clear any running intervals/timeouts
    if (Client.Tick) {
      clearInterval(Client.Tick);
      console.log('[Shutdown] Cleared trading ticker interval');
    }
    
    // Close Binance exchange connection
    if (process.binance) {
      try { process.binance.Close(); } catch (_) {}
      console.log('[Shutdown] Binance connection closed');
    }

    // Close PairSelector / PairDB
    if (process.pairSelector?.pairDB?.Close) {
      try { await process.pairSelector.pairDB.Close(); } catch (_) {}
      console.log('[Shutdown] PairDB connection closed');
    }

    // Close AutoTrader DBs
    if (process.autoTrader?.tradeDB?.Close) {
      try { await process.autoTrader.tradeDB.Close(); } catch (_) {}
      console.log('[Shutdown] TradeDB connection closed');
    }
    if (process.autoTrader?.decisionDB?.Close) {
      try { await process.autoTrader.decisionDB.Close(); } catch (_) {}
      console.log('[Shutdown] DecisionDB connection closed');
    }

    // Close Cranks safety system
    if (process.cranks?.Close) {
      try { await process.cranks.Close(); } catch (_) {}
      console.log('[Shutdown] Cranks DB connection closed');
    }

    // Close database connection if exists
    if (process.engine?.users) {
      // Connection cleanup if needed
    }
    
    // Close log stream
    await new Promise((resolve) => {
      if (logStream) {
        logStream.end(() => resolve());
      } else {
        resolve();
      }
    });
    
    console.log('[Shutdown] Complete.');
    process.exit(0);
  } catch (error) {
    console.error('Error during shutdown:', error.message);
    process.exit(1);
  }
}

/*
 * Starts the client engine and initializes necessary modules and variables.
 * @param {object} ClientType - The client type object containing connection details.
 * @returns {object}
 */
async function Start(ClientType, LastLoaded = false) {
  // Initialize the client engine with the provided connection details
  Client.Engine = new Core({
    host: ClientType.host,
    port: ClientType.port,
    username: ClientType.user,
    password: ClientType.pass,
  });

  // Initialize the process engine object if it doesn't exist (DON'T OVERWRITE!)
  if (!process.engine) {
    process.engine = {};
  }

  // Initialize users object if it doesn't exist
  if (!process.engine.users) {
    process.engine.users = {};
  }

  // Assign the client engine to the appropriate cryptocurrency type
  switch (ClientType.type) {
    case 'LTC':
      process.engine.ltc = Client.Engine;
      break;
    case 'BTC':
      process.engine.btc = Client.Engine;
      break;
    case 'DOGE':
      process.engine.doge = Client.Engine;
      break;
    default:
      console.error(`Unknown client type: ${ClientType.type}`);
      return {};
  }

  // Load the configuration settings (only once)
  if (!process.settings) {
    process.settings = require('./Settings.json');
  }

  // Load the transactions module (only once or per coin if needed)
  if (!process.engine.transactions) {
    try {
      process.engine.transactions = await require('./Wallet/Transactions.js')();
      console.log(`📜 [${ClientType.type.toUpperCase()}] Transactions module loaded.`);
    } catch (error) {
      console.error(`Failed to load transactions module for ${ClientType.type.toUpperCase()}:`, error);
      return {};
    }
  }

  // Load the user module for this cryptocurrency (ADD to users, don't overwrite)
  try {
    const userModule = await require('./Wallet/Users.js')();
    process.engine.users[ClientType.type.toLowerCase()] = userModule;
    console.log(`📜 [${ClientType.type.toUpperCase()}] User Script Loaded.`);

    // Verify the module was loaded correctly
    if (!userModule || !userModule.GetForTX) {
      throw new Error(`User module for ${ClientType.type.toUpperCase()} missing GetForTX method`);
    }

    // Debug: Show currently loaded modules
    if (LastLoaded) console.log(`📜 [${ClientType.type.toUpperCase()}] Available user modules:`, Object.keys(process.engine.users));
  } catch (error) {
    console.error(`Failed to load user module for ${ClientType.type.toUpperCase()}:`, error);
    return {};
  }

  await Ticker_Routine(Client, ClientType);

  return {};
}

/*
 * The main ticker routine for the client engine.
 * @param {object} Client - The client object.
 * @param {object} ClientType - The client type object.
 *
 * @returns {object}
 */
async function Ticker_Routine(Client, ClientType) {
  const userModule = process.engine.users[ClientType.type.toLowerCase()];
  // Do it every few seconds.
  Client.Tick = setInterval(async function () {
    var hasConn = await Check_Connection();
    if (!hasConn) {
      console.log('Connection to the RPC Server was lost.');
      clearInterval(Client.Tick);
      process.exit(0);
    } else {
      //clearInterval(Client.Tick);

      await userModule.createManyAccounts(ClientType, Client.Engine);

      await getTXs(Client, ClientType);
    }
  }, 1 * 1000);
}

// END START

/*
 * Retrieves a transaction by txid.
 * @param {string} txid - The transaction ID.
 * @returns {object} The transaction object.
 */
async function Get_Transaction(ClientType, txid) {
  const userModule = process.engine.users[ClientType.type.toLowerCase()];
  //console.log(`Getting transaction for ${ClientType.type.toUpperCase()} with txid: ${txid}`);
  // Get the transaction
  const transaction = await userModule.GetForTX(txid); // uuid address balance tx transaction_type status currency
  // Return the transaction.
  return transaction;
}

/*
 * Processes a single transaction, updating statuses and adding balances as necessary.
 * @param {object} ClientType - The client type object.
 * @param {array} txsTemp - The array of temporary transactions.
 * @param {number} i - The index of the current transaction in txsTemp.
 * No return value.
 */
async function processTransaction(Client, ClientType, txsTemp, i) {
  const txid = txsTemp[i].txid;
  if (Client.Engine.getProcessingTransactions().has(txid)) return;
  Client.Engine.getProcessingTransactions().add(txid);

  const userModule = process.engine.users[ClientType.type.toLowerCase()];

  try {
    const address = txsTemp[i].address;
    const Transaction = await Get_Transaction(ClientType, txid);
    const user = await userModule.Get_User_By_Address(address);
    const userUuid = user ? user : null;

    // Add null check for userUuid
    if (!userUuid) {
      return;
    }

    if (Transaction) {
      if (Transaction.status !== 'Confirmed' && txsTemp[i].confirmations >= 1 && Transaction.transaction_type === 'deposit') {
        console.log(`Transaction ${txid} reached 1+ confirmations. Processing deposit.`);
        const depositProcessed = await processDeposit(ClientType, txsTemp, i);
        await process.engine.transactions.UpdateTransactionStatus(txid, 'Confirmed');
        // console.log(`Transaction ${txid} confirmed. Marking as Confirmed.`);
        /*
        await process.engine.users[ClientType.type.toLowerCase()].addBalance(userUuid, txsTemp[i].amount, {
          type: ClientType.type.toUpperCase(),
          decimals: 8,
        });
        */
        if (depositProcessed) {
          //console.log(`Transaction ${txid} marked as Unconfirmed.`);
        }

        return;
      }

      if (Transaction.status === 'Confirmed') {
        return;
      }

      return;
    }

    if (!MapTX(Client, txsTemp, i)) return;
    if (!process.engine.transactions) return;
    if (await process.engine.transactions.Transaction_Exists(userUuid, txid)) return;
    if (!(await process.engine.transactions.GetWalletFromAddress(address))) return;
    if (await process.engine.transactions.AddressHasTransactionRecord(address, txid)) return;

    const added = await process.engine.transactions.AddOrUpdateTransaction(userUuid, address, txsTemp[i].amount, txid, 'deposit', ClientType.type, txsTemp[i]);

    if (added) {
      Client.Engine.getTxs()[address].push(txsTemp[i]);
      await process.engine.transactions.UpdateTransactionStatus(txid, 'Pending');
      console.log(`Added new transaction ${txid} with status Pending for user ${userUuid}.`);
    }
  } finally {
    Client.Engine.getProcessingTransactions().delete(txid);
  }
}

/*
 * Processes a deposit transaction, updating transaction status and confirming deposits.
 * @param {object} ClientType - The client type object.
 * @param {array} txsTemp - The array of temporary transactions.
 * @param {number} i - The index of the current transaction in txsTemp.
 * @param {number} amount - The amount of the transaction.
 * @param {string} uuid - The user's UUID.
 * No return value.
 */
async function processDeposit(ClientType, txsTemp, i) {
  const txid = txsTemp[i]?.txid || 'unknown';
  const address = txsTemp[i]?.address || 'unknown';
  const amount = txsTemp[i]?.amount || 0;
  const userModule = process.engine.users[ClientType.type.toLowerCase()];
  const Check = await process.engine.transactions.CheckDepositAddressForTransaction(0, address);

  if (Check === false) {
    console.log(`No deposit addresses found for transaction ${txid}. Skipping.`);
    return false;
  }

  for (const record of Check) {
    // Skip transactions already in valid states
    if (['Confirmed', 'Unconfirmed', 'Processing'].includes(record.status)) {
      // console.log(`Skipping transaction ${record.txid || 'unknown'} with status ${record.status}.`);
      continue;
    }

    const user = await userModule.Get_User_By_Address(address);
    await userModule.Check_Addresses(ClientType, Client.Engine, address, user, txsTemp, i);
  }

  return false;
}

let ConfirmedTransactions = new Set(); // Tracks transactions that are at least 1-confirmed

async function getTXs(Client, ClientType) {
  var txsTemp = await Client.Engine.getAllTransactions();
  var Addresses = [];
  var AddressesWithPending = [];

  for (var i in txsTemp) {
    let tx = txsTemp[i];

    if (typeof Client.Engine.getTxs()[tx.address] === 'undefined') {
      Client.Engine.getTxs()[tx.address] = [];
    }

    if (tx.confirmations === 0 && !Detected.some((t) => t.txid === tx.txid)) {
      Detected.push(tx);
      if (!AddressesWithPending.includes(tx.address)) {
        AddressesWithPending.push(tx.address);
      }
      continue;
    }
    if (tx.amount < 0.005) continue;
    if (tx.confirmations >= 1) {
      ConfirmedTransactions.add(tx.txid);
    }

    await processTransaction(Client, ClientType, txsTemp, i);

    if (tx.confirmations < 0) continue;

    Addresses.push(tx);
  }

  var AddressesNoPending = [];
  for (var j = 0; j < Addresses.length; j++) {
    if (!AddressesWithPending.includes(Addresses[j].address)) {
      AddressesNoPending.push(Addresses[j].address);
    }
  }

  return {
    detected: Detected,
    addressesWithoutPending: AddressesNoPending,
  };
}

/*
 * Checks the connection to the blockchain.
 * No parameters.
 * @returns {boolean} True if connected, false otherwise.
 */
async function Check_Connection() {
  return (await Client.Engine.getBlockchainInfo()) ?? false;
}

/*
 * Checks if a transaction is not already in the transactions cache.
 * @param {array} txsTemp - The array of temporary transactions.
 * @param {number} i - The index of the current transaction in txsTemp.
 * @returns {boolean} True if the transaction is not in the cache, false otherwise.
 */
function MapTX(Client, txsTemp, i) {
  return (
    Client.Engine.getTxs()
      [txsTemp[i].address].map((tx) => {
        return tx.txid;
      })
      .indexOf(txsTemp[i].txid) === -1
  );
}

// Initialize and start
async function startPaymentServer() {
  try {
    const processor = new PaymentProcessor();
    await processor.initialize();

    // Your existing payment monitoring logic would go here
  } catch (error) {
    console.error('Failed to start payment server:', error);
  }
}

module.exports = { PaymentProcessor, startPaymentServer };

if (require.main === module) {
  startPaymentServer();
}
