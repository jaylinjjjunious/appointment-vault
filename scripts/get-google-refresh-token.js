const { google } = require("googleapis");
const readline = require("node:readline");

const clientId = String(process.env.GOOGLE_CLIENT_ID || "").trim();
const clientSecret = String(process.env.GOOGLE_CLIENT_SECRET || "").trim();
const redirectUri = String(process.env.GOOGLE_REDIRECT_URI || "").trim();

if (!clientId || !clientSecret || !redirectUri) {
  console.error(
    "Missing GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, or GOOGLE_REDIRECT_URI in your env."
  );
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
const scopes = ["https://www.googleapis.com/auth/calendar"];

const authUrl = oauth2Client.generateAuthUrl({
  access_type: "offline",
  scope: scopes,
  prompt: "consent"
});

console.log("Open this URL in your browser to authorize:");
console.log(authUrl);
console.log("");

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

rl.question("Paste the authorization code here: ", async (code) => {
  try {
    const { tokens } = await oauth2Client.getToken(String(code || "").trim());
    if (!tokens?.refresh_token) {
      console.error(
        "No refresh token returned. Make sure you include prompt=consent and remove any prior approvals."
      );
      process.exit(1);
    }
    console.log("");
    console.log("Your GOOGLE_REFRESH_TOKEN:");
    console.log(tokens.refresh_token);
  } catch (error) {
    console.error("Failed to exchange code for tokens:", error?.message || error);
    process.exit(1);
  } finally {
    rl.close();
  }
});
