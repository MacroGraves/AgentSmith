const { Client, IntentsBitField, EmbedBuilder, PermissionsBitField, Collection, Partials } = require('discord.js');
const fs = require('fs');
const axios = require('axios');
const Utils = require('../Utils');
const mysql = require('promise-mysql');
const ms = require('ms');

class Discord {
  constructor(config) {
    this.config = config;
    this.intents = new IntentsBitField();
   const { Client, GatewayIntentBits, Partials } = require('discord.js');

   // Define the intents properly using GatewayIntentBits
   const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildPresences, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMessageReactions, GatewayIntentBits.GuildIntegrations];

   // Create the client with specified intents and partials
   this.client = new Client({
     intents,
     partials: [Partials.Channel, Partials.Message, Partials.User, Partials.GuildMember, Partials.Reaction],
   });

    this.embedBuilder = EmbedBuilder;
    this.site_connection = false;
    this.chat_connection = false;
    this.openai_api_key = config.OpenAI_API_Key;

    this.cooldownMessage = 'You are on `<duration>` cooldown!';
    this.cooldown = new Collection();
    this.responses = ['You are a helpful assistant.'];
    this.messageResponses = [];

    // Setup collections
    this.client.Commands = new Collection();
    this.client.aliases = new Collection();
    this.client.buttons = new Collection();

    this.PreRegistrationCycle = null;
    this.dbConnection = null;
    this.db = null;
    this.init();
  }
  async init() {
    this.db = await this.initConnection();
  }
  async initConnection() {
    if (!this.dbConnection) {
      try {
        this.dbConnection = await Utils.Connection(mysql);
        console.log('Database connection established');

        // Do one time setup
        
        this.getBot().once('ready', async() => {
          await this.preRegistrationCycle();
        });
        
        // Setup a timer that checks every 30 seconds for users who are pre-registered but not registered on the site
        this.PreRegistrationCycle = setInterval(async () => {
          await this.preRegistrationCycle();
        }, 5000);
      } catch (error) {
        console.error('Database connection error:', error);
      }
    }
    return this.dbConnection;
  }

  async prepareCommands() {
    const path = require('path');
    const directoryPath = path.join(__dirname, '../handlers');
    if (this._directoryExists(directoryPath)) {
      fs.readdirSync(directoryPath).forEach((handler) => {
        if (handler.startsWith('_')) return;
        console.log(`Loading commands from: ${handler}`);
        require(path.join(directoryPath, handler))(this.client);
      });
    }
  }

  _setupEventListeners() {
    let ii = 0;

    this.client.on('ready', async () => {
      if (!this._doesRequireModule(this.chat)) {
        // this.site_connection = true;
        // this.chat_connection = true;
        // this.chat = require("./Modules/Chat.js");
      }
      console.log(`Logged in as ${this.client.user.tag}!`);
    });

    this.client.on('messageCreate', (message) => {
      if (message.author.id == '1164292936826110052') {
        setInterval(async () => {
          if (message.content !== '') {
            if (ii === 0) {
              ii = 1;
              await this._afterWait(message);
            }
          }
        }, 1000);
      }
    });

    this.client.on('interactionCreate', async (interaction) => {
      const command = this.client.Commands.get(interaction.commandName);
      if (interaction.type == 4) {
        if (command && command.autocomplete) {
          const choices = [];
          await command.autocomplete(interaction, choices);
        }
      }
      if (interaction.type != 2) return;
      if (!command) return this.client.Commands.delete(interaction.commandName);

      try {
        if (command.cooldown) {
          if (this.cooldown.has(`-${command.name}${interaction.user.id}`)) {
            return interaction.reply({
              content: this.cooldownMessage.replace('<duration>', ms(this.cooldown.get(`-${command.name}${interaction.user.id}`) - Date.now(), { long: true })),
            });
          }

          if (!this._checkPermissions(interaction, command)) return;

          await command.run(this.client, interaction);
          this.cooldown.set(`-${command.name}${interaction.user.id}`, Date.now() + command.cooldown);
          setTimeout(() => {
            this.cooldown.delete(`-${command.name}${interaction.user.id}`);
          }, command.cooldown);
        } else {
          if (!this._checkPermissions(interaction, command)) return;
          await command.run(this.client, interaction);
        }
      } catch (error) {
        console.log(error);
      }
    });
  }

  _checkPermissions(interaction, command) {
    if (command.userPerms && !interaction.memberPermissions.has(PermissionsBitField.resolve(command.userPerms || []))) {
      const userPerms = new EmbedBuilder().setDescription(`🚫 ${interaction.user}, You don't have \`${command.userPerms}\` permissions to use this command!`).setColor('Red');
      interaction.reply({ embeds: [userPerms] });
      return false;
    }

    if (command.botPerms && !interaction.guild.members.cache.get(this.client.user.id).permissions.has(PermissionsBitField.resolve(command.botPerms || []))) {
      const botPerms = new EmbedBuilder().setDescription(`🚫 ${interaction.user}, I don't have \`${command.botPerms}\` permissions to use this command!`).setColor('Red');
      interaction.reply({ embeds: [botPerms] });
      return false;
    }

    return true;
  }

  async _afterWait(message) {
    // Implementation here
  }

  _removeQuotes(inputString) {
    return inputString.replace(/['"]+/g, '');
  }

  /*
   * This function is used to check if a user is a VIP for life
   * If they are, we update their rank in the database
   */
  async preRegistrationCycle() {
    try {
      // Fetch the guild using its ID
      const guild = await this.getBot().guilds.fetch('1149058178802253924');

      // Fetch all members of the guild
      const members = await guild.members.fetch();

      // Iterate through each member
      for (const member of members.values()) {
        const { username, id } = member.user;
        const roles = member.roles.cache.map((role) => role.name);

        // Check if the member has both 'Legend' and 'EA' roles
        if (roles.includes('Legend') && roles.includes('EA')) {
          // Query the database for the user based on their Discord ID
          const [user] = await this.dbConnection.query('SELECT * FROM oauth WHERE discord = ?', [id]);

          if (user) {
            // Query the VIP status using the user's UUID
            const [vip] = await this.dbConnection.query('SELECT * FROM vip WHERE uuid = ?', [user.uuid]);

            if (vip && vip.rank !== 4) {
              console.log(`${username} is now a VIP for life!`);
              // Update the VIP rank and early status in the database
              // await this.dbConnection.query('UPDATE vip SET rank = ?, early = ? WHERE uuid = ?', [4, 1, user.uuid]);
              await this.dbConnection.query('UPDATE vip SET `rank` = ?, early = ? WHERE uuid = ?', [4, 1, `${user.uuid}`]);
            }
          }
        }
      }
    } catch (error) {
      console.error('An error occurred during the pre-registration cycle:', error);
    }
  }

  async start() {
    try {
      await this.prepareCommands();
      this._setupEventListeners();

      const token = this.config.Is_Server ? this.config.Discord.Token : this.config.Discord.Sandbox.Token;
      await this.client.login(token);
      return this.client;
    } catch (e) {
      console.error(e);
      throw e;
    }
  }

  _doesRequireModule(moduleType) {
    return moduleType ?? null;
  }

  _directoryExists(path) {
    try {
      return fs.statSync(path).isDirectory();
    } catch (error) {
      return false;
    }
  }

  getBot() {
    return this.client;
  }
}

module.exports = Discord;
