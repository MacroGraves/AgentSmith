/**
 * AgentSmith — Autonomous Trading Bot
 * Entry point: initializes exchange, loads settings from MySQL, runs trading loop.
 */

const BigNumber = require('bignumber.js');
const fs = require('fs');
const path = require('path');

// ─── CLI Arguments ──────────────────────────────────────────────────────────

const GPT_LOGGING = true;

const cliConfig = {
  loop: false,
  count: null,
  test: false,
  fast: false,
  log: null,
};

function ProcessArgument(arg, nextArg) {
  switch (true) {
    case arg === '--loop':
      cliConfig.loop = true;
      return 0;

    case arg.startsWith('--count='):
      cliConfig.count = parseInt(arg.substring(8), 10) || 1;
      return 0;

    case arg === '--count':
      cliConfig.count = parseInt(nextArg, 10) || 1;
      return 1; // consume next arg

    case arg === '--test':
      cliConfig.test = true;
      return 0;

    case arg === '--fast':
      cliConfig.fast = true;
      return 0;

    case arg.startsWith('--log='):
      cliConfig.log = arg.substring(6);
      return 0;

    case arg === '--log':
      cliConfig.log = nextArg || null;
      return 1;

    default:
      return 0;
  }
}

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const skip = ProcessArgument(args[i], args[i + 1]);
  i += skip;
}

// ─── Log Config ─────────────────────────────────────────────────────────────

function ParseLogConfig(logString) {
  if (!logString) return {};
  if (logString === 'all') return { all: true };
  const config = {};
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

BigNumber.config({ ROUNDING_MODE: BigNumber.ROUND_DOWN, EXPONENTIAL_AT: 10 });

// ─── Module Imports ─────────────────────────────────────────────────────────

const Settings = require('./Core/Settings.js');
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
const Discord = require('./Discord');

// ─── Logging Setup ──────────────────────────────────────────────────────────

const logFile = path.join(__dirname, 'output.log');
const logStream = fs.createWriteStream(logFile, { flags: 'w' });

const originalLog = console.log;
console._originalLog = originalLog;
const originalError = console.error;
const originalWarn = console.warn;

// Values_Only_Logging is set after Settings load; this var is updated later
let VALUES_ONLY_LOGGING = false;
const TRADE_LOG_PATTERNS = /^(===\s+Log|\[LOOP\]|\[AUTOTRADER\] (Loop|Executing action|Final action|Autonomous|Action execution failed)|Buy order placed|Sell order placed|Order ID|Duration:|Starting|Completed|Ready for)/i;

function _shouldLogMessage(message) {
  const logConfig = process.logConfig || {};
  if (!logConfig || Object.keys(logConfig).length === 0) return true;
  if (logConfig.all) return true;
  if (message.includes('[LOOP]') || message.includes('[AUTOTRADER]') || message.includes('=== Log')) return true;

  let matches = false;
  if (logConfig.gpt && message.includes('[GPT]')) matches = true;
  if (logConfig.pairs && (message.includes('[PAIR]') || message.includes('[PAIR ROTATION]'))) matches = true;
  if (logConfig.numbers && message.includes('[METRICS]')) matches = true;
  if (logConfig.logic && message.includes('[LOGIC]')) matches = true;
  if (logConfig.trading && message.includes('[AUTOTRADER]')) matches = true;
  if (logConfig.loop && message.includes('[LOOP]')) matches = true;
  if (process.GPT_LOGGING && (message.includes('[DEBUG_') || message.includes('[DECISION_CHAIN]') || message.includes('[Trading]'))) matches = true;
  if (message.includes('[ERROR]') || message.includes('[WARN]') || message.includes('SyntaxError')) matches = true;
  return matches;
}

function _formatArgs(args) {
  let logArgs = args;
  if (args.length > 0 && typeof args[args.length - 1] === 'object' && !Array.isArray(args[args.length - 1]) && args[args.length - 1]?.logType) {
    logArgs = args.slice(0, -1);
  }
  return logArgs;
}

console.log = function (...args) {
  const logArgs = _formatArgs(args);
  const message = logArgs.map(a => typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)).join(' ');

  if (process.logConfig && Object.keys(process.logConfig).length > 0) {
    if (!_shouldLogMessage(message)) return;
  } else if (VALUES_ONLY_LOGGING && !TRADE_LOG_PATTERNS.test(message)) {
    return;
  }

  logStream.write(message + '\n');
  originalLog.apply(console, logArgs);
};

