const { EmbedBuilder, MessageFlags } = require('discord.js');
const Settings = require('../../../Core/Settings.js');

module.exports = {
  name: 'start',
  description: 'Resume the trading loop',
  type: 1,
  cooldown: 5000,

  run: async (client, interaction) => {
    const discord = process.discord;
    if (!discord) return interaction.reply({ content: 'Discord module not available.', flags: [MessageFlags.Ephemeral] });

    discord.tradingPaused  = false;
    process.tradingPaused  = false;
    await Settings.Set('Trading.Paused', false);
    discord._updatePresence();

    const embed = new EmbedBuilder()
      .setColor(0x00FF00)
      .setTitle('🟢 Trading Resumed')
      .setDescription('The trading loop is now active.')
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });
  },
};
