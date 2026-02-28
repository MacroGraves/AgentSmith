const axios = require('axios');
const crypto = require('crypto');

/**
 * Binance Exchange Wrapper Class
 * Supports LTC/USDT trading with buy/sell automation
 * Reusable across multiple projects
 */
class BinanceExchange {
  constructor(config = {}) {
    this.config = {
      apiKey: config.apiKey || process.env.BINANCE_API_KEY,
      apiSecret: config.apiSecret || process.env.BINANCE_API_SECRET,
      baseURL: config.baseURL || 'https://api.binance.com/api',
      testnet: config.testnet || false,
      timeout: config.timeout || 10000,
    };

    this.client = null;
    this.isInitialized = false;
    this.balances = {};
    this.activeOrders = new Map();
    this.priceCache = new Map();
    this.websocket = null;
    this.exchangeInfo = null; // Will store exchange info including LOT_SIZE filter

    // Price check rate limiting (30 seconds minimum between checks)
    this.lastPriceCheckTime = 0;
    this.priceCheckInterval = config.priceCheckInterval || 30000; // 30 seconds in ms
    this.priceCheckSource = config.priceCheckSource || 'cryptocompare'; // 'cryptocompare' or 'binance'

    // Trading configuration
    this.tradeConfig = {
      pair: config.pair || 'LTCUSDT',
      baseAsset: config.baseAsset || 'LTC',
      quoteAsset: config.quoteAsset || 'USDT',
      buyRatio: config.buyRatio || 0.01,
      quantity: config.quantity || 0.1,
      buyPremium: config.buyPremium || 1.0005,
      sellTarget: config.sellTarget || 1.02,
      buyTarget: config.buyTarget || 0.98,
      minNotional: config.minNotional || 10,
    };
  }

  /**
   * Initialize the Binance connection
   * @param {boolean} Initial
   * @returns {Promise<boolean>}
   */
  async Initialize(Initial = true) {
    try {
      // Validate credentials
      if (!this.config.apiKey || !this.config.apiSecret) {
        throw new Error('Binance API credentials not provided');
      }

      // Set testnet URL if enabled
      if (this.config.testnet) {
        this.config.baseURL = 'https://testnet.binance.vision/api';
      }

      // Test connection
      if (Initial) {
        await this._testConnection();
      }

      this.isInitialized = true;
      console.log('Binance Exchange initialized successfully');
      return true;
    } catch (error) {
      console.error('Failed to initialize Binance Exchange:', error.message);
      return false;
    }
  }

  /**
   * Establish or retrieve a connection
   * @param {boolean} Initial
   * @returns {Promise<Object>}
   */
  async Connection(Initial = false) {
    if (!this.isInitialized && !Initial) {
      throw new Error('Binance Exchange not initialized. Call Initialize() first.');
    }

    if (Initial) {
      const initialized = await this.Initialize(Initial);
      if (!initialized) {
        throw new Error('Failed to initialize Binance connection');
      }
    }

    return {
      isActive: this.isInitialized,
      pair: this.tradeConfig.pair,
      balances: this.balances,
      activeOrderCount: this.activeOrders.size,
    };
  }

  /**
   * Test connection to Binance API
   * @returns {Promise<boolean>}
   * @private
   */
  async _testConnection() {
    try {
      const response = await this._request('GET', '/v3/ping');
      return response.status === 200;
    } catch (error) {
      throw new Error(`Binance connection test failed: ${error.message}`);
    }
  }

