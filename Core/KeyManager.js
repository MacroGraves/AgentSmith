const Settings = require('./Settings.js');

/**
 * Key Manager — Loads API keys from the MySQL Secrets table via Settings singleton.
 * 
 * Keys are stored in the Secrets table (service + key composite PK) and loaded
 * into memory by Settings.Load(). This module simply reads from the loaded cache.
 * 
 * Requires: Settings.Load() must have been called before using any method here.
 */
class KeyManager {
  /**
   * Load OpenAI API key from Secrets table
   * @returns {string|null} OpenAI API key
   */
  static LoadOpenAIKey() {
    try {
      const apiKey = Settings.Get('OpenAI.API_Key');
      if (!apiKey || apiKey.length === 0) {
        throw new Error('OpenAI API key not found in Secrets table. Set it via /exchange or insert into Secrets.');
      }

      if (apiKey.includes('YOUR_') || apiKey === 'sk-...') {
        throw new Error('OpenAI API key is a placeholder. Set the real key in the Secrets table.');
      }

      console.log('[KeyManager] OpenAI key loaded from database');
      return apiKey;
    } catch (error) {
      console.error(`[KeyManager] Failed to load OpenAI key: ${error.message}`);
      return null;
    }
  }

  /**
   * Load Binance API credentials from Secrets table
   * @returns {Object|null} { apiKey, apiSecret }
   */
  static LoadBinanceKey() {
    try {
      const apiKey = Settings.Get('Binance.API_Key');
      const apiSecret = Settings.Get('Binance.API_Secret');

      if (!apiKey || !apiSecret) {
        throw new Error(
          'Binance API credentials not found in Secrets table.\n' +
          '   Set them via Discord /exchange command or insert directly:\n' +
          '   INSERT INTO Secrets (`key`, value, service) VALUES ("API_Key", \'"your-key"\', "Binance");\n' +
          '   INSERT INTO Secrets (`key`, value, service) VALUES ("API_Secret", \'"your-secret"\', "Binance");'
        );
      }

      if (apiKey.includes('YOUR_') || apiSecret.includes('YOUR_')) {
        throw new Error('Binance API credentials are placeholders. Set real keys in the Secrets table.');
      }

      console.log('[KeyManager] Binance keys loaded from database');
      return { apiKey, apiSecret };
    } catch (error) {
      console.error(`[KeyManager] Failed to load Binance keys: ${error.message}`);
      return null;
    }
  }

  /**
   * Validate Binance key configuration
   * @param {Object} keyConfig - { apiKey, apiSecret }
   * @returns {boolean}
   */
  static ValidateBinanceKey(keyConfig) {
    if (!keyConfig || !keyConfig.apiKey || !keyConfig.apiSecret) {
      console.error('[KeyManager] Incomplete Binance key configuration');
      return false;
    }

    if (keyConfig.apiKey.includes('YOUR_') || keyConfig.apiSecret.includes('YOUR_')) {
      console.error('[KeyManager] Binance keys contain placeholder values');
      return false;
    }

    return true;
  }
}

module.exports = KeyManager;
