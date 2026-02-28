/**
 * /modify — Opens a modal to edit core trading settings in bulk.
 *
 * The modal pre-fills current values for the most frequently tuned settings.
 * On submit, each field is validated & saved back to the MySQL Settings table.
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
  name: 'modify',
  description: 'Open a modal to edit core trading settings',
  type: 1,
  cooldown: 5000,

  // ── Slash command handler — shows the modal ─────────────────────────
  run: async (client, interaction) => {
    const modal = new ModalBuilder()
      .setCustomId('modify_modal')
      .setTitle('Modify Trading Settings');

    // Row 1 — Max Position Size %
    const posSize = new TextInputBuilder()
      .setCustomId('position_size')
      .setLabel('Max Position Size % (5-20)')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('e.g. 15')
      .setValue(String(Settings.Get('Trading.Max_Position_Size', 20)))
      .setRequired(false);

    // Row 2 — Profit Gate %
    const profitGate = new TextInputBuilder()
      .setCustomId('profit_gate')
      .setLabel('Profit Gate % (min profit to sell)')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('e.g. 4')
      .setValue(String(Settings.Get('Trading.Profit_Gate', 4)))
      .setRequired(false);

    // Row 3 — Buy Cooldown (seconds)
    const buyCooldown = new TextInputBuilder()
      .setCustomId('buy_cooldown')
      .setLabel('Buy Cooldown seconds per pair')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('e.g. 300')
      .setValue(String(Settings.Get('Trading.Buy_Cooldown', 300)))
      .setRequired(false);

    // Row 4 — GPT Model
    const gptModel = new TextInputBuilder()
      .setCustomId('gpt_model')
      .setLabel('GPT Model')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('e.g. gpt-3.5-turbo')
      .setValue(String(Settings.Get('GPT.Model', 'gpt-3.5-turbo')))
      .setRequired(false);

    // Row 5 — Trading Enabled (true/false)
    const tradingEnabled = new TextInputBuilder()
      .setCustomId('trading_enabled')
      .setLabel('Trading Enabled (true / false)')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('true')
      .setValue(String(Settings.Get('Trading.Enabled', true)))
      .setRequired(false);

    modal.addComponents(
      new ActionRowBuilder().addComponents(posSize),
      new ActionRowBuilder().addComponents(profitGate),
      new ActionRowBuilder().addComponents(buyCooldown),
      new ActionRowBuilder().addComponents(gptModel),
      new ActionRowBuilder().addComponents(tradingEnabled),
    );

    await interaction.showModal(modal);
  },

  // ── Modal submit handler — called from Discord.js _handleModalSubmit ─
  handleModal: async (client, interaction) => {
    const fields = {
      position_size:    interaction.fields.getTextInputValue('position_size'),
      profit_gate:      interaction.fields.getTextInputValue('profit_gate'),
      buy_cooldown:     interaction.fields.getTextInputValue('buy_cooldown'),
      gpt_model:        interaction.fields.getTextInputValue('gpt_model'),
      trading_enabled:  interaction.fields.getTextInputValue('trading_enabled'),
    };

    const results = [];

    // ── Position Size ────────────────────────────────────────────
    if (fields.position_size) {
      const val = parseFloat(fields.position_size);
      if (!isNaN(val) && val >= 1 && val <= 50) {
        await Settings.Set('Trading.Max_Position_Size', val);
        results.push(`✅ Max Position Size → ${val}%`);
      } else {
        results.push(`❌ Position Size invalid (${fields.position_size})`);
      }
    }

    // ── Profit Gate ──────────────────────────────────────────────
    if (fields.profit_gate) {
      const val = parseFloat(fields.profit_gate);
      if (!isNaN(val) && val >= 0 && val <= 100) {
        await Settings.Set('Trading.Profit_Gate', val);
        results.push(`✅ Profit Gate → ${val}%`);
      } else {
        results.push(`❌ Profit Gate invalid (${fields.profit_gate})`);
      }
    }

    // ── Buy Cooldown ─────────────────────────────────────────────
    if (fields.buy_cooldown) {
      const val = parseInt(fields.buy_cooldown, 10);
      if (!isNaN(val) && val >= 0) {
        await Settings.Set('Trading.Buy_Cooldown', val);
        results.push(`✅ Buy Cooldown → ${val}s`);
      } else {
        results.push(`❌ Buy Cooldown invalid (${fields.buy_cooldown})`);
      }
    }

    // ── GPT Model ────────────────────────────────────────────────
    if (fields.gpt_model) {
      await Settings.Set('GPT.Model', fields.gpt_model.trim());
      results.push(`✅ GPT Model → ${fields.gpt_model.trim()}`);
    }

    // ── Trading Enabled ──────────────────────────────────────────
    if (fields.trading_enabled) {
      const raw = fields.trading_enabled.trim().toLowerCase();
      if (raw === 'true' || raw === 'false') {
        const val = raw === 'true';
        await Settings.Set('Trading.Enabled', val);
        results.push(`✅ Trading Enabled → ${val}`);
      } else {
        results.push(`❌ Trading Enabled must be true/false (${fields.trading_enabled})`);
      }
    }

    const embed = new EmbedBuilder()
      .setTitle('Settings Updated')
      .setColor(results.some(r => r.startsWith('❌')) ? 0xFF9900 : 0x00FF00)
      .setDescription(results.length > 0 ? results.join('\n') : 'No changes made.')
      .setTimestamp();

    return interaction.reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
  },
};
