const { EmbedBuilder } = require('discord.js');

module.exports = {
  name: 'balance',
  description: 'Detailed balance breakdown across all assets',
  type: 1,
  cooldown: 10000,

  run: async (client, interaction) => {
    await interaction.deferReply();

    const binance = process.binance;
    if (!binance?.isInitialized) return interaction.editReply('Binance not connected.');

    const balances = await binance.GetBalances();
    const lines = [];

    for (const [asset, info] of Object.entries(balances)) {
      const free   = parseFloat(info.free   || 0);
      const locked = parseFloat(info.locked || 0);
      if (free <= 0 && locked <= 0) continue;

      let usdValue = '';
      if (asset !== 'USDT' && asset !== 'USDC') {
        try {
          const price = await binance.GetPrice(`${asset}USDT`);
          usdValue = ` (~$${(free * price).toFixed(2)})`;
        } catch (_) {}
      }
      lines.push(
        `**${asset}**: ${free.toFixed(6)}${usdValue}${locked > 0 ? ` (${locked.toFixed(6)} locked)` : ''}`
      );
    }

    const embed = new EmbedBuilder()
      .setTitle('Balance Breakdown')
      .setColor(0x3498DB)
      .setDescription(lines.length > 0 ? lines.join('\n') : 'No balances found.')
      .setTimestamp();

    return interaction.editReply({ embeds: [embed] });
  },
};
