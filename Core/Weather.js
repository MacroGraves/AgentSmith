/**
 * Weather Module — AgentSmith
 *
 * Fetches current weather using the free Open-Meteo API (no key needed).
 * Uses Open-Meteo Geocoding to resolve city names → lat/lon.
 * Stores coordinates in Settings to avoid re-geocoding on every MOTD refresh.
 *
 * Usage:
 *   const Weather = require('./Core/Weather');
 *   const data = await Weather.GetWeather('London');
 *   // → { city: 'London', temp_c: '12', condition: 'Partly cloudy', emoji: '⛅', ... }
 *
 *   const data = await Weather.GetWeatherByCoords(52.52, 13.41, 'Berlin');
 *   // → same shape, skips geocoding
 */

const axios    = require('axios');
const Settings = require('./Settings.js');

// ─── WMO Weather Code → Condition + Emoji ───────────────────────────────────

const WMO_CODES = {
  0:  { condition: 'Clear sky',              emoji: '☀️' },
  1:  { condition: 'Mainly clear',           emoji: '🌤️' },
  2:  { condition: 'Partly cloudy',          emoji: '⛅' },
  3:  { condition: 'Overcast',               emoji: '☁️' },
  45: { condition: 'Fog',                    emoji: '🌫️' },
  48: { condition: 'Rime fog',               emoji: '🌫️' },
  51: { condition: 'Light drizzle',          emoji: '🌧️' },
  53: { condition: 'Moderate drizzle',       emoji: '🌧️' },
  55: { condition: 'Dense drizzle',          emoji: '🌧️' },
  56: { condition: 'Freezing drizzle',       emoji: '🥶' },
  57: { condition: 'Dense freezing drizzle', emoji: '🥶' },
  61: { condition: 'Slight rain',            emoji: '🌧️' },
  63: { condition: 'Moderate rain',          emoji: '🌧️' },
  65: { condition: 'Heavy rain',             emoji: '🌧️' },
  66: { condition: 'Freezing rain',          emoji: '🥶' },
  67: { condition: 'Heavy freezing rain',    emoji: '🥶' },
  71: { condition: 'Slight snow',            emoji: '❄️' },
  73: { condition: 'Moderate snow',          emoji: '❄️' },
  75: { condition: 'Heavy snow',             emoji: '❄️' },
  77: { condition: 'Snow grains',            emoji: '❄️' },
  80: { condition: 'Light rain showers',     emoji: '🌦️' },
  81: { condition: 'Moderate rain showers',  emoji: '🌦️' },
  82: { condition: 'Violent rain showers',   emoji: '🌧️' },
  85: { condition: 'Light snow showers',     emoji: '🌨️' },
  86: { condition: 'Heavy snow showers',     emoji: '🌨️' },
  95: { condition: 'Thunderstorm',           emoji: '⛈️' },
  96: { condition: 'Thunderstorm with hail', emoji: '⛈️' },
  99: { condition: 'Heavy thunderstorm',     emoji: '⛈️' },
};

/**
 * Get condition + emoji from a WMO weather code
 * @param {number} code - WMO weather interpretation code
 * @returns {{ condition: string, emoji: string }}
 */
function GetEmoji(code) {
  return WMO_CODES[code] || { condition: 'Unknown', emoji: '🌍' };
}

/**
 * Geocode a city name → { name, latitude, longitude, country }
 * Uses Open-Meteo Geocoding API (free, no key).
 * @param {string} city - City name
 * @returns {Promise<Object|null>}
 */
async function Geocode(city) {
  try {
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1`;
    const res = await axios.get(url, { timeout: 10000 });
    const result = res.data?.results?.[0];
    if (!result) return null;
    return {
      name:      result.name,
      latitude:  result.latitude,
      longitude: result.longitude,
      country:   result.country || '',
    };
  } catch (err) {
    console.error(`[Weather] Geocode failed for "${city}": ${err.message}`);
    return null;
  }
}

/**
 * Build the standard weather result from Open-Meteo current data
 * @private
 */
function _parseWeather(data, cityName, lat, lon) {
  const current = data?.current_weather;
  if (!current) throw new Error('No weather data returned');

  const wmo   = GetEmoji(current.weathercode);
  const tempC = current.temperature;
  const tempF = Math.round((tempC * 9 / 5) + 32);

  return {
    city:         cityName,
    temp_c:       Math.round(tempC).toString(),
    temp_f:       tempF.toString(),
    condition:    wmo.condition,
    emoji:        wmo.emoji,
    humidity:     (data?.current?.relative_humidity_2m ?? '?').toString(),
    wind_kmph:    Math.round(current.windspeed || 0).toString(),
    feels_like_c: (data?.current?.apparent_temperature != null
                    ? Math.round(data.current.apparent_temperature).toString()
                    : Math.round(tempC).toString()),
    latitude:     lat,
    longitude:    lon,
  };
}

const FAIL = (city) => ({
  city, temp_c: '?', temp_f: '?', condition: 'Unknown',
  emoji: '🌍', humidity: '?', wind_kmph: '?', feels_like_c: '?',
});

/**
 * Fetch weather by lat/lon directly (no geocoding needed).
 * @param {number} lat
 * @param {number} lon
 * @param {string} [cityName='Unknown']
 * @returns {Promise<Object>}
 */
async function GetWeatherByCoords(lat, lon, cityName = 'Unknown') {
  try {
    const url = `https://api.open-meteo.com/v1/forecast`
      + `?latitude=${lat}&longitude=${lon}`
      + `&current_weather=true`
      + `&current=relative_humidity_2m,apparent_temperature`
      + `&temperature_unit=celsius&wind_speed_unit=kmh`;

    const res = await axios.get(url, { timeout: 10000 });
    return _parseWeather(res.data, cityName, lat, lon);
  } catch (error) {
    console.error(`[Weather] Coord fetch failed (${lat},${lon}): ${error.message}`);
    return FAIL(cityName);
  }
}

/**
 * Fetch current weather for a city.
 * Reuses stored lat/lon when city matches to avoid re-geocoding.
 * @param {string} city - City name (default: Antarctica)
 * @returns {Promise<Object>} Weather data with emoji
 */
async function GetWeather(city = 'Antarctica') {
  try {
    let lat, lon, resolvedCity = city;

    // Reuse stored coords when city matches — avoids geocoding on every MOTD tick
    const storedCity = Settings.Get('System.Weather.City', '');
    const storedLat  = Settings.Get('System.Weather.Latitude', null);
    const storedLon  = Settings.Get('System.Weather.Longitude', null);

    if (storedLat && storedLon && city.toLowerCase() === storedCity.toLowerCase()) {
      lat = parseFloat(storedLat);
      lon = parseFloat(storedLon);
    } else {
      const geo = await Geocode(city);
      if (!geo) return FAIL(city);
      lat = geo.latitude;
      lon = geo.longitude;
      resolvedCity = geo.name;
    }

    return await GetWeatherByCoords(lat, lon, resolvedCity);
  } catch (error) {
    console.error(`[Weather] Failed for "${city}": ${error.message}`);
    return FAIL(city);
  }
}

module.exports = { GetWeather, GetWeatherByCoords, Geocode, GetEmoji };
