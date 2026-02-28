/**
 * Command Handler — loads every .js file from Discord/Commands/<subfolder>/,
 * registers them on the client.Commands collection, then bulk-registers
 * all slash commands with the Discord REST API.
 */

const fs   = require('fs');
const path = require('path');
const { PermissionsBitField } = require('discord.js');
const { REST }    = require('discord.js');
const { Routes }  = require('discord.js');
const Settings    = require('../../Core/Settings.js');

module.exports = async (client) => {
  const commandsDir = path.join(__dirname, '..', 'Commands');
  const slashDefs   = []; // JSON payloads for the REST registration

  console.log('[Discord] Commands: Loading');

  // Read each subfolder (e.g. trading/, config/)
  const folders = fs.readdirSync(commandsDir).filter(f =>
    fs.statSync(path.join(commandsDir, f)).isDirectory()
  );

  for (const folder of folders) {
    const folderPath = path.join(commandsDir, folder);
    const files = fs.readdirSync(folderPath).filter(f => f.endsWith('.js'));

    for (const file of files) {
      const command = require(path.join(folderPath, file));

      if (!command.name) {
        console.log(`[Discord]   ${file}: skipped (no name)`);
        continue;
      }

      // Store on the client collection for runtime lookup
      client.Commands.set(command.name, command);

      // Build the REST payload
      slashDefs.push({
        name:        command.name,
        description: command.description || 'No description',
        type:        command.type || 1,
        options:     command.options || [],
        default_member_permissions: command.default_member_permissions
          ? PermissionsBitField.resolve(command.default_member_permissions).toString()
          : null,
      });

      console.log(`[Discord]   /${command.name}: Loaded`);
    }
  }

  // ── Register with Discord REST API ───────────────────────────────────

  const token    = Settings.Get('Discord.Token', '');
  const clientId = Settings.Get('Discord.ClientID', '');
  const guildId  = Settings.Get('Discord.GuildID', '');

  if (!clientId || !guildId || !token) {
    console.warn('[Discord] ClientID, GuildID, or Token not set — commands not registered with API');
    return;
  }

  try {
    const rest = new REST({ version: '10' }).setToken(token);

    // Clear stale global and guild commands before re-registering
    await rest.put(Routes.applicationCommands(clientId), { body: [] });
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: [] });
    console.log('[Discord] Cleared old commands');

    // Register fresh
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
      body: slashDefs,
    });
    console.log(`[Discord] ${slashDefs.length} slash commands registered`);
  } catch (err) {
    console.error('[Discord] Command registration failed:', err.message);
  }
};
