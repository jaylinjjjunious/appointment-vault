# Appointment Vault

Appointment Vault is a beginner-friendly full-stack web app for logging and managing appointments.

## Tech Stack

- Node.js (latest LTS recommended)
- Express
- EJS (server-rendered views)
- SQLite (`better-sqlite3`)
- Ollama local LLM (for AI Quick Add)

## Project Structure

```text
.
|-- data/                  # SQLite db file is created here at runtime
|-- src/
|   |-- app.js             # Express server and routes
|   |-- ai.js              # Ollama helper for AI Quick Add parsing
|   |-- googleCalendar.js  # Google OAuth + Calendar sync helper
|   |-- db.js              # SQLite initialization and table creation
|   |-- public/
|   |   `-- style.css      # App styles
|   `-- views/
|       |-- appointments/
|       |   |-- form.ejs
|       |   `-- view.ejs
|       |-- partials/
|       |   |-- bottom.ejs
|       |   `-- top.ejs
|       |-- 404.ejs
|       |-- agent.ejs
|       |-- error.ejs
|       `-- index.ejs
`-- package.json
```

## Run on Windows

1. Install dependencies:

```bash
npm install
```

2. Start in development mode:

```bash
npm run dev
```

This runs the server in the foreground. Keep this terminal open while using the app.
If you want to auto-ensure background startup, use:

```bash
npm run dev:ensure
```

If you want auto-restart on file changes, use:

```bash
npm run dev:nodemon
```

If you want it to keep running in the background (recommended to avoid accidental
"connection refused" after closing a terminal), use:

```bash
npm run up
```

`npm run up` now uses a lightweight supervisor that restarts the app if it exits.

Fastest reliable launch:

```bash
npm run open
```

That command ensures the server is running first, then opens the app URL.

You can also double-click:
- `Open Appointment Vault.cmd`
- `Stop Appointment Vault.cmd`

3. Open in browser:

```text
http://127.0.0.1:3000
```

The app is served by Express at `http://127.0.0.1:3000`.

4. Verify health endpoint:

```text
http://127.0.0.1:3000/health
```

It should return `OK`.

## Stable Mode (recommended)

If the app keeps going down, use PM2 so it auto-restarts immediately:

```bash
npm run stable:start
npm run stable:status
```

These commands store PM2 runtime files in local `.pm2/` inside the project.

Open:

```text
http://127.0.0.1:3000
```

Other PM2 controls:

```bash
npm run stable:restart
npm run stable:stop
npm run stable:delete
npm run stable:logs
```

## Server Control (Windows)

```bash
npm run up
npm run ensure
npm run open
npm run status
npm run down
npm run guard:start
npm run guard:status
npm run guard:stop
npm run autoheal:install
npm run autoheal:status
npm run autoheal:remove
```

## Auto-Heal Mode (recommended)

If you want automatic recovery whenever the app goes down, start the watchdog once:

```bash
npm run guard:start
```

The watchdog checks `http://127.0.0.1:3000` every few seconds and runs recovery automatically.

Check watchdog status:

```bash
npm run guard:status
```

Stop watchdog:

```bash
npm run guard:stop
```

Watchdog logs are written to:
- `data/watchdog.log`

## Persistent Auto-Heal (boots + crashes)

To make recovery automatic even after reboot/logoff, install the Windows scheduled task:

```bash
npm run autoheal:install
```

That task runs every minute and ensures the watchdog is active.

Check task status:

```bash
npm run autoheal:status
```

Remove it:

```bash
npm run autoheal:remove
```

Optional custom port:

```bash
$env:APP_PORT=3001
npm run open
```

## Connection Troubleshooting

- Use the full URL with port: `http://127.0.0.1:3000` (not just `127.0.0.1`).
- Run commands from the project folder that contains `package.json`.
- Check status:

```bash
npm run status
```

- If you previously set a different port in the same PowerShell window (example: `$env:APP_PORT=3001`), either:
  - open that port instead, or
  - clear it and restart:

```bash
Remove-Item Env:APP_PORT -ErrorAction SilentlyContinue
npm run down
npm run up
```

- If port `3000` is busy, start on a different port:

```bash
$env:APP_PORT=3001
npm run dev
```

