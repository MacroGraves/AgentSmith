const { EmbedBuilder } = require('discord.js');

module.exports = {
  name: 'trades',
  description: 'Show recent trade history',
  type: 1,
  cooldown: 10000,
  options: [
    {
      name: 'count',
      description: 'Number of trades to show (default 10)',
      type: 4, // INTEGER
      required: false,
    },
  ],

  run: async (client, interaction) => {
    await interaction.deferReply();

    const count   = interaction.options.getInteger('count') || 10;
    const tradeDB = process.autoTrader?.tradeDB;
    if (!tradeDB) return interaction.editReply('TradeDB not available.');

    try {
      const trades = await tradeDB.GetRecentTrades(count);
      if (!trades || trades.length === 0) return interaction.editReply('No recent trades.');

      const lines = trades.map(t => {
        const pl   = t.profit_loss_percent ? `${parseFloat(t.profit_loss_percent).toFixed(2)}%` : 'N/A';
        const side = t.action === 'BUY' ? '🟢 BUY' : '🔴 SELL';
        return `${side} ${t.pair} | ${parseFloat(t.quantity).toFixed(4)} @ $${parseFloat(t.price).toFixed(4)} | P/L: ${pl}`;
      });

      const embed = new EmbedBuilder()
        .setTitle(`Last ${trades.length} Trades`)
        .setColor(0xF39C12)
        .setDescription('```\n' + lines.join('\n') + '\n```')
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    } catch (err) {
      return interaction.editReply(`Error: ${err.message}`);
    }
  },
};
