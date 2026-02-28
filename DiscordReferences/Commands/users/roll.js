const Config = require('../../Config.json');
const Utils = require('../../Utils');
const { ApplicationCommandOptionType, EmbedBuilder, MessageFlags } = require('discord.js');
module.exports = {
  name: 'roll',
  description: 'Hashes an input',
  type: 1,
  options: [
    {
      name: 'input',
      description: 'The input to hash',
      type: 3,
      required: true,
    },
    {
      name: 'faces',
      description: 'The amount of faces to set',
      required: true,
      type: ApplicationCommandOptionType.Integer,
    },
  ],
  run: async (client, interaction) => {
    var Message = {
      input: interaction.options.getString('input') ?? 'No Input',
      hash: Utils.Hash_It(interaction.options.getString('input')) ?? 'No Hash',
      result: Utils.Result(interaction.options.getString('input'), interaction.options.getString('input'), 0, 'dice', 100, interaction.options.getInteger('faces')) ?? 'No Result',
      string: function () {
        var resultString = 'Rolled a ' + this.result + ' on a ' + interaction.options.getInteger('faces') + ' sided dice.';
        return resultString ?? 'No Result String';
      },
    };
    const embed = new EmbedBuilder()
      .setColor('Blurple')
      .setTitle(`Hash Command`)
      .setDescription('Input: ' + Message.input)
      .addFields({ name: 'Hash: ', value: Message.hash }, { name: 'Result', value: Message.string() });
    const interactionObject = {};
    interactionObject.embeds = [embed];
    interactionObject.flags = [MessageFlags.Ephemeral];
    const response = await interaction.reply(interactionObject);
  },
};
