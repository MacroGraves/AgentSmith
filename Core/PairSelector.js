const PairDB = require('./PairDB.js');
const Settings = require('./Settings.js');
const DYOR = require('./DYOR.js');

/**
 * Pair Selector Module
 * Intelligently chooses which trading pair to analyze/trade based on market metrics
 * 
 * Market Condition Filters (enforced from Settings.Trading.Rules.TrendThresholds):
 *   - MinVolatilityForTrade: Skip pairs below this volatility (too flat)
 *   - MaxVolatilityForTrade: Skip pairs above this volatility (too risky)
 *   - MinVolume24h: Skip pairs with insufficient 24h trading volume
 *   - DYOR: Validate coins before first trade (CoinGecko + scam search)
 */
class PairSelector {
  constructor(binanceExchange, pairDB) {
    this.binance = binanceExchange;
    this.pairDB = pairDB;
    this.commonPairs = [
      // ── Top 50 by market cap / liquidity on Binance ──
      'BTCUSDT',  'ETHUSDT',  'BNBUSDT',  'SOLUSDT',  'XRPUSDT',
      'ADAUSDT',  'DOGEUSDT', 'AVAXUSDT', 'DOTUSDT',  'LINKUSDT',
      'MATICUSDT','UNIUSDT',  'LTCUSDT',  'ATOMUSDT', 'NEARUSDT',
      'FTMUSDT',  'ALGOUSDT', 'XLMUSDT',  'VETUSDT',  'MANAUSDT',
      'SANDUSDT', 'AXSUSDT',  'AAVEUSDT', 'ICPUSDT',  'FILUSDT',
      'THETAUSDT','EGLDUSDT', 'HBARUSDT', 'XTZUSDT',  'EOSUSDT',
      'FLOWUSDT', 'CHZUSDT',  'APEUSDT',  'LDOUSDT',  'CRVUSDT',
      'ARUSDT',   'GRTUSDT',  'MKRUSDT',  'SNXUSDT',  'COMPUSDT',
      'IMXUSDT',  'INJUSDT',  'OPUSDT',   'ARBUSDT',  'APTUSDT',
      'SUIUSDT',  'SEIUSDT',  'TIAUSDT',  'WLDUSDT',  'JUPUSDT',
    ];
    this.lastSelectedPair = null;
    this.recentBuys = new Map(); // pair → timestamp of last buy (cooldown tracking)
    this.buyCooldownMs = 15 * 60 * 1000; // 15 minute cooldown after buying a pair
    this.dyorApproved = new Set(); // Pairs that passed DYOR validation
  }

  /**
   * Initialize pairs database and run DYOR validation.
   * Inserts all 50 common pairs, then validates each one.
   * Pairs that fail DYOR are removed from Pairs and logged to PairRejects.
   * @returns {Promise<boolean>}
   */
  async Initialize() {
    try {
      const initialized = await this.pairDB.Initialize();
      
      // Add common pairs if not already in database
      // Use InitializePair to avoid setting last_checked (keeps pairs "unchecked")
      if (initialized) {
        for (const pair of this.commonPairs) {
          // Skip if already rejected previously
          const rejected = await this.pairDB.IsRejected(pair);
          if (rejected) continue;

          await this.pairDB.InitializePair(pair, {
            baseAsset: pair.substring(0, pair.length - 4),
            quoteAsset: 'USDT',
            notes: 'Common trading pair - auto-discovered',
          });
        }
      }

      // ── DYOR Startup Validation ───────────────────────────────────────────
      // Validate ALL active pairs at boot. Remove unacceptable ones.
      const dyorEnabled = Settings.Get('Trading.DYOR.Enabled', true);
      if (dyorEnabled) {
        const allPairs = await this.pairDB.GetAllPairs('score');
        console.log(`[PairSelector] Running DYOR validation on ${allPairs.length} active pairs...`);

        for (const p of allPairs) {
          if (this.dyorApproved.has(p.id)) continue;

          const baseAsset = p.id.replace(/USDT$|BTC$|ETH$|BNB$|BUSD$/i, '');
          try {
            const result = await DYOR.Validate(baseAsset, this.binance);
            if (result.approved) {
              this.dyorApproved.add(p.id);
            } else {
              // REJECTED — remove from Pairs, log to PairRejects
              await this.pairDB.RejectPair(p.id, result.score, result.reasons);
              console.log(`[DYOR] ${p.id} REJECTED (score: ${result.score}) — removed from active pairs`);
            }
          } catch (err) {
            // DYOR failure is non-fatal — approve by default so we don't nuke pairs on network blips
            console.warn(`[DYOR] Validation failed for ${p.id}: ${err.message} — approving by default`);
            this.dyorApproved.add(p.id);
          }
        }

        const activePairCount = await this.pairDB.GetActivePairCount();
        console.log(`[PairSelector] DYOR complete: ${activePairCount} pairs approved, ${allPairs.length - activePairCount} rejected`);
      }
      
      const finalCount = await this.pairDB.GetActivePairCount();
      console.log(`[PairSelector] Initialized with ${finalCount} active trading pairs`);
      return initialized;
    } catch (error) {
      console.error('[PairSelector] Initialization failed:', error.message);
      return false;
    }
  }