- If Twilio env vars are missing, reminder calls are skipped by design and a clear log is printed.
- Twilio trial accounts can only call verified numbers until your account is upgraded.

## Production Start

```bash
npm start
```

## AI Quick Add Setup

1. Install Ollama and start it (Windows):

```bash
ollama serve
```

2. Pull the default model:

```bash
ollama pull phi3
```

3. Optional environment variables (PowerShell):

```bash
$env:OLLAMA_HOST="http://localhost:11434"
$env:OLLAMA_MODEL="phi3"
```

4. Start the app:

```bash
npm run dev
```

5. Open the AI page:

```text
http://127.0.0.1:3000/agent
```

6. Enter a natural language instruction, click **Create appointment**, review the parsed preview, then click **Save it**.

## Quick Add Verification Checklist

- Start server: `npm run dev`
- Open home page: `http://127.0.0.1:3000/`
- In **Quick Add**, enter: `Dentist tomorrow 3pm`
- Click **Create** and confirm preview renders on `/agent`
- Click **Save it** and confirm the appointment appears on `/`

## Calendar View Verification Checklist

- Start server: `npm run dev`
- Add one appointment for today
- Add one appointment later this week
- Add one appointment for next month
- Open `/` and confirm they appear under **Today**, **This Week**, and **Upcoming**

## Google Calendar Sync Setup

1. In Google Cloud Console:
- Create/choose a project
- Enable **Google Calendar API**
- Configure OAuth consent screen as **External** (required for personal Gmail)
- Add test user(s) if the app is still in testing mode
- Create an OAuth Client ID (Web application)
- Add redirect URI:
  - `http://127.0.0.1:3000/auth/google/callback`

2. Set environment variables in `.env`:

```bash
GOOGLE_CLIENT_ID=your_client_id
GOOGLE_CLIENT_SECRET=your_client_secret
GOOGLE_REDIRECT_URI=http://127.0.0.1:3000/auth/google/callback
```

3. Start the app:

```bash
npm run dev
```

4. Open the app and click **Connect Google** in the header.

After connection, creating appointments in Appointment Vault will also create events in your primary Google Calendar for the current session.

Notes:
- OAuth tokens are stored in server session (not in database).
- If Google API sync fails, local appointment save still succeeds.

## Twilio Voice Reminder Setup

1. Create a Twilio account, verify your destination number, and use a voice-capable Twilio number.
2. Set environment variables in `.env`:

```bash
TWILIO_ACCOUNT_SID=your_account_sid
TWILIO_AUTH_TOKEN=your_auth_token
TWILIO_FROM_NUMBER=+1xxxxxxxxxx
CALL_TO_NUMBER=+1xxxxxxxxxx
PUBLIC_BASE_URL=https://xxxxx.trycloudflare.com
```

3. Start the app:

```bash
npm run dev
```

4. Expose local server publicly using Cloudflare Tunnel (PowerShell):

```bash
cloudflared --version
cloudflared tunnel --url http://localhost:3000
```

Copy the generated URL (for example `https://abcd-1234.trycloudflare.com`) and set it as `PUBLIC_BASE_URL` in `.env`, then restart `npm run dev`.

5. Twilio webhook endpoint used by outbound reminder calls:

```text
https://<your-trycloudflare-domain>/twilio/voice
```

Optional Twilio Console check:
- Phone Numbers -> your Twilio number -> Voice
- Set **A call comes in** webhook to the same `/twilio/voice` URL (method `POST`).

6. Reminder behavior:
- Scheduler runs every minute.
- Outbound voice reminders trigger at both 60 minutes and 30 minutes before start time.
- Duplicate reminders are prevented using `reminder_calls` records in SQLite.

7. Quick verification checklist (Windows):
- Start server: `npm run dev`
- Confirm health: `http://127.0.0.1:3000/health`
- Start tunnel: `cloudflared tunnel --url http://localhost:3000`
- Update `.env` with `PUBLIC_BASE_URL` from tunnel and restart app
- Add an appointment within the next hour
- Wait for 60-minute and 30-minute marks (or run `http://127.0.0.1:3000/twilio/test-call?minutes=30` for a fast call test)
# appointment-vault
