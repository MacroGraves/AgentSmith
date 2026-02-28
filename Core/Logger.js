const fs = require('fs');
const path = require('path');

/**
 * Simple logging module that writes to both console and a file
 */
class Logger {
  constructor(filePath = 'output.log') {
    this.filePath = filePath;
    // Use 'a' mode so multiple instances don't truncate (file writing is now handled by index.js console.log override)
    this.stream = fs.createWriteStream(filePath, { flags: 'a' });
    
    // Log startup - this will go through console.log override which handles both console and file output
    this.log(`=== Log Session Started: ${new Date().toISOString()} ===`);
  }

  // Check if message should be logged based on log type and Settings
  _shouldLog(message, logType = 'default') {
    // Get log config from process
    const logConfig = typeof process !== 'undefined' && process.logConfig ? process.logConfig : {};
    
    // If custom log config is set, use it
    if (Object.keys(logConfig).length > 0) {
      // logAll overrides everything
      if (logConfig.all) return true;
      
      // Check if message type is enabled
      if (!this._matchesLogType(message, logType, logConfig)) {
        return false;
      }
    }
    
    // Also respect Values_Only_Logging mode
    const valuesOnly = typeof process !== 'undefined' && process.valuesOnlyLogging;
    if (!valuesOnly && Object.keys(logConfig).length === 0) {
      return true; // Log everything if not in values-only mode
    }
    
    // ULTRA-STRICT (values-only mode): ONLY log actual trade execution messages
    if (valuesOnly) {
      const tradePattern = /^(===\s+Log|\[LOOP\]|\[AUTOTRADER\] (Loop|Executing action|Final action|Autonomous|Action execution failed)|Buy order placed|Sell order placed|Order ID|Duration:|Starting|Completed|Ready for)/i;
      return tradePattern.test(message);
    }
    
    return true;
  }

  // Match message against log type filter
  _matchesLogType(message, logType, logConfig) {
    // Check enabled log types
    if (logConfig.gpt && message.includes('[GPT]')) return true;
    if (logConfig.pairs && (message.includes('[PAIR]') || message.includes('Selected pair'))) return true;
    if (logConfig.numbers && (message.includes('[METRICS]') || message.includes('volatility') || message.includes('score'))) return true;
    if (logConfig.logic && (message.includes('[LOGIC]') || message.includes('SelectBestPair'))) return true;
    if (logConfig.trading && (message.includes('[AUTOTRADER]') || message.includes('[TRADE]'))) return true;
    if (logConfig.loop && message.includes('[LOOP]')) return true;
    
    // If no specific filters match, allow it (to not suppress untagged messages)
    return true;
  }

  log(...args) {
    // Last argument can be {logType: 'type'} for filtering
    let logType = 'default';
    let logArgs = args;
    
    if (args.length > 0 && typeof args[args.length - 1] === 'object' && args[args.length - 1].logType) {
      logType = args[args.length - 1].logType;
      logArgs = args.slice(0, -1);
    }
    
    const message = logArgs.map(arg => 
      typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
    ).join(' ');
    
    // Check if we should log this message
    if (this._shouldLog(message, logType)) {
      // Use console.log (which is overridden in index.js) - this handles both file and console output
      console.log(...logArgs);
    }
  }

  error(...args) {
    // Last argument can be {logType: 'type'} for filtering
    let logType = 'default';
    let logArgs = args;
    
    if (args.length > 0 && typeof args[args.length - 1] === 'object' && args[args.length - 1].logType) {
      logType = args[args.length - 1].logType;
      logArgs = args.slice(0, -1);
    }
    
    const message = logArgs.map(arg => 
      typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
    ).join(' ');
    
    if (this._shouldLog(message, logType)) {
      console.error(...logArgs);
    }
  }

  warn(...args) {
    // Last argument can be {logType: 'type'} for filtering
    let logType = 'default';
    let logArgs = args;
    
    if (args.length > 0 && typeof args[args.length - 1] === 'object' && args[args.length - 1].logType) {
      logType = args[args.length - 1].logType;
      logArgs = args.slice(0, -1);
    }
    
    const message = logArgs.map(arg => 
      typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
    ).join(' ');
    
    if (this._shouldLog(message, logType)) {
      console.warn(...logArgs);
    }
  }

  close() {
    this.stream.end();
  }
}

module.exports = Logger;
