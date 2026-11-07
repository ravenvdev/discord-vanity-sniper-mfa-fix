# Discord Vanity URL Sniper

A standalone Node.js CLI that monitors Discord vanity URLs in real-time and claims them the instant they drop — no dependencies, pure Node.js stdlib.

---

## Features

- **Real-time detection** via Discord Gateway WebSocket — no polling delay
- **Auto-scan mode** — monitors every vanity URL across all your guilds simultaneously; claims the first one that drops, then stops (no double-claim)
- **Single-target mode** — watch one specific URL and snipe it to a chosen server
- **TOTP 2FA support** — works with Google Authenticator / any TOTP app (RFC 6238, SHA-1, 30 s, 6 digits)
- **MFA auto-refresh** — refreshes the MFA token every 2 minutes so it never expires during 7/24 operation
- **Webhook notification** — sends `@everyone` ping on successful claim with claim details
- **HTTP/2 transport** — native `node:http2` matching Discord's TLS fingerprint expectations (bypasses Cloudflare 1015)
- **7/24 watchdog** — `watchdog.bat` restarts the process automatically on crash or exit
- **State persistence** — token, TOTP secret, server ID and webhook URL saved locally in `.state.json`
- **No external dependencies** — zero `npm install` required

---

## Requirements

- **Node.js 22+** (uses native `WebSocket` API and `node:http2`)
- A Discord **user token** (not a bot token)
- **2FA enabled** on the Discord account with a TOTP app (Google Authenticator, Authy, etc.)
- Server Manager permission (`MANAGE_GUILD`) on the target server

---

## Setup

### 1. Clone the repo

```bash
git clone https://github.com/YOUR_USERNAME/discord-vanity-sniper.git
cd discord-vanity-sniper
```

### 2. Create `.state.json`

Copy the example file and fill in your credentials:

```bash
cp .state.json.example .state.json
```

```json
{
  "token": "YOUR_DISCORD_USER_TOKEN",
  "lastServerId": "YOUR_TARGET_SERVER_ID",
  "totpSecret": "YOUR_TOTP_BASE32_SECRET",
  "webhookUrl": "https://discord.com/api/webhooks/..."
}
```

> **Never commit `.state.json`** — it is in `.gitignore` by default.

### 3. Run

```bash
node sniper.js
```

---

## How to Get Your Credentials

### Discord User Token

1. Open Discord in browser → **F12** → **Network** tab
2. Send any message, find a request to `discord.com/api`
3. Copy the `Authorization` header value

> **Keep this secret.** Anyone with your token has full access to your account.

### TOTP Base32 Secret

1. In Discord: **User Settings → Account → Two-Factor Authentication**
2. When setting up 2FA, Discord shows a QR code **and** a text key
3. Copy the text key (looks like `65OP EMVR AWXM DYMR O2LZ 6O5C RO73 L3C4`)
4. Remove spaces → lowercase → that is your `totpSecret`

> If you already have 2FA enabled and didn't save the key, you need to disable and re-enable it.

### Target Server ID

1. Enable **Developer Mode** in Discord settings
2. Right-click your server → **Copy Server ID**

### Webhook URL

1. Server Settings → **Integrations → Webhooks → New Webhook**
2. Choose channel → **Copy Webhook URL**

---

## Usage

### Interactive Menu

```
node sniper.js
```

```
════════════════════════════════
   Discord Vanity Sniper
════════════════════════════════
 1 › Token gir / değiştir
 2 › Tüm vanity URL'leri listele
 3 › Tek URL snipe
 4 › AUTO-SCAN (tüm urleri izle)
 5 › Webhook ayarla
 6 › TOTP secret temizle
 7 › Çıkış
```

### Direct Auto Mode (for watchdog / headless)

```bash
node sniper.js auto
```

Skips the menu and immediately starts AUTO-SCAN using credentials from `.state.json`.

---

## 7/24 Operation (Watchdog)

Double-click `watchdog.bat` or run it from terminal:

```bat
watchdog.bat
```

It runs `node sniper.js auto` in an infinite loop — if the process exits for any reason (crash, rate limit, network drop), it waits 5 seconds and restarts. Exit logs are written to `logs\restarts.log`.

**To stop:** Close the watchdog window, or press `Ctrl+C` in it.

---

## How It Works

### Claim Flow

```
Discord Gateway (WebSocket)
       │
       │  GUILD_UPDATE event
       │  (vanity_url_code changed / cleared)
       │
       ▼
  Vanity dropped?
       │ yes
       ▼
  Request MFA ticket  ──► /mfa/finish  ──► MFA token
       │
       ▼
  PATCH /guilds/{targetId}/vanity-url
  { "code": "<dropped_url>", "mfa_token": "..." }
       │
       ▼
  200 OK → claimed ✓   /   retry on 429/40x
```

### MFA Auto-Refresh

The MFA token from `/mfa/finish` is valid for ~5 minutes. The sniper refreshes it every **2 minutes** in the background so there is always a fresh token ready when a drop is detected — no race condition at the moment of claiming.

### TOTP Rotation

TOTP codes rotate every 30 seconds. The sniper generates a fresh code on every MFA refresh call using `Date.now()` and also tries the previous window's code as fallback, so a code that just rotated is never a problem.

### Anti-Rate-Limit

- HTTP/2 multiplexed connection to `canary.discord.com` (single persistent session)
- MFA ticket obtained via alternative endpoints to avoid Cloudflare 1015 on the vanity endpoint
- Gateway for instant drop detection (zero polling on the snipe path)
- Round-robin `GET /invites/{code}` polling as secondary signal for guilds not in Gateway

---

## Project Structure

```
discord-vanity-sniper/
├── sniper.js           # main CLI — all logic in one file
├── watchdog.bat        # 7/24 restart loop
├── start.bat           # simple interactive launcher
├── package.json        # name + "type": "module"
├── .gitignore
├── .state.json.example # credential template
└── README.md
```

---

## Disclaimer

This tool uses a Discord **user token** for automation, which is against Discord's Terms of Service. Use at your own risk. The author is not responsible for any account suspensions or bans.

---

## License

MIT
