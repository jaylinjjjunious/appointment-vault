# Appointment Vault

Appointment Vault is a beginner-friendly full-stack web app for logging and managing appointments.

## Tech Stack

- Node.js (latest LTS recommended)
- Express
- EJS (server-rendered views)
- SQLite (`better-sqlite3`)
- Ollama local LLM (for AI Quick Add)
- Tailwind CSS + DaisyUI (modern dashboard UI)

## Modern UI Setup

1. Install UI dependencies:

```bash
npm install
```

2. Build the Tailwind + DaisyUI stylesheet:

```bash
npm run ui:build
```

3. Optional: watch for CSS changes during development:

```bash
npm run ui:watch
```

The compiled file is written to `src/public/app.css`. The layout now uses a DaisyUI drawer sidebar + glassmorphism panels, with a theme toggle that persists in localStorage.

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
http://localhost:3000
```

The app is served by Express at `http://localhost:3000`.

4. Verify health endpoint:

```text
http://localhost:3000/health
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
http://localhost:3000
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

The watchdog checks `http://localhost:3000` every few seconds and runs recovery automatically.

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

- Use the full URL with port: `http://localhost:3000` (not just `localhost`).
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
http://localhost:3000/agent
```

6. Enter a natural language instruction, click **Create appointment**, review the parsed preview, then click **Save it**.

## OpenAI Calendar Logging

Use the `/agent` page to instantly log appointments and create Google Calendar events from natural language.

### Environment Variables

```
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-4.1-mini
DEFAULT_TIMEZONE=America/Los_Angeles
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=https://your-domain/auth/google/callback
GOOGLE_REFRESH_TOKEN=...
GOOGLE_CALENDAR_ID=primary
```

### Getting a Google Refresh Token (quick method)

1. Go to the Google OAuth Playground: https://developers.google.com/oauthplayground
2. Click the gear icon, check **Use your own OAuth credentials**, and paste your client ID/secret.
3. In Step 1, select **Google Calendar API v3** scope:
   - `https://www.googleapis.com/auth/calendar`
4. Click **Authorize APIs**, sign in, then in Step 2 click **Exchange authorization code for tokens**.
5. Copy the **refresh_token** and put it in `GOOGLE_REFRESH_TOKEN`.

### Getting a Google Refresh Token (local script)

1. Set these env vars locally:
   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_CLIENT_SECRET`
   - `GOOGLE_REDIRECT_URI`
2. Run:

```bash
npm run google:refresh-token
```

3. Open the printed URL, approve access, then paste the code back in the terminal.
4. Copy the refresh token into `GOOGLE_REFRESH_TOKEN`.

### Example prompts

- “I have an appointment for 3pm on March 4th”
- “Schedule a checkup tomorrow at 10am”
- “Book a meeting next Tuesday at 2:30pm, notes: bring documents”

## ChatGPT Action Setup

Use a ChatGPT Action to create appointments directly from ChatGPT.

1. Deploy the app and note your public base URL (must be HTTPS).
2. Set these env vars in production:
   - `ACTION_API_TOKEN`
   - `DEFAULT_TIMEZONE`
   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_CLIENT_SECRET`
   - `GOOGLE_REDIRECT_URI`
   - `GOOGLE_REFRESH_TOKEN`
   - `GOOGLE_CALENDAR_ID`
3. In ChatGPT → Create a GPT → Actions:
   - Paste `openapi.chatgpt-action.yaml`
   - Set the server URL to your deployed base (replace `https://YOUR_DOMAIN`)
   - Configure auth as **API Key / Bearer Token** and paste the same `ACTION_API_TOKEN`
4. Test with:
   - “I have an appointment for March 4 at 3pm”

Expected behavior:
- Valid token creates a DB row and Google Calendar event.
- Invalid token returns 401.
- Missing required fields returns 400.

## Quick Add Verification Checklist

- Start server: `npm run dev`
- Open home page: `http://localhost:3000/`
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
  - `http://localhost:3000/auth/google/callback`

2. Set environment variables in `.env`:

```bash
GOOGLE_CLIENT_ID=your_client_id
GOOGLE_CLIENT_SECRET=your_client_secret
GOOGLE_REDIRECT_URI=http://localhost:3000/auth/google/callback
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
- Confirm health: `http://localhost:3000/health`
- Start tunnel: `cloudflared tunnel --url http://localhost:3000`
- Update `.env` with `PUBLIC_BASE_URL` from tunnel and restart app
- Add an appointment within the next hour
- Wait for 60-minute and 30-minute marks (or run `http://localhost:3000/twilio/test-call?minutes=30` for a fast call test)
# appointment-vault


## Professional Refactor Scaffold (v2)

This repository now includes a production-oriented scaffold while preserving the existing appointment CRUD, AI quick-add, Google sync, and Twilio reminder flows.

### New Architecture Highlights

- Session persistence via SQLite-backed `better-sqlite3-session-store` (replaces in-memory default)
- Local auth (email/password) plus existing Google OAuth path
- Role-ready user model (`role`, `isActive`, `emailVerifiedAt`, `lastLoginAt`)
- Security middleware: Helmet + rate limiting
- Request correlation IDs and structured logging (Pino + pino-http)
- Route modularization for auth + API routes
- Zod validation schemas for auth and appointments
- JSON API + Swagger docs at `/api/docs`
- Appointment filtering (`title`, `dateFrom`, `dateTo`) on dashboard
- ICS export endpoint (`GET /api/appointments/:id.ics`)
- Backup/restore scripts for SQLite
- Vitest + Supertest test scaffolding
- CI scaffold (GitHub Actions)

### New Key Directories

```text
src/
  config/
    env.js
  docs/
    openapi.yaml
  lib/
    logger.js
  middleware/
    authz.js
    errorHandler.js
    requestContext.js
    security.js
  routes/
    authRoutes.js
    api/
      index.js
      adminRoutes.js
      authRoutes.js
      appointmentsRoutes.js
      remindersRoutes.js
  services/
    authService.js
    emailService.js
  validation/
    authSchemas.js
    appointmentSchemas.js
  views/
    auth/
      login.ejs
      register.ejs
```

### Setup Notes

1. Install new dependencies:

```bash
npm install
```

2. Run tests:

```bash
npm run test
```

3. Open API docs:

```text
http://localhost:3000/api/docs
```

### Data & Migration Notes

- `users` table now has additional columns:
  - `passwordHash`, `role`, `emailVerifiedAt`, `lastLoginAt`, `isActive`
- Existing data is preserved; schema migration is automatic in `src/db.js`.

### New Scripts

- `npm run test`
- `npm run test:watch`
- `npm run format`
- `npm run backup:db`
- `npm run restore:db -- <path-to-backup-file>`

### New Environment Variables

- `AUTH_REQUIRED=true`
- `SESSION_MAX_AGE_MS=1209600000`
- `RATE_LIMIT_WINDOW_MS=900000`
- `RATE_LIMIT_MAX=300`
- `SMTP_HOST=...`
- `SMTP_PORT=587`
- `SMTP_SECURE=false`
- `SMTP_USER=...`
- `SMTP_PASS=...`
- `SMTP_FROM="Appointment Vault <no-reply@example.com>"`

### Breaking Changes

- Authentication is now required by default (`AUTH_REQUIRED=true`).
- API is now available under `/api/*` and expects authenticated session context.
- Session storage moved from memory store to SQLite-backed persistent store.
