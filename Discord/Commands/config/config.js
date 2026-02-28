/**
 * /config — View or update a single setting by key (dot notation).
 *
 *   /config key:Trading.Max_Position_Size              → view
 *   /config key:Trading.Max_Position_Size value:15     → set
 */

const { EmbedBuilder, MessageFlags } = require('discord.js');
const Settings = require('../../../Core/Settings.js');

module.exports = {
  name: 'config',
  description: 'View or update a single setting',
  type: 1,
  cooldown: 3000,
  options: [
    {
      name: 'key',
      description: 'Setting key (dot notation, e.g. Trading.Profit_Gate)',
      type: 3, // STRING
      required: true,
    },
    {
      name: 'value',
      description: 'New value (omit to view current)',
      type: 3, // STRING
      required: false,
    },
  ],

  run: async (client, interaction) => {
    const key      = interaction.options.getString('key');
    const newValue = interaction.options.getString('value');

    // ── View ─────────────────────────────────────────────────────
    if (!newValue) {
      const current = Settings.Get(key, undefined);
      if (current === undefined) {
        return interaction.reply({ content: `Setting **${key}** not found.`, flags: [MessageFlags.Ephemeral] });
      }
      const display = typeof current === 'object' ? JSON.stringify(current, null, 2) : String(current);
      return interaction.reply({ content: `**${key}**: \`${display}\``, flags: [MessageFlags.Ephemeral] });
    }

    // ── Set ──────────────────────────────────────────────────────
    let parsed;
    try { parsed = JSON.parse(newValue); } catch (_) { parsed = newValue; }

    const success = await Settings.Set(key, parsed);
    if (success) {
      const embed = new EmbedBuilder()
        .setColor(0x00FF00)
        .setDescription(`✅ **${key}** → \`${newValue}\``)
        .setTimestamp();
      return interaction.reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
    }

    return interaction.reply({ content: `❌ Failed to update **${key}**`, flags: [MessageFlags.Ephemeral] });
  },
};