  /**
   * Select best pair to trade based on market metrics
   * Rotates through unchecked pairs, scoring each one dynamically
   * @returns {Promise<string>} - Selected trading pair
   */
  async SelectBestPair() {
    try {
      // Always fetch fresh data for a batch of candidates to pick the real best
      const TOP_CANDIDATES = 5; // Analyze top N candidates each iteration
      const FULL_SCAN_INTERVAL_MINUTES = 10; // Full re-scan of all pairs every N minutes

      const allPairs = await this.pairDB.GetAllPairs('score');
      if (allPairs.length === 0) {
        console.warn('[PairSelector] No pairs available, defaulting to LTCUSDT');
        return 'LTCUSDT';
      }

      // Check if we need a full scan (stale pairs that haven't been scored yet)
      const uncheckedPairs = await this.pairDB.GetUncheckedPairs(FULL_SCAN_INTERVAL_MINUTES);
      
      let candidatePairs;
      if (uncheckedPairs.length >= allPairs.length * 0.5) {
        // More than half are stale - do a full scan of ALL pairs
        console.log(`[PAIR] Full scan: ${uncheckedPairs.length}/${allPairs.length} pairs stale (>${FULL_SCAN_INTERVAL_MINUTES}min)`, { logType: 'pairs' });
        candidatePairs = allPairs;
      } else {
        // Pick a mixed set: top scored + some unchecked ones for discovery
        const topScored = allPairs.slice(0, Math.min(TOP_CANDIDATES, allPairs.length));
        const uncheckedIds = new Set(uncheckedPairs.map(p => p.id));
        const topIds = new Set(topScored.map(p => p.id));
        // Add unchecked pairs not already in the top set (up to 3 extras for diversity)
        const extraUnchecked = uncheckedPairs.filter(p => !topIds.has(p.id)).slice(0, 3);
        candidatePairs = [...topScored, ...extraUnchecked];
        console.log(`[PAIR] Evaluating ${candidatePairs.length} candidates (top ${topScored.length} + ${extraUnchecked.length} unchecked)`, { logType: 'pairs' });
      }

      // Analyze all candidates with FRESH data
      const pairScores = [];
      for (const pair of candidatePairs) {
        try {
          const metrics = await this.AnalyzePair(pair.id);
          const score = PairDB.CalculateScore(metrics);

          console.log(`[METRICS] ${pair.id} - Vol: ${metrics.volatility.toFixed(2)}%, Vol24h: $${(metrics.volume24h / 1000000).toFixed(2)}M, Change: ${metrics.priceChange24h.toFixed(2)}%, Trend: ${metrics.trend}, Score: ${score.toFixed(1)}`, { logType: 'numbers' });

          pairScores.push({ pair: pair.id, score, metrics });

          // Update metrics in DB WITHOUT touching last_checked
          await this.pairDB.UpdatePairMetrics(pair.id, {
            volatility: metrics.volatility,
            volume24h: metrics.volume24h,
            priceChange24h: metrics.priceChange24h,
            trend: metrics.trend,
            score,
            notes: `Vol: ${metrics.volatility.toFixed(2)}%, Trend: ${metrics.trend}, Score: ${score.toFixed(1)}`,
          });
        } catch (err) {
          console.warn(`[PairSelector] Failed to analyze ${pair.id}: ${err.message}`);
        }
      }

      if (pairScores.length === 0) {
        console.warn('[PairSelector] All analyses failed, defaulting to LTCUSDT');
        return 'LTCUSDT';
      }

      // Sort by score descending
      pairScores.sort((a, b) => b.score - a.score);

      // ── Market Condition Filters ──────────────────────────────────────────
      // Enforce volatility and volume thresholds from Settings
      const trendThresholds = Settings.Trading?.Rules?.TrendThresholds || {};
      const minVol = trendThresholds.MinVolatilityForTrade || 0.5;
      const maxVol = trendThresholds.MaxVolatilityForTrade || 5.0;
      const minVolume24h = trendThresholds.MinVolume24h || 1000000; // $1M default

      const filteredPairs = pairScores.filter(p => {
        const vol = p.metrics?.volatility || 0;
        const vol24h = p.metrics?.volume24h || 0;

        if (vol < minVol) {
          console.log(`[PAIR FILTER] ${p.pair} SKIPPED — volatility ${vol.toFixed(2)}% below ${minVol}% minimum (too flat)`, { logType: 'pairs' });
          return false;
        }
        if (vol > maxVol) {
          console.log(`[PAIR FILTER] ${p.pair} SKIPPED — volatility ${vol.toFixed(2)}% above ${maxVol}% maximum (too risky)`, { logType: 'pairs' });
          return false;
        }
        if (vol24h < minVolume24h) {
          console.log(`[PAIR FILTER] ${p.pair} SKIPPED — 24h volume $${(vol24h/1000000).toFixed(2)}M below $${(minVolume24h/1000000).toFixed(2)}M minimum`, { logType: 'pairs' });
          return false;
        }
        return true;
      });

      // If all pairs filtered out, fall back to full set (don't deadlock)
      let scoredPool = filteredPairs.length > 0 ? filteredPairs : pairScores;
      if (filteredPairs.length === 0 && pairScores.length > 0) {
        console.warn('[PAIR FILTER] All pairs filtered out by market conditions — using unfiltered pool');
      }

      // ── DYOR Coin Validation ──────────────────────────────────────────────
      // Validate candidates if not already approved. Rejects are REMOVED from DB.
      const dyorEnabled = Settings.Get('Trading.DYOR.Enabled', true);
      if (dyorEnabled) {
        const dyorRejected = new Set();
        for (const p of scoredPool) {
          if (this.dyorApproved.has(p.pair)) continue;

          try {
            const baseAsset = p.pair.replace(/USDT$|BTC$|ETH$|BNB$|BUSD$/i, '');
            const result = await DYOR.Validate(baseAsset, this.binance);
            if (result.approved) {
              this.dyorApproved.add(p.pair);
            } else {
              // REJECTED — remove from Pairs table, log to PairRejects
              await this.pairDB.RejectPair(p.pair, result.score, result.reasons);
              dyorRejected.add(p.pair);
              console.log(`[DYOR] ${p.pair} REJECTED (score: ${result.score}) — removed from active pairs`, { logType: 'pairs' });
            }
          } catch (err) {
            // DYOR failure is non-fatal — approve by default
            console.warn(`[DYOR] Validation failed for ${p.pair}: ${err.message} — approving by default`);
            this.dyorApproved.add(p.pair);
          }
        }

        // Filter out rejected pairs from this cycle's selection pool
        if (dyorRejected.size > 0) {
          scoredPool = scoredPool.filter(p => !dyorRejected.has(p.pair));
          if (scoredPool.length === 0) {
            console.warn('[PairSelector] All candidates rejected by DYOR, defaulting to LTCUSDT');
            return 'LTCUSDT';
          }
        }
      }

      // Filter out pairs on buy cooldown (recently bought)
      const now = Date.now();
      const availablePairs = scoredPool.filter(p => {
        const lastBuy = this.recentBuys.get(p.pair);
        if (lastBuy && (now - lastBuy) < this.buyCooldownMs) {
          const remainMin = ((this.buyCooldownMs - (now - lastBuy)) / 60000).toFixed(1);
          console.log(`[PAIR] ${p.pair} on buy cooldown (${remainMin}m remaining) — skipping`, { logType: 'pairs' });
          return false;
        }
        return true;
      });

      // If ALL pairs are on cooldown, use the full list (don't deadlock)
      const selectionPool = availablePairs.length > 0 ? availablePairs : scoredPool;

      // Log ranking
      console.log(`[PAIR] Ranking: ${pairScores.map((p, i) => `${i+1}. ${p.pair}=${p.score.toFixed(1)}`).join(', ')}`, { logType: 'pairs' });

      // Pick from top tier using weighted random selection
      // This ensures diversity while favoring higher scores
      const selected = this._weightedSelect(selectionPool);

      this.lastSelectedPair = selected.pair;
      console.log(`[PAIR] Selected: ${selected.pair} (score: ${selected.score.toFixed(1)}/100)`, { logType: 'pairs' });
      return selected.pair;
    } catch (error) {
      console.error('[PairSelector] Failed to select pair:', error.message);
      return 'LTCUSDT';
    }
  }

