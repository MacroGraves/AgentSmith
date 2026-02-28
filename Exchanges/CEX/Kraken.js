const axios = require('axios');
const crypto = require('crypto');
const querystring = require('querystring');

/**
 * Kraken Exchange Wrapper Class
 * Mirrors BinanceExchange interface for drop-in compatibility
 * STATUS: DISABLED — scaffold only, not yet wired into AutoTrader
 *
 * Kraken API docs: https://docs.kraken.com/rest/
 *
 * Key differences from Binance:
 *   - Auth uses HMAC-SHA512 of (path + SHA256(nonce + body)), base64-encoded
 *   - All private endpoints are POST with nonce
 *   - Pair names differ (e.g. XLTCZUSD, XXBTZUSD, SOLUSD)
 *   - Quantity precision varies per asset
 *   - Rate limits are stricter (15 calls / decay)
 */
class KrakenExchange {
  constructor(config = {}) {
    this.config = {
      apiKey: config.apiKey || process.env.KRAKEN_API_KEY || '',
      apiSecret: config.apiSecret || process.env.KRAKEN_API_SECRET || '',
      baseURL: config.baseURL || 'https://api.kraken.com',
      timeout: config.timeout || 15000,
    };

    this.isInitialized = false;
    this.disabled = true; // ← Exchange is disabled until explicitly enabled
    this.balances = {};
    this.activeOrders = new Map();
    this.priceCache = new Map();
    this.exchangeInfo = null;

    // Rate limiting — Kraken allows ~15 calls per decay window
    this.lastPriceCheckTime = 0;
    this.priceCheckInterval = config.priceCheckInterval || 30000;
    this.priceCheckSource = 'kraken';

    // Trading configuration (defaults, overridden per-trade by AutoTrader)
    this.tradeConfig = {
      pair: config.pair || 'SOLUSD',
      baseAsset: config.baseAsset || 'SOL',
      quoteAsset: config.quoteAsset || 'USD',
      buyRatio: config.buyRatio || 0.01,
      quantity: config.quantity || 0.1,
      buyPremium: config.buyPremium || 1.0005,
      sellTarget: config.sellTarget || 1.02,
      buyTarget: config.buyTarget || 0.98,
      minNotional: config.minNotional || 10,
    };

    // Kraken uses different pair names internally — map common symbols
    this.pairMap = {
      BTCUSD: 'XXBTZUSD',
      BTCUSDT: 'XBTUSDT',
      ETHUSD: 'XETHZUSD',
      ETHUSDT: 'ETHUSDT',
      LTCUSD: 'XLTCZUSD',
      LTCUSDT: 'LTCUSDT',
      SOLUSD: 'SOLUSD',
      SOLUSDT: 'SOLUSDT',
      XRPUSD: 'XXRPZUSD',
      DOGEUSD: 'XDGEUSD',
    };
  }

  // ─── Lifecycle ──────────────────────────────────────────────

  /**
   * Initialize the Kraken connection
   * @param {boolean} Initial
   * @returns {Promise<boolean>}
   */
  async Initialize(Initial = true) {
    if (this.disabled) {
      console.log('[Kraken] Exchange is DISABLED. Skipping initialization.');
      return false;
    }

    try {
      if (!this.config.apiKey || !this.config.apiSecret) {
        throw new Error('Kraken API credentials not provided');
      }

      if (Initial) {
        await this._testConnection();
      }

      this.isInitialized = true;
      console.log('[Kraken] Exchange initialized successfully');
      return true;
    } catch (error) {
      console.error('[Kraken] Failed to initialize:', error.message);
      return false;
    }
  }

