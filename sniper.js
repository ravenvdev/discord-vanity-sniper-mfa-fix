#!/usr/bin/env node
// Standalone Discord Vanity URL Sniper + Listesi
// Node 18+ (native fetch) gerekir. Harici bağımlılık yok.
//
// Kullanım:
//   node sniper.js
//
// Menü:
//   1) Token gir
//   2) Tüm sunucuların vanity URL'lerini listele
//   3) Snipe başlat (hedef URL + hangi sunucuna alınacak + şifre)
//
// Not: Vanity swap/snipe için hesabın hedef sunucuda yönetici olması
// ve 2FA (MFA) açık olması zorunludur.

'use strict';

const readline = require('node:readline');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http2 = require('node:http2');

// Discord'un ana domaini — Node fetch TLS fingerprint ile algılanıyor,
// canary.discord.com'a HTTP/2 ham modülüyle istek atıyoruz (btwtool swapper
// altyapısında da aynı yöntem kullanılıyor).
const HOST = 'canary.discord.com';
const BASE = `https://${HOST}`;
const API = `${BASE}/api/v10`;
const API9 = `${BASE}/api/v9`;

// ─── TOTP (RFC 6238, Google Authenticator uyumlu) ──────────────────────
function base32Decode(input) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = String(input).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) { bits -= 8; out.push((value >> bits) & 0xff); }
  }
  return Buffer.from(out);
}
function totp(secretB32, offsetSteps = 0) {
  const key = base32Decode(secretB32);
  const counter = Math.floor(Date.now() / 1000 / 30) + offsetSteps;
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const off = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[off] & 0x7f) << 24) | (hmac[off + 1] << 16) | (hmac[off + 2] << 8) | hmac[off + 3];
  return String(code % 1000000).padStart(6, '0');
}

// ─── Terminal yardımcıları ─────────────────────────────────────────────
const C = {
  r: '\x1b[0m', b: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m',
  blue: '\x1b[34m', m: '\x1b[35m', cy: '\x1b[36m', w: '\x1b[37m',
};
const log = (...a) => console.log(...a);
const info = (s) => log(C.cy + '[i]' + C.r + ' ' + s);
const ok = (s) => log(C.g + '[+]' + C.r + ' ' + s);
const warn = (s) => log(C.y + '[!]' + C.r + ' ' + s);
const err = (s) => log(C.red + '[x]' + C.r + ' ' + s);
const hr = () => log(C.dim + '─'.repeat(60) + C.r);

function banner() {
  console.clear();
  log(C.m + C.b + '┌───────────────────────────────────────┐');
  log('│   DISCORD VANITY URL SNIPER (CLI)     │');
  log('│   token → listele → snipe             │');
  log('└───────────────────────────────────────┘' + C.r);
  log('');
}

// ─── State / disk ──────────────────────────────────────────────────────
const STATE_FILE = path.join(__dirname, '.state.json');
let state = { token: null, lastServerId: null };
try { state = Object.assign(state, JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))); } catch {}
function saveState() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch {}
}

// ─── readline wrapper ──────────────────────────────────────────────────
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
function ask(q) {
  return new Promise((res) => rl.question(C.y + '? ' + C.r + q + ' ', (a) => res(a.trim())));
}
function askHidden(q) {
  return new Promise((res) => {
    // readline'ın kendi echo'sunu maskele — stringToWrite = kullanıcı girişi
    // Prompt yazılırken normal göster, girilen tuşlarda '*' yaz
    let masking = false;
    const prompt = C.y + '? ' + C.r + q + ' ';
    const origWrite = rl._writeToOutput?.bind(rl);
    if (rl._writeToOutput) {
      rl._writeToOutput = function (str) {
        if (!masking) return origWrite(str);
        // readline echo'yu bastır; kullanıcı tuş vurdukça yıldızla hallediyoruz
        // Satır temizleme/newline karakterlerine izin ver
        if (/^[\r\n]+$/.test(str)) return origWrite(str);
        if (str === prompt) return origWrite(str);
        // Her yazılan karakter için '*' yaz
        for (const ch of str) {
          if (ch === '\n' || ch === '\r') origWrite(ch);
          else if (ch === '\b' || ch === '\x7f') origWrite('\b \b');
          else origWrite('*');
        }
      };
    }
    masking = true;
    rl.question(prompt, (ans) => {
      masking = false;
      if (origWrite) rl._writeToOutput = origWrite;
      res((ans || '').trim());
    });
  });
}

// ─── Discord HTTP ──────────────────────────────────────────────────────
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.265 Safari/537.36';
const XSUPER = Buffer.from(JSON.stringify({
  os: 'Windows', browser: 'Chrome', device: '',
  system_locale: 'tr-TR',
  browser_user_agent: UA,
  browser_version: '131.0.0.0', os_version: '10',
  referrer: '', referring_domain: '',
  referrer_current: '', referring_domain_current: '',
  release_channel: 'stable', client_build_number: 371547,
  client_event_source: null, has_client_mods: false,
})).toString('base64');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── HTTP/2 kalıcı bağlantı ────────────────────────────────────────────
let h2Client = null;
function getH2() {
  if (h2Client && !h2Client.destroyed && !h2Client.closed) return h2Client;
  h2Client = http2.connect(BASE, {
    settings: { enablePush: false },
  });
  h2Client.on('error', () => {});
  h2Client.on('close', () => { h2Client = null; });
  return h2Client;
}

