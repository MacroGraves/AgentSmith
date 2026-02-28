/**
 * DYOR — Do Your Own Research: Coin Validator
 *
 * Before the bot trades a coin, this module validates it by:
 *   1. Checking CoinGecko listings (free, no key needed)
 *   2. Searching DuckDuckGo for scam/rug-pull warnings (via proxy)
 *   3. Checking Binance listing status
 *   4. Scoring the coin on legitimacy
 *
 * Proxy system (from Proxies.txt):
 *   - Each line is a proxy: protocol://host:port or host:port
 *   - One proxy consumed per external web request
 *   - Line is REMOVED from file after use (burn-after-reading)
 *   - When file is empty or missing, falls back to direct connection
 *
 * Results are cached (24h) to minimize proxy consumption.
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const Settings = require('./Settings.js');
const Utils = require('./Utils.js');

// ─── Constants ──────────────────────────────────────────────────────────────

const COINGECKO_API = 'https://api.coingecko.com/api/v3';
const DDG_SEARCH_URL = 'https://html.duckduckgo.com/html/';
const PROXIES_FILE = path.join(__dirname, '..', 'Proxies.txt');

// Known scam/rug-pull keywords in search results
const SCAM_KEYWORDS = [
  'scam', 'rug pull', 'rugpull', 'ponzi', 'fraud', 'exit scam',
  'honey pot', 'honeypot', 'fake token', 'pump and dump',
  'warning', 'hack', 'exploit', 'drained', 'stolen',
];

// Trusted coins that don't need DYOR (top market cap)
const TRUSTED_COINS = new Set([
  'BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'ADA', 'DOGE', 'AVAX',
  'DOT', 'LINK', 'MATIC', 'UNI', 'LTC', 'ATOM', 'NEAR', 'FTM',
  'ALGO', 'XLM', 'VET', 'MANA', 'SAND', 'AXS', 'AAVE', 'ICP',
  'FIL', 'THETA', 'EGLD', 'HBAR', 'XTZ', 'EOS', 'FLOW', 'CHZ',
  'APE', 'LDO', 'CRV', 'AR', 'GRT', 'MKR', 'SNX', 'COMP',
  'IMX', 'INJ', 'OP', 'ARB', 'APT', 'SUI', 'SEI', 'TIA', 'WLD', 'JUP',
]);

// ─── Proxy Manager ──────────────────────────────────────────────────────────

/**
 * Read the first proxy line from Proxies.txt, then remove it from the file.
 * Returns null if file is empty or missing.
 * @returns {string|null} Proxy string e.g. "http://1.2.3.4:8080" or null
 */
function _consumeProxy() {
  try {
    if (!fs.existsSync(PROXIES_FILE)) return null;

    const content = fs.readFileSync(PROXIES_FILE, 'utf8');
    const lines = content.split(/\r?\n/).filter(l => l.trim().length > 0);

    if (lines.length === 0) return null;

    const proxy = lines[0].trim();
    const remaining = lines.slice(1).join('\n');
    fs.writeFileSync(PROXIES_FILE, remaining.length > 0 ? remaining + '\n' : '', 'utf8');

    console.log(`[DYOR] Consumed proxy: ${proxy} (${lines.length - 1} remaining)`);
    return proxy;
  } catch (err) {
    console.warn(`[DYOR] Failed to read Proxies.txt: ${err.message}`);
    return null;
  }
}

/**
 * Parse a proxy string into {host, port, auth, protocol}
 * Supports:
 *   - http://user:pass@host:port
 *   - host:port:user:pass  (InfiniteProxies format)
 *   - host:port
 */
function _parseProxy(proxyStr) {
  try {
    // Format: host:port:user:pass (colon-separated, 4 parts)
    const parts = proxyStr.split(':');
    if (parts.length >= 4 && !proxyStr.includes('://')) {
      const host = parts[0];
      const port = parseInt(parts[1]) || 8080;
      const user = parts.slice(2).join(':'); // Rejoin in case password contains colons
      // Actually, for user:pass format: host:port:user:pass
      // But password might contain colons (session tokens), so:
      const user2 = parts[2];
      const pass = parts.slice(3).join(':');
      return { host, port, protocol: 'http', auth: `${user2}:${pass}` };
    }

    // URL format: http://user:pass@host:port
    if (proxyStr.includes('://')) {
      const url = new URL(proxyStr);
      const auth = url.username ? `${url.username}:${url.password}` : null;
      return { host: url.hostname, port: parseInt(url.port) || 8080, protocol: url.protocol.replace(':', ''), auth };
    }

    // Simple: host:port
    const [host, port] = proxyStr.split(':');
    return { host, port: parseInt(port) || 8080, protocol: 'http', auth: null };
  } catch {
    return null;
  }
}