  /**
   * Establish or retrieve a connection
   * @param {boolean} Initial
   * @returns {Promise<Object>}
   */
  async Connection(Initial = false) {
    if (this.disabled) {
      return { isActive: false, disabled: true, message: 'Kraken exchange is disabled' };
    }

    if (!this.isInitialized && !Initial) {
      throw new Error('Kraken Exchange not initialized. Call Initialize() first.');
    }

    if (Initial) {
      const initialized = await this.Initialize(Initial);
      if (!initialized) {
        throw new Error('Failed to initialize Kraken connection');
      }
    }

    return {
      isActive: this.isInitialized,
      pair: this.tradeConfig.pair,
      balances: this.balances,
      activeOrderCount: this.activeOrders.size,
    };
  }

  // ─── Authentication ─────────────────────────────────────────

  /**
   * Generate Kraken API signature
   * Kraken auth: HMAC-SHA512( path + SHA256(nonce + body) ) signed with base64-decoded secret
   * @param {string} path - API endpoint path (e.g. /0/private/Balance)
   * @param {string} body - POST body string
   * @param {number} nonce - Unique incrementing nonce
   * @returns {string} Base64-encoded signature
   * @private
   */
  _generateSignature(path, body, nonce) {
    const sha256Hash = crypto
      .createHash('sha256')
      .update(nonce + body)
      .digest();

    const hmac = crypto
      .createHmac('sha512', Buffer.from(this.config.apiSecret, 'base64'))
      .update(Buffer.concat([Buffer.from(path), sha256Hash]))
      .digest('base64');

    return hmac;
  }

  /**
   * Generate a unique nonce (millisecond timestamp)
   * @returns {string}
   * @private
   */
  _getNonce() {
    return Date.now().toString();
  }

  // ─── HTTP Layer ─────────────────────────────────────────────

  /**
   * Test connection to Kraken API
   * @returns {Promise<boolean>}
   * @private
   */
  async _testConnection() {
    try {
      const data = await this._publicRequest('/0/public/SystemStatus');
      if (data.result && data.result.status === 'online') {
        console.log('[Kraken] System status: online');
        return true;
      }
      throw new Error(`Kraken system status: ${data.result?.status || 'unknown'}`);
    } catch (error) {
      throw new Error(`Kraken connection test failed: ${error.message}`);
    }
  }

