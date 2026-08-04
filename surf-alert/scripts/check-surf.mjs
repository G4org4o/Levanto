// Surf Alert — controlla le previsioni di onde e vento per uno spot
// e invia un'email (via Resend) quando le condizioni rientrano nelle
// soglie definite in config/thresholds.json.
//
// Pensato per girare via GitHub Actions (cron), ma funziona anche in locale
// con: RESEND_API_KEY=... EMAIL_TO=... EMAIL_FROM=... node scripts/check-surf.mjs

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, "..", "config", "thresholds.json");
const STATE_PATH = path.join(__dirname, "..", "data", "state.json");

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_TO = process.env.EMAIL_TO;
const EMAIL_FROM = process.env.EMAIL_FROM;

// Quante ore in avanti guardare ad ogni esecuzione (copre l'intera giornata
// anche se lo script gira una volta sola, e si auto-corregge ad ogni run
// successivo perché i dati vengono ri-scaricati aggiornati).
const LOOKAHEAD_HOURS = 24;

function todayISO(timezone) {
  return new Date().toLocaleDateString("en-CA", { timeZone: timezone }); // YYYY-MM-DD
}

// Gestisce range di direzione che possono "attraversare" lo 0/360
// (es. da 320 a 40 gradi, che copre NNO -> NE passando per N).
function isDirectionInRange(deg, from, to) {
  deg = ((deg % 360) + 360) % 360;
  from = ((from % 360) + 360) % 360;
  to = ((to % 360) + 360) % 360;
  if (from <= to) return deg >= from && deg <= to;
  return deg >= from || deg <= to; // range che attraversa 360/0
}

async function loadJSON(filePath) {
  const raw = await readFile(filePath, "utf-8");
  return JSON.parse(raw);
}

async function fetchMarine(lat, lon, timezone) {
  const url = new URL("https://marine-api.open-meteo.com/v1/marine");
  url.searchParams.set("latitude", lat);
  url.searchParams.set("longitude", lon);
  url.searchParams.set("hourly", "wave_height,wave_period,wave_direction");
  url.searchParams.set("timezone", timezone);
  url.searchParams.set("forecast_days", "2");

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo Marine API error: ${res.status}`);
  return res.json();
}

async function fetchWind(lat, lon, timezone) {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", lat);
  url.searchParams.set("longitude", lon);
  url.searchParams.set("hourly", "wind_speed_10m,wind_direction_10m");
  url.searchParams.set("wind_speed_unit", "kn");
  url.searchParams.set("timezone", timezone);
  url.searchParams.set("forecast_days", "2");

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo Weather API error: ${res.status}`);
  return res.json();
}

function mergeHourly(marine, wind) {
  const hours = marine.hourly.time;
  return hours.map((time, i) => ({
    time,
    waveHeight: marine.hourly.wave_height[i],
    wavePeriod: marine.hourly.wave_period[i],
    waveDirection: marine.hourly.wave_direction[i],
    windSpeed: wind.hourly.wind_speed_10m[i],
    windDirection: wind.hourly.wind_direction_10m[i],
  }));
}

function isSurfable(hour, cfg) {
  return (
    hour.waveHeight >= cfg.wave_height_min_m &&
    hour.waveHeight <= cfg.wave_height_max_m &&
    hour.wavePeriod >= cfg.wave_period_min_s &&
    hour.windSpeed <= cfg.wind_speed_max_kts &&
    isDirectionInRange(
      hour.windDirection,
      cfg.wind_direction_ideal_from_deg,
      cfg.wind_direction_ideal_to_deg
    )
  );
}

// Punteggio per scegliere l'ora "migliore" tra quelle surfabili:
// preferisce onde più vicine al centro del range e vento più leggero.
function score(hour, cfg) {
  const mid = (cfg.wave_height_min_m + cfg.wave_height_max_m) / 2;
  const waveScore = -Math.abs(hour.waveHeight - mid);
  const windScore = -hour.windSpeed;
  return waveScore * 2 + windScore * 0.1;
}

function formatHourLabel(isoTime, timezone) {
  const d = new Date(isoTime);
  return d.toLocaleString("it-IT", {
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: timezone,
  });
}

