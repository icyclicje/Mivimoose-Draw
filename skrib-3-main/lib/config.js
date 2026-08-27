// ─────────────────────────────────────────────────────────────
// config.js — server configuration.
// Values come from config.json in the project root, overridable
// with environment variables. See config.example.json.
// ─────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, '..', 'config.json');

let fileConfig = {};
try {
  if (fs.existsSync(CONFIG_FILE)) {
    fileConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  }
} catch (e) {
  console.error('⚠️  Could not read config.json:', e.message);
}

const config = {
  // Discord OAuth app credentials — https://discord.com/developers/applications
  discordClientId: process.env.DISCORD_CLIENT_ID || fileConfig.discordClientId || '',
  discordClientSecret: process.env.DISCORD_CLIENT_SECRET || fileConfig.discordClientSecret || '',
  // Public base URL of this server (must match the redirect URL registered
  // on the Discord app): <baseUrl>/api/auth/discord/callback
  baseUrl: process.env.BASE_URL || fileConfig.baseUrl || `http://localhost:${process.env.PORT || 3000}`,
  // Test-only password-less login endpoint, used by the smoke test. Never
  // enable this on a real server.
  allowTestLogin: process.env.ALLOW_TEST_LOGIN === '1' || fileConfig.allowTestLogin === true,
};

config.discordConfigured = !!(config.discordClientId && config.discordClientSecret);

module.exports = config;