// ─── HTTP Helpers (proxy-aware) ─────────────────────────────────────────────

function _fetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const timeout = options.timeout || 10000;
    const proxy = options.proxy ? _parseProxy(options.proxy) : null;
    const parsedUrl = new URL(url);

    const proxyAuth = proxy && proxy.auth
      ? { 'Proxy-Authorization': 'Basic ' + Buffer.from(proxy.auth).toString('base64') }
      : {};

    const reqOptions = {
      hostname: proxy ? proxy.host : parsedUrl.hostname,
      port: proxy ? proxy.port : (parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80)),
      path: proxy ? url : parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/json,*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        ...(proxy ? { Host: parsedUrl.host } : {}),
        ...proxyAuth,
        ...(options.headers || {}),
      },
      timeout,
    };

    // Use http for proxy tunneling (proxy receives full URL), https for direct
    const lib = proxy ? http : (url.startsWith('https') ? https : http);
    const req = lib.get(reqOptions, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return _fetch(res.headers.location, options).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function _postForm(url, formData, options = {}) {
  return new Promise((resolve, reject) => {
    const timeout = options.timeout || 10000;
    const postData = new URLSearchParams(formData).toString();
    const proxy = options.proxy ? _parseProxy(options.proxy) : null;
    const parsedUrl = new URL(url);

    const proxyAuth = proxy && proxy.auth
      ? { 'Proxy-Authorization': 'Basic ' + Buffer.from(proxy.auth).toString('base64') }
      : {};

    const reqOptions = {
      hostname: proxy ? proxy.host : parsedUrl.hostname,
      port: proxy ? proxy.port : (parsedUrl.port || 443),
      path: proxy ? url : parsedUrl.pathname,
      method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
        ...(proxy ? { Host: parsedUrl.host } : {}),
        ...proxyAuth,
        ...(options.headers || {}),
      },
      timeout,
    };

    const lib = proxy ? http : (url.startsWith('https') ? https : http);
    const req = lib.request(reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(postData);
    req.end();
  });
}

// ─── DYOR Class ─────────────────────────────────────────────────────────────

class DYOR {
  constructor() {
    this.cache = new Map(); // symbol → { score, reasons, timestamp }
    this.cacheTTL = 24 * 60 * 60 * 1000; // 24 hours
  }

  /**
   * Validate a coin before trading.
   * Returns a score (0-100) and reasons.
   *
   * @param {string} symbol - Base asset symbol (e.g. 'LTC', 'SOL')
   * @param {Object} [binance] - Optional Binance instance for exchange checks
   * @returns {Promise<{ score: number, approved: boolean, reasons: string[], cached: boolean }>}
   */
  async Validate(symbol, binance = null) {
    const upper = symbol.toUpperCase();

    // Check cache first
    const cached = this.cache.get(upper);
    if (cached && (Date.now() - cached.timestamp) < this.cacheTTL) {
      return { ...cached, cached: true };
    }

    // Trusted coins get automatic approval
    if (TRUSTED_COINS.has(upper)) {
      const result = { score: 95, approved: true, reasons: ['Top market-cap coin (trusted)'], timestamp: Date.now() };
      this.cache.set(upper, result);
      return { ...result, cached: false };
    }

    console.log(`[DYOR] Researching ${upper}...`);
    const reasons = [];
    let score = 50; // Start neutral

    // ── 1. CoinGecko Listing Check ──
    try {
      const cgResult = await this._checkCoinGecko(upper);
      if (cgResult.listed) {
        score += 20;
        reasons.push(`Listed on CoinGecko (market cap rank: #${cgResult.rank || 'N/A'})`);
        if (cgResult.rank && cgResult.rank <= 100) score += 10;
        if (cgResult.rank && cgResult.rank <= 500) score += 5;
      } else {
        score -= 20;
        reasons.push('NOT found on CoinGecko');
      }
    } catch (err) {
      reasons.push(`CoinGecko check failed: ${err.message}`);
    }

    // ── 2. Binance Exchange Info ──
    if (binance) {
      try {
        const pair = `${upper}USDT`;
        const exchInfo = await binance.GetExchangeInfo(pair);
        if (exchInfo) {
          score += 15;
          reasons.push(`Active on Binance (${pair})`);
        } else {
          score -= 10;
          reasons.push(`Not actively traded on Binance (${pair})`);
        }
      } catch (err) {
        reasons.push(`Binance check failed: ${err.message}`);
      }
    }

    // ── 3. DuckDuckGo Scam Search ──
    try {
      const scamResult = await this._searchForScams(upper);
      if (scamResult.scamHits > 0) {
        const penalty = Math.min(scamResult.scamHits * 10, 40);
        score -= penalty;
        reasons.push(`Found ${scamResult.scamHits} scam/warning references in web search`);
        if (scamResult.topHits.length > 0) {
          reasons.push(`Flagged terms: ${scamResult.topHits.join(', ')}`);
        }
      } else {
        score += 10;
        reasons.push('No scam warnings found in web search');
      }
    } catch (err) {
      reasons.push(`Web search failed: ${err.message}`);
    }

    // Clamp score
    score = Math.max(0, Math.min(100, score));

    const minScore = Settings.Get('Trading.DYOR.MinScore', 40);
    const approved = score >= minScore;

    const result = { score, approved, reasons, timestamp: Date.now() };
    this.cache.set(upper, result);

    const status = approved ? '✅ APPROVED' : '❌ REJECTED';
    console.log(`[DYOR] ${upper}: ${status} (score: ${score}/100, min: ${minScore})`);
    for (const r of reasons) console.log(`  → ${r}`);

    return { ...result, cached: false };
  }

  /**
   * Check CoinGecko for coin listing
   * @private
   */
  async _checkCoinGecko(symbol) {
    try {
      // Consume a proxy for this request (burn-after-reading)
      const proxy = _consumeProxy();
      if (proxy) console.log(`[DYOR] CoinGecko request via proxy`);

      const url = `${COINGECKO_API}/search?query=${encodeURIComponent(symbol)}`;
      const response = await _fetch(url, { proxy });

      if (response.status !== 200) {
        throw new Error(`CoinGecko returned ${response.status}`);
      }

      const data = JSON.parse(response.body);
      const coins = data.coins || [];
      const match = coins.find(c => c.symbol?.toUpperCase() === symbol.toUpperCase());

      if (match) {
        return { listed: true, name: match.name, rank: match.market_cap_rank || null };
      }
      return { listed: false };
    } catch (error) {
      throw new Error(`CoinGecko: ${error.message}`);
    }
  }

  /**
   * Search DuckDuckGo for scam/rug-pull warnings about a coin.
   * Uses HTML endpoint (no API key, proxy-friendly).
   * Pattern inspired by ImageSearch.cs (VQD token + form POST).
   * @private
   */
  async _searchForScams(symbol) {
    try {
      // Consume a proxy for this request (burn-after-reading)
      const proxy = _consumeProxy();
      if (proxy) console.log(`[DYOR] DuckDuckGo request via proxy`);

      const query = `${symbol} cryptocurrency scam OR "rug pull" OR warning OR fraud`;
      const response = await _postForm(DDG_SEARCH_URL, { q: query }, { proxy });

      if (response.status !== 200) {
        throw new Error(`DuckDuckGo returned ${response.status}`);
      }

      const body = response.body.toLowerCase();
      const scamHits = [];

      for (const keyword of SCAM_KEYWORDS) {
        // Count occurrences in result snippets
        const regex = new RegExp(keyword.replace(/\s+/g, '\\s+'), 'gi');
        const matches = body.match(regex);
        if (matches && matches.length > 0) {
          scamHits.push(keyword);
        }
      }

      return {
        scamHits: scamHits.length,
        topHits: scamHits.slice(0, 5),
      };
    } catch (error) {
      throw new Error(`DuckDuckGo: ${error.message}`);
    }
  }

  /**
   * Clear cache for a specific coin or all coins
   * @param {string} [symbol] - If omitted, clears all
   */
  clearCache(symbol) {
    if (symbol) {
      this.cache.delete(symbol.toUpperCase());
    } else {
      this.cache.clear();
    }
  }

  /**
   * Get cached validation results
   * @returns {Object[]}
   */
  getCacheStatus() {
    const results = [];
    for (const [sym, data] of this.cache.entries()) {
      results.push({
        symbol: sym,
        score: data.score,
        approved: data.approved,
        reasons: data.reasons,
        age: Math.round((Date.now() - data.timestamp) / 60000) + ' min',
      });
    }
    return results;
  }
}

module.exports = new DYOR();