  /**
   * Weighted random selection from scored pairs
   * Higher scored pairs have proportionally higher chance of being picked
   * Top 3 are considered; if scores are very close, it's nearly random among them
   * @param {Array} sortedScores - Array of {pair, score, metrics}, sorted desc
   * @returns {Object} - Selected {pair, score, metrics}
   */
  _weightedSelect(sortedScores) {
    // Take top 3 (or fewer if not enough candidates)
    const topN = sortedScores.slice(0, Math.min(3, sortedScores.length));

    if (topN.length === 1) return topN[0];

    // Use score as weight directly; minimum weight of 1 to avoid zero-weight
    const weights = topN.map(p => Math.max(p.score, 1));
    const totalWeight = weights.reduce((sum, w) => sum + w, 0);
    
    let random = Math.random() * totalWeight;
    for (let i = 0; i < topN.length; i++) {
      random -= weights[i];
      if (random <= 0) {
        return topN[i];
      }
    }

    return topN[0]; // Fallback
  }

  /**
   * Analyze a trading pair and get market metrics
   * @param {string} pair - Trading pair
   * @returns {Promise<Object>} - { volatility, volume24h, priceChange24h, trend }
   */
  async AnalyzePair(pair) {
    try {
      // Get 24h statistics from Binance
      const ticker = await this.binance.GetTicker(pair);
      
      if (!ticker) {
        throw new Error(`Could not fetch ticker for ${pair}`);
      }

      const priceChange24h = parseFloat(ticker.priceChangePercent || 0);
      const volume24h = parseFloat(ticker.quoteVolume || ticker.quoteAssetVolume || ticker.volume || 0);

      // Calculate volatility from recent price history
      // Using simple approach: get last 24 candles and calculate std deviation
      const volatility = await this.CalculateVolatility(pair);

      // Determine trend
      const trend = this.DetermineTrend(priceChange24h, volatility);

      return {
        volatility,
        volume24h,
        priceChange24h,
        trend,
      };
    } catch (error) {
      console.warn(`[PairSelector] Analysis failed for ${pair}:`, error.message);
      // Return default metrics if analysis fails
      return {
        volatility: 0,
        volume24h: 0,
        priceChange24h: 0,
        trend: 'NEUTRAL',
      };
    }
  }

