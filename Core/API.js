/**
 * API Server — AgentSmith
 *
 * Lightweight Express server exposing bot data as REST endpoints.
 * Runs alongside the trading engine on a configurable port.
 *
 * Endpoints:
 *   GET  /api/weather          → Current weather for configured city
 *   GET  /api/weather?city=X   → Current weather for a specific city
 *   GET  /api/status           → Bot trading status
 *   GET  /api/locate           → Browser-based geolocation page (auto-detect city)
 *   POST /api/locate/save      → Save detected location to Settings
 */

const express = require('express');
const Settings = require('./Settings.js');
const Weather = require('./Weather.js');

class API {
  constructor() {
    this.app = null;
    this.server = null;
    this.port = null;
  }

  /**
   * Start the Express server
   * @param {number} port - Port to listen on (default from Settings or 3000)
   * @returns {Promise<boolean>}
   */
  async Initialize(port) {
    try {
      this.port = port || Settings.Get('System.API.Port', 3000);
      this.app = express();
      this.app.use(express.json());

      this._registerRoutes();

      return new Promise((resolve) => {
        this.server = this.app.listen(this.port, () => {
          console.log(`[API] Express server running on port ${this.port}`);
          resolve(true);
        });
        this.server.on('error', (err) => {
          console.error(`[API] Failed to start: ${err.message}`);
          resolve(false);
        });
      });
    } catch (error) {
      console.error(`[API] Initialization failed: ${error.message}`);
      return false;
    }
  }

