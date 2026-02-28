const { EmbedBuilder } = require('discord.js');

module.exports = {
  name: 'status',
  description: 'Trading status overview — balance, trades, % invested, crank',
  type: 1,
  cooldown: 10000,

  run: async (client, interaction) => {
    await interaction.deferReply();

    const binance = process.binance;
    if (!binance?.isInitialized) return interaction.editReply('Binance not connected.');

    const balances  = await binance.GetBalances();
    const usdtFree  = parseFloat(balances['USDT']?.free || 0);

    const stables = ['USDT', 'USDC', 'BUSD', 'USD'];
    let openTrades   = 0;
    let totalInvested = 0;

    for (const [asset, info] of Object.entries(balances)) {
      if (stables.includes(asset)) continue;
      const free = parseFloat(info.free || 0);
      if (free <= 0) continue;
      try {
        const price = await binance.GetPrice(`${asset}USDT`);
        const value = free * price;
        if (value >= 1) { openTrades++; totalInvested += value; }
      } catch (_) {}
    }

    const totalBalance = usdtFree + totalInvested;
    const investedPct  = totalBalance > 0 ? ((totalInvested / totalBalance) * 100).toFixed(0) : '0';
    const crankTotal   = process.cranks?.totalLockedUSDC?.toFixed(2) || '0.00';
    const paused       = process.tradingPaused;

    const statusLine = `$${usdtFree.toFixed(2)} | ${openTrades} | ${investedPct}% | $${crankTotal}`;

    const embed = new EmbedBuilder()
      .setTitle('AgentSmith Status')
      .setColor(paused ? 0xFF0000 : 0x00FF00)
      .setDescription(`\`${statusLine}\``)
      .addFields(
        { name: 'USDT Balance', value: `$${usdtFree.toFixed(2)}`, inline: true },
        { name: 'Open Trades',  value: `${openTrades}`,           inline: true },
        { name: 'Invested',     value: `${investedPct}% ($${totalInvested.toFixed(2)})`, inline: true },
        { name: 'Locked USDC',  value: `$${crankTotal}`,          inline: true },
        { name: 'Status',       value: paused ? '🔴 Paused' : '🟢 Trading', inline: true },
      )
      .setFooter({ text: 'Balance | Trades | % Invested | Crank Total' })
      .setTimestamp();

    return interaction.editReply({ embeds: [embed] });
  },
};