  /**
   * Calculate volatility for a pair
   * Uses standard deviation of returns from 1h candles
   * @param {string} pair - Trading pair
   * @returns {Promise<number>} - Volatility as percentage
   */
  async CalculateVolatility(pair) {
    try {
      // Get last 24 1-hour candles
      const candles = await this.binance.GetCandles(pair, '1h', 24);
      
      if (!candles || candles.length < 2) {
        return 0;
      }

      // Calculate hourly returns
      const returns = [];
      for (let i = 1; i < candles.length; i++) {
        const close = parseFloat(candles[i].close);
        const prevClose = parseFloat(candles[i - 1].close);
        const ret = ((close - prevClose) / prevClose) * 100;
        returns.push(ret);
      }

      // Calculate standard deviation (volatility)
      const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
      const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length;
      const stdDev = Math.sqrt(variance);

      // Annualize volatility (hourly to daily)
      return stdDev * Math.sqrt(24);
    } catch (error) {
      console.warn(`[PairSelector] Volatility calculation failed for ${pair}:`, error.message);
      return 0;
    }
  }

  /**
   * Determine trend from price change and volatility
   * @param {number} priceChange - 24h price change percentage
   * @param {number} volatility - Volatility percentage
   * @returns {string} - UPTREND, DOWNTREND, or NEUTRAL
   */
  DetermineTrend(priceChange, volatility) {
    // Consider volatility to ensure significant movement
    if (volatility < 0.5 && Math.abs(priceChange) < 1) {
      return 'NEUTRAL';
    }

    if (priceChange > 2) {
      return 'UPTREND';
    } else if (priceChange < -2) {
      return 'DOWNTREND';
    } else {
      return 'NEUTRAL';
    }
  }

  /**
   * Record the action taken on current pair
   * @param {string} action - Action taken (BUY/SELL/WAIT)
   * @returns {Promise<boolean>}
   */
  async RecordAction(action) {
    if (!this.lastSelectedPair) return false;
    
    try {
      // Track buy cooldowns to prevent repeated buys on the same pair
      if (action === 'buy') {
        this.recentBuys.set(this.lastSelectedPair, Date.now());
        console.log(`[PAIR] ${this.lastSelectedPair} entered buy cooldown (${(this.buyCooldownMs / 60000).toFixed(0)}min)`, { logType: 'pairs' });
      }

      console.log(`[PAIR] Recording action '${action}' for ${this.lastSelectedPair}`, { logType: 'pairs' });
      return await this.pairDB.RecordAction(this.lastSelectedPair, action);
    } catch (error) {
      console.error('[PairSelector] Failed to record action:', error.message);
      return false;
    }
  }

  /**
   * Get current selected pair
   * @returns {string}
   */
  GetCurrentPair() {
    return this.lastSelectedPair || 'LTCUSDT';
  }

  /**
   * Close database connection
   */
  async Close() {
    if (this.pairDB) {
      await this.pairDB.Close();
    }
  }
}

module.exports = PairSelector;
