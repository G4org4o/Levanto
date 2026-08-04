const SPOT = { name: "Levanto", lat: 44.1667, lon: 9.6167, timezone: "Europe/Rome" };
const CONFIG_PATH = "config/thresholds.json";

const $ = (id) => document.getElementById(id);

// Ripristina owner/repo salvato localmente per comodità (non sensibile).
$("repoOwner").value = localStorage.getItem("surfAlertRepo") || "";

// ---------- Condizioni live ----------
async function loadLiveConditions() {
  try {
    const [marineRes, windRes] = await Promise.all([
      fetch(`https://marine-api.open-meteo.com/v1/marine?latitude=${SPOT.lat}&longitude=${SPOT.lon}&hourly=wave_height,wave_period&timezone=${SPOT.timezone}&forecast_days=1`),
      fetch(`https://api.open-meteo.com/v1/forecast?latitude=${SPOT.lat}&longitude=${SPOT.lon}&hourly=wind_speed_10m,wind_direction_10m&wind_speed_unit=kn&timezone=${SPOT.timezone}&forecast_days=1`)
    ]);
    const marine = await marineRes.json();
    const wind = await windRes.json();

    const now = new Date();
    const nowHourISO = now.toISOString().slice(0, 13);
    let idx = marine.hourly.time.findIndex(t => t.startsWith(nowHourISO));
    if (idx === -1) idx = 0;

    const waveH = marine.hourly.wave_height[idx];
    const period = marine.hourly.wave_period[idx];
    const windSpeed = wind.hourly.wind_speed_10m[idx];
    const windDir = wind.hourly.wind_direction_10m[idx];

    $("liveWave").textContent = waveH.toFixed(1);
    $("livePeriod").textContent = period.toFixed(0);
    $("liveWind").textContent = windSpeed.toFixed(0);
    $("liveWindDir").textContent = degToCompass(windDir) + " " + windDir.toFixed(0) + "°";

    const cfg = readFormThresholds();
    const surfable = isSurfable({ waveHeight: waveH, wavePeriod: period, windSpeed, windDirection: windDir }, cfg);
    setStatus(surfable);
  } catch (e) {
    $("statusText").textContent = "Dati non disponibili";
  }
}

function degToCompass(deg) {
  const dirs = ["N","NE","E","SE","S","SO","O","NO"];
  return dirs[Math.round(deg / 45) % 8];
}

function isDirectionInRange(deg, from, to) {
  deg = ((deg % 360) + 360) % 360;
  from = ((from % 360) + 360) % 360;
  to = ((to % 360) + 360) % 360;
  if (from <= to) return deg >= from && deg <= to;
  return deg >= from || deg <= to;
}

function isSurfable(h, cfg) {
  return h.waveHeight >= cfg.wave_height_min_m &&
    h.waveHeight <= cfg.wave_height_max_m &&
    h.wavePeriod >= cfg.wave_period_min_s &&
    h.windSpeed <= cfg.wind_speed_max_kts &&
    isDirectionInRange(h.windDirection, cfg.wind_direction_ideal_from_deg, cfg.wind_direction_ideal_to_deg);
}

function setStatus(surfable) {
  const pill = $("statusPill");
  pill.classList.toggle("bad", !surfable);
  $("statusText").textContent = surfable ? "Surfabile adesso" : "Non nella soglia adesso";
}

// ---------- Form soglie ----------
function readFormThresholds() {
  return {
    wave_height_min_m: parseFloat($("waveMin").value),
    wave_height_max_m: parseFloat($("waveMax").value),
    wave_period_min_s: parseFloat($("periodMin").value),
    wind_speed_max_kts: parseFloat($("windMax").value),
    wind_direction_ideal_from_deg: parseFloat($("dirFrom").value),
    wind_direction_ideal_to_deg: parseFloat($("dirTo").value),
  };
}

function fillForm(cfg) {
  $("waveMin").value = cfg.wave_height_min_m;
  $("waveMax").value = cfg.wave_height_max_m;
  $("periodMin").value = cfg.wave_period_min_s;
  $("windMax").value = cfg.wind_speed_max_kts;
  $("dirFrom").value = cfg.wind_direction_ideal_from_deg;
  $("dirTo").value = cfg.wind_direction_ideal_to_deg;
}

async function loadConfigFromRepo() {
  const repo = $("repoOwner").value.trim();
  if (!repo) {
    // valori di default finché non è collegato un repo
    fillForm({
      wave_height_min_m: 0.5, wave_height_max_m: 2.5,
      wave_period_min_s: 5, wind_speed_max_kts: 15,
      wind_direction_ideal_from_deg: 0, wind_direction_ideal_to_deg: 90
    });
    return;
  }
  try {
    const res = await fetch(`https://raw.githubusercontent.com/${repo}/main/${CONFIG_PATH}?t=${Date.now()}`);
    if (!res.ok) throw new Error("File non trovato sul repo");
    const cfg = await res.json();
    fillForm(cfg);
  } catch (e) {
    $("saveMsg").textContent = "Impossibile leggere le soglie dal repo (" + e.message + ")";
    $("saveMsg").className = "msg err";
  }
}

async function saveConfigToRepo() {
  const repo = $("repoOwner").value.trim();
  const token = $("ghToken").value.trim();
  const msg = $("saveMsg");

  if (!repo || !token) {
    msg.textContent = "Inserisci repository e token GitHub.";
    msg.className = "msg err";
    return;
  }

  localStorage.setItem("surfAlertRepo", repo);

  const newConfig = {
    spot: SPOT,
    ...readFormThresholds(),
    notes: "Direzione vento espressa in gradi (0=N, 90=E, 180=S, 270=O). L'intervallo puo' attraversare lo 0 (es. from 320 to 40)."
  };

  $("saveBtn").disabled = true;
  msg.textContent = "Salvataggio in corso…";
  msg.className = "msg";

  try {
    const apiUrl = `https://api.github.com/repos/${repo}/contents/${CONFIG_PATH}`;
    const getRes = await fetch(apiUrl, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!getRes.ok) throw new Error("Impossibile leggere il file corrente (" + getRes.status + ")");
    const current = await getRes.json();

    const content = btoa(unescape(encodeURIComponent(JSON.stringify(newConfig, null, 2) + "\n")));

    const putRes = await fetch(apiUrl, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        message: "chore: aggiorna soglie surf alert dal pannello admin",
        content,
        sha: current.sha
      })
    });

    if (!putRes.ok) {
      const errBody = await putRes.text();
      throw new Error("Errore salvataggio (" + putRes.status + "): " + errBody);
    }

    msg.textContent = "Soglie salvate ✓";
    msg.className = "msg ok";
  } catch (e) {
    msg.textContent = e.message;
    msg.className = "msg err";
  } finally {
    $("saveBtn").disabled = false;
  }
}

$("saveBtn").addEventListener("click", saveConfigToRepo);
$("reloadBtn").addEventListener("click", loadConfigFromRepo);

loadConfigFromRepo();
loadLiveConditions();
setInterval(loadLiveConditions, 5 * 60 * 1000);
