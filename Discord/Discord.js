/**
 * Discord Bot — AgentSmith
 *
 * Main bot class: manages the client, loads command handlers, dispatches
 * interactions (slash commands, modals, buttons), and handles cooldowns
 * and permission checks.
 */

const {
  Client,
  GatewayIntentBits,
  Collection,
  EmbedBuilder,
  ActivityType,
  MessageFlags,
} = require('discord.js');
const fs   = require('fs');
const path = require('path');
const Settings = require('../Core/Settings.js');

class Discord {
  constructor() {
    this.client       = null;
    this.ready        = false;
    this.statusInterval = null;
    this.tradingPaused  = false;
    this.cooldown       = new Collection();
  }

  // ─── Initialize ───────────────────────────────────────────────────────

  /**
   * Build the client, load commands, login, and register slash commands.
   * @returns {Promise<boolean>}
   */
  async Initialize() {
    try {
      const token   = Settings.Get('Discord.Token', '');
      const enabled = Settings.Get('Discord.Enabled', false);

      if (!enabled || !token) {
        console.log('[Discord] Disabled or no token configured. Skipping.');
        return false;
      }

      this.client = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
        ],
      });

      // Attach collections the command handler will populate
      this.client.Commands = new Collection();

      // Load handlers (this registers commands to the API & populates client.Commands)
      await this._loadHandlers();

      // Wire up event listeners
      this._setupEventListeners();

      // Login
      await this.client.login(token);

      return true;
    } catch (error) {
      console.error('[Discord] Initialization failed:', error.message);
      return false;
    }
  }

  // ─── Handler Loader ───────────────────────────────────────────────────

  /**
   * Require every .js file inside ./handlers/ (skipping files prefixed _)
   * Each handler receives the client instance.
   */
  async _loadHandlers() {
    const handlersDir = path.join(__dirname, 'handlers');
    if (!fs.existsSync(handlersDir)) return;

    const files = fs.readdirSync(handlersDir).filter(f => f.endsWith('.js') && !f.startsWith('_'));
    for (const file of files) {
      console.log(`[Discord] Loading handler: ${file}`);
      const handler = require(path.join(handlersDir, file));
      // handler can be a function or an async function
      await handler(this.client);
    }
  }

  // ─── Event Listeners ──────────────────────────────────────────────────

  _setupEventListeners() {
    // Ready
    this.client.once('clientReady', () => {
      console.log(`[Discord] Bot online as ${this.client.user.tag}`);
      this.ready = true;

      const motdEnabled = Settings.Get('System.MOTD.Enabled', true);
      if (motdEnabled) {
        // MOTD controls presence — skip the other two
        this._startMOTDLoop();
      } else {
        this._updatePresence();
        this._startStatusLoop();
      }
    });

    // Interaction handler — slash commands, modals, buttons
    this.client.on('interactionCreate', async (interaction) => {
      // ── Modal Submit ──────────────────────────────────────────────
      if (interaction.isModalSubmit()) {
        return this._handleModalSubmit(interaction);
      }

      // ── Slash Command ─────────────────────────────────────────────
      if (!interaction.isChatInputCommand()) return;

      const command = this.client.Commands.get(interaction.commandName);
      if (!command) return;

      // Staff-role gate
      const staffRole = Settings.Get('Discord.Staff_Role', '');
      if (staffRole && !interaction.member?.roles?.cache?.has(staffRole)) {
        return interaction.reply({ content: 'Unauthorized.', flags: [MessageFlags.Ephemeral] });
      }

      // Cooldown
      if (command.cooldown) {
        const key = `${command.name}-${interaction.user.id}`;
        if (this.cooldown.has(key)) {
          const remaining = this.cooldown.get(key) - Date.now();
          if (remaining > 0) {
            return interaction.reply({
              content: `Cooldown — try again in ${(remaining / 1000).toFixed(0)}s`,
              flags: [MessageFlags.Ephemeral],
            });
          }
        }
        this.cooldown.set(key, Date.now() + command.cooldown);
        setTimeout(() => this.cooldown.delete(key), command.cooldown);
      }

      // Execute
      try {
        await command.run(this.client, interaction);
      } catch (err) {
        console.error(`[Discord] Command /${command.name} error:`, err.message);
        const msg = `Error: ${err.message}`;
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply({ content: msg }).catch(() => {});
        } else {
          await interaction.reply({ content: msg, flags: [MessageFlags.Ephemeral] }).catch(() => {});
        }
      }
    });
  }

  // ─── Modal Dispatch ───────────────────────────────────────────────────

  /**
   * Route modal submissions to the originating command's handleModal()
   */
  async _handleModalSubmit(interaction) {
    // customId format: "commandName_modal" (e.g. "modify_modal")
    const commandName = interaction.customId.split('_')[0];
    const command = this.client.Commands.get(commandName);

    if (command && typeof command.handleModal === 'function') {
      try {
        await command.handleModal(this.client, interaction);
      } catch (err) {
        console.error(`[Discord] Modal error (${commandName}):`, err.message);
        const msg = `Error: ${err.message}`;
        if (interaction.replied || interaction.deferred) {
          await interaction.editReply({ content: msg }).catch(() => {});
        } else {
          await interaction.reply({ content: msg, flags: [MessageFlags.Ephemeral] }).catch(() => {});
        }
      }
    }
  }

  // ─── MOTD — Matrix-themed Status via GPT ───────────────────────────

  /**
   * Generate a Matrix-themed MOTD using current weather.
   * Returns { status, weather } or null on failure.
   */
  async _generateMOTD() {
    try {
      const Weather = require('../Core/Weather.js');
      const city    = Settings.Get('System.Weather.City', 'Antarctica');

      const weather = await Weather.GetWeather(city);

      const status = `${weather.emoji} ${weather.temp_c}°C ${weather.condition} — ${weather.city}`;

      return { status: status.substring(0, 128), weather };
    } catch (err) {
      console.error(`[Discord] MOTD generation failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Start the MOTD loop — generates a Matrix-themed status immediately,
   * then refreshes every N minutes (default 15).
   * Posts the MOTD to the status channel and updates bot presence.
   */
  async _startMOTDLoop() {
    if (!Settings.Get('System.MOTD.Enabled', true)) return;

    const intervalMs = (Settings.Get('System.MOTD.IntervalMinutes', 15)) * 60_000;

    const refresh = async () => {
      try {
        const motd = await this._generateMOTD();
        if (!motd) return;

        // Update bot presence with the MOTD status
        if (this.client?.user) {
          this.client.user.setActivity(motd.status, { type: ActivityType.Playing });
        }
      } catch (err) {
        console.error(`[Discord] MOTD refresh failed: ${err.message}`);
      }
    };

    // Run immediately on boot, then on interval
    await refresh();
    this._motdInterval = setInterval(refresh, intervalMs);
  }

  // ─── Presence / Status Loop ───────────────────────────────────────────

  _updatePresence() {
    if (!this.client?.user) return;
    const status = this.tradingPaused ? 'Scheming' : 'Trading';
    this.client.user.setActivity(status, { type: ActivityType.Watching });
  }

  _startStatusLoop() {
    this.statusInterval = setInterval(async () => {
      if (!process.binance?.isInitialized) return;
      try {
        const balances   = await process.binance.GetBalances();
        const usdt       = parseFloat(balances['USDT']?.free || 0);
        const crankTotal = process.cranks?.totalLockedUSDC?.toFixed(0) || '0';
        const text = this.tradingPaused
          ? `PAUSED | $${usdt.toFixed(0)} USDT`
          : `$${usdt.toFixed(0)} | USDC $${crankTotal}`;
        this.client.user.setActivity(text, { type: ActivityType.Watching });
      } catch (_) {}
    }, 60_000);
  }

  // ─── Public Helpers ───────────────────────────────────────────────────

  /**
   * Send a message / embed to a channel
   */
  async Send(channelId, content) {
    if (!this.ready || !this.client) return;
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel) return;
      if (typeof content === 'string') {
        await channel.send(content);
      } else {
        await channel.send({ embeds: [content] });
      }
    } catch (err) {
      console.error(`[Discord] Send error: ${err.message}`);
    }
  }

  /**
   * Send a trade notification (buy/sell) to the status channel
   */
  async NotifyTrade(data) {
    const channelId = Settings.Get('Discord.Status_Channel', '');
    if (!channelId) return;

    const isBuy = data.action === 'buy';
    const totalValue = (data.quantity * data.price).toFixed(2);
    const title = isBuy ? '📈 BUY Executed' : '📉 SELL Executed';
    const color = isBuy ? 0x00CC66 : 0xFF4444;

    const embed = new EmbedBuilder()
      .setTitle(title)
      .setColor(color)
      .addFields(
        { name: 'Pair',     value: data.pair || 'N/A',                       inline: true },
        { name: 'Quantity', value: `${data.quantity}`,                        inline: true },
        { name: 'Price',    value: `$${data.price.toFixed(4)}`,               inline: true },
        { name: 'Total',    value: `$${totalValue}`,                          inline: true },
        { name: 'Order ID', value: `${data.orderId || 'N/A'}`,                inline: true },
      );

    if (!isBuy && data.profitLoss !== undefined) {
      const plSign = data.profitLoss >= 0 ? '+' : '';
      embed.addFields(
        { name: 'P/L',   value: `${plSign}$${data.profitLoss.toFixed(4)}`,            inline: true },
        { name: 'P/L %', value: `${plSign}${data.profitLossPercent.toFixed(2)}%`,     inline: true },
      );
    }

    embed.setTimestamp();
    await this.Send(channelId, embed);
  }

  /**
   * Send a warning to the status channel
   */
  async Warn(message) {
    const channelId = Settings.Get('Discord.Status_Channel', '');
    if (!channelId) return;

    const embed = new EmbedBuilder()
      .setTitle('⚠️ Warning')
      .setColor(0xFF9900)
      .setDescription(message)
      .setTimestamp();

    await this.Send(channelId, embed);
  }

  // ─── Shutdown ─────────────────────────────────────────────────────────

  async Shutdown() {
    if (this.statusInterval) clearInterval(this.statusInterval);
    if (this._motdInterval) clearInterval(this._motdInterval);
    if (this.client) {
      this.client.destroy();
      this.client = null;
    }
    this.ready = false;
    console.log('[Discord] Bot shut down');
  }
}

module.exports = Discord;
