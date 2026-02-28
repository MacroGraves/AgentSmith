/**
 * /nuke — Drop and recreate all database tables.
 *
 * Requires confirmation: user must type "CONFIRM" to proceed.
 * Pauses trading, nukes the database, recreates schema, reseeds defaults,
 * reloads Settings, and restarts in paused state.
 */

const { EmbedBuilder, MessageFlags } = require('discord.js');
const Settings = require('../../../Core/Settings.js');
const Database = require('../../../Database.js');

module.exports = {
  name: 'nuke',
  description: 'Drop ALL database tables and recreate from scratch (destructive!)',
  type: 1,
  cooldown: 30000,
  options: [
    {
      name: 'confirm',
      description: 'Type CONFIRM to proceed (this is irreversible)',
      type: 3, // STRING
      required: true,
    },
  ],

  run: async (client, interaction) => {
    const confirmation = interaction.options.getString('confirm');

    if (confirmation !== 'CONFIRM') {
      const embed = new EmbedBuilder()
        .setTitle('Nuke Aborted')
        .setColor(0xE74C3C)
        .setDescription('You must type **CONFIRM** (exact, case-sensitive) to nuke the database.\n\nThis will **permanently delete** all tables, trade history, settings, and secrets.');
      return interaction.reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
    }

    // Defer — this takes a few seconds
    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

    try {
      // Pause trading immediately
      process.tradingPaused = true;
      if (process.discord) process.discord.tradingPaused = true;

      const steps = [];
      let conn;

      // 1. Get DB connection
      conn = await Database.GetConnection();
      steps.push('Connected to database');

      // 2. Nuke
      await Database.NukeDatabase(conn);
      steps.push('All tables and views dropped');

      // 3. Recreate schema
      await Database.CreateTables(conn);
      steps.push('Tables recreated');

      await Database.CreateViews(conn);
      steps.push('Views recreated');

      // 4. Reseed defaults
      await Database.SeedAll(conn);
      steps.push('Default data seeded');

      // 5. Close temp connection
      conn.end();

      // 6. Reload Settings
      const loaded = await Settings.Load();
      steps.push(loaded ? 'Settings reloaded' : 'Settings reload FAILED');

      // 7. Persist paused state
      await Settings.Set('Trading.Paused', true);
      steps.push('Trading paused');

      const embed = new EmbedBuilder()
        .setTitle('Database Nuked')
        .setColor(0xE74C3C)
        .setDescription([
          'All tables dropped and recreated from scratch.',
          '',
          '**Steps completed:**',
          ...steps.map(s => `• ${s}`),
          '',
          '⚠️ Trading is **paused**. Use `/start` to resume.',
          '⚠️ API keys were cleared — reconfigure with `/exchange`.',
        ].join('\n'))
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    } catch (error) {
      console.error('[/nuke] Error:', error.message);
      const embed = new EmbedBuilder()
        .setTitle('Nuke Failed')
        .setColor(0xE74C3C)
        .setDescription(`Error: \`${error.message}\`\n\nDatabase may be in an inconsistent state. Check logs.`);
      return interaction.editReply({ embeds: [embed] });
    }
  },
};
