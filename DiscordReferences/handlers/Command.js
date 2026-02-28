const fs = require("fs");
const { PermissionsBitField } = require("discord.js");
const { Routes } = require("discord-api-types/v9");
const { REST } = require("@discordjs/rest");
const { Capitalise } = require("../Utils.js");
var Config = require("../Config.json");
var Discord = {
	CLIENT_ID: Config.Discord.ClientID,
	GUILD_ID: Config.Discord.GuildID,
	TOKEN: Config.Discord.Token,
};
var Discord_Sandbox = {
  CLIENT_ID: Config.Discord.Sandbox.ClientID,
  GUILD_ID: Config.Discord.Sandbox.GuildID,
  TOKEN: Config.Discord.Sandbox.Token,
};
var Discord_Object = Config.Is_Server ? Discord : Discord_Sandbox;
const rest = new REST({ version: "9" }).setToken(Discord_Object.TOKEN);
const path = require('path');
module.exports = (client) => {
  const Commands = [];
  console.log('Commands: Loading');
  fs.readdirSync(path.join(__dirname, '../Commands')).forEach(async (dir) => {
    console.log(`Loading command from: ${dir}`);
    const files = fs.readdirSync(path.join(__dirname, `../Commands/${dir}/`)).filter((file) => file.endsWith('.js'));
    for (const file of files) {
      const Command = require(path.join(__dirname, `../Commands/${dir}/${file}`));
      Commands.push({
        name: Command.name,
        description: Command.description,
        type: Command.type,
        options: Command.options ? Command.options : null,
        default_permission: Command.default_permission ? Command.default_permission : null,
        default_member_permissions: Command.default_member_permissions ? PermissionsBitField.resolve(Command.default_member_permissions).toString() : null,
      });
      if (Command.name) {
        client.Commands.set(Command.name, Command);
        console.log(`${Capitalise(file.split('.js')[0])}:`, 'Enabled');
      } else console.log(`${Capitalise(file.split('.js')[0])}:`, 'Failed');
    }
  });
  (async () => {
    try {
      await rest.put(process.env.GUILD_ID ? Routes.applicationGuildCommands(Discord_Object.CLIENT_ID, Discord_Object.GUILD_ID) : Routes.applicationCommands(Discord_Object.CLIENT_ID), {
        body: Commands,
      });
      console.log('Commands: Enabled');
    } catch (error) {
      console.log(error);
    }
  })();
};