function h2Request(method, pathUrl, headers, bodyStr) {
  return new Promise((resolve) => {
    const client = getH2();
    const h = {
      ':method': method,
      ':path': pathUrl,
      ':authority': HOST,
      ':scheme': 'https',
      ...headers,
    };
    if (bodyStr) h['content-length'] = Buffer.byteLength(bodyStr);
    const req = client.request(h);
    let status = 0, buf = '';
    req.setEncoding('utf8');
    req.on('response', (hdrs) => { status = hdrs[':status']; });
    req.on('data', (chunk) => { buf += chunk; });
    req.on('end', () => {
      let data = null;
      try { data = buf ? JSON.parse(buf) : null; } catch { data = buf; }
      resolve({ status, data, raw: buf });
    });
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function dreq(method, url, token, { body, mfaToken, extraHeaders } = {}) {
  // url'den path çıkar (base her zaman canary.discord.com)
  const pathUrl = url.replace(BASE, '');
  const headers = {
    'authorization': token,
    'user-agent': UA,
    'x-super-properties': XSUPER,
    'x-discord-locale': 'tr-TR',
    'x-discord-timezone': 'Europe/Istanbul',
    'accept': '*/*',
    'accept-language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
    'origin': 'https://discord.com',
    'referer': 'https://discord.com/channels/@me',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24", "Google Chrome";v="131"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
  };
  if (body) headers['content-type'] = 'application/json';
  if (mfaToken) {
    headers['x-discord-mfa-authorization'] = mfaToken;
    headers['cookie'] = `__Secure-recent_mfa=${mfaToken}`;
  }
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) headers[k.toLowerCase()] = v;
  }

  const bodyStr = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
  try {
    return await h2Request(method, pathUrl, headers, bodyStr);
  } catch (e) {
    return { status: 0, error: e.message };
  }
}

// ─── Token doğrula ─────────────────────────────────────────────────────
async function verifyToken(token) {
  const r = await dreq('GET', `${API}/users/@me`, token);
  if (r.status === 200 && r.data?.id) return r.data;
  return null;
}

// ─── MFA (TOTP) ────────────────────────────────────────────────────────
// Discord 2024/2025 güncellemesi: password MFA artık kabul edilmiyor,
// sadece totp/sms/backup/webauthn. Snipe için TOTP (Google Authenticator)
// kullanıyoruz. Secret base32 olarak saklanır, kod anlık üretilir.
// Ticket için VANITY-URL YERİNE farklı sensitive endpoint'ler denenir
// (çünkü /guilds/*/vanity-url Cloudflare 1015 yiyor). Herhangi biri 60003
// dönerse ticket oradan alınır. Bu endpoint'ler günlük normal kullanımda da
// MFA ticket üretir, hiç tetikte değillerdir.
const TICKET_SOURCES = [
  // POST /users/@me/mfa/totp/disable — TOTP devre dışı bırakma, kesin MFA ister
  { method: 'POST', path: '/users/@me/mfa/totp/disable', body: () => ({ code: '000000' }), api: API9 },
  // PATCH /users/@me — hesap değişikliği, kesin MFA ister
  { method: 'PATCH', path: '/users/@me', body: () => ({ discriminator: null }), api: API9 },
  // POST /users/@me/mfa/sms/enable
  { method: 'POST', path: '/users/@me/mfa/sms/enable', body: () => ({ code: '000000' }), api: API9 },
  // GET /users/@me/mfa/codes-verification
  { method: 'POST', path: '/users/@me/mfa/codes-verification', body: () => ({ password: 'x', nonce: 'x' }), api: API9 },
  // En son çare: vanity-url (eğer diğerleri çalışmazsa)
  { method: 'PATCH', path: null /* /guilds/{id}/vanity-url */, body: null, api: API9, fallback: true },
];

async function requestMfaTicket(token, serverId = null, code = null) {
  for (const src of TICKET_SOURCES) {
    let path = src.path;
    let body = src.body ? src.body() : undefined;
    if (src.fallback) {
      // Vanity-url fallback
      path = `/guilds/${serverId || '0'}/vanity-url`;
      body = code ? { code } : undefined;
    }
    const r = await dreq(src.method, `${src.api}${path}`, token, { body });
    const d = r.data || {};
    const ticket = d?.mfa?.ticket || null;
    if (ticket) {
      console.log(`[+] ticket kaynağı: ${src.method} ${path}`);
      return ticket;
    }
    // Debug: her source'un cevabını kısaca
    const preview = typeof d === 'string' ? d.slice(0, 100) : JSON.stringify(d).slice(0, 160);
    console.log(`[?] ${src.method} ${path} → ${r.status} ${preview}`);
    // 1015 Cloudflare → bu endpoint'i atla, sonrakini dene
    if (r.status === 429 && typeof d === 'string' && d.includes('1015')) continue;
    // Başka MFA mesajı var mı? Bazen başka error ama ticket içeriyor
    if (d?.mfa_ticket) return d.mfa_ticket;
  }
  return null;
}

// Birden fazla endpoint/body kombinasyonu dener, çalışanı döndürür.
async function finishMfa(ticket, token, totpSecret) {
  const code = totp(totpSecret);
  const prev = totp(totpSecret, -1); // 30sn geri (saat offset'i varsa)
  const codes = [code, prev];

  const tries = [];
  for (const c of codes) {
    tries.push({ label: 'v9 /mfa/finish mfa_type=totp', url: `${API9}/mfa/finish`, body: { ticket, mfa_type: 'totp', data: c } });
    tries.push({ label: 'v10 /mfa/finish mfa_type=totp', url: `${API}/mfa/finish`,  body: { ticket, mfa_type: 'totp', data: c } });
    tries.push({ label: 'v9 /auth/mfa/totp mfa_method=totp', url: `${API9}/auth/mfa/totp`, body: { ticket, mfa_method: 'totp', data: c } });
    tries.push({ label: 'v9 /auth/mfa/totp code', url: `${API9}/auth/mfa/totp`, body: { ticket, code: c } });
    tries.push({ label: 'v9 /auth/mfa/finish method=totp', url: `${API9}/auth/mfa/finish`, body: { ticket, mfa_method: 'totp', data: c } });
  }

  for (const t of tries) {
    const r = await dreq('POST', t.url, token, { body: t.body });
    const d = r.data || {};
    const mfa = d.token || d.mfa_token || d.mfa?.token;
    if (mfa) {
      console.log('[+] MFA endpoint çalıştı:', t.label);
      return mfa;
    }
    // İlk 2 denemenin sonucunu detaylı göster (debug)
    if (tries.indexOf(t) < 2) {
      console.log('[?]', t.label, '→', r.status, JSON.stringify(d).slice(0, 180));
    }
  }
  return null;
}

async function initMfa(token, totpSecret, serverId = null, targetCode = null) {
  const t = await requestMfaTicket(token, serverId, targetCode);
  if (!t) return null;
  return await finishMfa(t, token, totpSecret);
}

// ─── Guild listesi + vanity bilgisi ─────────────────────────────────────
async function listGuilds(token) {
  const r = await dreq('GET', `${API}/users/@me/guilds?with_counts=true`, token);
  if (r.status !== 200 || !Array.isArray(r.data)) {
    throw new Error('Sunucu listesi alınamadı (status ' + r.status + ')');
  }
  return r.data;
}

async function getGuildVanity(guildId, token) {
  // Guild detayı — vanity_url_code dolu gelir
  const r = await dreq('GET', `${API}/guilds/${guildId}`, token);
  if (r.status === 200 && r.data) {
    return {
      name: r.data.name,
      id: r.data.id,
      vanity: r.data.vanity_url_code || null,
      features: r.data.features || [],
      owner_id: r.data.owner_id,
      premium_tier: r.data.premium_tier,
      member_count: r.data.approximate_member_count || null,
    };
  }
  return null;
}

// Küçük paralel havuz
async function pool(items, worker, concurrency = 10) {
  const out = new Array(items.length);
  let i = 0;
  async function run() {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = await worker(items[idx], idx); }
      catch (e) { out[idx] = { __err: e.message }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return out;
}

async function showVanities(token) {
  info('Sunucular alınıyor...');
  let guilds;
  try { guilds = await listGuilds(token); }
  catch (e) { err(e.message); return; }

  ok(`${guilds.length} sunucu bulundu. Vanity bilgileri çekiliyor (paralel)...`);
  const results = await pool(guilds, async (g) => {
    const info = await getGuildVanity(g.id, token);
    return info || { name: g.name, id: g.id, vanity: null };
  }, 12);

  hr();
  log(C.b + 'YÖNETİCİ/SAHİP OLDUKLARIN (snipe için uygun):' + C.r);
  const mine = guilds.filter((g) => (BigInt(g.permissions || '0') & 0x8n) !== 0n || g.owner);
  const mineIds = new Set(mine.map((g) => g.id));
  const myRows = results.filter((r) => mineIds.has(r.id));
  if (!myRows.length) warn('Admin/sahip olduğun sunucu bulunamadı.');
  for (const r of myRows) printRow(r, true);

  hr();
  log(C.b + 'DİĞER SUNUCULAR:' + C.r);
  const otherRows = results.filter((r) => !mineIds.has(r.id));
  for (const r of otherRows) printRow(r, false);

  hr();
  const withVanity = results.filter((r) => r.vanity);
  ok(`Toplam ${results.length} sunucu — ${withVanity.length} tanesinde vanity URL var.`);
}

function printRow(r, mine) {
  const v = r.vanity ? C.g + 'discord.gg/' + r.vanity + C.r : C.dim + '(yok)' + C.r;
  const star = mine ? C.y + '★ ' + C.r : '  ';
  log(`${star}${C.b}${(r.name || '').padEnd(32).slice(0, 32)}${C.r}  ${C.dim}${r.id}${C.r}  ${v}`);
}

// ─── Snipe çekirdeği (spam-PATCH) ──────────────────────────────────────
async function patchVanity(guildId, token, mfaToken, code) {
  // v9 + MFA header — bu, swapper altyapısında kullanılan yöntem
  return await dreq('PATCH', `${API9}/guilds/${guildId}/vanity-url`, token, {
    mfaToken, body: { code },
  });
}

// ─── Webhook gönder (Discord webhook, @everyone destekli) ──────────────
async function sendWebhook(url, content, embeds = null) {
  if (!url) return false;
  try {
    const body = {
      content,
      allowed_mentions: { parse: ['everyone', 'users', 'roles'] },
    };
    if (embeds) body.embeds = embeds;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
      body: JSON.stringify(body),
    });
    return r.status >= 200 && r.status < 300;
  } catch { return false; }
}