console.error = function (...args) {
  const logArgs = _formatArgs(args);
  const message = logArgs.map(a => typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)).join(' ');
  logStream.write('[ERROR] ' + message + '\n');
  originalError.apply(console, logArgs);
};

console.warn = function (...args) {
  const logArgs = _formatArgs(args);
  const message = logArgs.map(a => typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)).join(' ');
  logStream.write('[WARN] ' + message + '\n');
  originalWarn.apply(console, logArgs);
};

const Logger = require('./Core/Logger.js');
const logger = new Logger('output.log');

// ─── Sell All Open Positions ────────────────────────────────────────────────

/**
 * Sell all non-USDT/non-USDC assets at market price.
 * Used on restart when OnRestart.Sell_All is enabled.
 */
async function SellAllPositions(binance) {
  try {
    logger.log('[SellAll] Liquidating all open positions...');
    const balances = await binance.GetBalances();
    const stablecoins = ['USDT', 'USDC', 'BUSD', 'USD'];
    let soldCount = 0;

    for (const [asset, info] of Object.entries(balances)) {
      if (stablecoins.includes(asset)) continue;
      const free = parseFloat(info.free || 0);
      if (free <= 0) continue;

      const symbol = `${asset}USDT`;
      try {
        const price = await binance.GetPrice(symbol);
        if (!price || price <= 0) continue;

        const value = free * price;
        if (value < 1) continue; // Skip dust

        logger.log(`[SellAll] Selling ${free} ${asset} (~$${value.toFixed(2)})`);
        const result = await binance.Sell(free, null, symbol);
        if (result?.success) {
          soldCount++;
          logger.log(`[SellAll] Sold ${asset}: Order ${result.order?.orderId || 'N/A'}`);
        } else {
          logger.warn(`[SellAll] Failed to sell ${asset}: ${result?.error || 'unknown'}`);
        }
      } catch (err) {
        logger.warn(`[SellAll] Could not sell ${asset}: ${err.message}`);
      }
    }

    logger.log(`[SellAll] Complete — ${soldCount} position(s) liquidated.`);
  } catch (error) {
    logger.error('[SellAll] Error:', error.message);
  }
}

// ─── Binance Connection ─────────────────────────────────────────────────────

async function TestBinanceConnection() {
  try {
    const { apiKey, apiSecret } = KeyManager.LoadBinanceKey();
    if (!apiKey || !apiSecret) {
      logger.error('[Binance] API keys not found in .Keys/ directory.');
      return;
    }
    logger.log('[Binance] API keys loaded successfully');

    const binanceConfig = Settings.Binance || {};
    const binance = new BinanceExchange({
      apiKey,
      apiSecret,
      testnet: binanceConfig.testnet || false,
      pair: binanceConfig.pair || 'LTCUSDT',
      baseAsset: binanceConfig.baseAsset || 'LTC',
      quoteAsset: binanceConfig.quoteAsset || 'USDT',
      quantity: binanceConfig.quantity || 0.1,
      buyTarget: binanceConfig.buyTarget || 0.98,
      sellTarget: binanceConfig.sellTarget || 1.02,
      minNotional: binanceConfig.minNotional || 10,
    });

    const connected = await binance.Initialize(true);
    if (!connected) {
      logger.error('[Binance] Failed to initialize');
      return;
    }

    logger.log('[Binance] Connected successfully');
    process.binance = binance;
    return binance;
  } catch (error) {
    logger.error('[Binance] Connection error:', error.message);
  }
}

// ─── Build Trading Context ──────────────────────────────────────────────────

