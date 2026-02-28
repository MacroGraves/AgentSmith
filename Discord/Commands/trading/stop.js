const { EmbedBuilder, MessageFlags } = require('discord.js');

module.exports = {
  name: 'stop',
  description: 'Pause the trading loop',
  type: 1,
  cooldown: 5000,

  run: async (client, interaction) => {
    const discord = process.discord;
    if (!discord) return interaction.reply({ content: 'Discord module not available.', flags: [MessageFlags.Ephemeral] });

    discord.tradingPaused  = true;
    process.tradingPaused  = true;
    discord._updatePresence();

    const embed = new EmbedBuilder()
      .setColor(0xFF0000)
      .setTitle('🔴 Trading Paused')
      .setDescription('The trading loop has been paused. Use `/start` to resume.')
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });
  },
};