async function notifyClaim(vanity, serverId, attempts, durationSec) {
  if (!state.webhookUrl) return;
  const content =
    `@everyone\n` +
    `🎯 **VANITY URL ALINDI!**\n` +
    `**URL:** discord.gg/${vanity}\n` +
    `**Sunucu:** \`${serverId}\`\n` +
    `**Süre:** ${durationSec}s · **Deneme:** ${attempts}`;
  const ok = await sendWebhook(state.webhookUrl, content);
  if (ok) log(C.g + '[+] Webhook bildirimi gönderildi' + C.r);
  else log(C.red + '[x] Webhook gönderilemedi' + C.r);
}

// ─── AUTO-SCAN: hesaba bağlı tüm vanity URL'leri izle, ilk düşeni al ────
async function autoScan(token, autoMode = false) {
  let serverId;
  if (autoMode) {
    serverId = state.lastServerId;
  } else {
    serverId = (await ask(`URL'nin alınacağı sunucu ID [${state.lastServerId || ''}]:`)) || state.lastServerId;
  }
  if (!serverId) return err('Sunucu ID boş');

  let secret = state.totpSecret;
  if (secret) {
    info(`TOTP secret kayıtlı — kullanılıyor`);
  } else if (!autoMode) {
    secret = (await askHidden('Authenticator (TOTP) secret:')).replace(/\s+/g, '');
    if (!secret) return err('TOTP secret boş');
    state.totpSecret = secret;
  } else {
    return err('Auto mod için TOTP secret kayıtlı değil. Önce menüden ayarla.');
  }
  state.lastServerId = serverId; saveState();

  // 1) Tüm sunucuları + vanity bilgilerini çek
  info('Hesaba bağlı sunucular taranıyor...');
  let guilds;
  try { guilds = await listGuilds(token); }
  catch (e) { return err(e.message); }

  const details = await pool(guilds, async (g) => await getGuildVanity(g.id, token), 12);
  const vanities = details.filter(d => d && d.vanity && d.id !== serverId); // kendi sunucun hariç
  if (!vanities.length) return err('Hesapta izlenecek vanity URL\'si olan sunucu yok.');

  ok(`${vanities.length} vanity URL izleniyor:`);
  for (const v of vanities) log(`  · /${v.vanity}  ← ${v.name} (${v.id})`);
  hr();

  // 2) MFA ticket + token (bir kere) + arka planda auto-refresh (her 2 dk)
  info(`MFA alınıyor (TOTP: ${totp(secret)})...`);
  let mfa = await initMfa(token, secret, serverId, null);
  let mfaFetchedAt = mfa ? Date.now() : 0;
  if (!mfa) {
    warn('Pre-MFA fail — monitor devam, auto-refresh devam, drop\'ta JIT denenecek.');
  } else {
    ok(`MFA token hazır (otomatik yenilenir her 2 dk)`);
  }

  // Her 2 dakikada bir arka planda MFA'yı yenile → drop anında ASLA expire olmaz
  const mfaRefresh = setInterval(async () => {
    if (claimed || claiming) return;
    try {
      const nm = await initMfa(token, secret, serverId, null);
      if (nm) {
        mfa = nm;
        mfaFetchedAt = Date.now();
        log(C.dim + `  · MFA token yenilendi (${new Date().toLocaleTimeString('tr-TR')})` + C.r);
      } else {
        warn('MFA auto-refresh fail (geçici)');
      }
    } catch (e) { warn('MFA refresh hata: ' + e.message); }
  }, 2 * 60 * 1000);

  log('');
  ok('MONİTÖR AKTİF — İlk düşen URL alınacak. Ctrl+C ile iptal.');
  hr();

  // vanity_code → owner_guild_id map (izleme için)
  const codeToOwner = new Map();
  const ownerToCode = new Map();
  for (const v of vanities) {
    codeToOwner.set(v.vanity.toLowerCase(), v.id);
    ownerToCode.set(v.id, v.vanity.toLowerCase());
  }

  let claimed = false;
  let claiming = false;
  const started = Date.now();

  async function tryClaim(code, reason) {
    if (claiming || claimed) return;
    claiming = true;
    log(C.y + `\n[!] /${code} DÜŞTÜ (${reason}) — alım başlıyor` + C.r);

    if (!mfa) {
      info('MFA alınıyor (JIT)...');
      mfa = await initMfa(token, secret, serverId, null);
      if (!mfa) { err('MFA alınamadı — bu URL atlandı'); claiming = false; return; }
    }

    for (let attempt = 1; attempt <= 5 && !claimed; attempt++) {
      const r = await patchVanity(serverId, token, mfa, code);
      if (r.status < 300 && typeof r.data?.code === 'string' && r.data.code.toLowerCase() === code) {
        claimed = true;
        hr();
        ok(C.b + `🎯 ALINDI! /${code} → ${serverId}` + C.r);
        const dur = ((Date.now() - started) / 1000).toFixed(1);
        ok(`Süre: ${dur}s, deneme: ${attempt}`);
        await notifyClaim(code, serverId, attempt, dur);
        try { ws?.close(); } catch {}
        clearInterval(pollTimer);
        clearInterval(heartbeat);
        clearInterval(mfaRefresh);
        process.exit(0);
      }
      const errCode = r.data?.code;
      if (errCode === 60003) {
        // Auto-refresh her 2dk çalışıyor ama fresh almak kurtarır
        warn(`[${attempt}] MFA expired (nadir), yenileniyor`);
        const nm = await initMfa(token, secret, serverId, null);
        if (!nm) { err('MFA yenileme fail'); break; }
        mfa = nm; mfaFetchedAt = Date.now();
      } else if (r.status === 429) {
        const wait = Math.max(500, Number(r.data?.retry_after || 1) * 1000 + 100);
        warn(`[${attempt}] rate limit → ${wait}ms`);
        await sleep(wait);
      } else if (errCode === 50020) {
        warn(`[${attempt}] /${code} geri alınmış veya tekrar dolmuş — iptal`);
        break;
      } else if (errCode === 50013) {
        err(`İzin yok — ${serverId} sunucusunda admin değilsin. Durduruluyor.`);
        claimed = true; break;
      } else {
        warn(`[${attempt}] ${r.data?.message || 'hata'} (${errCode})`);
        await sleep(300);
      }
    }
    claiming = false;
  }

  // ─── Gateway ─────────────────────────────────────────────────────────
  let ws = null, heartbeat = null, seq = null;
  let gwStatus = 'bağlanıyor';

  function connectGateway() {
    ws = new WebSocket('wss://gateway.discord.gg/?v=10&encoding=json');
    ws.onopen = () => { gwStatus = 'açık'; };
    ws.onclose = () => {
      gwStatus = 'kapalı';
      clearInterval(heartbeat);
      if (!claimed) setTimeout(connectGateway, 3000);
    };
    ws.onerror = () => {};
    ws.onmessage = (e) => {
      let p; try { p = JSON.parse(e.data); } catch { return; }
      if (p.s) seq = p.s;
      if (p.op === 10) {
        heartbeat = setInterval(() => { try { ws.send(JSON.stringify({ op: 1, d: seq })); } catch {} }, p.d.heartbeat_interval);
        ws.send(JSON.stringify({
          op: 2,
          d: {
            token,
            properties: { os: 'Windows', browser: 'Chrome', device: '', browser_user_agent: UA, browser_version: '131.0.0.0', os_version: '10', system_locale: 'tr-TR', release_channel: 'stable', client_build_number: 371547 },
            intents: 1, capabilities: 16381,
            presence: { status: 'invisible', afk: false, activities: [], since: 0 },
          },
        }));
      } else if (p.op === 0) {
        if (p.t === 'READY') {
          gwStatus = 'READY';
          const monitored = (p.d.guilds || []).filter(g => ownerToCode.has(g.id)).length;
          ok(`Gateway READY — ${monitored}/${vanities.length} izlenen sunucuya üyesin (diğerleri sadece polling)`);
        } else if (p.t === 'GUILD_UPDATE' && p.d) {
          const code = ownerToCode.get(p.d.id);
          if (code) {
            const now = p.d.vanity_url_code?.toLowerCase() || null;
            if (now !== code) {
              info(`[gateway] /${code} değişti → /${now || 'null'}`);
              tryClaim(code, 'gateway GUILD_UPDATE');
            }
          }
        } else if (p.t === 'GUILD_DELETE' && p.d) {
          const code = ownerToCode.get(p.d.id);
          if (code) {
            info(`[gateway] /${code} sunucusu silindi`);
            tryClaim(code, 'gateway GUILD_DELETE');
          }
        }
      } else if (p.op === 9) {
        setTimeout(() => connectGateway(), 2000);
      }
    };
  }
  connectGateway();

  // ─── Round-robin invite polling (yedek) ─────────────────────────────
  const codes = [...codeToOwner.keys()];
  let rrIdx = 0, tick = 0;
  const pollTimer = setInterval(async () => {
    if (claimed || claiming || !codes.length) return;
    const code = codes[rrIdx]; rrIdx = (rrIdx + 1) % codes.length;
    tick++;
    const r = await dreq('GET', `${API}/invites/${encodeURIComponent(code)}`, token);
    if (r.status === 404 || r.data?.code === 10006) {
      tryClaim(code, `invite 404 /${code}`);
    } else if (tick % (codes.length * 5) === 0) {
      log(C.dim + `  · ${Math.floor((Date.now() - started) / 1000)}sn — ${codes.length} URL dolu, gw ${gwStatus}` + C.r);
    }
  }, Math.max(3000, Math.min(10000, codes.length * 1000))); // code sayısına göre adapte

  const stopHandler = () => {
    log('\n' + C.y + '[-] Durduruldu.' + C.r);
    claimed = true;
    try { ws?.close(); } catch {}
    clearInterval(pollTimer); clearInterval(heartbeat); clearInterval(mfaRefresh);
    rl.close(); process.exit(0);
  };
  process.on('SIGINT', stopHandler);

  while (!claimed) await sleep(500);
  clearInterval(pollTimer); clearInterval(heartbeat); clearInterval(mfaRefresh);
  process.off('SIGINT', stopHandler);
}

