/**
 * /config — View or update settings.
 *
 *   /config                                        → list ALL settings grouped by category
 *   /config key:Trading.Max_Position_Size          → view one setting
 *   /config key:Trading.Max_Position_Size value:15 → set one setting
 */

const { EmbedBuilder, MessageFlags } = require('discord.js');
const Settings = require('../../../Core/Settings.js');

// Keys that are secrets — redact their values in listing
const REDACTED = new Set([
  'Discord.Token', 'Binance.API_Key', 'Binance.API_Secret',
  'OpenAI.API_Key', 'Kraken.API_Key', 'Kraken.API_Secret',
  'KuCoin.API_Key', 'KuCoin.API_Secret',
]);

module.exports = {
  name: 'config',
  description: 'View all settings, or view/update a single setting',
  type: 1,
  cooldown: 3000,
  options: [
    {
      name: 'key',
      description: 'Setting key (dot notation). Omit to list all.',
      type: 3, // STRING
      required: false,
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

    // ── List all settings ────────────────────────────────────────
    if (!key) {
      const all = Settings.GetAll();
      const grouped = {};

      for (const [k, v] of Object.entries(all)) {
        const cat = k.split('.')[0];
        if (!grouped[cat]) grouped[cat] = [];
        let display;
        if (REDACTED.has(k)) {
          const s = String(v);
          display = s && s.length > 4 ? `${s.slice(0, 2)}••••` : '(set)';
          if (!v) display = '(empty)';
        } else {
          display = typeof v === 'object' ? JSON.stringify(v) : String(v);
          if (display.length > 60) display = display.slice(0, 57) + '...';
        }
        grouped[cat].push(`\`${k}\` = ${display}`);
      }

      const embeds = [];
      for (const [cat, entries] of Object.entries(grouped)) {
        // Discord embed field value limit is 1024 chars. Split if needed.
        const text = entries.join('\n');
        const chunks = splitText(text, 4000);
        for (let i = 0; i < chunks.length; i++) {
          const embed = new EmbedBuilder()
            .setTitle(i === 0 ? `Config — ${cat}` : `Config — ${cat} (cont.)`)
            .setColor(0x3498DB)
            .setDescription('```\n' + chunks[i] + '\n```');
          embeds.push(embed);
        }
      }

      // Discord max 10 embeds per message
      if (embeds.length === 0) {
        return interaction.reply({ content: 'No settings found.', flags: [MessageFlags.Ephemeral] });
      }
      return interaction.reply({ embeds: embeds.slice(0, 10), flags: [MessageFlags.Ephemeral] });
    }

    // ── View single ──────────────────────────────────────────────
    if (!newValue) {
      const current = Settings.Get(key, undefined);
      if (current === undefined) {
        return interaction.reply({ content: `Setting **${key}** not found.`, flags: [MessageFlags.Ephemeral] });
      }
      let display;
      if (REDACTED.has(key)) {
        display = '(redacted)';
      } else {
        display = typeof current === 'object' ? JSON.stringify(current, null, 2) : String(current);
      }
      return interaction.reply({ content: `**${key}**: \`${display}\``, flags: [MessageFlags.Ephemeral] });
    }

    // ── Set ──────────────────────────────────────────────────────
    if (REDACTED.has(key)) {
      return interaction.reply({ content: `**${key}** is a secret. Use the appropriate modal command to change it.`, flags: [MessageFlags.Ephemeral] });
    }

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

/** Split text into chunks of at most maxLen characters, breaking on newlines */
function splitText(text, maxLen) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let current = '';
  for (const line of text.split('\n')) {
    if (current.length + line.length + 1 > maxLen) {
      chunks.push(current);
      current = line;
    } else {
      current += (current ? '\n' : '') + line;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
