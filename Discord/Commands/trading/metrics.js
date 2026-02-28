/**
 * /metrics — View trading performance metrics.
 *
 * Shows win rate, P/L, drawdown, Sharpe ratio, per-pair breakdown.
 */

const { EmbedBuilder, MessageFlags } = require('discord.js');
const Metrics = require('../../../Core/Metrics.js');

module.exports = {
  name: 'metrics',
  description: 'View trading performance metrics (win rate, P/L, Sharpe, drawdown)',
  type: 1,
  cooldown: 5000,
  options: [],

  run: async (client, interaction) => {
    const summary = Metrics.getSummary();

    const embed = new EmbedBuilder()
      .setTitle('Trading Performance')
      .setColor(parseFloat(summary.netProfitUSDT) >= 0 ? 0x2ECC71 : 0xE74C3C)
      .addFields(
        { name: 'Uptime', value: summary.uptime, inline: true },
        { name: 'Total Trades', value: String(summary.totalTrades), inline: true },
        { name: 'Win Rate', value: summary.winRate, inline: true },
        { name: 'Buys / Sells', value: `${summary.buys} / ${summary.sells}`, inline: true },
        { name: 'Wins / Losses', value: `${summary.wins} / ${summary.losses}`, inline: true },
        { name: 'Sharpe Ratio', value: summary.sharpeRatio, inline: true },
        { name: 'Net P/L', value: `$${summary.netProfitUSDT}`, inline: true },
        { name: 'Gross Profit', value: `$${summary.totalProfitUSDT}`, inline: true },
        { name: 'Gross Loss', value: `-$${summary.totalLossUSDT}`, inline: true },
        { name: 'Max Drawdown', value: summary.maxDrawdown, inline: true },
        { name: 'Avg Hold Time', value: `${summary.avgHoldTimeMin} min`, inline: true },
        { name: 'Best Streak', value: `${summary.maxConsecutiveWins}W / ${summary.maxConsecutiveLosses}L`, inline: true },
      )
      .setTimestamp();

    // Add per-pair breakdown if we have data
    const pairs = summary.pairBreakdown;
    if (pairs.length > 0) {
      const pairText = pairs.slice(0, 12).map(p =>
        `**${p.pair}**: ${p.wins}W/${p.losses}L (${p.winRate}) $${p.netPL} | avg ${p.avgHoldMin}m`
      ).join('\n');
      embed.addFields({ name: 'Per-Pair Breakdown', value: pairText || 'No pair data', inline: false });
    }

    return interaction.reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
  },
};
