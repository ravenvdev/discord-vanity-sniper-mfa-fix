# Discord Vanity URL Sniper

A standalone Node.js CLI that monitors Discord vanity URLs in real-time and claims them the instant they drop. Zero external dependencies — pure Node.js stdlib only.

---

## Features

| Feature | Detail |
|---|---|
| Real-time detection | Discord Gateway WebSocket — event fires the moment a URL drops, no polling delay |
| AUTO-SCAN mode | Monitors every vanity URL across all your guilds at once; claims the first drop, then stops |
| Single-target mode | Watch one specific URL and snipe it to any server you manage |
| TOTP 2FA | Full RFC 6238 implementation (SHA-1, 30 s window, 6 digits) — works with Google Authenticator, Authy, etc. |
| MFA auto-refresh | Refreshes the MFA token every 2 minutes in the background — token never expires mid-operation |
| Webhook notification | Sends `@everyone` ping on successful claim with claimed URL and timestamp |
| HTTP/2 transport | Native `node:http2` — matches Discord's expected TLS fingerprint, avoids Cloudflare 1015 |
| 7/24 watchdog | `watchdog.bat` — infinite restart loop, survives crashes, network drops, rate limits |
| State persistence | Token, TOTP secret, server ID and webhook saved in `.state.json` — enter once, never again |
| Zero dependencies | No `npm install` needed — runs straight from clone |

---

## Requirements

- **Node.js v22+** — uses native `WebSocket` API (Node 21+) and `node:http2`
- A Discord **user token** (not a bot token)
- **2FA enabled** on the Discord account with a TOTP authenticator app
- **Manage Server** permission on the target server

---

## Quick Start

```bash
git clone https://github.com/ravenv/discord-vanity-sniper.git
cd discord-vanity-sniper
node sniper.js
```

First run: use the menu to enter your token, TOTP secret, target server and webhook URL. Everything is saved to `.state.json` automatically.

For 7/24 headless operation:

```bash
# Windows — double-click watchdog.bat, or:
watchdog.bat
```

---

## How to Get Your Credentials

### Discord User Token

1. Open Discord in a browser (chrome/firefox)
2. Press **F12** → open the **Network** tab
3. Send any message or switch channels
4. Find any request to `discord.com/api/...`
5. In the request headers, copy the value of **`Authorization`**

> This token gives full access to your account. Keep it secret. Never share it. Never commit it.

### TOTP Base32 Secret

You need this when setting up or resetting 2FA on Discord.

1. Go to **User Settings → My Account → Two-Factor Authentication**
2. Click **Enable Two-Factor Auth** (or disable and re-enable to get the key)
3. Discord shows a QR code **and** a text key below it, e.g.:
   ```
   65OP EMVR AWXM DYMR O2LZ 6O5C RO73 L3C4
   ```
4. Copy that key, **remove all spaces**, lowercase it → `65opemvrawxmdymro2lz6o5cro73l3c4`
5. Paste that into the sniper when asked for TOTP secret

> If you already have 2FA enabled and didn't save the key when you set it up, you must disable 2FA and re-enable it to get a new key.

### Target Server ID

1. Enable **Developer Mode**: Discord Settings → Advanced → Developer Mode ✓
2. Right-click your server icon → **Copy Server ID**

### Webhook URL (optional — for @everyone ping on claim)

1. Server Settings → **Integrations → Webhooks → New Webhook**
2. Set the channel → **Copy Webhook URL**
3. Paste it into the sniper menu option 5

---

## Menu Reference

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

| Option | What it does |
|---|---|
| 1 | Enter or update your Discord user token (saved to `.state.json`) |
| 2 | Lists every guild on your account with its current vanity URL and admin status |
| 3 | Snipe a single specific vanity URL — enter the URL and pick a destination server |
| 4 | AUTO-SCAN: connects Gateway, monitors all vanities simultaneously, claims first drop |
| 5 | Set a Discord webhook URL for @everyone notification on successful claim |
| 6 | Clear saved TOTP secret (if you need to re-enter it) |
| 7 | Exit |

---

## 7/24 Watchdog

`watchdog.bat` runs `node sniper.js auto` in an infinite loop:

```
node sniper.js auto  ← exits for any reason
        ↓ 5 second delay
node sniper.js auto  ← restarts automatically
        ↓
     ... forever
```

- Restart events are logged to `logs\restarts.log` with timestamp and exit code
- `auto` mode skips the menu entirely — reads credentials from `.state.json` and immediately starts AUTO-SCAN
- To stop: close the watchdog window, or press `Ctrl+C`

---

## How It Works — Technical Detail

### Complete Claim Flow