  /**
   * Send HTTP request to Binance API
   * @param {string} method
   * @param {string} endpoint
   * @param {Object} params
   * @param {boolean} signed
   * @returns {Promise<Object>}
   * @private
   */
  async _request(method, endpoint, params = {}, signed = false) {
    const maxRetries = 3;
    let lastError;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const url = `${this.config.baseURL}${endpoint}`;
        const config = {
          method,
          url,
          timeout: this.config.timeout,
          headers: {
            'X-MBX-APIKEY': this.config.apiKey,
          },
        };

        if (signed) {
          const timestamp = Date.now();
          const queryString = new URLSearchParams({
            ...params,
            timestamp,
          }).toString();

          const signature = crypto
            .createHmac('sha256', this.config.apiSecret)
            .update(queryString)
            .digest('hex');

          config.params = { ...params, timestamp, signature };
        } else {
          config.params = params;
        }

        const response = await axios(config);
        return response.data;
      } catch (error) {
        lastError = error;
        const message = error.response?.data?.msg || error.message;
        const statusCode = error.response?.status;
        const isTransient = !statusCode || statusCode >= 500 || statusCode === 429 ||
          error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED' ||
          error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN';

        if (isTransient && attempt < maxRetries) {
          const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000); // 1s, 2s, 4s (max 10s)
          console.warn(`[Binance] API retry ${attempt}/${maxRetries} for ${endpoint}: ${message} (waiting ${delay}ms)`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }

        throw new Error(`Binance API Error: ${message}`);
      }
    }
  }

  /**
   * Get account balances
   * @returns {Promise<Object>}
   */
  async GetBalances() {
    try {
      const response = await this._request('GET', '/v3/account', {}, true);
      
      response.balances.forEach((balance) => {
        this.balances[balance.asset] = {
          free: parseFloat(balance.free),
          locked: parseFloat(balance.locked),
          total: parseFloat(balance.free) + parseFloat(balance.locked),
        };
      });

      //console.log(`Balances updated:`, this.balances);
      return this.balances;
    } catch (error) {
      console.error('Failed to get balances:', error.message);
      return {};
    }
  }

  /**
   * Get current price for a pair
   * @param {string} pair
   * @returns {Promise<number>}
   */
  async GetPrice(pair = null) {
    pair = pair || this.tradeConfig.pair;

    try {
      console.log(`[Binance] GetPrice request for pair: ${pair}`);
      const response = await this._request('GET', '/v3/ticker/price', {
        symbol: pair,
      });

      const price = parseFloat(response.price);
      console.log(`[Binance] GetPrice API response: ${price} for ${pair}`);
      
      // Sanity check: if price changed >50% from cache, it's likely wrong
      const cachedPrice = this.priceCache.get(pair);
      if (cachedPrice && Math.abs(price - cachedPrice) / cachedPrice > 0.50) {
        console.warn(`[Binance] ⚠️  PRICE SANITY CHECK FAILED: Price jumped from $${cachedPrice.toFixed(2)} to $${price.toFixed(2)} (${((price - cachedPrice) / cachedPrice * 100).toFixed(2)}% change). Using cached price instead.`);
        return cachedPrice;
      }
      
      this.priceCache.set(pair, price);
      return price;
    } catch (error) {
      console.error(`Failed to get price for ${pair}:`, error.message);
      const cached = this.priceCache.get(pair) || 0;
      console.log(`[Binance] Using cached price: ${cached}`);
      return cached;
    }
  }

  /**
   * Price check with rate limiting (max once every 30 seconds)
   * Queries from CryptoCompare API
   * @param {string} baseSymbol - Base asset (e.g., 'LTC')
   * @param {string} quoteSymbol - Quote asset (e.g., 'USD')
   * @returns {Promise<Object>}
   */
  async PriceCheck(baseSymbol = null, quoteSymbol = 'USD') {
    baseSymbol = baseSymbol || this.tradeConfig.baseAsset;

    // Check if rate limit is still active
    const now = Date.now();
    const timeSinceLastCheck = now - this.lastPriceCheckTime;

    if (timeSinceLastCheck < this.priceCheckInterval) {
      const waitTime = Math.ceil((this.priceCheckInterval - timeSinceLastCheck) / 1000);
      console.log(
        `Price check rate limit active. Next check available in ${waitTime}s`
      );
      return {
        success: false,
        cached: true,
        price: this.priceCache.get(`${baseSymbol}${quoteSymbol}`),
        message: `Rate limited. Wait ${waitTime}s`,
      };
    }

    try {
      let result = { success: false, price: 0 };

      // Choose price source
      switch (this.priceCheckSource) {
        case 'cryptocompare':
          result = await this._checkPriceCryptoCompare(baseSymbol, quoteSymbol);
          break;
        case 'binance':
          result = await this._checkPriceBinance(baseSymbol, quoteSymbol);
          break;
        default:
          result = await this._checkPriceCryptoCompare(baseSymbol, quoteSymbol);
      }

      // Update last check time only on successful query
      if (result.success) {
        this.lastPriceCheckTime = now;
        const cacheKey = `${baseSymbol}${quoteSymbol}`;
        this.priceCache.set(cacheKey, result.price);

        console.log(
          `Price Check: ${baseSymbol}/${quoteSymbol} = $${result.price}`
        );

        return result;
      }

      return result;
    } catch (error) {
      console.error(`Price check failed:`, error.message);
      return {
        success: false,
        cached: true,
        price: this.priceCache.get(`${baseSymbol}${quoteSymbol}`),
        error: error.message,
      };
    }
  }

  /**
   * Check price from CryptoCompare API
   * @param {string} baseSymbol
   * @param {string} quoteSymbol
   * @returns {Promise<Object>}
   * @private
   */
  async _checkPriceCryptoCompare(baseSymbol, quoteSymbol) {
    try {
      const response = await axios.get(
        `https://min-api.cryptocompare.com/data/price?fsym=${baseSymbol}&tsyms=${quoteSymbol}`
      );

      const price = response.data[quoteSymbol];

      if (!price || isNaN(price)) {
        throw new Error(`Invalid price data for ${baseSymbol}/${quoteSymbol}`);
      }

      return {
        success: true,
        price: parseFloat(price),
        source: 'CryptoCompare',
      };
    } catch (error) {
      throw new Error(`CryptoCompare API Error: ${error.message}`);
    }
  }

  /**
   * Check price from Binance API
   * @param {string} baseSymbol
   * @param {string} quoteSymbol
   * @returns {Promise<Object>}
   * @private
   */
  async _checkPriceBinance(baseSymbol, quoteSymbol) {
    try {
      const pair = `${baseSymbol}${quoteSymbol}`;
      const response = await this._request('GET', '/v3/ticker/price', {
        symbol: pair,
      });

      const price = parseFloat(response.price);

      return {
        success: true,
        price,
        source: 'Binance',
      };
    } catch (error) {
      throw new Error(`Binance API Error: ${error.message}`);
    }
  }

  /**
   * Get exchange info and filters for a pair
   * @param {string} pair
   * @returns {Promise<Object>}
   */
  async GetExchangeInfo(pair = null) {
    pair = pair || this.tradeConfig.pair;

    try {
      const response = await this._request('GET', '/v3/exchangeInfo', {
        symbol: pair,
      });

      const symbol = response.symbols[0];
      const info = {
        baseAsset: symbol.baseAsset,
        quoteAsset: symbol.quoteAsset,
        filters: symbol.filters,
        status: symbol.status,
      };

      // Cache the exchange info
      this.exchangeInfo = info;
      
      console.log(`[Binance] Exchange info cached with ${info.filters?.length || 0} filters`);
      if (info.filters) {
        const lotSizeFilter = info.filters.find(f => f.filterType === 'LOT_SIZE');
        if (lotSizeFilter) {
          console.log(`[Binance] LOT_SIZE filter found: minQty=${lotSizeFilter.minQty}, maxQty=${lotSizeFilter.maxQty}`);
        }
      }
      
      return info;
    } catch (error) {
      console.error(`Failed to get exchange info for ${pair}:`, error.message);
      return {};
    }
  }

  /**
   * Validate a quantity against LOT_SIZE and NOTIONAL filters
   * @param {number} quantity
   * @param {number} price - Current price (needed for NOTIONAL validation)
   * @returns {Object} - { isValid: boolean, message: string }
   */
  ValidateQuantity(quantity, price) {
    console.log('[Binance] === NOTIONAL VALIDATION ENABLED ===');
    if (!this.exchangeInfo || !this.exchangeInfo.filters) {
      console.log('[Binance] No exchange info cached, skipping quantity validation');
      return { isValid: true, message: 'No exchange info cached, skipping validation' };
    }

    const qty = parseFloat(quantity);
    const orderPrice = parseFloat(price);

    // Check LOT_SIZE filter
    const lotSizeFilter = this.exchangeInfo.filters.find(f => f.filterType === 'LOT_SIZE');
    if (lotSizeFilter) {
      const minQty = parseFloat(lotSizeFilter.minQty);
      const maxQty = parseFloat(lotSizeFilter.maxQty);
      const stepSize = parseFloat(lotSizeFilter.stepSize);

      console.log(`[Binance] LOT_SIZE check: qty=${qty}, minQty=${minQty}, maxQty=${maxQty}, stepSize=${stepSize}`);

      if (qty < minQty) {
        return {
          isValid: false,
          message: `Quantity ${qty} is below LOT_SIZE minimum ${minQty}`
        };
      }

      if (qty > maxQty) {
        return {
          isValid: false,
          message: `Quantity ${qty} exceeds LOT_SIZE maximum ${maxQty}`
        };
      }

      // Check if quantity aligns with stepSize
      // Auto-correct to nearest valid quantity (round down)
      const remainder = Math.round((qty / stepSize) % 1 * 100000000) / 100000000;
      if (remainder !== 0) {
        const validQty = Math.floor(qty / stepSize) * stepSize;
        // Round to avoid floating point noise (e.g. 4.300000000000001)
        const roundedValidQty = parseFloat(validQty.toFixed(8));
        console.log(`[Binance] LOT_SIZE stepSize correction: ${qty} → ${roundedValidQty} (stepSize: ${stepSize})`);
        // Update the quantity and recheck
        return {
          isValid: true,
          correctedQuantity: roundedValidQty,
          message: `Quantity auto-corrected from ${qty} to ${roundedValidQty} for stepSize ${stepSize}`
        };
      }
    }

    // Check NOTIONAL filter (minimum order value)
    const notionalFilter = this.exchangeInfo.filters.find(f => f.filterType === 'NOTIONAL');
    if (notionalFilter && orderPrice > 0) {
      const minNotional = parseFloat(notionalFilter.minNotional);
      const maxNotional = parseFloat(notionalFilter.maxNotional);
      const orderValue = qty * orderPrice;

      console.log(`[Binance] NOTIONAL check: orderValue=${orderValue}, minNotional=${minNotional}, maxNotional=${maxNotional}`);

      if (orderValue < minNotional) {
        return {
          isValid: false,
          message: `Order value ${orderValue} is below NOTIONAL minimum ${minNotional}. Need at least ${(minNotional / orderPrice).toFixed(8)} qty at $${orderPrice}`
        };
      }

      if (orderValue > maxNotional) {
        return {
          isValid: false,
          message: `Order value ${orderValue} exceeds NOTIONAL maximum ${maxNotional}`
        };
      }
    }

    console.log(`[Binance] All filters passed for qty=${qty} at price=$${orderPrice}`);
    return {
      isValid: true,
      message: `Quantity ${qty} at $${orderPrice} is valid`
    };
  }

  /**
   * Place a buy order
   * @param {number} quantity
   * @param {number} price
   * @returns {Promise<Object>}
   */
  async Buy(quantity, price, symbol = null) {
    return await this._PlaceOrder('BUY', quantity, price, symbol);
  }

  /**
   * Place a sell order
   * @param {number} quantity
   * @param {number} price
   * @returns {Promise<Object>}
   */
  async Sell(quantity, price, symbol = null) {
    return await this._PlaceOrder('SELL', quantity, price, symbol);
  }

  /**
   * Buy LTC at a specific price (places limit order immediately)
   * @param {number} targetPrice - The price at which to buy
   * @param {number} quantity - Amount of base asset to buy
   * @returns {Promise<Object>}
   */
  async BuyAtPrice(targetPrice, quantity) {
    try {
      if (!targetPrice || targetPrice <= 0) {
        throw new Error('Target price must be greater than 0');
      }

      if (!quantity || quantity <= 0) {
        throw new Error('Quantity must be greater than 0');
      }

      console.log(
        `💰 Placing BUY order: ${quantity} ${this.tradeConfig.baseAsset} @ $${targetPrice}`
      );

      const order = await this._PlaceOrder('BUY', quantity, targetPrice);

      return {
        ...order,
        type: 'BUY_AT_PRICE',
      };
    } catch (error) {
      console.error(`BuyAtPrice failed:`, error.message);
      return {
        success: false,
        error: error.message,
        type: 'BUY_AT_PRICE',
      };
    }
  }

  /**
   * Sell LTC at a specific price (places limit order immediately)
   * @param {number} targetPrice - The price at which to sell
   * @param {number} quantity - Amount of base asset to sell
   * @returns {Promise<Object>}
   */
  async SellAtPrice(targetPrice, quantity) {
    try {
      if (!targetPrice || targetPrice <= 0) {
        throw new Error('Target price must be greater than 0');
      }

      if (!quantity || quantity <= 0) {
        throw new Error('Quantity must be greater than 0');
      }

      console.log(
        `💸 Placing SELL order: ${quantity} ${this.tradeConfig.baseAsset} @ $${targetPrice}`
      );

      const order = await this._PlaceOrder('SELL', quantity, targetPrice);

      return {
        ...order,
        type: 'SELL_AT_PRICE',
      };
    } catch (error) {
      console.error(`SellAtPrice failed:`, error.message);
      return {
        success: false,
        error: error.message,
        type: 'SELL_AT_PRICE',
      };
    }
  }

  /**
   * Buy when price drops to target (monitor and execute)
   * @param {number} targetPrice - Price threshold to trigger buy
   * @param {number} quantity - Amount to buy
   * @param {number} maxWaitTime - Max wait time in seconds (default: 300s = 5min)
   * @returns {Promise<Object>}
   */
  async BuyWhenPriceFalls(targetPrice, quantity, maxWaitTime = 300) {
    try {
      console.log(
        `Waiting for ${this.tradeConfig.pair} to fall to $${targetPrice}...`
      );

      const startTime = Date.now();
      const checkInterval = setInterval(async () => {
        const currentPrice = await this.GetPrice();
        const elapsed = (Date.now() - startTime) / 1000;

        if (elapsed > maxWaitTime) {
          clearInterval(checkInterval);
          console.error(`BuyWhenPriceFalls timeout after ${maxWaitTime}s`);
          return {
            success: false,
            message: 'Timeout: Price did not fall to target',
            targetPrice,
            lastPrice: currentPrice,
          };
        }

        if (currentPrice <= targetPrice) {
          clearInterval(checkInterval);
          console.log(`Price reached $${currentPrice}! Executing Buy...`);
          return await this.BuyAtPrice(targetPrice, quantity);
        }

        console.log(
          `Current price: $${currentPrice} (waiting for $${targetPrice}...)`
        );
      }, 5000); // Check every 5 seconds

      return { success: true, message: 'Monitoring price...' };
    } catch (error) {
      console.error(`BuyWhenPriceFalls failed:`, error.message);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Sell when price rises to target (monitor and execute)
   * @param {number} targetPrice - Price threshold to trigger sell
   * @param {number} quantity - Amount to sell
   * @param {number} maxWaitTime - Max wait time in seconds (default: 300s = 5min)
   * @returns {Promise<Object>}
   */
  async SellWhenPriceRises(targetPrice, quantity, maxWaitTime = 300) {
    try {
      console.log(
        `Waiting for ${this.tradeConfig.pair} to rise to $${targetPrice}...`
      );

      const startTime = Date.now();
      const checkInterval = setInterval(async () => {
        const currentPrice = await this.GetPrice();
        const elapsed = (Date.now() - startTime) / 1000;

        if (elapsed > maxWaitTime) {
          clearInterval(checkInterval);
          console.error(`SellWhenPriceRises timeout after ${maxWaitTime}s`);
          return {
            success: false,
            message: 'Timeout: Price did not rise to target',
            targetPrice,
            lastPrice: currentPrice,
          };
        }

        if (currentPrice >= targetPrice) {
          clearInterval(checkInterval);
          console.log(`Price reached $${currentPrice}! Executing Sell...`);
          return await this.SellAtPrice(targetPrice, quantity);
        }

        console.log(
          `Current price: $${currentPrice} (waiting for $${targetPrice}...)`
        );
      }, 5000); // Check every 5 seconds

      return { success: true, message: 'Monitoring price...' };
    } catch (error) {
      console.error(`SellWhenPriceRises failed:`, error.message);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Place an order (internal)
   * @param {string} side
   * @param {number} quantity
   * @param {number} price
   * @returns {Promise<Object>}
   * @private
   */
  async _PlaceOrder(side, quantity, price, symbol = null) {
    try {
      // Use provided symbol or default to configured pair
      const orderSymbol = symbol || this.tradeConfig.pair;
      
      // Ensure exchange info is cached (fetch if not available)
      // Always refresh exchange info for the specific pair we're about to trade
      console.log(`[Binance] Fetching/updating exchange info for ${orderSymbol}...`);
      await this.GetExchangeInfo(orderSymbol);
      
      // Validate quantity against LOT_SIZE and NOTIONAL filters (pass price for NOTIONAL check)
      const validation = this.ValidateQuantity(quantity, price);
      if (!validation.isValid) {
        throw new Error(`Order quantity validation failed: ${validation.message}`);
      }
      
      // Use corrected quantity if validation auto-fixed it (stepSize alignment)
      const finalQuantity = validation.correctedQuantity || quantity;

      // Use MARKET order (price-free) to bypass PERCENT_PRICE_BY_SIDE filter
      // Market orders execute immediately at best available price
      const formattedQuantity = this._formatQuantity(finalQuantity);
      const orderParams = {
        symbol: orderSymbol,
        side,
        type: 'MARKET',
        quantity: formattedQuantity,
      };
      
      console.log(`[Binance] Creating MARKET ${side} order:`);
      console.log(`   Symbol: ${orderParams.symbol}`);
      console.log(`   Side: ${orderParams.side}`);
      console.log(`   Type: ${orderParams.type}`);
      console.log(`   Quantity: ${formattedQuantity} (original: ${quantity})`);
      console.log(`[Binance] Sending order to API...`);

      const response = await this._request('POST', '/v3/order', orderParams, true);

      console.log(`[Binance] Order placed successfully: ${JSON.stringify(response)}`);

      const order = {
        orderId: response.orderId,
        side,
        quantity: parseFloat(response.origQty),
        price: parseFloat(response.cummulativeQuoteQty) / parseFloat(response.origQty), // Calculate actual fill price
        status: response.status,
        createdAt: new Date(response.transactTime),
      };

      this.activeOrders.set(response.orderId, order);

      console.log(
        `${side} Order #${response.orderId}: ${parseFloat(response.origQty)} ${this.tradeConfig.baseAsset} @ $${order.price.toFixed(2)} ${this.tradeConfig.quoteAsset} (MARKET)`
      );

      return { success: true, order };
    } catch (error) {
      console.error(`Failed to place ${side} order:`, error.message);
      if (error.response?.data) {
        console.error(`[Binance API Error Details]:`, JSON.stringify(error.response.data));
      }
      return { success: false, error: error.message };
    }
  }

  /**
   * Cancel an order
   * @param {number} orderId
   * @returns {Promise<boolean>}
   */
  async CancelOrder(orderId) {
    try {
      await this._request(
        'DELETE',
        '/v3/order',
        {
          symbol: this.tradeConfig.pair,
          orderId,
        },
        true
      );

      this.activeOrders.delete(orderId);
      console.log(`Order #${orderId} cancelled`);
      return true;
    } catch (error) {
      console.error(`Failed to cancel order:`, error.message);
      return false;
    }
  }

  /**
   * Get active orders
   * @returns {Promise<Array>}
   */
  async GetActiveOrders() {
    try {
      const response = await this._request(
        'GET',
        '/v3/openOrders',
        {
          symbol: this.tradeConfig.pair,
        },
        true
      );

      const orders = response.map((order) => ({
        orderId: order.orderId,
        side: order.side,
        quantity: parseFloat(order.origQty),
        price: parseFloat(order.price),
        status: order.status,
      }));

      return orders;
    } catch (error) {
      console.error('Failed to get active orders:', error.message);
      return [];
    }
  }

  /**
   * Start automated trading (simplified strategy)
   * @param {Function} strategyCallback - Custom strategy function
   * @returns {void}
   */
  async StartTrading(strategyCallback = null) {
    if (!this.isInitialized) {
      throw new Error('Binance Exchange not initialized');
    }

    console.log(`Starting automated trading for ${this.tradeConfig.pair}...`);

    // Get initial balances
    await this.GetBalances();

    // Use callback or default strategy
    const strategy = strategyCallback || this._defaultStrategy.bind(this);

    // Run strategy every 5 seconds
    setInterval(async () => {
      try {
        const currentPrice = await this.GetPrice();
        await strategy(currentPrice);
      } catch (error) {
        console.error('Strategy execution error:', error.message);
      }
    }, 5000);
  }

  /**
   * Default trading strategy (can be overridden)
   * @param {number} currentPrice
   * @returns {Promise<void>}
   * @private
   */
  async _defaultStrategy(currentPrice) {
    try {
      // Perform price check before trading (rate limited to once every 30s)
      const priceCheckResult = await this.PriceCheck(
        this.tradeConfig.baseAsset,
        this.tradeConfig.quoteAsset
      );

      // If rate limited, skip trading for this cycle
      if (priceCheckResult.cached && !priceCheckResult.success) {
        return; // Skip trading if rate limited
      }

      // Use price from check result if available, otherwise use current price
      const tradePrice = priceCheckResult.success ? priceCheckResult.price : currentPrice;

      const ltcBalance = this.balances[this.tradeConfig.baseAsset]?.free || 0;
      const usdtBalance = this.balances[this.tradeConfig.quoteAsset]?.free || 0;

      console.log(
        `${this.tradeConfig.pair} @ $${tradePrice} | ${this.tradeConfig.baseAsset}: ${ltcBalance} | ${this.tradeConfig.quoteAsset}: ${usdtBalance}`
      );

      // Simple strategy: Buy if price is low, sell if price is high
      const buyPrice = tradePrice * this.tradeConfig.buyTarget;
      const sellPrice = tradePrice * this.tradeConfig.sellTarget;

      if (usdtBalance >= this.tradeConfig.minNotional) {
        const buyQuantity = this._formatQuantity(this.tradeConfig.quantity);
        console.log(`💰 Buying ${buyQuantity} ${this.tradeConfig.baseAsset} at $${buyPrice}`);
        await this.Buy(buyQuantity, buyPrice);
      }

      if (ltcBalance >= this.tradeConfig.quantity) {
        const sellQuantity = this._formatQuantity(ltcBalance * 0.5); // Sell 50% of balance
        console.log(`💸 Selling ${sellQuantity} ${this.tradeConfig.baseAsset} at $${sellPrice}`);
        await this.Sell(sellQuantity, sellPrice);
      }

      // Refresh balances
      await this.GetBalances();
    } catch (error) {
      console.error('Strategy error:', error.message);
    }
  }

  /**
   * Format quantity to valid precision
   * @param {number} quantity
   * @returns {string}
   * @private
   */
  _formatQuantity(quantity) {
    return parseFloat(quantity).toFixed(6);
  }

  /**
   * Get 24h ticker data for a pair
   * @param {string} pair - Trading pair (e.g., LTCUSDT)
   * @returns {Promise<Object|null>}
   */
  async GetTicker(pair = null) {
    try {
      const symbol = pair || this.tradeConfig.pair;
      const data = await this._request('GET', '/v3/ticker/24hr', { symbol });
      return data || null;
    } catch (error) {
      console.warn(`[Binance] Failed to get ticker for ${pair}:`, error.message);
      return null;
    }
  }

  /**
   * Get candlestick (OHLC) data for a pair
   * @param {string} pair - Trading pair
   * @param {string} interval - Candle interval (1m, 5m, 1h, 1d, etc.)
   * @param {number} limit - Number of candles (default 100, max 1000)
   * @returns {Promise<Array|null>}
   */
  async GetCandles(pair = null, interval = '1h', limit = 24) {
    try {
      const symbol = pair || this.tradeConfig.pair;
      const data = await this._request('GET', '/v3/klines', {
        symbol,
        interval,
        limit: Math.min(limit, 1000),
      });
      
      // Format klines response to readable objects
      return (data || []).map(kline => ({
        time: kline[0],
        open: kline[1],
        high: kline[2],
        low: kline[3],
        close: kline[4],
        volume: kline[5],
        closeTime: kline[6],
        quoteAssetVolume: kline[7],
      }));
    } catch (error) {
      console.warn(`[Binance] Failed to get candles for ${pair}:`, error.message);
      return null;
    }
  }

  /**
   * Format price to valid precision
   * @param {number} price
   * @returns {string}
   * @private
   */
  _formatPrice(price) {
    return parseFloat(price).toFixed(2);
  }

  /**
   * Close connection and cleanup
   * @returns {boolean}
   */
  Close() {
    this.activeOrders.clear();
    this.priceCache.clear();
    if (this.websocket) {
      this.websocket.close();
    }
    this.isInitialized = false;
    console.log('Binance Exchange connection closed');
    return true;
  }
}

module.exports = BinanceExchange;