async function snipe(token) {
  const target = (await ask('Hedef vanity (örn: discord):')).toLowerCase().replace(/^.*\//, '');
  if (!target) return err('Hedef boş');
  const serverId = (await ask(`Hangi sunucuna alınacak? (ID) [${state.lastServerId || ''}]:`)) || state.lastServerId;
  if (!serverId) return err('Sunucu ID boş');

  let secret = state.totpSecret;
  if (secret) {
    info(`TOTP secret kayıtlı — kullanılıyor (${totp(secret)} şu anki kod)`);
  } else {
    secret = (await askHidden('Authenticator (TOTP) secret:')).replace(/\s+/g, '');
    if (!secret) return err('TOTP secret boş');
    state.totpSecret = secret;
  }
  state.lastServerId = serverId; saveState();

  // 1) URL'nin şu an kime ait olduğunu bul (TEK istek)
  info(`Hedef URL'nin sahibi bulunuyor...`);
  const inv = await dreq('GET', `${API}/invites/${encodeURIComponent(target)}?with_counts=true`, token);
  let ownerGuildId = inv.data?.guild?.id || null;
  if (ownerGuildId) {
    ok(`Sahip: ${inv.data.guild.name} (${ownerGuildId})`);
  } else if (inv.status === 404) {
    warn(`URL ŞU AN BOŞ! Direkt alım deneniyor...`);
  } else {
    warn(`Sahip bulunamadı (status ${inv.status}) — sadece polling + gateway devam.`);
  }

  // 2) MFA'yı önceden al — fail olursa monitor başlasın, drop'ta tekrar denenir
  info(`Sunucu için MFA alınıyor (TOTP: ${totp(secret)})...`);
  let mfa = await initMfa(token, secret, serverId, target);
  if (!mfa) {
    warn('Pre-MFA alınamadı (muhtemelen Cloudflare 1015 — IP geçici bloklu).');
    warn('Monitor başlıyor; URL düştüğünde o anda MFA + PATCH denenecek.');
    warn('IP bloku 15–60 dk içinde açılır. VPN/VPS ile sorun yaşamazsın.');
  } else {
    ok(`MFA OK — snipe anında kullanılacak`);
  }
  if (!mfa) {
    err('MFA başarısız — TOTP secret doğru mu? Discord\'da 2FA açık mı? Sistem saati senkronize mi?');
    return;
  }
  ok('MFA OK');

  info('Sunucunun mevcut vanity URL\'si kontrol ediliyor...');
  const g = await dreq('GET', `${API}/guilds/${serverId}`, token);
  const current = g.data?.vanity_url_code;
  if (current) {
    warn(`Sunucuda zaten /${current} var — temizleniyor`);
    const d = await patchVanity(serverId, token, mfa, null);
    if (d.status < 300) ok('Temizlendi');
    else warn('Temizleme uyarısı: ' + (d.data?.message || d.status));
  } else {
    info('Sunucuda vanity yok, direkt snipe moduna geçiliyor.');
  }

  log('');
  ok(`GATEWAY MONİTÖR aktif → hedef: /${target}`);
  if (ownerGuildId) info(`Hedef sunucu: ${ownerGuildId} — gateway'de GUILD_UPDATE bekleniyor`);
  info('Yedek: her 7sn\'de bir /invites kontrolü');
  info('Durdurmak için Ctrl+C');
  hr();

  let claimed = false;
  let claiming = false;
  const started = Date.now();

  async function doClaim(reason) {
    if (claiming || claimed) return;
    claiming = true;
    log(C.y + `\n[!] DÜŞME TESPİT EDİLDİ (${reason}) — PATCH gönderiliyor...` + C.r);

    // mfa yoksa (pre-MFA fail olmuştu) şimdi al
    if (!mfa) {
      info('MFA alınıyor (just-in-time)...');
      mfa = await initMfa(token, secret, serverId, target);
      if (!mfa) {
        err('MFA alınamadı (Cloudflare 1015 hâlâ aktif). IP açılana kadar snipe mümkün değil.');
        claiming = false;
        return;
      }
      ok('MFA alındı, PATCH gönderiliyor');
    }

    for (let attempt = 1; attempt <= 5 && !claimed; attempt++) {
      const r = await patchVanity(serverId, token, mfa, target);
      if (r.status < 300 && typeof r.data?.code === 'string' && r.data.code.toLowerCase() === target) {
        claimed = true;
        hr();
        ok(C.b + `🎯 ALINDI! /${target} → ${serverId}` + C.r);
        const dur = ((Date.now() - started) / 1000).toFixed(1);
        ok(`Süre: ${dur}s, deneme: ${attempt}`);
        await notifyClaim(target, serverId, attempt, dur);
        try { ws?.close(); } catch {}
        try { h2Client?.destroy(); } catch {}
        process.exit(0);
      }
      const code = r.data?.code;
      const msg = r.data?.message || '';
      if (code === 60003) {
        warn(`[${attempt}] MFA expired, yenileniyor...`);
        const nm = await initMfa(token, secret, serverId, target);
        if (!nm) { err('MFA yenileme başarısız'); break; }
        mfa = nm;
      } else if (r.status === 429) {
        const wait = Math.max(500, Number(r.data?.retry_after || 1) * 1000 + 100);
        warn(`[${attempt}] rate limit, ${wait}ms bekleniyor`);
        await sleep(wait);
      } else if (code === 50020) {
        warn(`[${attempt}] hâlâ dolu (muhtemelen başkası daha hızlıydı veya henüz düşmedi)`);
        await sleep(200);
      } else if (code === 50013) {
        err('İzin yok — admin değilsin.'); return;
      } else {
        warn(`[${attempt}] ${msg || 'bilinmeyen hata'} (code ${code})`);
        await sleep(300);
      }
    }
    claiming = false;
  }

  // ─── GATEWAY ─────────────────────────────────────────────────────────
  let ws = null;
  let heartbeat = null;
  let seq = null;
  let sessionId = null;
  let gatewayStatus = 'bağlanıyor';

  function connectGateway() {
    gatewayStatus = 'bağlanıyor';
    ws = new WebSocket('wss://gateway.discord.gg/?v=10&encoding=json');
    ws.onopen = () => { gatewayStatus = 'açık'; };
    ws.onclose = () => {
      gatewayStatus = 'kapandı';
      clearInterval(heartbeat);
      if (!claimed) {
        warn('Gateway kapandı, 3sn sonra tekrar bağlanılıyor...');
        setTimeout(connectGateway, 3000);
      }
    };
    ws.onerror = () => {};
    ws.onmessage = (e) => {
      let p;
      try { p = JSON.parse(e.data); } catch { return; }
      if (p.s) seq = p.s;

      if (p.op === 10) {
        // HELLO
        heartbeat = setInterval(() => {
          try { ws.send(JSON.stringify({ op: 1, d: seq })); } catch {}
        }, p.d.heartbeat_interval);
        // IDENTIFY
        ws.send(JSON.stringify({
          op: 2,
          d: {
            token,
            properties: {
              os: 'Windows', browser: 'Chrome', device: '',
              browser_user_agent: UA, browser_version: '131.0.0.0',
              os_version: '10', system_locale: 'tr-TR',
              release_channel: 'stable', client_build_number: 371547,
            },
            intents: 1, // GUILDS = 1
            capabilities: 16381,
            presence: { status: 'invisible', afk: false, activities: [], since: 0 },
          },
        }));
      } else if (p.op === 0) {
        if (p.t === 'READY') {
          sessionId = p.d.session_id;
          gatewayStatus = 'READY';
          const inThisGuild = (p.d.guilds || []).find(g => g.id === ownerGuildId);
          ok(`Gateway READY — ${(p.d.guilds || []).length} guild. Hedef guild'da: ${inThisGuild ? '✓' : '✗ (join değilsin → yalnız polling)'}`);
        } else if (p.t === 'GUILD_UPDATE' && p.d) {
          // Hedef sunucu güncellendi
          if (p.d.id === ownerGuildId) {
            const nowVanity = p.d.vanity_url_code;
            info(`[gateway] GUILD_UPDATE: /${nowVanity || '(null)'}`);
            if (!nowVanity || String(nowVanity).toLowerCase() !== target) {
              doClaim('gateway GUILD_UPDATE');
            }
          }
        } else if (p.t === 'GUILD_DELETE' && p.d?.id === ownerGuildId) {
          info(`[gateway] GUILD_DELETE: hedef sunucu silindi → URL düşmüş olmalı`);
          doClaim('gateway GUILD_DELETE');
        }
      } else if (p.op === 9) {
        // Invalid session, re-identify
        setTimeout(() => connectGateway(), 2000);
      }
    };
  }
  connectGateway();

  // ─── Hafif polling (yedek) ───────────────────────────────────────────
  let pollTick = 0;
  const pollTimer = setInterval(async () => {
    if (claimed || claiming) return;
    pollTick++;
    const r = await dreq('GET', `${API}/invites/${encodeURIComponent(target)}`, token);
    if (r.status === 404 || r.data?.code === 10006) {
      doClaim('invite 404');
    } else if (pollTick % 10 === 0) {
      log(C.dim + `  · ${pollTick * 7}sn — hâlâ dolu, gateway: ${gatewayStatus}` + C.r);
    }
  }, 7000);

  const stopHandler = () => {
    log('\n' + C.y + '[-] Durduruldu.' + C.r);
    claimed = true;
    try { ws?.close(); } catch {}
    try { h2Client?.destroy(); } catch {}
    clearInterval(pollTimer);
    clearInterval(heartbeat);
    rl.close();
    process.exit(0);
  };
  process.on('SIGINT', stopHandler);

  // Döngü — claimed olana kadar beklet (event'ler tetikleyecek)
  while (!claimed) {
    await sleep(500);
  }
  clearInterval(pollTimer);
  clearInterval(heartbeat);
  process.off('SIGINT', stopHandler);
}

// ─── Menü ──────────────────────────────────────────────────────────────
async function menu() {
  banner();
  while (true) {
    log(`${C.b}MENÜ${C.r}`);
    log(`  1) Token gir / değiştir  ${state.token ? C.g + '✓' + C.r : C.red + '✗' + C.r}`);
    log(`  2) Tüm sunucuların vanity URL'lerini listele`);
    log(`  3) SNIPE başlat (tek URL)  ${state.totpSecret ? C.g + '(TOTP kayıtlı)' + C.r : ''}`);
    log(`  4) AUTO-SCAN — tüm URL'leri izle, ilk düşeni al`);
    log(`  5) Webhook ayarla  ${state.webhookUrl ? C.g + '(kayıtlı)' + C.r : C.dim + '(yok)' + C.r}`);
    log(`  6) TOTP secret temizle`);
    log(`  7) Çık`);
    const c = await ask('Seçim:');
    log('');

    if (c === '1') {
      const t = await askHidden('Discord user token:');
      if (!t) { err('Boş token'); continue; }
      info('Token doğrulanıyor...');
      const u = await verifyToken(t);
      if (!u) { err('Token geçersiz'); continue; }
      ok(`Giriş: ${u.global_name || u.username} (${u.id})`);
      state.token = t; saveState();
    } else if (c === '2') {
      if (!state.token) { err('Önce token gir (1).'); continue; }
      await showVanities(state.token);
    } else if (c === '3') {
      if (!state.token) { err('Önce token gir (1).'); continue; }
      await snipe(state.token);
    } else if (c === '4') {
      if (!state.token) { err('Önce token gir (1).'); continue; }
      await autoScan(state.token);
    } else if (c === '5') {
      const url = await ask(`Webhook URL (boş = sil) [${state.webhookUrl ? 'kayıtlı' : 'yok'}]:`);
      if (!url) { state.webhookUrl = null; saveState(); ok('Webhook silindi.'); }
      else if (!/^https:\/\/(canary\.|ptb\.)?discord(app)?\.com\/api\/webhooks\//.test(url)) {
        err('Geçersiz Discord webhook URL.');
      } else {
        state.webhookUrl = url; saveState();
        ok('Webhook kaydedildi. Test gönderiliyor...');
        const r = await sendWebhook(url, '✅ **Sniper webhook test** — bağlantı başarılı.');
        if (r) ok('Test mesajı gönderildi.'); else err('Webhook gönderilemedi.');
      }
    } else if (c === '6') {
      state.totpSecret = null; saveState();
      ok('TOTP secret silindi.');
    } else if (c === '7' || c === 'q') {
      rl.close();
      process.exit(0);
    } else {
      warn('Geçersiz seçim');
    }
    log('');
  }
}

// ─── Auto-start modu (watchdog.bat `node sniper.js auto` ile çağırır) ─
if (process.argv[2] === 'auto') {
  if (!state.token || !state.totpSecret || !state.lastServerId) {
    err('Auto mod için önce menüden token + TOTP + sunucu ID ayarla.');
    err('Boş çalıştır: node sniper.js');
    process.exit(1);
  }
  banner();
  ok(`[AUTO MOD] ${new Date().toLocaleString('tr-TR')}`);
  ok(`Hedef sunucu: ${state.lastServerId}`);
  autoScan(state.token, true).catch((e) => {
    err('Auto scan crashed: ' + (e.stack || e.message));
    process.exit(1);
  });
} else {
  menu().catch((e) => { err(e.stack || e.message); process.exit(1); });
}