async function BuildTradingContext(tradingPair) {
  try {
    const contextParts = [];
    const constraintNotes = [];

    const tradingRules = Settings.Trading?.Rules || {};
    const balanceReqs = tradingRules.BalanceRequirements || { MinUSDTForBuy: 5, MinAssetValueForSell: 5 };
    const profitTargets = tradingRules.ProfitTargets || { MinProfitPercentToSell: 4 };
    const positionSizing = tradingRules.PositionSizing || { MaxPercent: 20, MinPercent: 5, DefaultPercent: 15 };
    const minUSDTForBuy = balanceReqs.MinUSDTForBuy || 5;
    const minAssetValueForSell = balanceReqs.MinAssetValueForSell || 5;

    // ── Balance Info ──
    const balances = await process.binance.GetBalances();
    let baseAsset = tradingPair.replace(/USDT$|BTC$|ETH$|BNB$|BUSD$/i, '');
    let quoteAsset = tradingPair.replace(baseAsset, '');
    const usdtBalance = parseFloat(balances['USDT']?.free || 0);
    const assetBalance = parseFloat(balances[baseAsset]?.free || 0);
    const currentPrice = await process.binance.GetPrice(tradingPair);
    const assetValue = assetBalance * currentPrice;

    contextParts.push(`BALANCE: ${usdtBalance.toFixed(2)} USDT | ${assetBalance.toFixed(6)} ${baseAsset} ($${assetValue.toFixed(2)} @ $${currentPrice})`);

    // ── Viable Actions ──
    const viableActions = [];
    if (usdtBalance >= minUSDTForBuy) {
      const maxBuyPercent = positionSizing.MaxPercent || 20;
      const maxBuyValue = (usdtBalance * (maxBuyPercent / 100)).toFixed(2);
      viableActions.push(`BUY: Yes — $${usdtBalance.toFixed(2)} USDT available (max $${maxBuyValue} per trade at ${maxBuyPercent}%)`);
      constraintNotes.push(`- Buy requires minimum $${minUSDTForBuy} USDT balance`);
    } else {
      viableActions.push(`BUY: No — only $${usdtBalance.toFixed(2)} USDT (need $${minUSDTForBuy}+)`);
    }

    if (assetValue >= minAssetValueForSell) {
      // Check open position P/L
      let positionInfo = '';
      if (process.autoTrader?.tradeDB) {
        try {
          const trades = await process.autoTrader.tradeDB.GetTradesForPair(tradingPair);
          const buys = trades.filter(t => t.action === 'BUY').sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
          if (buys.length > 0) {
            const entryPrice = parseFloat(buys[0].price);
            const pl = ((currentPrice - entryPrice) / entryPrice) * 100;
            positionInfo = ` | Entry: $${entryPrice.toFixed(4)}, P/L: ${pl.toFixed(2)}%`;

            contextParts.push(`\nOpen Position: ${assetBalance.toFixed(6)} ${baseAsset} @ entry $${entryPrice.toFixed(4)}, current $${currentPrice.toFixed(4)}, P/L: ${pl.toFixed(2)}%`);

            if (pl >= (profitTargets.MinProfitPercentToSell || 4)) {
              viableActions.push(`SELL: Yes — ${pl.toFixed(2)}% profit meets ${profitTargets.MinProfitPercentToSell || 4}% minimum${positionInfo}`);
            } else {
              viableActions.push(`SELL: No — ${pl.toFixed(2)}% profit below ${profitTargets.MinProfitPercentToSell || 4}% minimum${positionInfo}`);
            }
          } else {
            viableActions.push(`SELL: Available — $${assetValue.toFixed(2)} in ${baseAsset} (no entry price found)`);
          }
        } catch (_) {
          viableActions.push(`SELL: Available — $${assetValue.toFixed(2)} in ${baseAsset}`);
        }
      } else {
        viableActions.push(`SELL: Available — $${assetValue.toFixed(2)} in ${baseAsset}`);
      }
      constraintNotes.push(`- Sell requires minimum $${minAssetValueForSell} in asset value`);
    } else {
      viableActions.push(`SELL: No — only $${assetValue.toFixed(2)} in ${baseAsset} (need $${minAssetValueForSell}+)`);
    }

    contextParts.push(`\nViable Actions:\n${viableActions.map(a => `  ${a}`).join('\n')}`);

    // ── Position Sizing ──
    contextParts.push(`\nPosition Sizing: ${positionSizing.MinPercent || 5}%-${positionSizing.MaxPercent || 20}% per trade (default ${positionSizing.DefaultPercent || 15}%)`);
    constraintNotes.push(`- SELL requires minimum ${profitTargets.MinProfitPercentToSell || 4}% profit`);
    constraintNotes.push(`- Position size: ${positionSizing.MinPercent || 5}%-${positionSizing.MaxPercent || 20}% of balance per trade`);

    // ── Trend Data ──
    if (process.marketAnalysis) {
      try {
        const analysis = await process.marketAnalysis.AnalyzePair(tradingPair);
        if (analysis) {
          contextParts.push(`\nTrend: ${analysis.trend || 'NEUTRAL'} | Volatility: ${(analysis.volatility || 0).toFixed(2)}% | 24h Change: ${(analysis.priceChange24h || 0).toFixed(2)}%`);
        }
      } catch (_) {}
    }

    // ── Cranks Info ──
    if (process.cranks) {
      try {
        const mockBal = process.cranks.getMockBalance();
        const lockedUSDC = process.cranks.totalLockedUSDC || 0;
        if (mockBal !== Infinity) {
          contextParts.push(`\nCranks: MockBalance $${mockBal.toFixed(2)} | Locked USDC: $${lockedUSDC.toFixed(2)}`);
        }
      } catch (_) {}
    }

    // ── Constraints ──
    if (constraintNotes.length > 0) {
      contextParts.push(`\nConstraints:\n${constraintNotes.join('\n')}`);
    }

    return contextParts.join('\n');
  } catch (error) {
    logger.error('[Context] Failed to build trading context:', error.message);
    return null;
  }
}

