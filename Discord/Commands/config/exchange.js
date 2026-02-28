/**
 * /exchange — Add, view, or update exchange configuration.
 *
 * Subcommands:
 *   /exchange view                  → Show current exchange config (redacted keys)
 *   /exchange set key:<k> value:<v> → Update a Binance.* setting
 *   /exchange test                  → Test the current Binance connection
 */

const { EmbedBuilder, MessageFlags } = require('discord.js');
const Settings = require('../../../Core/Settings.js');

module.exports = {
  name: 'exchange',
  description: 'View, configure, or test exchange connections',
  type: 1,
  cooldown: 5000,
  options: [
    {
      name: 'action',
      description: 'What to do — view, set, or test',
      type: 3, // STRING
      required: true,
      choices: [
        { name: 'view', value: 'view' },
        { name: 'set',  value: 'set'  },
        { name: 'test', value: 'test' },
      ],
    },
    {
      name: 'key',
      description: 'Binance setting key (e.g. API_Key, API_Secret, Sandbox)',
      type: 3,
      required: false,
    },
    {
      name: 'value',
      description: 'New value for the key',
      type: 3,
      required: false,
    },
  ],

  run: async (client, interaction) => {
    const action = interaction.options.getString('action');
    const key    = interaction.options.getString('key');
    const value  = interaction.options.getString('value');

    switch (action) {
      case 'view': return _view(interaction);
      case 'set':  return _set(interaction, key, value);
      case 'test': return _test(interaction);
      default:
        return interaction.reply({ content: 'Unknown action.', flags: [MessageFlags.Ephemeral] });
    }
  },
};

// ─── View ─────────────────────────────────────────────────────────────────

async function _view(interaction) {
  const apiKey    = Settings.Get('Binance.API_Key', '');
  const apiSecret = Settings.Get('Binance.API_Secret', '');
  const sandbox   = Settings.Get('Binance.Sandbox', false);

  const redact = (s) => s ? `${s.slice(0, 4)}••••${s.slice(-4)}` : '(not set)';

  const embed = new EmbedBuilder()
    .setTitle('Exchange Configuration')
    .setColor(0x3498DB)
    .addFields(
      { name: 'API Key',    value: `\`${redact(apiKey)}\``,    inline: true },
      { name: 'API Secret', value: `\`${redact(apiSecret)}\``, inline: true },
      { name: 'Sandbox',    value: `${sandbox}`,               inline: true },
    )
    .setTimestamp();

  return interaction.reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
}

// ─── Set ──────────────────────────────────────────────────────────────────

async function _set(interaction, key, value) {
  if (!key || !value) {
    return interaction.reply({ content: 'Both `key` and `value` are required for `set`.', flags: [MessageFlags.Ephemeral] });
  }

  const allowed = ['API_Key', 'API_Secret', 'Sandbox'];
  if (!allowed.includes(key)) {
    return interaction.reply({
      content: `Invalid key. Allowed: ${allowed.map(k => `\`${k}\``).join(', ')}`,
      flags: [MessageFlags.Ephemeral],
    });
  }

  let parsed;
  try { parsed = JSON.parse(value); } catch (_) { parsed = value; }

  const fullKey = `Binance.${key}`;
  const success = await Settings.Set(fullKey, parsed);

  if (success) {
    return interaction.reply({ content: `✅ **${fullKey}** updated.`, flags: [MessageFlags.Ephemeral] });
  }
  return interaction.reply({ content: `❌ Failed to update **${fullKey}**.`, flags: [MessageFlags.Ephemeral] });
}

// ─── Test ─────────────────────────────────────────────────────────────────

async function _test(interaction) {
  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

  const binance = process.binance;
  if (!binance) return interaction.editReply('Binance module not loaded.');

  try {
    const balances = await binance.GetBalances();
    const usdt     = parseFloat(balances['USDT']?.free || 0);
    const embed = new EmbedBuilder()
      .setTitle('Exchange Connection Test')
      .setColor(0x00FF00)
      .setDescription(`✅ Connected — USDT balance: $${usdt.toFixed(2)}`)
      .setTimestamp();
    return interaction.editReply({ embeds: [embed] });
  } catch (err) {
    const embed = new EmbedBuilder()
      .setTitle('Exchange Connection Test')
      .setColor(0xFF0000)
      .setDescription(`❌ Failed: ${err.message}`)
      .setTimestamp();
    return interaction.editReply({ embeds: [embed] });
  }
}
