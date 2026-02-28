/**
 * AutoTrader Interface
 * Provides convenient methods for launching and managing autonomous trading decisions
 * Bridges GPT decision-making with actual trading execution via Binance API
 */

const Settings = require('./Settings.js');
const TradeDB = require('./TradeDB.js');

class AutoTrader {
  constructor(gptWrapper, decisionDB, binanceExchange, tradeDB, cranks = null) {
    this.gpt = gptWrapper;
    this.decisionDB = decisionDB;
    this.binance = binanceExchange;
    this.tradeDB = tradeDB;
    this.cranks = cranks;
    this.activeLoops = new Map(); // Track running loops by ID
  }

  /**
   * Start automated trading based on initial strategy prompt
   * @param {string} initialPrompt - The trading strategy prompt
   * @param {Object} config - Configuration options
   * @param {number} config.maxIterations - Max loop iterations (default: 10)
   * @param {number} config.timeoutMs - Timeout in ms (default: 300000 = 5 minutes)
   * @param {boolean} config.executeActions - Whether to execute buy/sell orders (default: false for testing)
   * @returns {Promise<Object>} - Loop result with summary
   */
  async StartAutonomousTrading(initialPrompt, config = {}) {
    try {
      if (!this.gpt || !this.gpt.isInitialized) {
        throw new Error('GPT wrapper not initialized');
      }

      const mergedConfig = {
        maxIterations: config.maxIterations || 10,
        timeoutMs: config.timeoutMs || 300000,
        executeActions: config.executeActions || false,
        terminalActions: ['complete', 'wait', 'error', 'stop'],
        pair: config.pair || 'LTCUSDT',
      };

      console.log('[AUTOTRADER] Starting autonomous trading session...');
      console.log(`   Strategy: "${initialPrompt}"`);
      console.log(`   Execute actions: ${mergedConfig.executeActions}\n`);

      // Run the autonomous loop here so we can execute actions as they are produced
      const loopId = `loop_${Date.now()}_${Math.random().toString(36).substr(2,9)}`;
      const startTime = new Date();
      let iteration = 0;
      let currentPrompt = initialPrompt;
      const loopDecisions = [];
      let finalAction = null;
      let waitSeconds = null;
      let accountDrainDetected = false;
      let excessiveLossDetected = false;
      const lossPrevention = Settings.Trading?.Rules?.LossPrevention || { StrictlyNoLosses: true };
      const lossThreshold = -1.0; // Stop if loss exceeds -1%

      while (iteration < mergedConfig.maxIterations) {
        iteration++;
        console.log(`[AUTOTRADER] Loop ${loopId} - iteration ${iteration}`);

        // FAILSAFE: Check for account drain or excessive losses
        if (accountDrainDetected) {
          console.error('[AUTOTRADER] ⛔ FAILSAFE TRIGGERED: Account drain detected! Stopping all trading.');
          finalAction = 'stop';
          break;
        }
        if (excessiveLossDetected) {
          console.error('[AUTOTRADER] ⛔ FAILSAFE TRIGGERED: Loss threshold exceeded! Stopping all trading.');
          finalAction = 'stop';
          break;
        }

        const decisionResult = await this.gpt.Process(currentPrompt, async (decision) => {
          // Persist each decision if we have a DB
          if (this.decisionDB) {
            decision.loop_id = loopId;
            try {
              await this.decisionDB.SaveDecision(decision);
            } catch (e) {
              console.warn('[AUTOTRADER] Failed to save decision to DB:', e.message);
            }
          }
        });

        if (!decisionResult.success) {
          console.error('[AUTOTRADER] Decision process failed:', decisionResult.error);
          break;
        }

        const decision = decisionResult.decision;
        loopDecisions.push(decision);

        // Log full decision chain if logging enabled
        if (typeof process !== 'undefined' && process.GPT_LOGGING) {
          console.log('\n[DECISION_CHAIN]');
          console.log(JSON.stringify(decision.chain, null, 2));
        }

        // Extract actions for processing
        const act = decision.chain.find((c) => c.step === 'act')?.actions || [];
        const reflectStep = decision.chain.find((c) => c.step === 'reflect');
        const reflect = reflectStep?.next_action || reflectStep?.nextSteps || '';

        // Add symbol/pair to all actions from config
        for (const action of act) {
          if (!action.symbol && mergedConfig.pair) {
            action.symbol = mergedConfig.pair;
          }
        }

        // Inspect actions and execute if requested
        for (const a of act) {
          const actionType = (a.action || '').toString().toLowerCase();

          // If action is terminal, mark and stop
          if (mergedConfig.terminalActions.includes(actionType)) {
            finalAction = actionType;
            // Capture GPT's recommended wait duration
            if (actionType === 'wait' && a.seconds) {
              waitSeconds = parseInt(a.seconds) || null;
            }
            break;
          }

          // Execute actionable trades if allowed
          if (mergedConfig.executeActions && ['buy', 'sell', 'buyatprice', 'sellatprice'].includes(actionType)) {
            try {
              // Get balance before trade
              const balanceBefore = await this.binance.GetBalances();
              const usdtBefore = balanceBefore.USDT?.free || 0;

              const execResult = await this.ExecuteAction(a);
              // Attach execution result into decision for record-keeping
              a.execution = execResult;

              // Check if external modification was detected
              if (execResult && execResult.externalModificationDetected) {
                console.error('[FAILSAFE] 🛑 Account modified externally! Stopping all trading immediately.');
                accountDrainDetected = true;
                finalAction = 'stop';
                break;
              }

              // If buy was rejected due to insufficient balance, stop retrying
              if (execResult && execResult.insufficientBalance) {
                console.log(`[AUTOTRADER] Insufficient balance for buy — ending loop.`);
                finalAction = 'wait';
                break;
              }

              // Check for account drain AFTER execution
              if (execResult && execResult.success) {
                // Re-check balance after trade
                const balanceAfter = await this.binance.GetBalances();
                const usdtAfter = balanceAfter.USDT?.free || 0;
                const usdtDrained = usdtBefore - usdtAfter;

                // Check for excessive losses on SELL
                if (actionType === 'sell' && execResult.profitLossPercent !== undefined) {
                  console.log(`[FAILSAFE] SELL trade profit/loss: ${execResult.profitLossPercent.toFixed(2)}%`);
                  if (execResult.profitLossPercent < lossThreshold) {
                    console.error(`[FAILSAFE] ⛔ Loss ${execResult.profitLossPercent.toFixed(2)}% exceeds threshold ${lossThreshold}%`);
                    excessiveLossDetected = true;
                  }
                }

                // Warn about unexpected balance drain (only for sell - buy is expected to drain USDT)
                if (actionType === 'sell' && usdtDrained > 0.50) { // More than 50 cents drained unexpectedly on a sell
                  console.warn(`[FAILSAFE] ⚠️ WARNING: USDT drained by $${usdtDrained.toFixed(2)} during SELL trade. Original: $${usdtBefore.toFixed(2)}, After: $${usdtAfter.toFixed(2)}`);
                } else if (actionType === 'buy') {
                  console.log(`[FAILSAFE] BUY trade spent $${usdtDrained.toFixed(2)} USDT. Remaining: $${usdtAfter.toFixed(2)}`);
                }

                finalAction = actionType;
                break;
              }
            } catch (execErr) {
              console.error('[AUTOTRADER] Execution error:', execErr.message);
            }
          }
        }

        if (finalAction) {
          console.log(`[AUTOTRADER] Final action reached: ${finalAction}`);
          break;
        }

        // Prepare next prompt using reflection
        currentPrompt = `Previous decision: ${JSON.stringify(
          act.map((x) => ({ action: x.action, params: x }))
        )}\n\nNext steps: ${reflect}\n\nWhat should we do now?`;

        // small delay
        await new Promise((r) => setTimeout(r, 500));
      }

      const endTime = new Date();
      const duration = endTime - startTime;

      // Save loop metadata
      if (this.decisionDB) {
        try {
          await this.decisionDB.SaveAutoLoop(loopId, {
            initialPrompt,
            status: finalAction ? 'completed' : 'completed',
            decisionCount: loopDecisions.length,
            endTime: new Date().toISOString(),
            finalOutcome: `Final action: ${finalAction || 'none'}`,
            config: mergedConfig,
          });
        } catch (e) {
          console.warn('[AUTOTRADER] Failed to save loop metadata:', e.message);
        }
      }

      // Track this loop in memory (keep only last 50 to prevent memory leak)
      this.activeLoops.set(loopId, {
        startTime,
        prompt: initialPrompt,
        iterations: iteration,
        finalAction: finalAction || 'none',
      });
      if (this.activeLoops.size > 50) {
        const oldestKey = this.activeLoops.keys().next().value;
        this.activeLoops.delete(oldestKey);
      }

      console.log(`\n[AUTOTRADER] Autonomous trading session completed`);
      console.log(`   Loop ID: ${loopId}`);
      console.log(`   Iterations completed: ${iteration}`);
      console.log(`   Decisions made: ${loopDecisions.length}`);
      console.log(`   Duration: ${(duration / 1000).toFixed(2)}s`);
      console.log(`   Final action: ${finalAction || 'none'}`);

      return {
        success: true,
        loopId,
        iterations: iteration,
        decisionsCount: loopDecisions.length,
        finalAction: finalAction || null,
        decisions: loopDecisions,
        totalTime: duration,
        waitSeconds,
      };
    } catch (error) {
      console.error(`[AUTOTRADER] Autonomous trading error: ${error.message}`);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Execute a GPT decision action (buy, sell, etc.)
   * Maps GPT action types to actual Binance trading operations
   * @param {Object} action - Action object from GPT decision
   * @param {string} action.action - Action type: 'buy', 'sell', 'wait', 'query'
   * @param {Object} action.params - Action parameters
   * @returns {Promise<Object>} - Execution result
   */
  async ExecuteAction(action) {
    try {
      if (!this.binance || !this.binance.isInitialized) {
        console.warn('[AUTOTRADER] Binance not initialized, skipping action execution');
        return { success: false, reason: 'Binance not initialized' };
      }

      const { action: actionType, ...params } = action;

      console.log(`\n[AUTOTRADER] Executing action: ${actionType}`);

      switch (actionType.toLowerCase()) {
        case 'buy':
          return await this._ExecuteBuy(params);

        case 'sell':
          return await this._ExecuteSell(params);

        case 'buyatprice':
          return await this._ExecuteBuyAtPrice(params);

        case 'sellatprice':
          return await this._ExecuteSellAtPrice(params);

        case 'query':
          return await this._ExecuteQuery(params);

        case 'wait':
          return await this._ExecuteWait(params);

        case 'complete':
          return { success: true, message: 'Trading session marked as complete' };

        default:
          console.warn(`[AUTOTRADER] Unknown action type: ${actionType}`);
          return { success: false, reason: `Unknown action: ${actionType}` };
      }
    } catch (error) {
      console.error(`[AUTOTRADER] Action execution failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Execute BUY action via Binance API
   * @private
   */
  async _ExecuteBuy(params) {
    try {
      const { quantity, price, symbol } = params;

      // quantity is optional when percent is provided — we compute it from percent below
      if (!quantity && !params.percent) {
        throw new Error('Buy action requires either quantity or percent parameter');
      }

      // Check Settings constraints for BUY
      const tradingRules = Settings.Trading?.Rules || {};
      const balanceReqs = tradingRules.BalanceRequirements || { MinUSDTForBuy: 15, MinAssetValueForSell: 15 };
      const currentPrice = price || (await this.binance.GetPrice(symbol));
      let requiredUSDT = quantity ? quantity * currentPrice : 0;
      const minUSDTForBuy = balanceReqs.MinUSDTForBuy || 15;

      // Derive baseAsset from symbol for logging
      const buyBaseAsset = symbol ? symbol.replace(/USDT$|BTC$|ETH$|BNB$|BUSD$/i, '') : 'LTC';

      // Check if account has sufficient USDT balance to buy
      const balances = await this.binance.GetBalances();
      const usdtBalance = balances.USDT || { free: 0, locked: 0, total: 0 };
      let availableUSDT = usdtBalance.free || 0;

      // Early bail: if balance already below minimum, don't waste API calls
      if (availableUSDT < minUSDTForBuy) {
        console.log(`   [Balance Check] Balance $${availableUSDT.toFixed(2)} is below minimum trade size $${minUSDTForBuy}. Skipping buy.`);
        return { success: false, action: 'buy', error: 'Low balance', insufficientBalance: true };
      }

      // Cranks safety: subtract locked USDC, cap at MockBalance after first cascade
      const cranksLockedUSDC = this.cranks ? this.cranks.getLockedUSDC() : 0;
      const realFreeUSDT = Math.max(0, availableUSDT - cranksLockedUSDC);
      const cranksMockBalance = this.cranks ? this.cranks.getMockBalance() : Infinity;
      if (cranksLockedUSDC > 0 || cranksMockBalance < Infinity) {
        const mockStr = cranksMockBalance === Infinity ? 'unlimited (no cascades yet)' : `$${cranksMockBalance.toFixed(2)}`;
        console.log(`   [Cranks] 🔒 Locked USDC: $${cranksLockedUSDC.toFixed(2)}, MockBalance: ${mockStr}`);
        availableUSDT = Math.min(realFreeUSDT, cranksMockBalance);
      }
      
      // GPT-CONTROLLED position sizing: GPT sends "percent" (5-20) in its buy action
      // HARD CAP: 20% (1/5th) of balance — NEVER more, regardless of what GPT asks
      const hardMaxPercent = 0.20; // Absolute safety cap: 20% of budget (1/5th)
      const hardMinPercent = 0.05; // Minimum: 5% of budget
      const defaultPercent = 0.15; // Default if GPT doesn't specify
      let gptPercent = params.percent ? parseFloat(params.percent) / 100 : null;
      
      let effectivePercent;
      if (gptPercent !== null && !isNaN(gptPercent)) {
        // GPT chose a percentage — clamp to safe range (max 20%)
        effectivePercent = Math.max(hardMinPercent, Math.min(hardMaxPercent, gptPercent));
        if (gptPercent > hardMaxPercent) {
          console.log(`   [GPT Sizing] GPT requested ${(gptPercent * 100).toFixed(0)}% → CAPPED to ${(effectivePercent * 100).toFixed(0)}% (hard max 20%)`);
        } else {
          console.log(`   [GPT Sizing] GPT requested ${(gptPercent * 100).toFixed(0)}% → using ${(effectivePercent * 100).toFixed(0)}%`);
        }
      } else {
        effectivePercent = defaultPercent;
        console.log(`   [GPT Sizing] No percent from GPT, defaulting to ${(effectivePercent * 100).toFixed(0)}%`);
      }
      
      const maxBuyUSDT = availableUSDT * effectivePercent;
      
      console.log(`   [Balance Status] Requested: ${quantity} ${buyBaseAsset} (cost: $${requiredUSDT.toFixed(2)}), Available: $${availableUSDT.toFixed(2)}, GPT position: $${maxBuyUSDT.toFixed(2)} (${(effectivePercent * 100).toFixed(0)}%)`);
      
      // Compute quantity from GPT's chosen percentage (override GPT's quantity — percent is the source of truth)
      {
        const targetUSDT = Math.min(maxBuyUSDT, availableUSDT);
        const computedQuantity = Math.floor((targetUSDT * 0.99) / currentPrice * 10000000) / 10000000;
        if (computedQuantity <= 0) {
          const error = `GPT sizing ($${maxBuyUSDT.toFixed(2)} = ${(effectivePercent * 100).toFixed(0)}% of $${availableUSDT.toFixed(2)}) too small to buy any ${buyBaseAsset} at $${currentPrice}. Action blocked.`;
          console.warn(`   [GPT Sizing] ${error}`);
          return { success: false, action: 'buy', error };
        }
        console.log(`   [GPT Sizing] Computed quantity: ${computedQuantity} ${buyBaseAsset} ($${(computedQuantity * currentPrice).toFixed(2)}) from ${(effectivePercent * 100).toFixed(0)}% of $${availableUSDT.toFixed(2)}`);
        params.quantity = computedQuantity;
        requiredUSDT = computedQuantity * currentPrice;
      }
      
      // CRITICAL CHECK: Did balance change drastically between context and execution?
      // If GPT recommended buying an amount > $0 but USDT balance is now critically low
      if (requiredUSDT > 0 && availableUSDT === 0) {
        const error = `⛔ CRITICAL: Account state changed externally! GPT recommended buying ${quantity} (costing $${requiredUSDT.toFixed(2)}), but USDT balance is now 0. This suggests your account was modified outside the bot. Stopping all trading.`;
        console.error(`   [External Modification Detected] ${error}`);
        return { success: false, action: 'buy', error, externalModificationDetected: true };
      }
      
      if (requiredUSDT > 0 && availableUSDT > 0 && availableUSDT < (requiredUSDT * 0.50)) {
        console.warn(`   [Account State Changed] USDT balance reduced from ~$${requiredUSDT.toFixed(2)} to $${availableUSDT.toFixed(2)} between decision and execution (50%+ change detected). Account may have been modified externally.`);
      }
      
      // If purchase would exceed available balance, reduce quantity to fit
      if (requiredUSDT > availableUSDT) {
        console.log(`   [Quantity Adjustment Triggered] Required: $${requiredUSDT.toFixed(2)}, Available: $${availableUSDT.toFixed(2)}`);
        const adjustedQuantity = Math.floor((availableUSDT * 0.99) / currentPrice * 10000000) / 10000000;
        console.log(`   [Quantity Adjustment Calculation] (${availableUSDT.toFixed(2)} * 0.99) / ${currentPrice} = ${adjustedQuantity}`);
        
        if (adjustedQuantity <= 0) {
          const error = `Insufficient USDT balance: trying to buy ${quantity} asset costing $${requiredUSDT.toFixed(2)}, but only ${availableUSDT.toFixed(2)} USDT available. Action blocked.`;
          console.warn(`   [Balance Check] ${error}`);
          return { success: false, action: 'buy', error };
        }
        console.log(`   [Quantity Adjustment] Reduced buy quantity from ${quantity} to ${adjustedQuantity} to fit available balance`);
        requiredUSDT = adjustedQuantity * currentPrice;
        params.quantity = adjustedQuantity;
      }

      // ENFORCE MinTrade requirement — bump UP to minimum if GPT chose too low a percent
      if (requiredUSDT < minUSDTForBuy) {
        if (availableUSDT >= minUSDTForBuy) {
          // Bump up to minimum trade size + 5% margin to safely clear Binance NOTIONAL filter
          const bumpTarget = minUSDTForBuy * 1.05;
          const bumpQuantity = Math.floor((bumpTarget) / currentPrice * 10000000) / 10000000;
          console.log(`   [MinTrade Bump] GPT amount $${requiredUSDT.toFixed(2)} below $${minUSDTForBuy} min → bumping to ${bumpQuantity} ${buyBaseAsset} ($${(bumpQuantity * currentPrice).toFixed(2)})`);
          params.quantity = bumpQuantity;
          requiredUSDT = bumpQuantity * currentPrice;
        } else {
          // Can't afford the minimum — REJECT, don't send a doomed order to Binance
          const error = `Insufficient balance ($${availableUSDT.toFixed(2)}) to meet minimum trade ($${minUSDTForBuy}). Buy blocked.`;
          console.warn(`   [MinTrade Reject] ${error}`);
          return { success: false, action: 'buy', error, insufficientBalance: true };
        }
      }

      if (requiredUSDT <= 0) {
        const error = `Buy order value is $0. Cannot place order.`;
        console.warn(`   [Balance Check] ${error}`);
        return { success: false, action: 'buy', error };
      }

      // If no price provided, use market order (price = null)
      const orderPrice = price ? parseFloat(price) : null;

      // Get exchange info for this pair to determine proper stepSize
      let stepSize = 0.001; // Default fallback
      try {
        const exchInfo = await this.binance.GetExchangeInfo(symbol);
        if (exchInfo?.filters) {
          const lotSizeFilter = exchInfo.filters.find(f => f.filterType === 'LOT_SIZE');
          if (lotSizeFilter) {
            stepSize = parseFloat(lotSizeFilter.stepSize);
            console.log(`   [Exchange Info] ${symbol} stepSize: ${stepSize}`);
          }
        }
      } catch (e) {
        console.warn(`   [Exchange Info] Failed to get stepSize for ${symbol}, using default ${stepSize}`);
      }

      // Auto-correct quantity to align with stepSize
      let correctedQuantity = Math.floor(params.quantity / stepSize) * stepSize;
      correctedQuantity = parseFloat(correctedQuantity.toFixed(8)); // Remove floating point noise
      
      if (correctedQuantity !== params.quantity) {
        console.log(`   [StepSize Correction] Adjusted quantity from ${params.quantity} to ${correctedQuantity} (stepSize: ${stepSize})`);
      }

      // CRITICAL: Refresh current price before final check to ensure quantity is still valid
      // Market price may have moved between decision time and execution time
      const refreshedPrice = await this.binance.GetPrice(symbol);
      console.log(`   [Price Refresh] Current price before order: $${refreshedPrice.toFixed(2)} (was $${currentPrice.toFixed(2)})`);
      
      // SANITY CHECK: Reject refreshed price if it's drastically different (likely bad data)
      const priceDelta = Math.abs(refreshedPrice - currentPrice) / currentPrice;
      let finalPrice = currentPrice; // Default to original price
      let usedRefreshedPrice = false;
      
      if (priceDelta > 0.50) {
        // Price move >50% is abnormal - likely bad data or wrong pair
        console.error(`   [Price Sanity Check FAILED] Price moved ${(priceDelta * 100).toFixed(2)}% from $${currentPrice.toFixed(2)} to $${refreshedPrice.toFixed(2)}. This is likely stale/corrupted data. REJECTING refreshed price - using original $${currentPrice.toFixed(2)} only.`);
        finalPrice = currentPrice; // FORCE use of original price
        usedRefreshedPrice = false;
      } else if (priceDelta > 0.02) {
        // Price moved 2-50% - valid market movement, use refreshed price and readjust quantity
        console.warn(`   [Price Alert] Price moved significantly from $${currentPrice.toFixed(2)} to $${refreshedPrice.toFixed(2)} (${(priceDelta * 100).toFixed(2)}% change)`);
        finalPrice = refreshedPrice;
        usedRefreshedPrice = true;
        
        // Recalculate quantity with new price to ensure it still fits balance
        const recalculatedQuantity = Math.floor((availableUSDT * 0.99) / refreshedPrice * 10000000) / 10000000;
        const recalculatedQtyRounded = Math.floor(recalculatedQuantity * 1000) / 1000;
        
        if (recalculatedQtyRounded < correctedQuantity) {
          console.log(`   [Quantity Readjustment] Price moved. Reducing quantity from ${correctedQuantity} to ${recalculatedQtyRounded} to fit new market price.`);
          correctedQuantity = recalculatedQtyRounded;
        }
      } else {
        // Price moved <2% - normal, use refreshed price for final check
        console.log(`   [Price Normal] Price movement within 2% tolerance, using refreshed price`);
        finalPrice = refreshedPrice;
        usedRefreshedPrice = true;
      }

      // FINAL SAFETY CHECK: Verify the corrected quantity doesn't exceed available balance
      const finalRequiredUSDT = correctedQuantity * finalPrice;
      console.log(`   [Final Check] Verified: ${correctedQuantity} ${buyBaseAsset} @ $${finalPrice.toFixed(2)} = $${finalRequiredUSDT.toFixed(2)} (available: $${availableUSDT.toFixed(2)}) [using ${usedRefreshedPrice ? 'refreshed' : 'original'} price]`);
      
      if (finalRequiredUSDT > availableUSDT * 1.01) { // Allow 1% slip for rounding
        const error = `CRITICAL: Final safety check FAILED! Attempting to buy $${finalRequiredUSDT.toFixed(2)} but only $${availableUSDT.toFixed(2)} available. Quantity: ${correctedQuantity} ${buyBaseAsset} @ $${finalPrice.toFixed(2)}. Order REJECTED.`;
        console.error(`   [Safety Violation] ${error}`);
        return { success: false, action: 'buy', error };
      }

      // CHECK: After all adjustments, does the order still meet MINIMUM TRADE requirements?
      if (finalRequiredUSDT < minUSDTForBuy) {
        // Quantity was readjusted too much - now below minimum
        if (availableUSDT >= minUSDTForBuy) {
          // We COULD afford the minimum if price hadn't moved
          const error = `Order value ($${finalRequiredUSDT.toFixed(2)}) fell below minimum ($${minUSDTForBuy}) due to price/quantity adjustments. This suggests unstable market conditions. Order REJECTED.`;
          console.warn(`   [MinTrade Failed] ${error}`);
          return { success: false, action: 'buy', error };
        } else {
          // Balance is too low to meet minimum — REJECT, don't send a doomed order
          const error = `Insufficient balance ($${availableUSDT.toFixed(2)}) to meet minimum trade ($${minUSDTForBuy}) after adjustments. Buy blocked.`;
          console.warn(`   [MinTrade Reject] ${error}`);
          return { success: false, action: 'buy', error, insufficientBalance: true };
        }
      }

      console.log(`   💰 Buying ${correctedQuantity} of ${symbol || 'asset'} at ${orderPrice ? '$' + orderPrice : 'market price'}...`);

      const result = await this.binance.Buy(correctedQuantity, orderPrice, symbol);

      if (!result.success) {
        const ec = result.errorCode || 'UNKNOWN';
        console.log(`   ⚠️  Order failed [${ec}]: ${result.error}`);

        // ── Structured error handling for every known Binance rejection ──
        switch (ec) {
          case 'NOTIONAL': {
            // Order value too small for Binance's NOTIONAL filter.
            // Try ONE bump: recalculate quantity to meet the minimum notional.
            console.log(`   [NOTIONAL Recovery] Attempting to bump order to meet minimum notional...`);
            try {
              const exchInfo = await this.binance.GetExchangeInfo(symbol);
              const notionalFilter = exchInfo?.filters?.find(f => f.filterType === 'NOTIONAL');
              const minNotional = notionalFilter ? parseFloat(notionalFilter.minNotional) : 5;
              const livePrice = await this.binance.GetPrice(symbol);
              // Need qty such that qty * price >= minNotional. Add 5% margin.
              const bumpQty = Math.ceil((minNotional * 1.05) / livePrice * 10000000) / 10000000;
              const bumpCost = bumpQty * livePrice;

              if (bumpCost > availableUSDT) {
                console.warn(`   [NOTIONAL Recovery] Can't afford bumped order ($${bumpCost.toFixed(2)} > $${availableUSDT.toFixed(2)}). Buy blocked.`);
                return { success: false, action: 'buy', error: `NOTIONAL: need $${minNotional} but balance is $${availableUSDT.toFixed(2)}`, insufficientBalance: true };
              }

              console.log(`   [NOTIONAL Recovery] Retrying with ${bumpQty} ${buyBaseAsset} ($${bumpCost.toFixed(2)}) to clear $${minNotional} minimum...`);
              const retryResult = await this.binance.Buy(bumpQty, null, symbol);
              if (!retryResult.success) {
                console.warn(`   [NOTIONAL Recovery] Retry also failed: ${retryResult.error}`);
                return { success: false, action: 'buy', error: retryResult.error, insufficientBalance: true };
              }
              // Retry succeeded — continue with the rest of the success path
              console.log(`   [NOTIONAL Recovery] ✅ Retry succeeded!`);
              // Overwrite variables so the downstream code (trade save, Cranks) uses the retried order
              Object.assign(result, retryResult);
              correctedQuantity = bumpQty;
            } catch (retryErr) {
              console.error(`   [NOTIONAL Recovery] Exception during retry: ${retryErr.message}`);
              return { success: false, action: 'buy', error: result.error, insufficientBalance: true };
            }
            break;
          }

          case 'INSUFFICIENT_BALANCE':
            console.warn(`   [Binance] Insufficient balance on exchange. Stopping buy attempts.`);
            return { success: false, action: 'buy', error: result.error, insufficientBalance: true };

          case 'LOT_SIZE':
          case 'MARKET_LOT_SIZE':
            console.warn(`   [Binance] Quantity ${correctedQuantity} rejected by LOT_SIZE filter. Order blocked.`);
            return { success: false, action: 'buy', error: result.error };

          case 'PERCENT_PRICE':
          case 'PRICE_FILTER':
            console.warn(`   [Binance] Price filter rejection — market may be too volatile. Order blocked.`);
            return { success: false, action: 'buy', error: result.error };

          case 'MAX_ORDERS':
            console.warn(`   [Binance] Too many open orders. Waiting for existing orders to fill.`);
            return { success: false, action: 'buy', error: result.error };

          case 'RATE_LIMIT':
            console.warn(`   [Binance] Rate limited by exchange. Will retry next iteration.`);
            return { success: false, action: 'buy', error: result.error };

          case 'TIMESTAMP':
            console.warn(`   [Binance] Timestamp sync error. Check system clock.`);
            return { success: false, action: 'buy', error: result.error };

          default:
            // Unknown / unclassified error — return as-is
            return { success: false, action: 'buy', error: result.error };
        }
      }

