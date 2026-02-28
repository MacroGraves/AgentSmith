const { EmbedBuilder } = require('discord.js');
const Settings = require('../../../Core/Settings.js');

module.exports = {
  name: 'sell',
  description: 'Sell a specific pair or all open positions',
  type: 1,
  cooldown: 5000,
  options: [
    {
      name: 'pair',
      description: 'Trading pair (e.g. LTCUSDT) or "all"',
      type: 3, // STRING
      required: true,
    },
  ],

  run: async (client, interaction) => {
    await interaction.deferReply();

    const pair    = interaction.options.getString('pair');
    const binance = process.binance;
    if (!binance?.isInitialized) return interaction.editReply('Binance not connected.');

    // Pause trading to prevent GPT from immediately rebuying after the sell
    const wasPaused = process.tradingPaused;
    process.tradingPaused = true;
    if (process.discord) process.discord.tradingPaused = true;
    await Settings.Set('Trading.Paused', true);

    // ── Sell all ──────────────────────────────────────────────────
    if (pair.toLowerCase() === 'all') {
      const Settings = require('../../../Core/Settings.js');
      const minSellValue = Settings.Get('Trading.Rules.MinimumTradeValue', 5);
      const balances = await binance.GetBalances();
      const stables  = ['USDT', 'USDC', 'BUSD', 'USD'];
      const results  = [];

      for (const [asset, info] of Object.entries(balances)) {
        if (stables.includes(asset)) continue;
        const free = parseFloat(info.free || 0);
        if (free <= 0) continue;

        const symbol = `${asset}USDT`;
        try {
          const price = await binance.GetPrice(symbol);
          if (!price || price <= 0) continue;
          const value = free * price;
          if (value < minSellValue) {
            results.push(`${asset}: ⏩ Skipped — $${value.toFixed(2)} below $${minSellValue} minimum`);
            continue;
          }
          const result = await binance.Sell(free, null, symbol);
          results.push(`${asset}: ${result?.success ? '✅ Sold' : `❌ ${result?.error || 'Failed'}`}`);
        } catch (err) {
          results.push(`${asset}: ❌ ${err.message}`);
        }
      }

      const footer = wasPaused ? '' : '\n\n⏸️ Trading paused to prevent rebuy. Use `/start` to resume.';
      return interaction.editReply((results.length > 0 ? results.join('\n') : 'No positions to sell.') + footer);
    }

    // ── Sell specific pair ───────────────────────────────────────
    const symbol    = pair.toUpperCase().replace('/', '');
    const baseAsset = symbol.replace(/USDT$|BTC$|ETH$|BNB$|BUSD$/i, '');
    const balances  = await binance.GetBalances();
    const free      = parseFloat(balances[baseAsset]?.free || 0);

    if (free <= 0) return interaction.editReply(`No ${baseAsset} balance to sell.`);

    try {
      const result = await binance.Sell(free, null, symbol);
      const footer = wasPaused ? '' : '\n⏸️ Trading paused to prevent rebuy. Use `/start` to resume.';
      if (result?.success) {
        return interaction.editReply(`✅ Sold ${free.toFixed(6)} ${baseAsset} — Order: ${result.order?.orderId || 'N/A'}${footer}`);
      }
      return interaction.editReply(`❌ Sell failed: ${result?.error || 'Unknown error'}${footer}`);
    } catch (err) {
      return interaction.editReply(`❌ ${err.message}`);
    }
  },
};
