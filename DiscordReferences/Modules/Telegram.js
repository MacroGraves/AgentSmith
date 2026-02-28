const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const { Collection } = require('discord.js');
let Commands;

class Telegram {
  constructor(config) {
    this.config = config;
    this.token = config.Is_Server ? config.Telegram.Token : config.Telegram.Sandbox.Token;

    this.bot = null;

    // Setup collections
    this.commands = new Collection();
    this.cooldown = new Collection();
    this.cooldownMessage = 'You are on `<duration>` cooldown!';
  }

  async _setupEventListeners() {
    Commands = new (require('../handlers/_Command'))(this.bot);
    // Handle incoming messages
    this.bot.on('message', async (msg) => {
      const chatId = msg.chat.id;
      const messageText = msg.text || '';

      // Process commands
      //if (messageText.startsWith('/'))
      {
        console.log('Command:', messageText);
        await Commands.handleCommand(msg);
      }
    });

    // Handle callback queries (inline buttons)
    this.bot.on('callback_query', (query) => {
      const data = query.data;
      const chatId = query.message.chat.id;
      const userId = query.from.id;

      // Process callback data
      this._handleCallbackQuery(query);
    });
  }

  _handleCallbackQuery(query) {
    const data = query.data;

    // Answer the callback query to remove loading state
    this.bot.answerCallbackQuery(query.id);

    // Process callback data
    // Implementation here based on your button handling needs
  }

  async _isAdmin(chatId, userId) {
    const chatMember = await this.bot.getChatMember(chatId, userId);
    return ['creator', 'administrator'].includes(chatMember.status);
  }

  _directoryExists(path) {
    try {
      return fs.statSync(path).isDirectory();
    } catch (error) {
      return false;
    }
  }

  async start() {
    try {
      // Initialize the bot with polling enabled
      this.bot = new TelegramBot(this.token, { polling: true });
      await this._setupEventListeners();
      return this.bot;
    } catch (error) {
      console.error('Failed to start Telegram bot:', error);
      throw error;
    }
  }

  getBot() {
    return this.bot;
  }

  // Helper methods
  sendMessage(chatId, text, options = {}) {
    return this.bot.sendMessage(chatId, text, options);
  }

  sendPhoto(chatId, photo, options = {}) {
    return this.bot.sendPhoto(chatId, photo, options);
  }

  sendDocument(chatId, document, options = {}) {
    return this.bot.sendDocument(chatId, document, options);
  }
}

module.exports = Telegram;
