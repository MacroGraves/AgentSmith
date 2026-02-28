/**
 * /city — View or set the weather city.
 *
 *   /city              → Shows current city weather + link to auto-detect via Express
 *   /city set:Paris    → Changes the city (geocodes via Open-Meteo)
 */

const { EmbedBuilder, MessageFlags } = require('discord.js');
const Settings = require('../../../Core/Settings.js');
const Weather  = require('../../../Core/Weather.js');

module.exports = {
  name: 'city',
  description: 'View current weather city or change it',
  type: 1,
  cooldown: 5000,
  options: [
    {
      name: 'set',
      description: 'New city name to set (e.g. London, Tokyo, New York)',
      type: 3, // STRING
      required: false,
    },
  ],

  run: async (client, interaction) => {
    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

    const newCity = interaction.options.getString('set');

    // ── Set new city ──
    if (newCity) {
      // Geocode the city via Open-Meteo
      const geo = await Weather.Geocode(newCity);
      if (!geo) {
        return interaction.editReply(`❌ Could not find **${newCity}**. Check spelling and try again.`);
      }

      // Validate by fetching weather
      const test = await Weather.GetWeatherByCoords(geo.latitude, geo.longitude, geo.name);
      if (test.condition === 'Unknown' && test.temp_c === '?') {
        return interaction.editReply(`❌ Found ${geo.name} but could not fetch weather. Try again later.`);
      }

      // Save city + coordinates
      await Settings.Set('System.Weather.City', geo.name);
      await Settings.Set('System.Weather.Latitude', geo.latitude.toString());
      await Settings.Set('System.Weather.Longitude', geo.longitude.toString());

      const embed = new EmbedBuilder()
        .setColor(0x00FF41)
        .setTitle('🌍 City Updated')
        .setDescription(`Weather city set to **${geo.name}**${geo.country ? `, ${geo.country}` : ''}`)
        .addFields(
          { name: 'Weather',  value: `${test.emoji} ${test.condition}`, inline: true },
          { name: 'Temp',     value: `${test.temp_c}°C / ${test.temp_f}°F`, inline: true },
          { name: 'Humidity', value: `${test.humidity}%`, inline: true },
        )
        .setFooter({ text: 'MOTD will use this city on next refresh.' })
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    // ── No args — show current city + auto-detect link ──
    const city = Settings.Get('System.Weather.City', 'Antarctica');
    const weather = await Weather.GetWeather(city);

    const apiEnabled = Settings.Get('System.API.Enabled', false);
    const apiPort    = Settings.Get('System.API.Port', 3000);

    // Build description with auto-detect link if Express is running
    let desc = `Use \`/city set:<name>\` to change.`;
    if (apiEnabled) {
      desc += `\n\n🔗 **[Detect My City](http://localhost:${apiPort}/api/locate)**`;
    }

    const embed = new EmbedBuilder()
      .setColor(0x00FF41)
      .setTitle(`${weather.emoji} Weather — ${city}`)
      .addFields(
        { name: 'Condition',  value: `${weather.emoji} ${weather.condition}`, inline: true },
        { name: 'Temp',       value: `${weather.temp_c}°C / ${weather.temp_f}°F`, inline: true },
        { name: 'Feels Like', value: `${weather.feels_like_c}°C`, inline: true },
        { name: 'Humidity',   value: `${weather.humidity}%`, inline: true },
        { name: 'Wind',       value: `${weather.wind_kmph} km/h`, inline: true },
      )
      .setDescription(desc)
      .setFooter({ text: `Never send a human to do a machine's job.` })
      .setTimestamp();

    return interaction.editReply({ embeds: [embed] });
  },
};
