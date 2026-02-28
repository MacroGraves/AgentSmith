/**
 * /exchange — Modal-based exchange configuration.
 *
 * Opens a pre-filled modal with current Binance settings.
 * On submit, validates and saves all changed fields.
 * Secrets (API Key, API Secret) are stored separately in the Secrets table.
 */

const {
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  EmbedBuilder,
  MessageFlags,
} = require('discord.js');
const Settings = require('../../../Core/Settings.js');

module.exports = {
  name: 'exchange',
  description: 'Configure exchange settings (opens a modal)',
  type: 1,
  cooldown: 5000,

  // ── Slash command handler — shows the modal ─────────────────────────
  run: async (client, interaction) => {
    const modal = new ModalBuilder()
      .setCustomId('exchange_modal')
      .setTitle('Exchange Configuration');

    // Row 1 — API Key
    const apiKeyField = new TextInputBuilder()
      .setCustomId('api_key')
      .setLabel('API Key')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('Binance API Key')
      .setValue(redact(Settings.Get('Binance.API_Key', '')))
      .setRequired(false);

    // Row 2 — API Secret
    const apiSecretField = new TextInputBuilder()
      .setCustomId('api_secret')
      .setLabel('API Secret')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('Binance API Secret')
      .setValue(redact(Settings.Get('Binance.API_Secret', '')))
      .setRequired(false);

    // Row 3 — Trading Pair
    const pairField = new TextInputBuilder()
      .setCustomId('pair')
      .setLabel('Default Trading Pair')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('e.g. LTCUSDT')
      .setValue(String(Settings.Get('Binance.pair', 'LTCUSDT')))
      .setRequired(false);

    // Row 4 — Base Asset
    const baseAssetField = new TextInputBuilder()
      .setCustomId('base_asset')
      .setLabel('Base Asset')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('e.g. LTC')
      .setValue(String(Settings.Get('Binance.baseAsset', 'LTC')))
      .setRequired(false);

    // Row 5 — Sandbox (true/false)
    const sandboxField = new TextInputBuilder()
      .setCustomId('sandbox')
      .setLabel('Testnet / Sandbox (true or false)')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('false')
      .setValue(String(Settings.Get('Binance.testnet', false)))
      .setRequired(false);

    modal.addComponents(
      new ActionRowBuilder().addComponents(apiKeyField),
      new ActionRowBuilder().addComponents(apiSecretField),
      new ActionRowBuilder().addComponents(pairField),
      new ActionRowBuilder().addComponents(baseAssetField),
      new ActionRowBuilder().addComponents(sandboxField),
    );

    await interaction.showModal(modal);
  },

  // ── Modal submit handler ────────────────────────────────────────────
  handleModal: async (client, interaction) => {
    const fields = {
      api_key:    interaction.fields.getTextInputValue('api_key'),
      api_secret: interaction.fields.getTextInputValue('api_secret'),
      pair:       interaction.fields.getTextInputValue('pair'),
      base_asset: interaction.fields.getTextInputValue('base_asset'),
      sandbox:    interaction.fields.getTextInputValue('sandbox'),
    };

    const results = [];

    // API Key — only save if it changed (not still redacted)
    if (fields.api_key && !fields.api_key.includes('••••')) {
      await Settings.Set('Binance.API_Key', fields.api_key.trim());
      results.push('✅ API Key updated');
    }

    // API Secret — only save if it changed
    if (fields.api_secret && !fields.api_secret.includes('••••')) {
      await Settings.Set('Binance.API_Secret', fields.api_secret.trim());
      results.push('✅ API Secret updated');
    }

    // Trading Pair
    if (fields.pair) {
      const pair = fields.pair.trim().toUpperCase();
      await Settings.Set('Binance.pair', pair);
      // Auto-derive base/quote
      const base = pair.replace(/USDT$|BTC$|ETH$|BNB$|BUSD$/i, '');
      const quote = pair.replace(base, '');
      await Settings.Set('Binance.baseAsset', base);
      await Settings.Set('Binance.quoteAsset', quote);
      results.push(`✅ Pair → ${pair} (${base}/${quote})`);
    }

    // Base Asset (manual override)
    if (fields.base_asset && !fields.pair) {
      await Settings.Set('Binance.baseAsset', fields.base_asset.trim().toUpperCase());
      results.push(`✅ Base Asset → ${fields.base_asset.trim().toUpperCase()}`);
    }

    // Sandbox
    if (fields.sandbox) {
      const raw = fields.sandbox.trim().toLowerCase();
      if (raw === 'true' || raw === 'false') {
        const val = raw === 'true';
        await Settings.Set('Binance.testnet', val);
        results.push(`✅ Testnet → ${val}`);
      } else {
        results.push('❌ Sandbox must be true/false');
      }
    }

    const embed = new EmbedBuilder()
      .setTitle('Exchange Settings Updated')
      .setColor(results.some(r => r.startsWith('❌')) ? 0xFF9900 : 0x00FF00)
      .setDescription(results.length > 0 ? results.join('\n') : 'No changes made.')
      .setTimestamp();

    return interaction.reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
  },
};

function redact(s) {
  if (!s || s.length < 8) return s ? '••••' : '';
  return `${s.slice(0, 4)}••••${s.slice(-4)}`;
}