function buildEmailHTML(cfg, goodHours, bestHour) {
  const rows = goodHours
    .map(
      (h) => `
      <tr>
        <td style="padding:6px 10px;border-bottom:1px solid #1d3a3f;">${formatHourLabel(h.time, cfg.spot.timezone)}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #1d3a3f;">${h.waveHeight.toFixed(1)} m</td>
        <td style="padding:6px 10px;border-bottom:1px solid #1d3a3f;">${h.wavePeriod.toFixed(0)} s</td>
        <td style="padding:6px 10px;border-bottom:1px solid #1d3a3f;">${h.windSpeed.toFixed(0)} kts</td>
      </tr>`
    )
    .join("");

  return `
  <div style="font-family:Helvetica,Arial,sans-serif;background:#0b2027;color:#eef6f4;padding:24px;">
    <h2 style="margin:0 0 4px;color:#7fd9c4;">🌊 Oggi si può surfare a ${cfg.spot.name}</h2>
    <p style="margin:0 0 16px;color:#b7cfc9;">
      Ora migliore: <strong>${formatHourLabel(bestHour.time, cfg.spot.timezone)}</strong> —
      onda ${bestHour.waveHeight.toFixed(1)} m, periodo ${bestHour.wavePeriod.toFixed(0)} s,
      vento ${bestHour.windSpeed.toFixed(0)} kts
    </p>
    <table style="border-collapse:collapse;width:100%;max-width:480px;background:#0f2b31;border-radius:8px;overflow:hidden;">
      <thead>
        <tr style="background:#123a41;color:#7fd9c4;text-align:left;">
          <th style="padding:8px 10px;">Ora</th>
          <th style="padding:8px 10px;">Onda</th>
          <th style="padding:8px 10px;">Periodo</th>
          <th style="padding:8px 10px;">Vento</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <p style="margin-top:16px;color:#7a9490;font-size:12px;">
      Soglie attuali: onda ${cfg.wave_height_min_m}-${cfg.wave_height_max_m} m,
      periodo min ${cfg.wave_period_min_s} s, vento max ${cfg.wind_speed_max_kts} kts,
      direzione ${cfg.wind_direction_ideal_from_deg}°-${cfg.wind_direction_ideal_to_deg}°.
      Modificabili dal pannello admin.
    </p>
  </div>`;
}

async function sendEmail(cfg, goodHours, bestHour) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: EMAIL_FROM,
      to: [EMAIL_TO],
      subject: `🌊 Surf ok a ${cfg.spot.name} oggi`,
      html: buildEmailHTML(cfg, goodHours, bestHour),
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Resend API error: ${res.status} ${text}`);
  }
}

async function main() {
  const cfg = await loadJSON(CONFIG_PATH);
  const state = await loadJSON(STATE_PATH);

  const [marine, wind] = await Promise.all([
    fetchMarine(cfg.spot.lat, cfg.spot.lon, cfg.spot.timezone),
    fetchWind(cfg.spot.lat, cfg.spot.lon, cfg.spot.timezone),
  ]);

  const merged = mergeHourly(marine, wind).slice(0, LOOKAHEAD_HOURS);
  const today = todayISO(cfg.spot.timezone);

  // Considera solo le ore che appartengono ancora alla giornata odierna,
  // così l'email riguarda sempre "oggi" e non condizioni di domani.
  const todaysHours = merged.filter((h) => h.time.startsWith(today));
  const goodHours = todaysHours.filter((h) => isSurfable(h, cfg));

  if (goodHours.length === 0) {
    console.log(`[${today}] Nessuna finestra surfabile oggi a ${cfg.spot.name}.`);
    return;
  }

  if (state.last_notified_date === today) {
    console.log(`[${today}] Condizioni buone, ma notifica già inviata oggi. Skip.`);
    return;
  }

  const bestHour = [...goodHours].sort((a, b) => score(b, cfg) - score(a, cfg))[0];

  if (!RESEND_API_KEY || !EMAIL_TO || !EMAIL_FROM) {
    console.log("RESEND_API_KEY / EMAIL_TO / EMAIL_FROM non configurati: skip invio email.");
    console.log("Finestre surfabili trovate:", goodHours.map((h) => h.time));
    return;
  }

  await sendEmail(cfg, goodHours, bestHour);
  console.log(`[${today}] Email inviata: ${goodHours.length} ore surfabili trovate.`);

  state.last_notified_date = today;
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2) + "\n", "utf-8");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
