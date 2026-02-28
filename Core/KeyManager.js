const fs = require('fs');
const path = require('path');

/**
 * Key Manager - Load and validate API keys from .key files
 * Files are plain text format (not JSON)
 */
class KeyManager {
  /**
   * Strip markdown code fence syntax from file content
   * @private
   */
  static _cleanContent(content) {
    return content
      .replace(/^```[a-z]*\n?/gm, '')
      .replace(/\n?```$/gm, '')
      .trim();
  }

  /**
   * Load OpenAI API key from .Keys/OpenAI.key
   * @returns {string} OpenAI API key
   */
  static LoadOpenAIKey() {
    try {
      const keyPath = path.join(__dirname, '..', '.Keys', 'OpenAI.key');

      if (!fs.existsSync(keyPath)) {
        console.warn(`OpenAI.key not found at ${keyPath}`);
        return null;
      }

      let content = fs.readFileSync(keyPath, 'utf-8');
      content = this._cleanContent(content);

      if (!content || content.length === 0) {
        throw new Error('OpenAI.key file is empty');
      }

      if (content.includes('YOUR_') || content === 'sk-...') {
        throw new Error('OpenAI.key contains placeholder value. Add actual OpenAI API key to .Keys/OpenAI.key');
      }

      console.log('OpenAI.key loaded successfully');
      return content;
    } catch (error) {
      console.error(`Failed to load OpenAI key: ${error.message}`);
      return null;
    }
  }

  /**
   * Load Binance API credentials from .Keys/Binance/
   * @returns {Object} { apiKey, apiSecret }
   */
  static LoadBinanceKey() {
    try {
      const apiKeyPath = path.join(__dirname, '..', '.Keys', 'Binance', 'API.key');
      const apiSecretPath = path.join(__dirname, '..', '.Keys', 'Binance', 'API.secret');

      if (!fs.existsSync(apiKeyPath) || !fs.existsSync(apiSecretPath)) {
        throw new Error(
          `Binance API files not found. Create:\n   .Keys/Binance/API.key\n   .Keys/Binance/API.secret`
        );
      }

      let apiKey = fs.readFileSync(apiKeyPath, 'utf-8');
      let apiSecret = fs.readFileSync(apiSecretPath, 'utf-8');

      apiKey = this._cleanContent(apiKey);
      apiSecret = this._cleanContent(apiSecret);

      if (!apiKey || !apiSecret) {
        throw new Error('Binance API key or secret is empty');
      }

      if (apiKey.includes('YOUR_') || apiSecret.includes('YOUR_')) {
        throw new Error('Binance keys contain placeholder values. Add actual API credentials.');
      }

      console.log('Binance API keys loaded successfully');
      return { apiKey, apiSecret };
    } catch (error) {
      console.error(`Failed to load Binance keys: ${error.message}`);
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
      console.error(`Incomplete Binance key configuration`);
      return false;
    }

    if (keyConfig.apiKey.includes('YOUR_') || keyConfig.apiSecret.includes('YOUR_')) {
      console.error(`Binance keys contain placeholder values`);
      return false;
    }

    return true;
  }
}

module.exports = KeyManager;
