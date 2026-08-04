# Surf Alert — Levanto

Controlla ogni ora le previsioni di onde e vento per Levanto e invia
un'email quando le condizioni rientrano nelle soglie impostate.
Le soglie si modificano dal pannello admin, senza toccare il codice.

- Dati onde/vento: [Open-Meteo](https://open-meteo.com/) (gratuito, nessuna chiave)
- Invio email: [Resend](https://resend.com/) (piano free: 100 email/giorno)
- Esecuzione periodica: GitHub Actions (cron orario, gratuito su repo pubblici)
- Pannello soglie: pagina statica su GitHub Pages (gratuito su repo pubblici)

## Struttura

```
config/thresholds.json   soglie attuali (onda, periodo, vento, direzione)
data/state.json          traccia l'ultima data in cui è stata inviata un'email
scripts/check-surf.mjs   script che controlla le condizioni e invia l'email
admin/                   pannello web per modificare le soglie
.github/workflows/       cron GitHub Actions
```

## Setup — passo per passo

### 1. Crea il repository

Crea un repository **pubblico** su GitHub (deve essere pubblico per avere
Actions e Pages gratis) e carica dentro tutti i file di questo progetto.

### 2. Crea un account Resend

1. Registrati su [resend.com](https://resend.com) (gratuito)
2. Verifica un dominio email che possiedi (Resend ti dà i record DNS da
   aggiungere) — serve per poter usare un indirizzo "from" credibile.
   In alternativa, per test rapidi puoi usare l'indirizzo di test che
   Resend fornisce di default, ma le email potrebbero non arrivare al tuo
   indirizzo personale: per uso reale conviene verificare un dominio.
3. Crea una **API Key** da Resend (Dashboard → API Keys)

### 3. Configura i secrets su GitHub

Nel repository: **Settings → Secrets and variables → Actions → New repository secret**

Aggiungi questi tre secrets:

| Nome | Valore |
|---|---|
| `RESEND_API_KEY` | la API key creata su Resend |
| `EMAIL_TO` | l'indirizzo email dove vuoi ricevere gli alert |
| `EMAIL_FROM` | l'indirizzo mittente verificato su Resend (es. `alert@tuodominio.it`) |

### 4. Attiva GitHub Pages per il pannello admin

**Settings → Pages → Source: Deploy from a branch → Branch: main, cartella `/admin`**

Dopo qualche minuto la pagina sarà raggiungibile su:
`https://<tuo-utente>.github.io/<nome-repo>/`

Aprila, inserisci in alto `owner/nome-repo` (es. `giorgio/surf-alert`) e
un **Personal Access Token** GitHub (Settings → Developer settings →
Personal access tokens → Fine-grained token, con permesso **Contents:
Read and write** limitato a questo repository) per poter salvare le
modifiche alle soglie direttamente da lì.

### 5. Verifica che il cron sia attivo

Il workflow gira automaticamente ogni ora (schedulazione GitHub Actions,
gratuita su repo pubblici). Per un test immediato: tab **Actions** →
seleziona "Check Surf Conditions" → **Run workflow** (esecuzione manuale).

## Come funziona la logica

Ad ogni esecuzione lo script:

1. scarica le previsioni orarie di oggi (onda, periodo, direzione onda,
   vento e direzione vento) da Open-Meteo per Levanto;
2. filtra le ore in cui **tutte** le soglie sono rispettate;
3. se ce n'è almeno una e non è già stata inviata un'email oggi, sceglie
   l'ora migliore della giornata e invia un'email di riepilogo con tutte
   le fasce orarie surfabili;
4. salva la data di invio in `data/state.json` (committato automaticamente
   dal workflow) per non inviare più email lo stesso giorno.

Il giorno dopo il contatore si resetta automaticamente.

## Modificare le soglie

Dal pannello admin (`admin/index.html`), oppure editando a mano
`config/thresholds.json`:

```json
{
  "wave_height_min_m": 0.5,
  "wave_height_max_m": 2.5,
  "wave_period_min_s": 5,
  "wind_speed_max_kts": 15,
  "wind_direction_ideal_from_deg": 0,
  "wind_direction_ideal_to_deg": 90
}
```

La direzione vento è in gradi (0=N, 90=E, 180=S, 270=O) e può
attraversare lo 0 (es. da 320 a 40 per un range N-NE).

## Test in locale

```bash
RESEND_API_KEY=... EMAIL_TO=tuo@email.it EMAIL_FROM=alert@tuodominio.it node scripts/check-surf.mjs
```

Senza le variabili d'ambiente, lo script stampa solo a console le ore
surfabili trovate, senza inviare email — utile per verificare la logica.