  /**
   * Send a PUBLIC request to Kraken (no auth needed)
   * @param {string} endpoint - e.g. /0/public/Ticker
   * @param {Object} params - Query parameters
   * @returns {Promise<Object>}
   * @private
   */
  async _publicRequest(endpoint, params = {}) {
    const maxRetries = 3;
    let lastError;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const url = `${this.config.baseURL}${endpoint}`;
        const response = await axios({
          method: 'GET',
          url,
          params,
          timeout: this.config.timeout,
        });

        if (response.data.error && response.data.error.length > 0) {
          throw new Error(`Kraken API: ${response.data.error.join(', ')}`);
        }

        return response.data;
      } catch (error) {
        lastError = error;
        const message = error.response?.data?.error?.join(', ') || error.message;
        const statusCode = error.response?.status;
        const isTransient =
          !statusCode ||
          statusCode >= 500 ||
          statusCode === 429 ||
          error.code === 'ECONNRESET' ||
          error.code === 'ETIMEDOUT' ||
          error.code === 'ECONNABORTED' ||
          error.code === 'ENOTFOUND' ||
          error.code === 'EAI_AGAIN';

        if (isTransient && attempt < maxRetries) {
          const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
          console.warn(
            `[Kraken] API retry ${attempt}/${maxRetries} for ${endpoint}: ${message} (waiting ${delay}ms)`
          );
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }

        throw new Error(`Kraken API Error: ${message}`);
      }
    }
  }

  /**
   * Send a PRIVATE (authenticated) request to Kraken
   * @param {string} endpoint - e.g. /0/private/Balance
   * @param {Object} params - POST body parameters
   * @returns {Promise<Object>}
   * @private
   */
  async _privateRequest(endpoint, params = {}) {
    const maxRetries = 3;
    let lastError;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const nonce = this._getNonce();
        const body = querystring.stringify({ nonce, ...params });
        const signature = this._generateSignature(endpoint, body, nonce);

        const url = `${this.config.baseURL}${endpoint}`;
        const response = await axios({
          method: 'POST',
          url,
          data: body,
          timeout: this.config.timeout,
          headers: {
            'API-Key': this.config.apiKey,
            'API-Sign': signature,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        });

        if (response.data.error && response.data.error.length > 0) {
          throw new Error(`Kraken API: ${response.data.error.join(', ')}`);
        }

        return response.data;
      } catch (error) {
        lastError = error;
        const message = error.response?.data?.error?.join(', ') || error.message;
        const statusCode = error.response?.status;
        const isTransient =
          !statusCode ||
          statusCode >= 500 ||
          statusCode === 429 ||
          error.code === 'ECONNRESET' ||
          error.code === 'ETIMEDOUT' ||
          error.code === 'ECONNABORTED' ||
          error.code === 'ENOTFOUND' ||
          error.code === 'EAI_AGAIN';

        if (isTransient && attempt < maxRetries) {
          const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
          console.warn(
            `[Kraken] API retry ${attempt}/${maxRetries} for ${endpoint}: ${message} (waiting ${delay}ms)`
          );
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }

        throw new Error(`Kraken API Error: ${message}`);
      }
    }
  }

  // ─── Market Data ────────────────────────────────────────────

  /**
   * Get account balances
   * @returns {Promise<Object>}
   */
  async GetBalances() {
    if (this.disabled) return {};

    try {
      const data = await this._privateRequest('/0/private/Balance');
      const result = data.result || {};

      // Kraken returns balances with Kraken-specific asset names (e.g. ZUSD, XXBT)
      // Normalize to standard names
      const assetMap = {
        ZUSD: 'USD',
        XXBT: 'BTC',
        XETH: 'ETH',
        XLTC: 'LTC',
        XXRP: 'XRP',
        XDGE: 'DOGE',
        SOL: 'SOL',
        USDT: 'USDT',
      };

      this.balances = {};
      for (const [krakenAsset, amount] of Object.entries(result)) {
        const normalName = assetMap[krakenAsset] || krakenAsset;
        const value = parseFloat(amount);
        this.balances[normalName] = {
          free: value, // Kraken doesn't separate free/locked in Balance endpoint
          locked: 0,
          total: value,
        };
      }

      return this.balances;
    } catch (error) {
      console.error('[Kraken] Failed to get balances:', error.message);
      return {};
    }
  }

  /**
   * Get current price for a pair
   * @param {string} pair - Trading pair (e.g. SOLUSD)
   * @returns {Promise<number>}
   */
  async GetPrice(pair = null) {
    if (this.disabled) return 0;

    pair = pair || this.tradeConfig.pair;
    const krakenPair = this.pairMap[pair] || pair;

    try {
      console.log(`[Kraken] GetPrice request for pair: ${pair} (kraken: ${krakenPair})`);
      const data = await this._publicRequest('/0/public/Ticker', { pair: krakenPair });

      // Ticker result is keyed by the Kraken pair name
      const tickerKey = Object.keys(data.result || {})[0];
      if (!tickerKey) throw new Error(`No ticker data for ${krakenPair}`);

      const ticker = data.result[tickerKey];
      const price = parseFloat(ticker.c[0]); // c = last trade closed [price, lot volume]

      console.log(`[Kraken] GetPrice API response: ${price} for ${pair}`);

      // Sanity check
      const cachedPrice = this.priceCache.get(pair);
      if (cachedPrice && Math.abs(price - cachedPrice) / cachedPrice > 0.5) {
        console.warn(
          `[Kraken] ⚠️  PRICE SANITY CHECK FAILED: ${cachedPrice} → ${price}. Using cached price.`
        );
        return cachedPrice;
      }

      this.priceCache.set(pair, price);
      return price;
    } catch (error) {
      console.error(`[Kraken] Failed to get price for ${pair}:`, error.message);
      return this.priceCache.get(pair) || 0;
    }
  }

  /**
   * Price check with rate limiting
   * @param {string} baseSymbol
   * @param {string} quoteSymbol
   * @returns {Promise<Object>}
   */
  async PriceCheck(baseSymbol = null, quoteSymbol = 'USD') {
    if (this.disabled) return { success: false, price: 0, disabled: true };

    baseSymbol = baseSymbol || this.tradeConfig.baseAsset;
    const now = Date.now();
    const timeSinceLastCheck = now - this.lastPriceCheckTime;

    if (timeSinceLastCheck < this.priceCheckInterval) {
      const waitTime = Math.ceil((this.priceCheckInterval - timeSinceLastCheck) / 1000);
      return {
        success: false,
        cached: true,
        price: this.priceCache.get(`${baseSymbol}${quoteSymbol}`),
        message: `Rate limited. Wait ${waitTime}s`,
      };
    }

    try {
      const pair = `${baseSymbol}${quoteSymbol}`;
      const price = await this.GetPrice(pair);

      if (price > 0) {
        this.lastPriceCheckTime = now;
        this.priceCache.set(pair, price);
        console.log(`[Kraken] Price Check: ${baseSymbol}/${quoteSymbol} = $${price}`);
        return { success: true, price, source: 'Kraken' };
      }

      return { success: false, price: 0, message: 'Invalid price' };
    } catch (error) {
      console.error('[Kraken] Price check failed:', error.message);
      return {
        success: false,
        cached: true,
        price: this.priceCache.get(`${baseSymbol}${quoteSymbol}`),
        error: error.message,
      };
    }
  }

  // ─── Exchange Info & Validation ─────────────────────────────

  /**
   * Get exchange info and trading pair details
   * @param {string} pair
   * @returns {Promise<Object>}
   */
  async GetExchangeInfo(pair = null) {
    if (this.disabled) return {};

    pair = pair || this.tradeConfig.pair;
    const krakenPair = this.pairMap[pair] || pair;

    try {
      const data = await this._publicRequest('/0/public/AssetPairs', { pair: krakenPair });
      const pairKey = Object.keys(data.result || {})[0];
      if (!pairKey) throw new Error(`No info for pair ${krakenPair}`);

      const info = data.result[pairKey];
      this.exchangeInfo = {
        baseAsset: info.base,
        quoteAsset: info.quote,
        pairDecimals: info.pair_decimals,     // Price precision
        lotDecimals: info.lot_decimals,       // Volume precision
        lotMultiplier: info.lot_multiplier,
        orderMin: parseFloat(info.ordermin || '0'),
        costMin: parseFloat(info.costmin || '0'),
        tickSize: info.tick_size,
        status: info.status,
      };

      console.log(
        `[Kraken] Exchange info: lotDecimals=${this.exchangeInfo.lotDecimals}, ` +
        `orderMin=${this.exchangeInfo.orderMin}, costMin=${this.exchangeInfo.costMin}`
      );

      return this.exchangeInfo;
    } catch (error) {
      console.error(`[Kraken] Failed to get exchange info for ${pair}:`, error.message);
      return {};
    }
  }

  /**
   * Validate a quantity against Kraken's constraints
   * @param {number} quantity
   * @param {number} price
   * @returns {Object}
   */
  ValidateQuantity(quantity, price) {
    console.log('[Kraken] === ORDER VALIDATION ===');
    if (!this.exchangeInfo) {
      console.log('[Kraken] No exchange info cached, skipping validation');
      return { isValid: true, message: 'No exchange info cached' };
    }

    const qty = parseFloat(quantity);
    const orderPrice = parseFloat(price);

    // Check minimum order size
    if (this.exchangeInfo.orderMin && qty < this.exchangeInfo.orderMin) {
      return {
        isValid: false,
        message: `Quantity ${qty} below minimum order size ${this.exchangeInfo.orderMin}`,
      };
    }

    // Check minimum cost (notional)
    if (this.exchangeInfo.costMin && orderPrice > 0) {
      const orderValue = qty * orderPrice;
      if (orderValue < this.exchangeInfo.costMin) {
        return {
          isValid: false,
          message: `Order value $${orderValue.toFixed(2)} below minimum cost $${this.exchangeInfo.costMin}`,
        };
      }
    }

    // Round quantity to valid lot precision
    const lotDecimals = this.exchangeInfo.lotDecimals || 8;
    const factor = Math.pow(10, lotDecimals);
    const correctedQty = Math.floor(qty * factor) / factor;

    if (correctedQty !== qty) {
      console.log(`[Kraken] Lot precision correction: ${qty} → ${correctedQty}`);
      return {
        isValid: true,
        correctedQuantity: correctedQty,
        message: `Quantity rounded from ${qty} to ${correctedQty} (${lotDecimals} decimals)`,
      };
    }

    console.log(`[Kraken] Validation passed: qty=${qty} at $${orderPrice}`);
    return { isValid: true, message: `Quantity ${qty} at $${orderPrice} is valid` };
  }

  // ─── Trading ────────────────────────────────────────────────

  /**
   * Place a buy order
   * @param {number} quantity
   * @param {number} price
   * @param {string} symbol
   * @returns {Promise<Object>}
   */
  async Buy(quantity, price, symbol = null) {
    return await this._PlaceOrder('buy', quantity, price, symbol);
  }

  /**
   * Place a sell order
   * @param {number} quantity
   * @param {number} price
   * @param {string} symbol
   * @returns {Promise<Object>}
   */
  async Sell(quantity, price, symbol = null) {
    return await this._PlaceOrder('sell', quantity, price, symbol);
  }

  /**
   * Place a buy order at a specific price (limit order)
   * @param {number} targetPrice
   * @param {number} quantity
   * @returns {Promise<Object>}
   */
  async BuyAtPrice(targetPrice, quantity) {
    if (this.disabled) return { success: false, error: 'Exchange disabled' };

    try {
      if (!targetPrice || targetPrice <= 0) throw new Error('Target price must be > 0');
      if (!quantity || quantity <= 0) throw new Error('Quantity must be > 0');

      console.log(`[Kraken] 💰 Placing limit BUY: ${quantity} ${this.tradeConfig.baseAsset} @ $${targetPrice}`);
      return await this._PlaceOrder('buy', quantity, targetPrice, null, 'limit');
    } catch (error) {
      console.error('[Kraken] BuyAtPrice failed:', error.message);
      return { success: false, error: error.message, type: 'BUY_AT_PRICE' };
    }
  }

  /**
   * Place a sell order at a specific price (limit order)
   * @param {number} targetPrice
   * @param {number} quantity
   * @returns {Promise<Object>}
   */
  async SellAtPrice(targetPrice, quantity) {
    if (this.disabled) return { success: false, error: 'Exchange disabled' };

    try {
      if (!targetPrice || targetPrice <= 0) throw new Error('Target price must be > 0');
      if (!quantity || quantity <= 0) throw new Error('Quantity must be > 0');

      console.log(`[Kraken] 💸 Placing limit SELL: ${quantity} ${this.tradeConfig.baseAsset} @ $${targetPrice}`);
      return await this._PlaceOrder('sell', quantity, targetPrice, null, 'limit');
    } catch (error) {
      console.error('[Kraken] SellAtPrice failed:', error.message);
      return { success: false, error: error.message, type: 'SELL_AT_PRICE' };
    }
  }

  /**
   * Internal order placement
   * @param {string} side - 'buy' or 'sell' (Kraken uses lowercase)
   * @param {number} quantity
   * @param {number} price
   * @param {string} symbol
   * @param {string} orderType - 'market' or 'limit'
   * @returns {Promise<Object>}
   * @private
   */
  async _PlaceOrder(side, quantity, price, symbol = null, orderType = 'market') {
    if (this.disabled) return { success: false, error: 'Exchange disabled' };

    try {
      const pair = symbol || this.tradeConfig.pair;
      const krakenPair = this.pairMap[pair] || pair;

      // Fetch/refresh exchange info for this pair
      console.log(`[Kraken] Fetching exchange info for ${pair}...`);
      await this.GetExchangeInfo(pair);

      // Validate quantity
      const validation = this.ValidateQuantity(quantity, price);
      if (!validation.isValid) {
        throw new Error(`Order validation failed: ${validation.message}`);
      }

      const finalQuantity = validation.correctedQuantity || quantity;
      const formattedQuantity = this._formatQuantity(finalQuantity);

      // Build order params
      const orderParams = {
        pair: krakenPair,
        type: side,       // 'buy' or 'sell'
        ordertype: orderType, // 'market' or 'limit'
        volume: formattedQuantity,
      };

      // Only include price for limit orders
      if (orderType === 'limit') {
        orderParams.price = this._formatPrice(price);
      }

      console.log(`[Kraken] Creating ${orderType.toUpperCase()} ${side.toUpperCase()} order:`);
      console.log(`   Pair: ${krakenPair}`);
      console.log(`   Side: ${side}`);
      console.log(`   Type: ${orderType}`);
      console.log(`   Volume: ${formattedQuantity} (original: ${quantity})`);
      if (orderType === 'limit') console.log(`   Price: ${orderParams.price}`);
      console.log('[Kraken] Sending order to API...');

      const data = await this._privateRequest('/0/private/AddOrder', orderParams);
      const result = data.result;

      console.log(`[Kraken] Order placed successfully: ${JSON.stringify(result)}`);

      // Kraken returns: { descr: { order: "..." }, txid: ["OXXXX-XXXXX-XXXXXX"] }
      const txid = result.txid?.[0] || 'unknown';
      const order = {
        orderId: txid,
        side: side.toUpperCase(),
        quantity: parseFloat(formattedQuantity),
        price: price, // Will be filled price for market orders (check via QueryOrders)
        status: 'open',
        description: result.descr?.order || '',
        createdAt: new Date(),
      };

      this.activeOrders.set(txid, order);

      console.log(
        `[Kraken] ${side.toUpperCase()} Order ${txid}: ${formattedQuantity} ${this.tradeConfig.baseAsset} ` +
        `@ ~$${parseFloat(price).toFixed(2)} (${orderType})`
      );

      return { success: true, order };
    } catch (error) {
      console.error(`[Kraken] Failed to place ${side} order:`, error.message);
      return { success: false, error: error.message };
    }
  }

  // ─── Order Management ───────────────────────────────────────

  /**
   * Cancel an order
   * @param {string} txid - Kraken transaction ID
   * @returns {Promise<boolean>}
   */
  async CancelOrder(txid) {
    if (this.disabled) return false;

    try {
      await this._privateRequest('/0/private/CancelOrder', { txid });
      this.activeOrders.delete(txid);
      console.log(`[Kraken] Order ${txid} cancelled`);
      return true;
    } catch (error) {
      console.error('[Kraken] Failed to cancel order:', error.message);
      return false;
    }
  }

  /**
   * Get active (open) orders
   * @returns {Promise<Array>}
   */
  async GetActiveOrders() {
    if (this.disabled) return [];

    try {
      const data = await this._privateRequest('/0/private/OpenOrders');
      const openOrders = data.result?.open || {};

      return Object.entries(openOrders).map(([txid, order]) => ({
        orderId: txid,
        side: order.descr?.type?.toUpperCase() || 'UNKNOWN',
        quantity: parseFloat(order.vol),
        price: parseFloat(order.descr?.price || 0),
        status: order.status,
      }));
    } catch (error) {
      console.error('[Kraken] Failed to get active orders:', error.message);
      return [];
    }
  }

  // ─── Market Data (Candles & Ticker) ─────────────────────────

  /**
   * Get 24h ticker data for a pair
   * @param {string} pair
   * @returns {Promise<Object|null>}
   */
  async GetTicker(pair = null) {
    if (this.disabled) return null;

    try {
      const symbol = pair || this.tradeConfig.pair;
      const krakenPair = this.pairMap[symbol] || symbol;
      const data = await this._publicRequest('/0/public/Ticker', { pair: krakenPair });
      const key = Object.keys(data.result || {})[0];

      if (!key) return null;

      const t = data.result[key];
      // Map Kraken ticker fields to Binance-like structure for compatibility
      return {
        symbol: symbol,
        lastPrice: t.c?.[0],          // Last trade close price
        highPrice: t.h?.[1],           // High (today)
        lowPrice: t.l?.[1],            // Low (today)
        volume: t.v?.[1],              // Volume (today)
        openPrice: t.o,                // Open price (today)
        priceChangePercent: t.o ? (((parseFloat(t.c[0]) - parseFloat(t.o)) / parseFloat(t.o)) * 100).toFixed(2) : '0',
      };
    } catch (error) {
      console.warn(`[Kraken] Failed to get ticker for ${pair}:`, error.message);
      return null;
    }
  }

  /**
   * Get candlestick (OHLC) data
   * @param {string} pair
   * @param {string} interval - Candle interval in minutes: 1, 5, 15, 30, 60, 240, 1440, 10080, 21600
   * @param {number} limit - Number of candles (Kraken returns up to 720)
   * @returns {Promise<Array|null>}
   */
  async GetCandles(pair = null, interval = '60', limit = 24) {
    if (this.disabled) return null;

    try {
      const symbol = pair || this.tradeConfig.pair;
      const krakenPair = this.pairMap[symbol] || symbol;

      // Kraken interval must be numeric (minutes): 1, 5, 15, 30, 60, 240, 1440, 10080, 21600
      // Convert common strings like '1h' to minutes
      const intervalMap = { '1m': 1, '5m': 5, '15m': 15, '30m': 30, '1h': 60, '4h': 240, '1d': 1440 };
      const krakenInterval = intervalMap[interval] || parseInt(interval) || 60;

      const data = await this._publicRequest('/0/public/OHLC', {
        pair: krakenPair,
        interval: krakenInterval,
      });

      const key = Object.keys(data.result || {}).find((k) => k !== 'last');
      if (!key) return null;

      const candles = data.result[key].slice(-limit);

      return candles.map((kline) => ({
        time: kline[0] * 1000,     // Convert to ms
        open: kline[1],
        high: kline[2],
        low: kline[3],
        close: kline[4],
        volume: kline[6],          // Kraken: [time, open, high, low, close, vwap, volume, count]
        closeTime: null,           // Kraken doesn't provide close time per candle
        quoteAssetVolume: null,
      }));
    } catch (error) {
      console.warn(`[Kraken] Failed to get candles for ${pair}:`, error.message);
      return null;
    }
  }

  // ─── Helpers ────────────────────────────────────────────────

  /**
   * Format quantity to valid precision
   * @param {number} quantity
   * @returns {string}
   * @private
   */
  _formatQuantity(quantity) {
    const decimals = this.exchangeInfo?.lotDecimals || 6;
    return parseFloat(quantity).toFixed(decimals);
  }

  /**
   * Format price to valid precision
   * @param {number} price
   * @returns {string}
   * @private
   */
  _formatPrice(price) {
    const decimals = this.exchangeInfo?.pairDecimals || 2;
    return parseFloat(price).toFixed(decimals);
  }

  /**
   * Close connection and cleanup
   * @returns {boolean}
   */
  Close() {
    this.activeOrders.clear();
    this.priceCache.clear();
    this.isInitialized = false;
    console.log('[Kraken] Exchange connection closed');
    return true;
  }
}

module.exports = KrakenExchange;
