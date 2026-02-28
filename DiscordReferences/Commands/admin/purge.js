const { ApplicationCommandType, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags } = require('discord.js');
const Config = require('../../Config.json');
const Utils = require('../../Utils.js');
module.exports = {
  name: 'purge',
  description: 'purge',
  type: ApplicationCommandType.ChatInput,
  cooldown: 3000,
  ephemeral: true,
  run: async (client, interaction) => {
    const member = interaction.member; // Guild member
    let embed, row;
    if ((await Utils.Deny_If_Not_Staff(interaction)) !== null) return;
    embed = new EmbedBuilder()
      .setColor('Blurple') //Don't use capitals
      .setTitle(`Clear Command`)
      .setDescription('Are you sure you want to clear all the messages in this channel?');
    const purge = new ButtonBuilder().setCustomId('purge').setLabel('Purge').setStyle(ButtonStyle.Danger);
    row = new ActionRowBuilder().addComponents(purge);

    //////////////
    const response = await interaction.reply({
      embeds: [embed],
      components: [row],
      flags: [MessageFlags.Ephemeral],
    });

    const collectorFilter = (i) => i.user.id === interaction.user.id;
    try {
      const confirmation = await response.awaitMessageComponent({ filter: collectorFilter, time: 60000 });
      switch (confirmation.customId) {
        case 'purge':
          await interaction.editReply({ content: 'Clearing..', components: [], embeds: [], flags: [MessageFlags.Ephemeral] });
          await interaction.channel.bulkDelete(100).then(async function () {
            await interaction.editReply({ content: 'Cleared.', components: [], embeds: [], Flags: [MessageFlags.Ephemeral] });
          });
          break;
      }
    } catch (e) {
      if (e.code != 50034) {
        embed.data.description = 'The request timed out. ';
        await interaction.editReply({ content: '', components: [], embeds: [embed], flags: [MessageFlags.Ephemeral] });
      }
    }
    //////////////
  },
};