// ─── Start Trading ──────────────────────────────────────────────────────────

async function StartTrading(strategyPrompt, config = {}) {
  try {
    const tradingPair = config.pair || Settings.Binance?.pair || 'LTCUSDT';
    const context = await BuildTradingContext(tradingPair);
    if (!context) {
      logger.error('[Trading] Failed to build market context');
      return { action: 'error', error: 'Failed to build context' };
    }

    const tradingRules = Settings.Trading?.Rules || {};
    const balanceReqs = tradingRules.BalanceRequirements || { MinUSDTForBuy: 5, MinAssetValueForSell: 5 };
    const profitTargets = tradingRules.ProfitTargets || { MinProfitPercentToSell: 4 };
    const minUSDTForBuy = balanceReqs.MinUSDTForBuy || 5;
    const minAssetValueForSell = balanceReqs.MinAssetValueForSell || 5;
    const minProfitPercent = profitTargets.MinProfitPercentToSell || 4;
    const positionSizing = tradingRules.PositionSizing || { MaxPercent: 20 };

    let fullPrompt = `${strategyPrompt}

${context}

HARD CONSTRAINTS (Non-Negotiable - Enforced at Execution):
1. LOSS PREVENTION (CRITICAL):
   - NEVER EVER recommend SELL at a loss or breakeven
   - If current price is below or equal to entry price, MUST recommend WAIT
   - Only SELL if profit would be >= ${minProfitPercent}% (hard minimum — system will REJECT sells below this)
   - Capital preservation is the #1 priority

2. BUYING:
   - Only recommend BUY if it shows as VIABLE in "Viable Actions" above
   - Downtrends and dips ARE buying opportunities — BUY into them, don't just watch
   - If insufficient balance ($${minUSDTForBuy}+ USDT needed), recommend WAIT
   - YOU control position size: include "percent" (5-20) in your buy action. HARD MAX: ${positionSizing.MaxPercent || 20}% per trade.
   - Suggested sizing: small dip (<2%) = 5-10%, medium dip (2-5%) = 10-15%, large dip (>5%) = 15-20%
   
3. SELLING:
   - Only recommend SELL if it shows as VIABLE AND profit >= ${minProfitPercent}% in "Open Position" above
   - System will REJECT any sell below ${minProfitPercent}% profit — don't waste a call on it
   - Check the Open Position section: if P/L < ${minProfitPercent}%, DO NOT suggest sell
   - Strong uptrend + profit target met = ideal exit. Lock in profits when ready

4. GENERAL:
   - Follow market signals: UPTREND = sell opportunity, DOWNTREND = buy opportunity
   - Be decisive: markets move fast, take action when signals are clear
   - If you recommend WAIT, include a "seconds" field (30-600) for recheck timing
   - Return ONE action: buy, sell, wait, query, or complete`;

    if (typeof process !== 'undefined' && process.GPT_LOGGING) {
      const origLog = console._originalLog || console.log;
      origLog(`[Trading] === GPT CONTEXT START ===\n${context}\n[Trading] === GPT CONTEXT END ===`);
    }
    logger.log('[Trading] Processing with strategy...');

    const defaultConfig = {
      maxIterations: config.maxIterations || 5,
      timeoutMs: config.timeoutMs || 300000,
      executeActions: config.executeActions || false,
      pair: tradingPair,
    };

    const result = await process.autoTrader.StartAutonomousTrading(fullPrompt, defaultConfig);
    return {
      ...result,
      action: result?.finalAction || 'wait',
    };
  } catch (error) {
    logger.error('[Trading] Error:', error.message);
    return { action: 'error', error: error.message };
  }
}