  /**
   * Register all API routes
   * @private
   */
  _registerRoutes() {
    // GET /api/weather — fetch weather for configured city or query param
    this.app.get('/api/weather', async (req, res) => {
      try {
        const city = req.query.city || Settings.Get('System.Weather.City', 'Antarctica');
        const weather = await Weather.GetWeather(city);
        res.json({ success: true, data: weather });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // GET /api/status — bot trading status
    this.app.get('/api/status', async (req, res) => {
      try {
        const paused = process.tradingPaused || false;
        const binanceConnected = process.binance?.isInitialized || false;
        const discordConnected = process.discord?.ready || false;

        let balance = null;
        if (binanceConnected) {
          try {
            const balances = await process.binance.GetBalances();
            balance = {
              USDT: parseFloat(balances['USDT']?.free || 0).toFixed(2),
              locked: process.cranks?.totalLockedUSDC?.toFixed(2) || '0',
            };
          } catch (_) {}
        }

        res.json({
          success: true,
          data: {
            paused,
            binance: binanceConnected,
            discord: discordConnected,
            balance,
            uptime: process.uptime(),
          },
        });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Health check
    this.app.get('/api/health', (req, res) => {
      res.json({ status: 'ok', timestamp: new Date().toISOString() });
    });

    // ── Location Auto-Detect ────────────────────────────────────────────

    // POST /api/locate/save — save detected location to Settings
    this.app.post('/api/locate/save', async (req, res) => {
      try {
        const { latitude, longitude, city } = req.body;
        if (!latitude || !longitude || !city) {
          return res.status(400).json({ success: false, error: 'Missing latitude, longitude, or city' });
        }

        // Validate by fetching weather for these coords
        const weather = await Weather.GetWeatherByCoords(latitude, longitude, city);
        if (weather.condition === 'Unknown' && weather.temp_c === '?') {
          return res.status(400).json({ success: false, error: 'Could not fetch weather for those coordinates' });
        }

        await Settings.Set('System.Weather.City', city);
        await Settings.Set('System.Weather.Latitude', latitude.toString());
        await Settings.Set('System.Weather.Longitude', longitude.toString());

        res.json({ success: true, data: weather });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // GET /api/locate — browser geolocation page
    this.app.get('/api/locate', (req, res) => {
      res.send(LOCATE_HTML);
    });
  }

  /**
   * Shut down the Express server
   */
  async Shutdown() {
    if (this.server) {
      return new Promise((resolve) => {
        this.server.close(() => {
          console.log('[API] Server shut down');
          resolve();
        });
      });
    }
  }
}

// ─── Locate Page HTML ───────────────────────────────────────────────────────

const LOCATE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AgentSmith — Set Location</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#0a0a0a;color:#00ff41;font-family:'Courier New',monospace;min-height:100vh;display:flex;align-items:center;justify-content:center}
  .card{background:#111;border:1px solid #00ff41;border-radius:8px;padding:32px;max-width:480px;width:90%;text-align:center}
  h1{font-size:1.4em;margin-bottom:8px;text-shadow:0 0 10px #00ff41}
  .sub{color:#888;font-size:.85em;margin-bottom:24px}
  .status{margin:20px 0;padding:16px;background:#0a0a0a;border-radius:4px;border:1px solid #333;min-height:60px}
  .weather{display:grid;grid-template-columns:1fr 1fr;gap:8px;text-align:left;margin:16px 0}
  .weather div{padding:6px 10px;background:#0a0a0a;border-radius:4px;border:1px solid #222}
  .weather .label{color:#888;font-size:.75em}
  .weather .val{font-size:1.1em}
  .emoji{font-size:2em;margin:12px 0}
  button{background:#00ff41;color:#0a0a0a;border:none;padding:12px 32px;border-radius:4px;font-family:inherit;font-size:1em;font-weight:bold;cursor:pointer;margin-top:16px;transition:all .2s}
  button:hover{background:#00cc33;box-shadow:0 0 20px rgba(0,255,65,.3)}
  button:disabled{background:#333;color:#666;cursor:not-allowed;box-shadow:none}
  .error{color:#ff4444;margin:12px 0}
  .success{color:#00ff41;font-size:1.2em;margin:20px 0}
  a{color:#00ff41}
</style>
</head>
<body>
<div class="card">
  <h1>&#x1f30d; AgentSmith Location</h1>
  <p class="sub">Auto-detect your city for weather &amp; MOTD</p>
  <div id="content">
    <div class="status" id="status">Requesting location...</div>
  </div>
</div>
<script>
const $ = id => document.getElementById(id);
const content = $('content');
const status = $('status');

async function reverseGeocode(lat, lon) {
  // Use Open-Meteo geocoding search with coordinates isn't supported,
  // so we use Nominatim (OpenStreetMap) for reverse geocoding
  const url = 'https://nominatim.openstreetmap.org/reverse?lat='+lat+'&lon='+lon+'&format=json&zoom=10';
  const res = await fetch(url);
  const data = await res.json();
  return data?.address?.city || data?.address?.town || data?.address?.village || data?.name || 'Unknown';
}

async function fetchWeather(lat, lon, city) {
  const res = await fetch('/api/weather?lat='+lat+'&lon='+lon+'&city='+encodeURIComponent(city));
  // Weather endpoint doesn't support lat/lon directly, but we'll preview via open-meteo
  const url = 'https://api.open-meteo.com/v1/forecast?latitude='+lat+'&longitude='+lon+'&current_weather=true&current=relative_humidity_2m,apparent_temperature&temperature_unit=celsius&wind_speed_unit=kmh';
  const r = await fetch(url);
  return await r.json();
}

function showLocation(lat, lon, city, weatherData) {
  const cw = weatherData?.current_weather || {};
  const cur = weatherData?.current || {};
  const codes = {0:'\\u2600\\ufe0f Clear',1:'\\u{1f324}\\ufe0f Mainly clear',2:'\\u26c5 Partly cloudy',3:'\\u2601\\ufe0f Overcast',45:'\\u{1f32b}\\ufe0f Fog',48:'\\u{1f32b}\\ufe0f Rime fog',51:'\\u{1f327}\\ufe0f Drizzle',53:'\\u{1f327}\\ufe0f Drizzle',55:'\\u{1f327}\\ufe0f Dense drizzle',61:'\\u{1f327}\\ufe0f Rain',63:'\\u{1f327}\\ufe0f Moderate rain',65:'\\u{1f327}\\ufe0f Heavy rain',71:'\\u2744\\ufe0f Snow',73:'\\u2744\\ufe0f Moderate snow',75:'\\u2744\\ufe0f Heavy snow',80:'\\u{1f326}\\ufe0f Showers',81:'\\u{1f326}\\ufe0f Showers',82:'\\u{1f327}\\ufe0f Heavy showers',95:'\\u26c8\\ufe0f Thunderstorm',96:'\\u26c8\\ufe0f Thunderstorm',99:'\\u26c8\\ufe0f Heavy storm'};
  const desc = codes[cw.weathercode] || '\\u{1f30d} Unknown';
  const tempC = Math.round(cw.temperature || 0);
  const tempF = Math.round((cw.temperature||0)*9/5+32);
  const feelsLike = cur.apparent_temperature != null ? Math.round(cur.apparent_temperature) : tempC;
  const humidity = cur.relative_humidity_2m || '?';
  const wind = Math.round(cw.windspeed || 0);

  content.innerHTML = '<div class="emoji">'+desc.split(' ')[0]+'</div>'
    + '<h2>'+city+'</h2>'
    + '<div class="weather">'
    + '<div><span class="label">Condition</span><br><span class="val">'+desc+'</span></div>'
    + '<div><span class="label">Temperature</span><br><span class="val">'+tempC+'\\u00b0C / '+tempF+'\\u00b0F</span></div>'
    + '<div><span class="label">Feels Like</span><br><span class="val">'+feelsLike+'\\u00b0C</span></div>'
    + '<div><span class="label">Humidity</span><br><span class="val">'+humidity+'%</span></div>'
    + '<div><span class="label">Wind</span><br><span class="val">'+wind+' km/h</span></div>'
    + '<div><span class="label">Coords</span><br><span class="val">'+lat.toFixed(2)+', '+lon.toFixed(2)+'</span></div>'
    + '</div>'
    + '<button id="saveBtn" onclick="saveLocation('+lat+','+lon+',\\''+city.replace(/'/g,"\\\\'")+'\\')">'
    + '\\u2714 Set as MOTD City</button>';
}

async function saveLocation(lat, lon, city) {
  const btn = $('saveBtn');
  btn.disabled = true;
  btn.textContent = 'Saving...';
  try {
    const res = await fetch('/api/locate/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ latitude: lat, longitude: lon, city: city })
    });
    const data = await res.json();
    if (data.success) {
      content.innerHTML = '<div class="success">\\u2705 Location saved!</div>'
        + '<p><strong>'+city+'</strong> is now your MOTD city.</p>'
        + '<p class="sub" style="margin-top:16px">You can close this tab.</p>';
    } else {
      btn.disabled = false;
      btn.textContent = '\\u2714 Set as MOTD City';
      content.innerHTML += '<div class="error">\\u274c '+data.error+'</div>';
    }
  } catch(e) {
    btn.disabled = false;
    btn.textContent = '\\u2714 Set as MOTD City';
    content.innerHTML += '<div class="error">\\u274c Network error: '+e.message+'</div>';
  }
}

async function detect() {
  if (!navigator.geolocation) {
    status.innerHTML = '<div class="error">Geolocation not supported by this browser.</div>';
    return;
  }

  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const lat = pos.coords.latitude;
      const lon = pos.coords.longitude;
      status.textContent = 'Location found! Fetching weather...';
      try {
        const [city, weatherData] = await Promise.all([
          reverseGeocode(lat, lon),
          fetchWeather(lat, lon, '')
        ]);
        showLocation(lat, lon, city, weatherData);
      } catch(e) {
        status.innerHTML = '<div class="error">Failed to fetch data: '+e.message+'</div>';
      }
    },
    (err) => {
      status.innerHTML = '<div class="error">Location access denied.</div>'
        + '<p style="margin-top:12px;color:#888">Use <code style="color:#00ff41">/city set:CityName</code> in Discord instead.</p>';
    },
    { enableHighAccuracy: false, timeout: 15000 }
  );
}

detect();
</script>
</body>
</html>`;

module.exports = new API();
