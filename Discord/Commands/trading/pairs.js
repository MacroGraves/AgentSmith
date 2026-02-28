const { EmbedBuilder } = require('discord.js');

module.exports = {
  name: 'pairs',
  description: 'Show active trading pairs and their scores',
  type: 1,
  cooldown: 10000,

  run: async (client, interaction) => {
    await interaction.deferReply();

    const pairDB = process.pairSelector?.pairDB;
    if (!pairDB) return interaction.editReply('PairDB not available.');

    try {
      const pairs = await pairDB.GetAllPairs();
      if (!pairs || pairs.length === 0) return interaction.editReply('No pairs tracked.');

      const lines = pairs
        .sort((a, b) => (parseFloat(b.score) || 0) - (parseFloat(a.score) || 0))
        .slice(0, 15)
        .map(p => {
          const score   = parseFloat(p.score || 0).toFixed(1);
          const trend   = p.trend || 'N/A';
          const enabled = p.enabled ? '✅' : '❌';
          return `${enabled} **${p.id}** — Score: ${score} | Trend: ${trend}`;
        });

      const embed = new EmbedBuilder()
        .setTitle('Trading Pairs')
        .setColor(0x9B59B6)
        .setDescription(lines.join('\n'))
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    } catch (err) {
      return interaction.editReply(`Error: ${err.message}`);
    }
  },
};