      // Use actual fill price from Binance MARKET order response (cummulativeQuoteQty / origQty)
      const actualFillPrice = result.order?.price || orderPrice || currentPrice;
      console.log(`   Buy order placed: Order ID ${result.order?.orderId} (fill price: $${actualFillPrice.toFixed(4)})`);
      
      // Save trade to database
      if (this.tradeDB) {
        try {
          const tradeId = `trade_${Date.now()}_${Math.random().toString(36).substr(2,9)}`;
          await this.tradeDB.SaveTrade({
            id: tradeId,
            orderId: result.order?.orderId,
            action: 'BUY',
            quantity: correctedQuantity,
            price: actualFillPrice,
            pair: symbol || 'LTCUSDT',
            timestamp: new Date(),
            status: 'completed',
            notes: `Autonomous buy order (fill: $${actualFillPrice.toFixed(4)})`,
          });
        } catch (err) {
          console.warn(`   [TradeDB] Failed to save buy trade: ${err.message}`);
        }
      }

      // Cranks: create ratchets for this coin on first buy (baseAmount = buy cost in USDT)
      if (this.cranks) {
        const buyCostUSD = correctedQuantity * actualFillPrice;
        if (!this.cranks.getStatus(buyBaseAsset)) {
          this.cranks.create(buyBaseAsset, buyCostUSD);
        }
      }

