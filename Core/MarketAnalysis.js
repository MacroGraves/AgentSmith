/**
 * Market Analysis Module
 * Provides historical data and trend analysis for trading decisions
 */
const axios = require('axios');

class MarketAnalysis {
  constructor(binanceExchange) {
    this.binance = binanceExchange;
    this.analysisCache = new Map();
  }

  /**
   * Get market analysis with historical data
   * @param {string} pair - Trading pair (e.g., 'LTC/USDT')
   * @param {number} hoursBack - Hours of history (default: 24)
   * @returns {Promise<Object>} Market analysis with trends
   */
  async GetMarketAnalysis(pair, hoursBack = 24) {
    try {
      // Check cache first (valid for 5 minutes)
      const cacheKey = `${pair}_${hoursBack}h`;
      const cached = this.analysisCache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < 300000) {
        return cached.data;
      }

      const symbol = pair.replace('/', '');
      const interval = '1h';
      const limit = Math.min(hoursBack, 1000); // Binance API limit

      // Fetch 1-hour candlestick data
      const klines = await this._fetchKlines(symbol, interval, limit);
      if (!klines || klines.length === 0) {
        return this._defaultAnalysis(pair);
      }

      // Analyze the data
      const analysis = this._analyzeKlines(klines, pair);

      // Cache the result
      this.analysisCache.set(cacheKey, {
        data: analysis,
        timestamp: Date.now(),
      });

      return analysis;
    } catch (error) {
      console.warn(`[MarketAnalysis] Error analyzing ${pair}:`, error.message);
      return this._defaultAnalysis(pair);
    }
  }

  /**
   * Fetch candlestick data from Binance API
   * Routes through Binance class for retry coverage when available
   * @private
   */
  async _fetchKlines(symbol, interval, limit) {
    try {
      // Use Binance class for retry coverage if available
      if (this.binance && this.binance.GetCandles) {
        const candles = await this.binance.GetCandles(symbol, interval, limit);
        if (candles && candles.length > 0) {
          return candles.map(kline => ({
            time: new Date(kline.time),
            open: parseFloat(kline.open),
            high: parseFloat(kline.high),
            low: parseFloat(kline.low),
            close: parseFloat(kline.close),
            volume: parseFloat(kline.quoteAssetVolume || kline.volume),
          }));
        }
        return null;
      }

      // Fallback to direct API call if Binance instance not available
      const url = 'https://api.binance.com/api/v3/klines';
      const response = await axios.get(url, {
        params: {
          symbol,
          interval,
          limit,
        },
        timeout: 10000,
      });

      return response.data.map(kline => ({
        time: new Date(kline[0]),
        open: parseFloat(kline[1]),
        high: parseFloat(kline[2]),
        low: parseFloat(kline[3]),
        close: parseFloat(kline[4]),
        volume: parseFloat(kline[7]),
      }));
    } catch (error) {
      console.warn(`[MarketAnalysis] Failed to fetch klines:`, error.message);
      return null;
    }
  }

  /**
   * Analyze candlestick data for trends
   * @private
   */
  _analyzeKlines(klines, pair) {
    const closes = klines.map(k => k.close);
    const opens = klines.map(k => k.open);

    // Current price
    const currentPrice = closes[closes.length - 1];

    // Historical data
    const highPrice = Math.max(...closes);
    const lowPrice = Math.min(...closes);
    const avgPrice = closes.reduce((a, b) => a + b, 0) / closes.length;

    // Trend calculation
    const priceChange = currentPrice - opens[0];
    const percentChange = ((priceChange / opens[0]) * 100).toFixed(2);

    // Simple moving averages
    const ma7 = closes.slice(-7).reduce((a, b) => a + b, 0) / Math.min(7, closes.length);
    const ma24 = closes.reduce((a, b) => a + b, 0) / closes.length;

    // Determine trend direction
    let trend = 'NEUTRAL';
    if (currentPrice > ma24 && currentPrice > ma7) {
      trend = 'UPTREND';
    } else if (currentPrice < ma24 && currentPrice < ma7) {
      trend = 'DOWNTREND';
    }

    // Volatility (standard deviation)
    const variance = closes.reduce((sum, price) => sum + Math.pow(price - avgPrice, 2), 0) / closes.length;
    const stdDev = Math.sqrt(variance);
    const volatility = ((stdDev / avgPrice) * 100).toFixed(2);

    // Price strength assessment
    let strength = 'NEUTRAL';
    if (currentPrice > highPrice * 0.95) {
      strength = 'STRONG (near 24h high)';
    } else if (currentPrice < lowPrice * 1.05) {
      strength = 'WEAK (near 24h low)';
    } else if (currentPrice > ma24) {
      strength = 'MODERATE-STRONG (above avg)';
    } else {
      strength = 'MODERATE-WEAK (below avg)';
    }

    return {
      pair,
      currentPrice: parseFloat(currentPrice.toFixed(2)),
      change24h: {
        price: parseFloat(priceChange.toFixed(2)),
        percent: parseFloat(percentChange),
      },
      historyData: {
        high24h: parseFloat(highPrice.toFixed(2)),
        low24h: parseFloat(lowPrice.toFixed(2)),
        avg24h: parseFloat(avgPrice.toFixed(2)),
        ma7h: parseFloat(ma7.toFixed(2)),
      },
      trend,
      strength,
      volatility: parseFloat(volatility),
      recommendation: this._getTrendRecommendation(trend, strength, percentChange),
      dataPoints: klines.length,
      analysisTime: new Date().toISOString(),
    };
  }

  /**
   * Get trading recommendation based on trend
   * @private
   */
  _getTrendRecommendation(trend, strength, percentChange) {
    const pctChange = parseFloat(percentChange) || 0;

    if (trend === 'UPTREND' && strength.includes('STRONG')) {
      return 'SELL opportunity if holding (strong uptrend, good exit point)';
    } else if (trend === 'UPTREND') {
      return 'HOLD or SELL if profit target met (uptrend, consider taking profits)';
    } else if (trend === 'DOWNTREND' && pctChange < -5) {
      return 'BUY opportunity - steep decline may be near bottom. Use small position size. Do NOT sell at a loss.';
    } else if (trend === 'DOWNTREND' && strength.includes('WEAK')) {
      return 'BUY opportunity - weak downtrend, potential entry point. Do NOT sell in downtrend.';
    } else if (trend === 'DOWNTREND') {
      return 'BUY opportunity - downtrend dip. Good entry if near support. Do NOT sell at a loss.';
    } else {
      return 'NEUTRAL - consider small entry or wait for clearer signal';
    }
  }

  /**
   * Default analysis when live data unavailable
   * @private
   */
  _defaultAnalysis(pair) {
    return {
      pair,
      currentPrice: null,
      trend: 'UNKNOWN',
      strength: 'UNKNOWN',
      recommendation: 'Unable to fetch market data. Consider waiting before trading.',
      dataPoints: 0,
      analysisTime: new Date().toISOString(),
      note: 'Using fallback analysis',
    };
  }

  /**
   * Clear analysis cache
   */
  ClearCache() {
    this.analysisCache.clear();
  }
}

module.exports = MarketAnalysis;
