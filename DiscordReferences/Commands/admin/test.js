const Config = require('../../Config.json');
const Utils = require('../../Utils');
const { EmbedBuilder, MessageFlags } = require('discord.js');
module.exports = {
  name: 'test',
  description: 'Test an input',
  type: 1,
  options: [
    {
      name: 'input',
      description: 'The input',
      type: 3,
      required: true,
    },
  ],
  run: async (client, interaction) => {
    const StaffRole = interaction.guild.roles.cache.get(Config.Is_Server ? Config.Discord.Staff_Role : Config.Discord.Sandbox.Staff_Role);
    const IsNotStaff = !interaction.member.roles.cache.has(StaffRole.id);

    switch (IsNotStaff) {
      case true:
        return await Disallow();
      case false:
        var Message = {
          input: interaction.options.getString('input') ?? 'No Input',
          string: function () {
            var resultString = this.input === '1' ? '[' + this.input + ']' : this.input;
            return resultString ?? 'Something went wrong';
          },
        };
        const embed = new EmbedBuilder()
          .setColor('Blurple')
          .setTitle(`Test Command`)
          .setDescription('Test Input: ' + Message.string());
        const interactionObject = {};
        interactionObject.embeds = [embed];
        interactionObject.flags = [MessageFlags.Ephemeral];
        const response = await interaction.reply(interactionObject);
        break;
    }

    async function Disallow() {
      const disallowedEmbed = new EmbedBuilder().setColor('Blurple').setTitle(`Not Allowed!`).setDescription('You do not have the required role to use this command.');
      const disallowedInteractionObject = {};
      disallowedInteractionObject.embeds = [disallowedEmbed];
      disallowedInteractionObject.flags = [MessageFlags.Ephemeral];

      return await interaction.reply(disallowedInteractionObject);
    }
  },
};
