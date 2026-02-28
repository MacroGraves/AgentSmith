/**
 * Discord Module — AgentSmith
 *
 * Entry point: creates and exports a singleton DiscordBot instance.
 * Usage in index.js:
 *   const Discord = require('./Discord');
 *   await Discord.Initialize();
 */

const Discord = require('./Discord.js');

module.exports = new Discord();