      // Notify Discord of the buy
      try {
        await process.discord?.NotifyTrade({
          action: 'buy',
          pair: symbol || 'LTCUSDT',
          quantity: correctedQuantity,
          price: actualFillPrice,
          orderId: result.order?.orderId,
        });
      } catch (_) { /* non-critical */ }
      
      return {
        success: true,
        action: 'buy',
        quantity: correctedQuantity,
        price: actualFillPrice,
        orderId: result.order?.orderId,
      };
    } catch (error) {
      console.error(`   Failed to place BUY order: ${error.message}`);
      return { success: false, action: 'buy', error: error.message };
    }
  }

  /**
   * Execute SELL action via Binance API
   * @private
   */
  async _ExecuteSell(params) {
    try {
      const { quantity, price, symbol } = params;

      if (!quantity) {
        throw new Error('Sell action requires quantity parameter');
      }

      // Check Settings constraints for SELL
      const tradingRules = Settings.Trading?.Rules || {};
      const balanceReqs = tradingRules.BalanceRequirements || { MinUSDTForBuy: 15, MinAssetValueForSell: 15 };
      const profitTargets = tradingRules.ProfitTargets || { MinProfitPercentToSell: 4 };
      const lossPrevention = tradingRules.LossPrevention || { StrictlyNoLosses: true };
      const currentPrice = price || (await this.binance.GetPrice(symbol));
      const sellValue = quantity * currentPrice;
      const minAssetValueForSell = balanceReqs.MinAssetValueForSell || 15;
      const minProfitPercent = profitTargets.MinProfitPercentToSell || 4;

      // Check if account has sufficient balance to sell this quantity
      // Derive baseAsset from symbol (e.g. UNIUSDT → UNI, LTCUSDT → LTC)
      let baseAsset = Settings.Binance?.baseAsset || 'LTC';
      if (symbol) {
        // Strip quote asset (USDT, BTC, ETH, BNB) from symbol to get base
        baseAsset = symbol.replace(/USDT$|BTC$|ETH$|BNB$|BUSD$/i, '');
        console.log(`   [Sell] Derived baseAsset: ${baseAsset} from symbol: ${symbol}`);
      }
      const balances = await this.binance.GetBalances();
      const assetBalance = balances[baseAsset];
      const availableQuantity = assetBalance?.free || 0;
      const maxAvailableSellValue = availableQuantity * currentPrice;
      
      // CRITICAL CHECK: Did balance change drastically between context and execution?
      // If GPT recommended selling a quantity > 0 but balance is now 0, account was modified externally
      if (quantity > 0 && availableQuantity === 0) {
        const error = `⛔ CRITICAL: Account state changed externally! GPT recommended selling ${quantity} ${baseAsset}, but balance is now 0. This suggests your account was modified outside the bot (manual trade, API call, etc.). Stopping all trading.`;
        console.error(`   [External Modification Detected] ${error}`);
        // This should trigger account drain detection
        return { success: false, action: 'sell', error, externalModificationDetected: true };
      }
      
      // Similar check for major balance reduction (> 10% loss without a trade)
      if (quantity > 0 && availableQuantity > 0 && availableQuantity < (quantity * 0.80)) {
        console.warn(`   [Account State Changed] Balance reduced from ~${quantity} to ${availableQuantity} ${baseAsset} between decision and execution (20%+ change detected). Account may have been modified externally.`);
      }
      
      // ENFORCE MinTrade requirement - but ONLY if you can afford it
      if (sellValue < minAssetValueForSell) {
        // Check: Can you sell enough to meet the minimum?
        if (maxAvailableSellValue >= minAssetValueForSell) {
          // YES - you CAN sell the minimum, so ENFORCE it
          const error = `Sell order value ($${sellValue.toFixed(2)}) is below minimum requirement ($${minAssetValueForSell}). You have ${availableQuantity} ${baseAsset} worth $${maxAvailableSellValue.toFixed(2)}, which can support the minimum. Order REJECTED to enforce minimum trade value.`;
          console.warn(`   [MinTrade Enforced] ${error}`);
          return { success: false, action: 'sell', error };
        } else {
          // NO - you CAN'T sell the minimum, so OVERRIDE it
          console.warn(`   [MinTrade Override] Sell order value ($${sellValue.toFixed(2)}) is below minimum requirement ($${minAssetValueForSell}), but available balance (${availableQuantity} ${baseAsset} = $${maxAvailableSellValue.toFixed(2)}) cannot support the minimum. Proceeding with available balance.`);
        }
      }

      if (sellValue <= 0) {
        const error = `Sell order value is $0. Cannot place order.`;
        console.warn(`   [Balance Check] ${error}`);
        return { success: false, action: 'sell', error };
      }

      if (availableQuantity < quantity) {
        const error = `Insufficient balance: trying to sell ${quantity} ${baseAsset}, but only ${availableQuantity} available. Action blocked.`;
        console.warn(`   [Balance Check] ${error}`);
        return { success: false, action: 'sell', error };
      }

      // Check profit requirement if StrictlyNoLosses is enabled or MinProfitPercentToSell is set
      // CRITICAL: Actually look up entry price from TradeDB BEFORE placing the order
      if (lossPrevention.StrictlyNoLosses || minProfitPercent > 0) {
        if (this.tradeDB) {
          try {
            const recentTrades = await this.tradeDB.GetTradesForPair(symbol || 'LTCUSDT');
            const recentBuys = recentTrades
              .filter(t => t.action === 'BUY')
              .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
            
            if (recentBuys.length > 0) {
              const entryPrice = parseFloat(recentBuys[0].price);
              const projectedPL = ((currentPrice - entryPrice) / entryPrice) * 100;
              console.log(`   [Profit Check] Entry: $${entryPrice.toFixed(4)}, Current: $${currentPrice.toFixed(4)}, P/L: ${projectedPL.toFixed(2)}%`);

              if (lossPrevention.StrictlyNoLosses && projectedPL < 0) {
                const error = `🛑 SELL BLOCKED: Would result in ${projectedPL.toFixed(2)}% LOSS (entry: $${entryPrice.toFixed(4)}, current: $${currentPrice.toFixed(4)}). StrictlyNoLosses is enabled.`;
                console.warn(`   [Loss Prevention] ${error}`);
                return { success: false, action: 'sell', error };
              }

              if (minProfitPercent > 0 && projectedPL < minProfitPercent) {
                const error = `⚠️ SELL BLOCKED: Profit ${projectedPL.toFixed(2)}% is below minimum ${minProfitPercent}% target (entry: $${entryPrice.toFixed(4)}, current: $${currentPrice.toFixed(4)}). Wait for more profit.`;
                console.warn(`   [Profit Target] ${error}`);
                return { success: false, action: 'sell', error };
              }

              console.log(`   [Profit Check] ✅ Profit ${projectedPL.toFixed(2)}% meets ${minProfitPercent}% target. Sell approved.`);
            } else {
              console.warn(`   [Profit Check] No buy history found for ${symbol}. Cannot verify profit. Blocking sell for safety.`);
              return { success: false, action: 'sell', error: `No entry price found for ${symbol}. Cannot verify sell would be profitable.` };
            }
          } catch (err) {
            console.warn(`   [Profit Check] TradeDB lookup failed: ${err.message}. Blocking sell for safety.`);
            return { success: false, action: 'sell', error: `Failed to verify profit: ${err.message}` };
          }
        } else {
          console.warn(`   [Profit Check] TradeDB not available. Cannot verify profit. Blocking sell for safety.`);
          return { success: false, action: 'sell', error: 'TradeDB not available to verify entry price. Sell blocked.' };
        }
      }

      // If no price provided, use market order (price = null)
      const orderPrice = price ? parseFloat(price) : null;

      // Get exchange info for this pair to determine proper stepSize
      let stepSize = 0.001; // Default fallback
      try {
        const exchInfo = await this.binance.GetExchangeInfo(symbol);
        if (exchInfo?.filters) {
          const lotSizeFilter = exchInfo.filters.find(f => f.filterType === 'LOT_SIZE');
          if (lotSizeFilter) {
            stepSize = parseFloat(lotSizeFilter.stepSize);
            console.log(`   [Exchange Info] ${symbol || baseAsset} stepSize: ${stepSize}`);
          }
        }
      } catch (e) {
        console.warn(`   [Exchange Info] Failed to get stepSize for ${symbol}, using default ${stepSize}`);
      }

      // Auto-correct quantity to align with stepSize
      let correctedQuantity = Math.floor(quantity / stepSize) * stepSize;
      correctedQuantity = parseFloat(correctedQuantity.toFixed(8)); // Remove floating point noise
      
      if (correctedQuantity !== quantity) {
        console.log(`   [StepSize Correction] Adjusted quantity from ${quantity} to ${correctedQuantity} (stepSize: ${stepSize})`);
      }

      // FINAL SAFETY CHECK: Verify the corrected quantity is available to sell
      console.log(`   [Final Check] Verified: ${correctedQuantity} ${baseAsset} (have: ${availableQuantity} available)`);
      
      if (correctedQuantity > availableQuantity * 1.01) { // Allow 1% slip for rounding
        const error = `CRITICAL: Final safety check FAILED! Attempting to sell ${correctedQuantity} ${baseAsset} but only ${availableQuantity} available. Order REJECTED.`;
        console.error(`   [Safety Violation] ${error}`);
        return { success: false, action: 'sell', error };
      }

      console.log(`   💵 Selling ${correctedQuantity} of ${symbol || 'asset'} at ${orderPrice ? '$' + orderPrice : 'market price'}...`);

      const result = await this.binance.Sell(correctedQuantity, orderPrice, symbol);

      if (!result.success) {
        const ec = result.errorCode || 'UNKNOWN';
        console.log(`   ⚠️  Sell order failed [${ec}]: ${result.error}`);

        // Structured error handling for sell-side Binance errors
        switch (ec) {
          case 'NOTIONAL':
            console.warn(`   [Binance] Sell value below NOTIONAL minimum. Order blocked.`);
            return { success: false, action: 'sell', error: result.error };

          case 'INSUFFICIENT_BALANCE':
            console.warn(`   [Binance] Insufficient asset balance to sell. Order blocked.`);
            return { success: false, action: 'sell', error: result.error };

          case 'LOT_SIZE':
          case 'MARKET_LOT_SIZE':
            console.warn(`   [Binance] Quantity ${correctedQuantity} rejected by LOT_SIZE filter.`);
            return { success: false, action: 'sell', error: result.error };

          case 'PERCENT_PRICE':
          case 'PRICE_FILTER':
            console.warn(`   [Binance] Price filter rejection — market too volatile.`);
            return { success: false, action: 'sell', error: result.error };

          case 'MAX_ORDERS':
            console.warn(`   [Binance] Too many open orders.`);
            return { success: false, action: 'sell', error: result.error };

          case 'RATE_LIMIT':
            console.warn(`   [Binance] Rate limited. Will retry next iteration.`);
            return { success: false, action: 'sell', error: result.error };

          case 'TIMESTAMP':
            console.warn(`   [Binance] Timestamp sync error. Check system clock.`);
            return { success: false, action: 'sell', error: result.error };

          default:
            return { success: false, action: 'sell', error: result.error };
        }
      }

      // Use actual fill price from Binance MARKET order response (cummulativeQuoteQty / origQty)
      const actualSellPrice = result.order?.price || orderPrice || currentPrice;
      console.log(`   Sell order placed: Order ID ${result.order?.orderId} (fill price: $${actualSellPrice.toFixed(4)})`);
      
      // Track profit/loss across DB and return value
      let entryPrice = undefined;
      let profitLoss = undefined;
      let profitLossPercent = undefined;

      // Save trade to database and calculate profit/loss
      if (this.tradeDB) {
        try {
          
          const recentTrades = await this.tradeDB.GetTradesForPair(symbol || 'LTCUSDT');
          const recentBuys = recentTrades
            .filter(t => t.action === 'BUY')
            .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
          
          if (recentBuys.length > 0) {
            // Use the most recent buy as entry price
            entryPrice = recentBuys[0].price;
            const pl = TradeDB.CalculateProfitLoss(entryPrice, actualSellPrice, correctedQuantity);
            profitLoss = pl.profitLoss;
            profitLossPercent = pl.profitLossPercent;
            
            // Check for losses - trading should NEVER take losses
            if (lossPrevention.StrictlyNoLosses && profitLossPercent < 0) {
              console.error(`   [Loss Prevention] ⛔ ERROR: SELL resulted in LOSS of ${profitLossPercent.toFixed(2)}%. This should never happen with StrictlyNoLosses enabled!`);
            }
          }
          
          const tradeId = `trade_${Date.now()}_${Math.random().toString(36).substr(2,9)}`;
          await this.tradeDB.SaveTrade({
            id: tradeId,
            orderId: result.order?.orderId,
            action: 'SELL',
            quantity: correctedQuantity,
            price: actualSellPrice,
            pair: symbol || 'LTCUSDT',
            entryPrice,
            profitLoss,
            profitLossPercent,
            timestamp: new Date(),
            status: 'completed',
            notes: profitLoss ? `Profit/Loss: $${profitLoss.toFixed(4)} (${profitLossPercent.toFixed(2)}%)` : 'Autonomous sell order',
          });
          
          // Log profit/loss if available
          if (profitLoss !== undefined) {
            const direction = profitLoss >= 0 ? '✅' : '❌';
            console.log(`   ${direction} P/L: $${profitLoss.toFixed(4)} (${profitLossPercent.toFixed(2)}%)`);
          }
        } catch (err) {
          console.warn(`   [TradeDB] Failed to save sell trade: ${err.message}`);
        }
      }

      // Cranks: register dollar profit on this coin — cascades toward permanent USDC lockup
      if (this.cranks && profitLoss !== undefined && profitLoss > 0) {
        try {
          const conversionResult = await this.cranks.add(baseAsset, profitLoss);
          if (conversionResult) {
            console.log(`   [Cranks] 🔒 USDC LOCKUP #${conversionResult.conversions} for ${baseAsset}! $${conversionResult.lockedAmount.toFixed(2)} permanently locked. Total: $${conversionResult.totalLocked.toFixed(2)}`);
          }
        } catch (cranksErr) {
          console.warn(`   [Cranks] Failed to update: ${cranksErr.message}`);
        }
      }

      // Notify Discord of the sell
      try {
        await process.discord?.NotifyTrade({
          action: 'sell',
          pair: symbol || 'LTCUSDT',
          quantity: correctedQuantity,
          price: actualSellPrice,
          orderId: result.order?.orderId,
          profitLoss,
          profitLossPercent,
        });
      } catch (_) { /* non-critical */ }
      
      return {
        success: true,
        action: 'sell',
        quantity: correctedQuantity,
        price: actualSellPrice,
        orderId: result.order?.orderId,
        profitLoss: profitLoss,
        profitLossPercent: profitLossPercent,
      };
    } catch (error) {
      console.error(`   Failed to place SELL order: ${error.message}`);
      return { success: false, action: 'sell', error: error.message };
    }
  }

  /**
   * Execute BuyAtPrice action
   * @private
   */
  async _ExecuteBuyAtPrice(params) {
    try {
      const { quantity, price, timeout, symbol } = params;

      if (!quantity || !price) {
        throw new Error('BuyAtPrice requires quantity and price parameters');
      }

      console.log(`   Monitoring for price ${price} to buy ${quantity}...`);

      const result = await this.binance.BuyAtPrice(price, quantity);

      if (result.success !== false) {
        const fillPrice = result.order?.price || price;
        console.log(`   Buy order executed at target price (fill: $${fillPrice})`);

        // Save trade to database
        if (this.tradeDB) {
          try {
            const tradeId = `trade_${Date.now()}_${Math.random().toString(36).substr(2,9)}`;
            await this.tradeDB.SaveTrade({
              id: tradeId,
              orderId: result.order?.orderId || null,
              action: 'BUY',
              quantity: quantity,
              price: fillPrice,
              pair: symbol || 'LTCUSDT',
              timestamp: new Date(),
              status: 'completed',
              notes: `BuyAtPrice order (target: $${price}, fill: $${fillPrice})`,
            });
          } catch (err) {
            console.warn(`   [TradeDB] Failed to save buyatprice trade: ${err.message}`);
          }
        }
      }

      return {
        success: result.success !== false,
        action: 'buyatprice',
        price,
        quantity,
      };
    } catch (error) {
      console.error(`   BuyAtPrice failed: ${error.message}`);
      return { success: false, action: 'buyatprice', error: error.message };
    }
  }

  /**
   * Execute SellAtPrice action
   * @private
   */
  async _ExecuteSellAtPrice(params) {
    try {
      const { quantity, price, timeout, symbol } = params;

      if (!quantity || !price) {
        throw new Error('SellAtPrice requires quantity and price parameters');
      }

      console.log(`   Monitoring for price ${price} to sell ${quantity}...`);

      // Pre-sell profit check (same safety as _ExecuteSell) — StrictlyNoLosses applies here too
      const tradingRules = Settings.Trading?.Rules || {};
      const lossPrevention = tradingRules.LossPrevention || { StrictlyNoLosses: true };
      const profitTargets = tradingRules.ProfitTargets || { MinProfitPercentToSell: 4 };
      const minProfitPercent = profitTargets.MinProfitPercentToSell || 4;

      if (lossPrevention.StrictlyNoLosses || minProfitPercent > 0) {
        if (this.tradeDB) {
          try {
            const recentTrades = await this.tradeDB.GetTradesForPair(symbol || 'LTCUSDT');
            const recentBuys = recentTrades
              .filter(t => t.action === 'BUY')
              .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

            if (recentBuys.length > 0) {
              const entryPrice = parseFloat(recentBuys[0].price);
              const projectedPL = ((price - entryPrice) / entryPrice) * 100;
              console.log(`   [SellAtPrice Profit Check] Entry: $${entryPrice.toFixed(4)}, Target: $${price}, P/L: ${projectedPL.toFixed(2)}%`);

              if (lossPrevention.StrictlyNoLosses && projectedPL < 0) {
                const error = `🛑 SELLATPRICE BLOCKED: Would result in ${projectedPL.toFixed(2)}% LOSS. StrictlyNoLosses is enabled.`;
                console.warn(`   [Loss Prevention] ${error}`);
                return { success: false, action: 'sellatprice', error };
              }
              if (minProfitPercent > 0 && projectedPL < minProfitPercent) {
                const error = `⚠️ SELLATPRICE BLOCKED: Profit ${projectedPL.toFixed(2)}% below ${minProfitPercent}% target.`;
                console.warn(`   [Profit Target] ${error}`);
                return { success: false, action: 'sellatprice', error };
              }
            } else {
              console.warn(`   [SellAtPrice] No buy history for ${symbol}. Blocking sell for safety.`);
              return { success: false, action: 'sellatprice', error: `No entry price found for ${symbol}.` };
            }
          } catch (err) {
            console.warn(`   [SellAtPrice] Profit check failed: ${err.message}. Blocking sell.`);
            return { success: false, action: 'sellatprice', error: `Profit check failed: ${err.message}` };
          }
        } else {
          console.warn(`   [SellAtPrice] TradeDB unavailable. Blocking sell.`);
          return { success: false, action: 'sellatprice', error: 'TradeDB unavailable.' };
        }
      }

      const result = await this.binance.SellAtPrice(price, quantity);

      if (result.success !== false) {
        const fillPrice = result.order?.price || price;
        console.log(`   Sell order executed at target price (fill: $${fillPrice})`);

        // Save trade to database with profit/loss if entry price available
        if (this.tradeDB) {
          try {
            let entryPrice = null;
            let profitLoss = null;
            let profitLossPercent = null;

            const recentTrades = await this.tradeDB.GetTradesForPair(symbol || 'LTCUSDT');
            const recentBuys = recentTrades
              .filter(t => t.action === 'BUY')
              .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

            if (recentBuys.length > 0) {
              entryPrice = parseFloat(recentBuys[0].price);
              const pl = TradeDB.CalculateProfitLoss(entryPrice, fillPrice, quantity);
              profitLoss = pl.profitLoss;
              profitLossPercent = pl.profitLossPercent;
            }

            const tradeId = `trade_${Date.now()}_${Math.random().toString(36).substr(2,9)}`;
            await this.tradeDB.SaveTrade({
              id: tradeId,
              orderId: result.order?.orderId || null,
              action: 'SELL',
              quantity: quantity,
              price: fillPrice,
              pair: symbol || 'LTCUSDT',
              entryPrice: entryPrice,
              profitLoss: profitLoss,
              profitLossPercent: profitLossPercent,
              timestamp: new Date(),
              status: 'completed',
              notes: profitLoss ? `SellAtPrice P/L: $${profitLoss.toFixed(4)} (${profitLossPercent.toFixed(2)}%)` : `SellAtPrice order (target: $${price})`,
            });
          } catch (err) {
            console.warn(`   [TradeDB] Failed to save sellatprice trade: ${err.message}`);
          }
        }
      }

      return {
        success: result.success !== false,
        action: 'sellatprice',
        price,
        quantity,
      };
    } catch (error) {
      console.error(`   SellAtPrice failed: ${error.message}`);
      return { success: false, action: 'sellatprice', error: error.message };
    }
  }

  /**
   * Execute QUERY action (get market data)
   * @private
   */
  async _ExecuteQuery(params) {
    try {
      const { type, symbol } = params;

      console.log(`   Querying market data...`);

      let result = {};

      if (type === 'price') {
        result = await this.binance.GetPrice(symbol);
      } else if (type === 'balances') {
        result = await this.binance.GetBalances();
      } else if (type === 'orders') {
        result = await this.binance.GetActiveOrders(symbol);
      } else {
        result = { message: 'Query executed' };
      }

      console.log(`   Query completed`);
      return {
        success: true,
        action: 'query',
        data: result,
      };
    } catch (error) {
      console.error(`   Query failed: ${error.message}`);
      return { success: false, action: 'query', error: error.message };
    }
  }

  /**
   * Execute WAIT action (pause execution)
   * @private
   */
  async _ExecuteWait(params) {
    try {
      const { seconds = 5 } = params;

      console.log(`   ⏸️  Waiting ${seconds} seconds...`);

      await new Promise((resolve) => setTimeout(resolve, seconds * 1000));

      console.log(`   Wait completed`);
      return {
        success: true,
        action: 'wait',
        seconds,
      };
    } catch (error) {
      console.error(`   Wait failed: ${error.message}`);
      return { success: false, action: 'wait', error: error.message };
    }
  }

  /**
   * Get information about an active loop
   * @param {string} loopId - Loop identifier
   * @returns {Promise<Object>}
   */
  async GetLoopStatus(loopId) {
    try {
      if (!this.decisionDB) {
        return { success: false, error: 'DecisionDB not available' };
      }

      const loopData = await this.decisionDB.GetAutoLoop(loopId);

      if (!loopData) {
        return { success: false, error: `Loop ${loopId} not found` };
      }

      const decisions = await this.decisionDB.GetLoopDecisions(loopId);

      return {
        success: true,
        loopId,
        status: loopData.status,
        initialPrompt: loopData.initialPrompt,
        decisionCount: loopData.decisionCount,
        startTime: loopData.startTime,
        endTime: loopData.endTime,
        finalOutcome: loopData.finalOutcome,
        decisions: decisions,
      };
    } catch (error) {
      console.error(`[AUTOTRADER] Failed to get loop status: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * List all trading loops by status
   * @param {string} status - Filter by status: 'running', 'completed', 'failed', 'timeout'
   * @returns {Promise<Array>}
   */
  async GetLoopsByStatus(status = 'completed') {
    try {
      if (!this.decisionDB) {
        return [];
      }

      return await this.decisionDB.GetAutoLoopsByStatus(status);
    } catch (error) {
      console.error(`[AUTOTRADER] Failed to list loops: ${error.message}`);
      return [];
    }
  }
}

module.exports = AutoTrader;
