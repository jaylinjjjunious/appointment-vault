Use these files to copy env vars into Render.

Files:
- `render-all.env`: full block exactly as provided
- `render-web.env`: paste into the `appointment-vault` web service
- `render-worker.env`: paste into the `appointment-vault-automation` worker service

Before saving in Render, replace:
- `AUTOMATION_SECRET_KEY=make-this-a-long-random-secret`

With a real long random secret.
