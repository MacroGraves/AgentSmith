const Config = require('./Config.json');
let Socials = {
  Discord: {
    Module: null,
    Client: null,
  },
  Telegram: {
    Module: null,
    Client: null,
  },
};

// Load the modules
Socials.Discord.Module = Config.Discord_Enabled ? require('./Modules/Discord.js') : null;
Socials.Telegram.Module = Config.Telegram_Enabled ? require('./Modules/Telegram.js') : null;

// Create bot instances
Socials.Discord.Client = Config.Discord_Enabled ? new Socials.Discord.Module(Config) : null;
Socials.Telegram.Client = Config.Telegram_Enabled ? new Socials.Telegram.Module(Config) : null;

// Start the Discord bot conditionally using ternary
(Config.Discord_Enabled ? Socials.Discord.Client.start() : Promise.resolve(null))
  .then((client) => {
    Config.Discord_Enabled && console.log('Discord bot started successfully!');
  })
  .catch((error) => {
    console.error('Failed to start Discord bot:', error);
  });

// Start the Telegram bot conditionally using ternary
(Config.Telegram_Enabled ? Socials.Telegram.Client.start() : Promise.resolve(null))
  .then((bot) => {
    Config.Telegram_Enabled && console.log('Telegram bot started successfully!');
  })
  .catch((error) => {
    console.error('Failed to start Telegram bot:', error);
  });

module.exports = {
  DiscordBot: Socials.Discord.Client.getBot(),
  //TelegramBot: Socials.Telegram.Client.getBot(),
};
