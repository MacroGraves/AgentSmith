const fs = require('fs');
const path = require('path');

/**
 * Exchange Discovery Module
 * Dynamically discovers available CEX/DEX exchanges from the filesystem
 */
class ExchangeDiscovery {
  /**
   * Discover all available exchanges
   * @returns {Array} Array of exchange names and their types
   */
  static DiscoverExchanges() {
    try {
      const exchangesDir = path.join(__dirname, '..', 'Exchanges');
      const result = {
        cex: [],
        dex: [],
        all: [],
      };

      // Check if Exchanges directory exists
      if (!fs.existsSync(exchangesDir)) {
        console.warn('[ExchangeDiscovery] Exchanges directory not found');
        return result;
      }

      // Check for CEX directory
      const cexDir = path.join(exchangesDir, 'CEX');
      if (fs.existsSync(cexDir)) {
        const cexFiles = fs.readdirSync(cexDir).filter((f) => f.endsWith('.js'));
        cexFiles.forEach((file) => {
          const name = path.basename(file, '.js');
          result.cex.push(name);
          result.all.push({ name, type: 'CEX' });
        });
      }

      // Check for DEX directory
      const dexDir = path.join(exchangesDir, 'DEX');
      if (fs.existsSync(dexDir)) {
        const dexFiles = fs.readdirSync(dexDir).filter((f) => f.endsWith('.js'));
        dexFiles.forEach((file) => {
          const name = path.basename(file, '.js');
          result.dex.push(name);
          result.all.push({ name, type: 'DEX' });
        });
      }

      return result;
    } catch (error) {
      console.error('[ExchangeDiscovery] Error discovering exchanges:', error.message);
      return { cex: [], dex: [], all: [] };
    }
  }

  /**
   * Get exchange info as a formatted string for prompts
   * @returns {string} Formatted exchange list
   */
  static GetExchangesForPrompt() {
    const exchanges = this.DiscoverExchanges();

    if (exchanges.all.length === 0) {
      return 'No exchanges configured';
    }

    let result = 'Available Exchanges:\n';

    if (exchanges.cex.length > 0) {
      result += 'CEX (Centralized):\n';
      exchanges.cex.forEach((ex) => {
        result += `  - ${ex}\n`;
      });
    }

    if (exchanges.dex.length > 0) {
      result += 'DEX (Decentralized):\n';
      exchanges.dex.forEach((ex) => {
        result += `  - ${ex}\n`;
      });
    }

    return result.trim();
  }

  /**
   * Get formatted exchange selection for prompt
   * @returns {string} Trading pair options with available exchanges
   */
  static GetExchangeSelectionPrompt() {
    const exchanges = this.DiscoverExchanges();

    if (exchanges.all.length === 0) {
      return 'ERROR: No exchanges available';
    }

    if (exchanges.all.length === 1) {
      const ex = exchanges.all[0];
      return `Only ${ex.name} (${ex.type}) is available for trading.`;
    }

    let prompt = 'Select an exchange for this trade:\n';
    exchanges.all.forEach((ex, idx) => {
      prompt += `${idx + 1}. ${ex.name} (${ex.type})\n`;
    });

    return prompt;
  }
}

module.exports = ExchangeDiscovery;