// ─── Main Trading Engine ────────────────────────────────────────────────────

async function RunTradingEngine() {
  try {
    // Check OpenAI key
    const openAIKey = KeyManager.LoadOpenAIKey();
    if (!openAIKey) {
      logger.warn('[GPT] OpenAI.key not found in .Keys/. Cannot trade without GPT.');
      return;
    }

    // Initialize Decision DB
    logger.log('[GPT] Initializing Decision Database...');
    const decisionDB = new DecisionDB();
    const dbInitialized = await decisionDB.Initialize();
    if (!dbInitialized) logger.warn('[GPT] Decision DB initialization failed');

    // Initialize GPT
    const gpt = new GPTWrapper();
    const gptReady = await gpt.Initialize(true);
    if (!gptReady) {
      logger.error('[GPT] Failed to initialize GPT Wrapper');
      return;
    }
    logger.log('[GPT] GPT Wrapper initialized');

    if (dbInitialized) {
      gpt.SetDecisionDB(decisionDB);
      logger.log('[GPT] DecisionDB linked for AutoProcess persistence');
    }

    process.gpt = gpt;
    process.decisionDB = decisionDB;
    process.GPT_LOGGING = GPT_LOGGING;

    // Initialize MarketAnalysis
    const marketAnalysis = new MarketAnalysis(process.binance);
    process.marketAnalysis = marketAnalysis;
    logger.log('[MarketAnalysis] Initialized\n');

    // Initialize PairSelector
    const pairDB = new PairDB();
    await pairDB.Initialize();
    const pairSelector = new PairSelector(process.binance, pairDB);
    const pairSelectorReady = await pairSelector.Initialize();
    process.pairSelector = pairSelector;
    if (pairSelectorReady) logger.log('[PairSelector] Initialized with intelligent pair rotation\n');

    // Require Binance to be connected
    if (!process.binance?.isInitialized) {
      logger.error('[Trading] Binance not connected. Cannot start trading engine.');
      return;
    }

    // Initialize TradeDB
    const tradeDB = new TradeDB();
    const tradeDBReady = await tradeDB.Initialize();

    // Initialize Cranks
    let cranks = null;
    if (Settings.Get('Trading.Cranks.Enabled', true)) {
      cranks = new Cranks(process.binance);
      const cranksReady = await cranks.Initialize();
      if (cranksReady) {
        process.cranks = cranks;
        logger.log('[Cranks] Safety system active — profits cascade toward permanent USDC lockup\n');
      }
    }

    // ── OnRestart Actions ──
    const clearTasks = [];
    if (Settings.Get('OnRestart.Clear_Decisions', true) && dbInitialized) {
      clearTasks.push(decisionDB._query('TRUNCATE TABLE Decisions').then(() => 'Decisions').catch(e => `Decisions(${e.message})`));
    }
    if (Settings.Get('OnRestart.Clear_Loops', true) && dbInitialized) {
      clearTasks.push(decisionDB._query('TRUNCATE TABLE Loops').then(() => 'Loops').catch(e => `Loops(${e.message})`));
    }
    if (Settings.Get('OnRestart.Clear_History', true) && tradeDBReady) {
      clearTasks.push(tradeDB._query('TRUNCATE TABLE History').then(() => 'History').catch(e => `History(${e.message})`));
    }
    if (Settings.Get('OnRestart.Clear_Cranks', true) && cranks) {
      clearTasks.push(cranks._query('TRUNCATE TABLE Cranks').then(() => 'Cranks').catch(e => `Cranks(${e.message})`));
    }
    if (clearTasks.length > 0) {
      const results = await Promise.all(clearTasks);
      logger.log(`[OnRestart] Cleared tables: ${results.join(', ')}`);
    }

    // ── Sell All on Start ──
    if (Settings.Get('OnRestart.Sell_All', false)) {
      await SellAllPositions(process.binance);
    }

    // Initialize AutoTrader
    const autoTrader = new AutoTrader(gpt, decisionDB, process.binance, tradeDB, cranks);
    process.autoTrader = autoTrader;
    logger.log('[AutoTrader] Initialized. Ready to accept trading commands.\n');

    // ── Trading Loop ──
    logger.log('[Trading] Starting autonomous trading loop...\n');

    const isInfiniteLoop = cliConfig.count === null;
    const iterationCount = cliConfig.count || Infinity;
    let iterationNum = 0;
    let consecutiveErrors = 0;
    const maxConsecutiveErrors = 5;
    const loopStartTime = Date.now();
    let totalTrades = 0;

    while (iterationNum < iterationCount) {
      iterationNum++;
      let gptWaitSeconds = null;

      // Check if trading is paused via Discord /stop command
      if (process.tradingPaused) {
        logger.log('[LOOP] Trading paused via Discord. Waiting 10s...');
        await new Promise(r => setTimeout(r, 10000));
        iterationNum--; // Don't count paused iterations
        continue;
      }

      try {
        if (isInfiniteLoop) {
          logger.log(`\n[LOOP] Continuous operation - iteration ${iterationNum}`);
        } else if (iterationCount > 1) {
          logger.log(`\n[LOOP] Iteration ${iterationNum}/${iterationCount}`);
        }

        // Heartbeat every 10 iterations
        if (iterationNum % 10 === 0) {
          const uptimeMin = ((Date.now() - loopStartTime) / 60000).toFixed(1);
          logger.log(`[HEARTBEAT] Uptime: ${uptimeMin}m | Iterations: ${iterationNum} | Trades: ${totalTrades} | Errors: ${consecutiveErrors}`);
        }

        // Select pair intelligently
        const selectedPair = await pairSelector.SelectBestPair();
        logger.log(`[LOOP] Selected pair: ${selectedPair}`);

        const strategy = `Execute your trading strategy for ${selectedPair} with strict loss prevention: NEVER sell at a loss or breakeven. Only SELL if profit >= 4%. Actively look for entry points during dips and downtrends — these are buying opportunities. Be decisive: when the market gives a signal, ACT on it. You control position sizing: include "percent" (5-20) in your buy action. Max 20% per trade (1/5th of balance). If you choose WAIT, include "seconds" (30-600) for recheck timing.`;

        const tradingResult = await StartTrading(strategy, {
          maxIterations: 3,
          timeoutMs: 60000,
          executeActions: true,
          pair: selectedPair,
        });

        const actionTaken = tradingResult?.action || 'wait';
        gptWaitSeconds = tradingResult?.waitSeconds || null;
        await pairSelector.RecordAction(actionTaken);

        if (['buy', 'sell'].includes(actionTaken)) totalTrades++;
        consecutiveErrors = 0;
      } catch (iterationError) {
        consecutiveErrors++;
        logger.error(`[LOOP] Iteration ${iterationNum} failed: ${iterationError.message}`);
        if (iterationError.stack) logger.error(iterationError.stack);

        if (consecutiveErrors >= maxConsecutiveErrors) {
          logger.error(`[LOOP] ${maxConsecutiveErrors} consecutive failures — stopping.`);
          break;
        }
        logger.log(`[LOOP] Continuing despite error (${consecutiveErrors}/${maxConsecutiveErrors})`);
      }

      // Wait between iterations
      if (iterationNum < iterationCount) {
        const defaultWaitMs = 150000;
        const minWaitMs = 30000;
        const maxWaitMs = 600000;
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

    logger.log('\n[Trading] Trading engine stopped.\n');
  } catch (error) {
    logger.error('[Trading] Engine error:', error.message);
  }
}

// ─── Graceful Shutdown ──────────────────────────────────────────────────────

async function GracefulShutdown() {
  try {
    console.log('[Shutdown] Cleaning up resources...');

    if (process.binance) {
      try { process.binance.Close(); } catch (_) {}
      console.log('[Shutdown] Binance connection closed');
    }

    if (process.pairSelector?.pairDB?.Close) {
      try { await process.pairSelector.pairDB.Close(); } catch (_) {}
      console.log('[Shutdown] PairDB closed');
    }

    if (process.autoTrader?.tradeDB?.Close) {
      try { await process.autoTrader.tradeDB.Close(); } catch (_) {}
      console.log('[Shutdown] TradeDB closed');
    }
    if (process.autoTrader?.decisionDB?.Close) {
      try { await process.autoTrader.decisionDB.Close(); } catch (_) {}
      console.log('[Shutdown] DecisionDB closed');
    }

    if (process.cranks?.Close) {
      try { await process.cranks.Close(); } catch (_) {}
      console.log('[Shutdown] Cranks closed');
    }

    // Close Discord bot
    if (process.discord?.Shutdown) {
      try { await process.discord.Shutdown(); } catch (_) {}
    }

    // Close Settings DB connection
    try { await Settings.Close(); } catch (_) {}

    await new Promise((resolve) => {
      if (logStream) logStream.end(() => resolve());
      else resolve();
    });

    console.log('[Shutdown] Complete.');
    process.exit(0);
  } catch (error) {
    console.error('Shutdown error:', error.message);
    process.exit(1);
  }
}

// ─── Entry Point ────────────────────────────────────────────────────────────

(async () => {
  console.log('[AgentSmith] Starting...\n');

  // Graceful shutdown handlers
  process.on('SIGINT', () => { console.log('\n[Shutdown] SIGINT received...'); GracefulShutdown(); });
  process.on('SIGTERM', () => { console.log('\n[Shutdown] SIGTERM received...'); GracefulShutdown(); });

  process.on('uncaughtException', (error) => {
    console.error(`[CRITICAL] Uncaught Exception: ${error.message}`);
    console.error(error.stack);
  });
  process.on('unhandledRejection', (reason) => {
    console.error(`[CRITICAL] Unhandled Rejection: ${reason}`);
    if (reason?.stack) console.error(reason.stack);
  });

  // Load Settings from MySQL
  console.log('[Settings] Loading from database...');
  let settingsLoaded = await Settings.Load();
  if (!settingsLoaded) {
    console.log('[Settings] Tables missing — auto-creating schema and seeding defaults...');
    try {
      const Database = require('./Database.js');
      const conn = await Database.GetConnection();
      await Database.CreateTables(conn);
      await Database.CreateViews(conn);
      await Database.SeedSettings(conn);
      conn.end();
      settingsLoaded = await Settings.Load();
    } catch (dbErr) {
      console.error('[Settings] Auto-setup failed:', dbErr.message);
    }
    if (!settingsLoaded) {
      console.error('[Settings] Failed to load settings from MySQL even after auto-setup.');
      process.exit(1);
    }
  }
  console.log('[Settings] Loaded successfully');

  // Apply Values_Only_Logging after settings load
  VALUES_ONLY_LOGGING = Settings.Get('Trading.Values_Only_Logging', false);
  if (!cliConfig.log && VALUES_ONLY_LOGGING) {
    cliConfig.log = 'numbers';
    process.logConfig = ParseLogConfig(cliConfig.log);
    console.log(`[CLI] Log filters enabled (from Settings): ${Object.keys(process.logConfig).join(', ')}`);
  }
  process.valuesOnlyLogging = VALUES_ONLY_LOGGING;

  // Connect to Binance
  console.log('\n[Binance] Connecting...');
  await TestBinanceConnection();

  if (!process.binance) {
    console.error('[Binance] Could not connect. Exiting.');
    process.exit(1);
  }

  // Initialize Discord bot (non-blocking — trading starts regardless)
  console.log('\n[Discord] Initializing...');
  const discordReady = await Discord.Initialize();
  if (discordReady) {
    process.discord = Discord;
  }

  // Run Trading Engine
  await RunTradingEngine();
  await GracefulShutdown();
})();