```
1. STARTUP
   ├── Load .state.json (token, totpSecret, serverId, webhookUrl)
   ├── Verify token → GET /users/@me
   ├── Fetch all guilds → GET /users/@me/guilds
   ├── For each guild: GET /guilds/{id}/vanity-url  (concurrent, rate-limit aware)
   └── Build watchlist: { code → guildId } for every active vanity

2. MFA PRE-FETCH (before watching — ready to claim instantly)
   ├── POST one of:
   │     /users/@me/mfa/totp/disable   { code: totp() }
   │     PATCH /users/@me              { ... }
   │     POST /users/@me/mfa/sms/enable { ... }
   │   → response contains mfa.ticket
   ├── POST /mfa/finish  { ticket, mfa_type: "totp", data: totp() }
   │   → returns { token: "<mfa_token>" }
   └── mfa_token saved, refreshed every 2 minutes automatically

3. REAL-TIME MONITORING (Gateway WebSocket)
   ├── Connect wss://gateway.discord.gg/?v=10&encoding=json
   ├── Receive opcode 10 HELLO → start heartbeat at given interval
   ├── Send opcode 2 IDENTIFY  { token, intents: 0 (no extra intents needed) }
   ├── Receive opcode 0 READY  → session established
   └── Listen for:
         GUILD_UPDATE   → check if vanity_url_code changed or is now null
         GUILD_DELETE   → vanity freed when server deleted

4. DROP DETECTED
   ├── code = dropped vanity URL
   ├── Acquire claim lock (prevents double-claim in auto mode)
   └── PATCH /guilds/{targetServerId}/vanity-url
         { "code": code }
         Headers: { Authorization: token, X-Discord-MFA-Authorization: mfa_token }

5. RESPONSE HANDLING
   ├── 200 → CLAIMED ✓
   │     ├── Send webhook @everyone notification
   │     ├── Release all Gateway connections
   │     └── Exit (watchdog will restart; next run sees empty watchlist = idle)
   ├── 429 → rate limited → retry after Retry-After header value
   ├── 60003 → MFA required → re-fetch MFA token → retry
   └── other 4xx → log and abort
```

### Why HTTP/2 Instead of fetch()

Node.js's built-in `fetch()` (via undici) uses a TLS fingerprint that Cloudflare recognizes as an automated client and returns **error 1015** (rate limit / block) on sensitive Discord endpoints like `/guilds/*/vanity-url`.

The sniper uses `node:http2` directly with raw header ordering that matches a real browser's HTTP/2 connection — Cloudflare passes it through.

### Why Gateway Instead of Polling

Polling `GET /invites/{code}` every N seconds:
- Introduces N seconds of delay between drop and detection
- Consumes Discord API rate limit budget on every guild
- Scales poorly with many guilds

Gateway WebSocket receives `GUILD_UPDATE` events **instantly** when a guild's vanity changes — same millisecond the server owner changes or removes it. No polling overhead.

### TOTP Rotation Safety

TOTP codes rotate every 30 seconds. The sniper:
1. Generates a fresh code at every MFA refresh call using `Date.now()` — never caches a code
2. On each attempt also tries the **previous** window's code as fallback, so a code that just rotated never causes a failed claim
3. MFA token (returned by Discord after TOTP verification) is valid for ~5 minutes — the 2-minute refresh interval means there is always a fresh token with ≥3 minutes remaining when a drop is detected

### MFA Ticket Sources (Anti-1015)

Getting an MFA ticket directly via the vanity URL endpoint triggers Cloudflare 1015. The sniper obtains the ticket through alternative endpoints that are not rate-limited the same way:

```
Priority 1: POST /users/@me/mfa/totp/disable
Priority 2: PATCH /users/@me
Priority 3: POST /users/@me/mfa/sms/enable
```

Each returns a `mfa.ticket` in its 60003 error response which is then passed to `/mfa/finish`.

---

## Project Structure

```
discord-vanity-sniper/
├── sniper.js              # entire CLI — Gateway, HTTP/2, TOTP, MFA, menu
├── watchdog.bat           # 7/24 infinite restart loop
├── start.bat              # simple interactive launcher (double-click)
├── package.json           # { "type": "module" }
├── .gitignore             # excludes .state.json and logs/
├── .state.json.example    # credential template — copy to .state.json
└── README.md
```

---

## Troubleshooting

| Error | Cause | Fix |
|---|---|---|
| `Token geçersiz` | Expired or wrong token | Re-copy Authorization header from browser DevTools |
| `60003 MFA required` | MFA token expired mid-claim | Auto-refresh will recover on next attempt; if persistent, clear TOTP (option 6) and re-enter |
| `1015 Cloudflare` | IP rate limited | Wait ~1 minute; sniper retries automatically |
| `TOTP hatalı` | Wrong base32 secret | Option 6 → clear TOTP → re-enter. Remove ALL spaces from the key. |
| `Gateway bağlantı hatası` | Network drop | Watchdog will restart automatically |
| `Vanity URL yok` | Server has no vanity (needs Level 3 boost) | Expected — shows as `-` in list |

---

## Security Notes

- `.state.json` is in `.gitignore` — it will never be committed
- Never share your Discord user token — it grants full account access
- Running the watchdog on a VPS/server is safer than on a personal machine (always-on without leaving your PC running)

---

## Disclaimer

Automating a Discord user account violates Discord's Terms of Service. Use at your own risk. The author takes no responsibility for account suspensions or bans.

---

## License

MIT
