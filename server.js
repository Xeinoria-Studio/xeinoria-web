const express = require('express');
const path = require('path');
const dotenv = require('dotenv');
const { status } = require('minecraft-server-util');
const fs = require('fs');
const os = require('os');
const { Transform } = require('stream');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

dotenv.config();

const app = express();

const PORT = Number(process.env.PORT || 8080);
const MC_HOST = process.env.MC_HOST || '127.0.0.1';
const MC_PORT = Number(process.env.MC_PORT || 25565);
const STATUS_TIMEOUT_MS = Number(process.env.STATUS_TIMEOUT_MS || 3000);
const STATUS_CACHE_TTL_MS = Number(process.env.STATUS_CACHE_TTL_MS || 15000);
const HTTP_TIMEOUT_MS = Number(process.env.HTTP_TIMEOUT_MS || 5000);
const ASSUME_MAINTENANCE_WHEN_OFFLINE = String(process.env.ASSUME_MAINTENANCE_WHEN_OFFLINE || 'false').toLowerCase() === 'true';
const MAINTENANCE_KEYWORDS = (process.env.MAINTENANCE_KEYWORDS || 'maintenance,maint,ferme,closed')
  .split(',')
  .map((v) => v.trim().toLowerCase())
  .filter(Boolean);
const MAP_REDIRECT_URL = process.env.MAP_REDIRECT_URL || 'https://map.norath.fr';
const TWITCH_URL = process.env.TWITCH_URL || 'https://www.twitch.tv/norath_1211';
const TWITCH_CHANNEL_LOGIN = process.env.TWITCH_CHANNEL_LOGIN || 'norath_1211';
const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID || '';
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET || '';
const TWITCH_PARENT_DOMAINS = (process.env.TWITCH_PARENT_DOMAINS || 'norath.fr,www.norath.fr,localhost,127.0.0.1')
  .split(',')
  .map((v) => v.trim())
  .filter(Boolean);
const SERVER_DISPLAY_NAME = process.env.SERVER_DISPLAY_NAME || 'NORATH';
const SERVER_JOIN_IP = process.env.SERVER_JOIN_IP || 'norath.fr';
const CONTACT_EMAIL = process.env.CONTACT_EMAIL || '';
const BACKGROUND_IMAGE = process.env.BACKGROUND_IMAGE || '/assets/bg-norath-v2.svg';
const BACKGROUND_BLUR_PX = Number(process.env.BACKGROUND_BLUR_PX || 1);
const BACKGROUND_OVERLAY_OPACITY = Number(process.env.BACKGROUND_OVERLAY_OPACITY || 0.26);
const DOWNLOAD_MANIFEST_PATH = process.env.DOWNLOAD_MANIFEST_PATH || '/srv/xeinoria-downloads/survie/manifest.json';
const DOWNLOAD_PUBLIC_BASE = process.env.DOWNLOAD_PUBLIC_BASE || '/download/survie';
const DOWNLOAD_SERVE_DIR = process.env.DOWNLOAD_SERVE_DIR || '/srv/xeinoria-downloads/survie';
const DOWNLOAD_ENABLED_FLAG = path.join(DOWNLOAD_SERVE_DIR, '.enabled');
const DOWNLOAD_CONFIG_PATH = process.env.DOWNLOAD_CONFIG_PATH || path.join(DOWNLOAD_SERVE_DIR, '.dl_config.json');
const DOWNLOAD_TOKEN_SECRET_PATH = process.env.DOWNLOAD_TOKEN_SECRET_PATH || path.join(DOWNLOAD_SERVE_DIR, '.dl_token_secret');
const DOWNLOAD_ADMIN_IPS_PATH = process.env.DOWNLOAD_ADMIN_IPS_PATH || path.join(DOWNLOAD_SERVE_DIR, '.dl_admin_ips.json');
const DOWNLOAD_ADMIN_IPS_TTL_MS = 7 * 24 * 3600 * 1000; // 7 jours
const DOWNLOAD_RESTRICTED_IPS_PATH = process.env.DOWNLOAD_RESTRICTED_IPS_PATH || path.join(DOWNLOAD_SERVE_DIR, '.dl_restricted_ips.json');
const DOWNLOAD_LITEBANS_DB = process.env.DOWNLOAD_LITEBANS_DB || 'minecraft';
const DOWNLOAD_LITEBANS_USER = process.env.DOWNLOAD_LITEBANS_USER || 'user';
const DOWNLOAD_LITEBANS_PASS = process.env.DOWNLOAD_LITEBANS_PASS || 'password';

// Suivi des téléchargements actifs
// Map<id, { ip, filename, startTime, bytesTransferred, totalBytes }>
const activeDownloads = new Map();
// Liste des derniers DL termines (avec raison reelle). LRU avec TTL ~120s.
// Permet au Skript de connaitre la raison de fin (done/cancel_user/cancel_admin/error/disabled)
const recentlyFinished = new Map(); // id -> { ts, ip, status, doneBytes, totalBytes, elapsedMs, pct }
const RECENT_FINISHED_TTL_MS = 120 * 1000;
const RECENT_FINISHED_MAX = 100;
function _pruneRecentlyFinished() {
  const now = Date.now();
  for (const [id, e] of recentlyFinished) {
    if (now - e.ts > RECENT_FINISHED_TTL_MS) recentlyFinished.delete(id);
  }
  // Cap absolu
  while (recentlyFinished.size > RECENT_FINISHED_MAX) {
    const firstKey = recentlyFinished.keys().next().value;
    recentlyFinished.delete(firstKey);
  }
}
let _dlIdSeq = 0;
let _dlVersion = 0; // incrémenté à chaque add/remove pour le polling côté Skript
function _bumpDlVersion() { _dlVersion = (_dlVersion + 1) % 1000000; }

// ---------------------------------------------------------------------------
//  Config DL : VPN, ban, captcha, max_gb (stockée dans .dl_config.json)
// ---------------------------------------------------------------------------
const DL_CONFIG_DEFAULTS = {
  block_vpn: true,
  block_banned: true,
  admin_whitelist_enabled: true,
  vpn_whitelist: [],
  captcha_min_ms: 2500,
  captcha_max_ms: 600000,
  max_gb: 50,
  // ---- Bande passante (KB/s = kilo-octets/seconde) ----
  bandwidth_mode: 'auto',          // 'auto' | 'manual' | 'unlimited'
  bandwidth_per_user_kbs: 10240,   // 'manual' : vitesse fixe par DL (10 MB/s)
  bandwidth_total_kbs: 51200,      // 'auto' : cap global a partager (50 MB/s)
  bandwidth_min_kbs: 2048,         // 'auto' : plancher par DL (2 MB/s)
  bandwidth_max_kbs: 20480,        // 'auto' : plafond par DL (20 MB/s)
  bandwidth_load_threshold: 0,     // 0 = desactive ; sinon load avg 1m seuil (ex: 4.0)
  bandwidth_load_penalty_pct: 50,  // si load > seuil : multiplie rate par 1 - X/100
};
function loadDlConfig() {
  try {
    const raw = fs.readFileSync(DOWNLOAD_CONFIG_PATH, 'utf8');
    return Object.assign({}, DL_CONFIG_DEFAULTS, JSON.parse(raw));
  } catch {
    return Object.assign({}, DL_CONFIG_DEFAULTS);
  }
}
function saveDlConfig(cfg) {
  const merged = Object.assign({}, DL_CONFIG_DEFAULTS, cfg);
  const tmp = DOWNLOAD_CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2));
  fs.renameSync(tmp, DOWNLOAD_CONFIG_PATH);
  try { _invalidateBwCfgCache(); } catch { /* not initialized yet */ }
  return merged;
}

// Secret HMAC persistant (généré au premier démarrage)
function getTokenSecret() {
  try {
    return fs.readFileSync(DOWNLOAD_TOKEN_SECRET_PATH);
  } catch {
    const buf = crypto.randomBytes(32);
    try { fs.writeFileSync(DOWNLOAD_TOKEN_SECRET_PATH, buf, { mode: 0o600 }); } catch { /* ignore */ }
    return buf;
  }
}
const TOKEN_SECRET = getTokenSecret();

function signToken(ts, ip) {
  const payload = `${ts}|${ip}`;
  const sig = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('base64url');
  return Buffer.from(payload).toString('base64url') + '.' + sig;
}
function verifyToken(token, ip, maxAgeMs) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [payloadB64, sig] = token.split('.');
  let payload;
  try { payload = Buffer.from(payloadB64, 'base64url').toString('utf8'); } catch { return null; }
  const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('base64url');
  let sigBuf, expBuf;
  try {
    sigBuf = Buffer.from(sig);
    expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length) return null;
    if (!crypto.timingSafeEqual(sigBuf, expBuf)) return null;
  } catch { return null; }
  const sep = payload.indexOf('|');
  if (sep <= 0) return null;
  const tsStr = payload.slice(0, sep);
  const tokIp = payload.slice(sep + 1);
  const ts = parseInt(tsStr, 10);
  if (!Number.isFinite(ts)) return null;
  const age = Date.now() - ts;
  if (age < 0 || age > maxAgeMs) return null;
  // Note: on n'impose plus tokIp === ip. Les clients mobiles (happy-eyeballs
  // IPv4/IPv6, CGNAT, bascule WiFi/4G) peuvent changer d'IP entre la generation
  // du token (POST /api/dl-token) et son utilisation (GET /download/...).
  // La securite reste assuree par : HMAC, TTL court (captcha_max_ms),
  // single-use (burnToken) et delai mini anti-bot (captcha_min_ms).
  return { ts, age, tokIp, ipChanged: tokIp !== ip };
}

// Cache VPN check (Map<ip, { proxy, hosting, expiresAt }>)
const vpnCache = new Map();
const VPN_CACHE_TTL_MS = 3600 * 1000;
async function isVpnIp(ip) {
  if (/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(ip) || ip === '::1') {
    return { proxy: false, hosting: false, local: true };
  }
  const now = Date.now();
  const cached = vpnCache.get(ip);
  if (cached && cached.expiresAt > now) return cached;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2500);
    const r = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,proxy,hosting,query`, { signal: ctrl.signal });
    clearTimeout(t);
    const j = await r.json();
    const entry = { proxy: !!j.proxy, hosting: !!j.hosting, expiresAt: now + VPN_CACHE_TTL_MS };
    vpnCache.set(ip, entry);
    return entry;
  } catch (e) {
    return { proxy: false, hosting: false, error: String(e && e.message || e) };
  }
}

// Vérifie si une IP est ban active dans LiteBans (via mysql CLI subprocess)
function isIpBanned(ip) {
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) return null;
  try {
    const out = execFileSync('mysql', [
      '--batch', '--skip-column-names',
      `-u${DOWNLOAD_LITEBANS_USER}`,
      `-p${DOWNLOAD_LITEBANS_PASS}`,
      '-D', DOWNLOAD_LITEBANS_DB,
      '--execute', `SELECT reason FROM litebans_bans WHERE ip='${ip.replace(/'/g, '')}' AND active=1 AND (until=0 OR until>UNIX_TIMESTAMP()*1000) LIMIT 1;`
    ], { timeout: 3000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const trimmed = (out || '').trim();
    if (!trimmed) return null;
    return trimmed.split('\n')[0];
  } catch {
    return null;
  }
}

// --- Admin IP whitelist (auto, TTL 7j) -------------------------------------
function loadAdminIps() {
  try {
    const raw = fs.readFileSync(DOWNLOAD_ADMIN_IPS_PATH, 'utf8');
    const obj = JSON.parse(raw);
    return (obj && typeof obj === 'object') ? obj : {};
  } catch { return {}; }
}
function saveAdminIps(map) {
  const tmp = DOWNLOAD_ADMIN_IPS_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(map, null, 2));
  fs.renameSync(tmp, DOWNLOAD_ADMIN_IPS_PATH);
}
function pruneAdminIps(map) {
  const now = Date.now();
  let changed = false;
  for (const ip of Object.keys(map)) {
    const e = map[ip];
    const last = (e && typeof e === 'object') ? (e.last || 0) : (typeof e === 'number' ? e : 0);
    if (!last || (now - last) > DOWNLOAD_ADMIN_IPS_TTL_MS) {
      delete map[ip];
      changed = true;
    }
  }
  return changed;
}
function isAdminIp(ip) {
  const map = loadAdminIps();
  if (pruneAdminIps(map)) {
    try { saveAdminIps(map); } catch { /* ignore */ }
  }
  const e = map[ip];
  if (!e) return false;
  const last = (typeof e === 'object') ? (e.last || 0) : e;
  return last && (Date.now() - last) <= DOWNLOAD_ADMIN_IPS_TTL_MS;
}
function recordAdminIp(ip, name) {
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) return false;
  const map = loadAdminIps();
  pruneAdminIps(map);
  map[ip] = { last: Date.now(), name: String(name || '').slice(0, 32) };
  try { saveAdminIps(map); } catch { /* ignore */ }
  return true;
}

// --- Tokens captcha brûlés (single-use) -----------------------------------
// Map<token, expiresAt_ms>. Un token utilisé une fois ne peut plus servir,
// même si sa signature HMAC est valide et son TTL non expiré. Empêche le
// retry automatique du navigateur après un cancel/interruption.
const burnedTokens = new Map();
function burnToken(token, expiresAt) {
  if (!token) return;
  burnedTokens.set(token, expiresAt || (Date.now() + 600000));
}
function isTokenBurned(token) {
  if (!token) return false;
  const exp = burnedTokens.get(token);
  if (!exp) return false;
  if (Date.now() > exp) { burnedTokens.delete(token); return false; }
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [t, exp] of burnedTokens) {
    if (exp < now) burnedTokens.delete(t);
  }
}, 60 * 1000).unref();

// --- IP restreintes (blacklist temporaire) --------------------------------
// Format: { "<ip>": { until_ms, since_ms, reason, by } }
// until_ms = 0 => restriction permanente (jusqu'à unrestrict manuel).
function loadRestrictedIps() {
  try {
    const raw = fs.readFileSync(DOWNLOAD_RESTRICTED_IPS_PATH, 'utf8');
    const obj = JSON.parse(raw);
    return (obj && typeof obj === 'object') ? obj : {};
  } catch { return {}; }
}
function saveRestrictedIps(map) {
  const tmp = DOWNLOAD_RESTRICTED_IPS_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(map, null, 2));
  fs.renameSync(tmp, DOWNLOAD_RESTRICTED_IPS_PATH);
}
function pruneRestrictedIps(map) {
  const now = Date.now();
  let changed = false;
  for (const ip of Object.keys(map)) {
    const e = map[ip];
    if (!e || typeof e !== 'object') { delete map[ip]; changed = true; continue; }
    if (e.until_ms && e.until_ms > 0 && e.until_ms <= now) {
      delete map[ip];
      changed = true;
    }
  }
  return changed;
}
function isRestricted(ip) {
  const map = loadRestrictedIps();
  if (pruneRestrictedIps(map)) { try { saveRestrictedIps(map); } catch { /* ignore */ } }
  const e = map[ip];
  if (!e) return null;
  if (e.until_ms && e.until_ms > 0 && e.until_ms <= Date.now()) return null;
  return e;
}
function restrictIp(ip, durationSec, reason, by) {
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) return null;
  const map = loadRestrictedIps();
  pruneRestrictedIps(map);
  const now = Date.now();
  const sec = Number.isFinite(durationSec) ? Math.max(0, Math.floor(durationSec)) : 86400;
  const entry = {
    since_ms: now,
    until_ms: sec > 0 ? (now + sec * 1000) : 0,
    reason: String(reason || '').slice(0, 200),
    by: String(by || '').slice(0, 32),
  };
  map[ip] = entry;
  try { saveRestrictedIps(map); } catch { /* ignore */ }
  return entry;
}
function unrestrictIp(ip) {
  const map = loadRestrictedIps();
  if (!map[ip]) return false;
  delete map[ip];
  try { saveRestrictedIps(map); } catch { /* ignore */ }
  return true;
}

// --- Bande passante : throttle adaptatif ----------------------------------
// Token bucket : on convertit la config (KB/s) en bytes/s. Le getter est
// rappele a chaque chunk, ce qui rend la vitesse dynamique :
//   - mode 'unlimited' : aucune limite
//   - mode 'manual'    : bandwidth_per_user_kbs * 1024 par DL
//   - mode 'auto'      : (bandwidth_total_kbs / nb DL actifs) clampe entre
//                        bandwidth_min_kbs et bandwidth_max_kbs
// Si bandwidth_load_threshold > 0 et load avg 1m > seuil, multiplie par
// (1 - penalty_pct/100). Permet d'absorber automatiquement les pics de DL
// simultanes sans plomber le serveur Minecraft.

// Cache leger pour eviter de relire la config a chaque chunk (16 KiB).
let _bwCfgCache = { ts: 0, cfg: null };
function _getBwCfg() {
  const now = Date.now();
  if (_bwCfgCache.cfg && (now - _bwCfgCache.ts) < 1000) return _bwCfgCache.cfg;
  _bwCfgCache = { ts: now, cfg: loadDlConfig() };
  return _bwCfgCache.cfg;
}
function _invalidateBwCfgCache() { _bwCfgCache = { ts: 0, cfg: null }; }

function computeRateBytesPerSec() {
  const cfg = _getBwCfg();
  const mode = cfg.bandwidth_mode || 'auto';
  if (mode === 'unlimited') return Infinity;
  const activeCount = Math.max(1, activeDownloads.size);
  let kbs;
  if (mode === 'manual') {
    kbs = cfg.bandwidth_per_user_kbs || DL_CONFIG_DEFAULTS.bandwidth_per_user_kbs;
  } else {
    // auto
    const total = cfg.bandwidth_total_kbs || DL_CONFIG_DEFAULTS.bandwidth_total_kbs;
    const min = cfg.bandwidth_min_kbs || DL_CONFIG_DEFAULTS.bandwidth_min_kbs;
    const max = cfg.bandwidth_max_kbs || DL_CONFIG_DEFAULTS.bandwidth_max_kbs;
    kbs = Math.floor(total / activeCount);
    if (kbs < min) kbs = min;
    if (kbs > max) kbs = max;
  }
  // Penalite charge systeme
  const thr = cfg.bandwidth_load_threshold || 0;
  if (thr > 0) {
    const load = os.loadavg()[0];
    if (load > thr) {
      const pen = Math.max(0, Math.min(95, cfg.bandwidth_load_penalty_pct || 0));
      kbs = Math.floor(kbs * (1 - pen / 100));
    }
  }
  if (kbs < 64) kbs = 64; // plancher absolu
  return kbs * 1024;
}

// Transform stream : token bucket. Burst max = rate (1s de debit).
function makeBandwidthThrottle(getRate) {
  let lastTs = Date.now();
  let bucket = 0;
  return new Transform({
    transform(chunk, enc, cb) {
      const rate = getRate();
      if (!Number.isFinite(rate) || rate <= 0) {
        // unlimited
        this.push(chunk);
        return cb();
      }
      const now = Date.now();
      bucket += ((now - lastTs) / 1000) * rate;
      lastTs = now;
      if (bucket > rate) bucket = rate;

      const self = this;
      const sendRest = (data) => {
        if (!data || data.length === 0) return cb();
        const curRate = getRate();
        const curNow = Date.now();
        bucket += ((curNow - lastTs) / 1000) * curRate;
        lastTs = curNow;
        if (bucket > curRate) bucket = curRate;
        const allowed = Math.max(0, Math.floor(bucket));
        if (allowed >= data.length) {
          bucket -= data.length;
          self.push(data);
          return cb();
        }
        if (allowed > 0) {
          bucket -= allowed;
          self.push(data.slice(0, allowed));
          data = data.slice(allowed);
        }
        // wait until enough tokens are available
        const need = data.length;
        const ms = Math.max(15, Math.ceil((need / curRate) * 1000));
        setTimeout(() => sendRest(data), Math.min(ms, 500));
      };
      sendRest(chunk);
    }
  });
}

// Page d'erreur stylisée renvoyée pour les rejets de /dl/survie/latest
function sendDlError(res, status, title, message, showRetryButton) {
  const safe = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const retryBtn = showRetryButton
    ? '<a class="btn primary" href="/telechargement">Recharger la page</a>'
    : '';
  const html = `<!doctype html>
<html lang="fr"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${safe(title)} — Xeinoria</title>
<style>
  :root{--bg:#0b0d12;--card:#151821;--border:#262b38;--text:#e6e8ec;--muted:#8a92a6;--accent:#8b5cf6;--accent2:#22c55e}
  *{box-sizing:border-box}
  body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:radial-gradient(1200px 600px at 50% -200px,#1a1330 0,#0b0d12 60%) fixed,#0b0d12;color:var(--text);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
  .card{max-width:520px;width:100%;background:var(--card);border:1px solid var(--border);border-radius:16px;padding:32px;box-shadow:0 20px 60px rgba(0,0,0,.5);text-align:center}
  .badge{display:inline-block;padding:4px 10px;border-radius:999px;background:rgba(139,92,246,.15);color:var(--accent);font-size:12px;font-weight:600;letter-spacing:.5px;text-transform:uppercase;margin-bottom:18px}
  h1{margin:0 0 12px;font-size:24px;font-weight:700}
  p{margin:0 0 24px;color:var(--muted);line-height:1.6}
  .actions{display:flex;gap:10px;justify-content:center;flex-wrap:wrap}
  .btn{display:inline-flex;align-items:center;gap:6px;padding:10px 18px;border-radius:10px;font-weight:600;text-decoration:none;font-size:14px;transition:transform .1s,background .15s;cursor:pointer;border:0}
  .btn.primary{background:var(--accent);color:#fff}
  .btn.primary:hover{background:#7c4def}
  .btn.ghost{background:transparent;color:var(--text);border:1px solid var(--border)}
  .btn.ghost:hover{background:rgba(255,255,255,.05)}
  .footer{margin-top:22px;font-size:12px;color:var(--muted)}
  .footer a{color:var(--accent)}
</style>
</head><body>
  <div class="card">
    <span class="badge">Xeinoria</span>
    <h1>${safe(title)}</h1>
    <p>${safe(message)}</p>
    <div class="actions">
      <a class="btn ghost" href="javascript:history.length>1?history.back():location.assign('/')">&larr; Retour</a>
      ${retryBtn}
    </div>
    <div class="footer">Besoin d'aide ? Rejoins le Discord depuis <a href="/">la page d'accueil</a>.</div>
  </div>
</body></html>`;
  res.status(status).type('html').send(html);
}

function fmtBytes(b) {
  if (b >= 1073741824) return (b / 1073741824).toFixed(1) + ' GB';
  if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MB';
  return Math.round(b / 1024) + ' KB';
}
function fmtRate(bytesPerSec) {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return '0 KB/s';
  return fmtBytes(bytesPerSec) + '/s';
}
function fmtElapsed(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  if (m >= 60) return Math.floor(m / 60) + 'h' + (m % 60) + 'm';
  if (m > 0) return m + 'm' + (s % 60) + 's';
  return s + 's';
}

const MC_COLORS = {
  '0': '#000000',
  '1': '#0000AA',
  '2': '#00AA00',
  '3': '#00AAAA',
  '4': '#AA0000',
  '5': '#AA00AA',
  '6': '#FFAA00',
  '7': '#AAAAAA',
  '8': '#555555',
  '9': '#5555FF',
  a: '#55FF55',
  b: '#55FFFF',
  c: '#FF5555',
  d: '#FF55FF',
  e: '#FFFF55',
  f: '#FFFFFF'
};

const publicDir = path.join(__dirname, 'public');

let statusCache = {
  expiresAt: 0,
  payload: null
};

let twitchTokenCache = {
  expiresAt: 0,
  token: ''
};

let twitchLiveCache = {
  expiresAt: 0,
  payload: null
};

function clamp(value, min, max) {
  if (Number.isNaN(value)) {
    return min;
  }

  if (value < min) {
    return min;
  }

  if (value > max) {
    return max;
  }

  return value;
}

async function fetchJsonWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });

    const data = await response.json();
    return {
      response,
      data
    };
  } finally {
    clearTimeout(timer);
  }
}

function buildTwitchEmbedUrl(channelLogin) {
  const base = new URL('https://player.twitch.tv/');
  base.searchParams.set('channel', channelLogin);
  base.searchParams.set('muted', 'true');

  TWITCH_PARENT_DOMAINS.forEach((domain) => {
    base.searchParams.append('parent', domain);
  });

  return base.toString();
}

async function getTwitchAppToken() {
  if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) {
    return '';
  }

  const now = Date.now();
  if (twitchTokenCache.token && now < twitchTokenCache.expiresAt) {
    return twitchTokenCache.token;
  }

  const tokenUrl = new URL('https://id.twitch.tv/oauth2/token');
  tokenUrl.searchParams.set('client_id', TWITCH_CLIENT_ID);
  tokenUrl.searchParams.set('client_secret', TWITCH_CLIENT_SECRET);
  tokenUrl.searchParams.set('grant_type', 'client_credentials');

  const { response, data } = await fetchJsonWithTimeout(tokenUrl.toString(), {
    method: 'POST'
  }, HTTP_TIMEOUT_MS);

  if (!response.ok || !data.access_token) {
    throw new Error('Failed to get Twitch token');
  }

  const expiresInSec = Number(data.expires_in || 3600);
  twitchTokenCache = {
    token: data.access_token,
    expiresAt: now + Math.max((expiresInSec - 60) * 1000, 60000)
  };

  return twitchTokenCache.token;
}

async function fetchTwitchLiveStatus() {
  const now = Date.now();
  if (twitchLiveCache.payload && now < twitchLiveCache.expiresAt) {
    return twitchLiveCache.payload;
  }

  const fallbackPayload = {
    ok: true,
    available: false,
    live: false,
    channelLogin: TWITCH_CHANNEL_LOGIN,
    channelUrl: TWITCH_URL,
    embedUrl: buildTwitchEmbedUrl(TWITCH_CHANNEL_LOGIN)
  };

  if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) {
    twitchLiveCache = {
      payload: fallbackPayload,
      expiresAt: now + 60000
    };
    return fallbackPayload;
  }

  try {
    const token = await getTwitchAppToken();
    const streamUrl = new URL('https://api.twitch.tv/helix/streams');
    streamUrl.searchParams.set('user_login', TWITCH_CHANNEL_LOGIN);

    const { response, data } = await fetchJsonWithTimeout(streamUrl.toString(), {
      headers: {
        'Client-Id': TWITCH_CLIENT_ID,
        Authorization: `Bearer ${token}`
      }
    }, HTTP_TIMEOUT_MS);

    if (!response.ok || !Array.isArray(data.data)) {
      throw new Error('Failed Twitch stream request');
    }

    const stream = data.data[0] || null;
    const payload = {
      ok: true,
      available: true,
      live: Boolean(stream),
      channelLogin: TWITCH_CHANNEL_LOGIN,
      channelUrl: TWITCH_URL,
      embedUrl: buildTwitchEmbedUrl(TWITCH_CHANNEL_LOGIN),
      title: stream ? stream.title : '',
      viewerCount: stream ? Number(stream.viewer_count || 0) : 0
    };

    twitchLiveCache = {
      payload,
      expiresAt: now + 60000
    };

    return payload;
  } catch (error) {
    const payload = {
      ...fallbackPayload,
      available: true,
      error: 'Twitch API unavailable'
    };

    twitchLiveCache = {
      payload,
      expiresAt: now + 30000
    };

    return payload;
  }
}

function getMotdText(motd) {
  if (!motd) {
    return '';
  }

  if (typeof motd === 'string') {
    return motd;
  }

  if (Array.isArray(motd.raw)) {
    return motd.raw.join(' ').trim();
  }

  if (typeof motd.raw === 'string') {
    return motd.raw;
  }

  if (Array.isArray(motd.clean)) {
    return motd.clean.join(' ').trim();
  }

  if (typeof motd.clean === 'string') {
    return motd.clean;
  }

  return '';
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function motdToColoredHtml(input) {
  const value = String(input || '');
  const normalized = value.replace(/\\u00A7/g, '§');

  let currentColor = MC_COLORS.f;
  let bold = false;
  let italic = false;
  let underlined = false;
  let strikethrough = false;
  let obfuscated = false;
  let buffer = '';
  let html = '';

  function flush() {
    if (!buffer) {
      return;
    }

    const styles = [
      `color:${currentColor}`,
      bold ? 'font-weight:700' : '',
      italic ? 'font-style:italic' : '',
      underlined ? 'text-decoration:underline' : '',
      strikethrough ? 'text-decoration:line-through' : ''
    ].filter(Boolean).join(';');

    const className = obfuscated ? 'mc-obfuscated' : '';
    html += `<span class="${className}" style="${styles}">${escapeHtml(buffer)}</span>`;
    buffer = '';
  }

  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i];
    const next = normalized[i + 1];

    if (char === '§' && next) {
      flush();
      const code = next.toLowerCase();

      if (MC_COLORS[code]) {
        currentColor = MC_COLORS[code];
        bold = false;
        italic = false;
        underlined = false;
        strikethrough = false;
        obfuscated = false;
      } else if (code === 'l') {
        bold = true;
      } else if (code === 'o') {
        italic = true;
      } else if (code === 'n') {
        underlined = true;
      } else if (code === 'm') {
        strikethrough = true;
      } else if (code === 'k') {
        obfuscated = true;
      } else if (code === 'r') {
        currentColor = MC_COLORS.f;
        bold = false;
        italic = false;
        underlined = false;
        strikethrough = false;
        obfuscated = false;
      }

      i += 1;
      continue;
    }

    buffer += char;
  }

  flush();
  return html || escapeHtml(value);
}

function sanitizeMotd(value) {
  return value
    .replace(/\\u00A7[0-9A-FK-OR]/gi, '')
    .replace(/§[0-9A-FK-OR]/gi, '')
    .trim();
}

function detectMaintenanceFromMotd(motdText) {
  const text = motdText.toLowerCase();
  return MAINTENANCE_KEYWORDS.some((keyword) => text.includes(keyword));
}

async function fetchServerStatus() {
  const now = Date.now();
  if (statusCache.payload && now < statusCache.expiresAt) {
    return statusCache.payload;
  }

  let payload;

  try {
    const response = await status(MC_HOST, MC_PORT, {
      timeout: STATUS_TIMEOUT_MS,
      enableSRV: true
    });

    const motdRaw = getMotdText(response.motd);
    const motdText = sanitizeMotd(motdRaw);
    const maintenance = detectMaintenanceFromMotd(motdText);

    payload = {
      ok: true,
      online: true,
      maintenance,
      playersOnline: response.players.online,
      playersMax: response.players.max,
      version: response.version.name,
      motd: motdText,
      motdHtml: motdToColoredHtml(motdRaw),
      checkedAt: new Date().toISOString()
    };
  } catch (error) {
    payload = {
      ok: true,
      online: false,
      maintenance: ASSUME_MAINTENANCE_WHEN_OFFLINE,
      playersOnline: 0,
      playersMax: 0,
      version: null,
      motd: '',
      motdHtml: '-',
      checkedAt: new Date().toISOString(),
      error: 'Server unreachable'
    };
  }

  statusCache = {
    payload,
    expiresAt: now + STATUS_CACHE_TTL_MS
  };

  return payload;
}

function renderPage(fileName) {
  return (req, res) => {
    res.sendFile(path.join(publicDir, fileName));
  };
}

app.disable('x-powered-by');
app.use((req, res, next) => {
  if (req.path === '/' || req.path === '/informations' || req.path === '/reglement') {
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
});

app.use(express.static(publicDir, {
  maxAge: '2h'
}));

app.get('/', renderPage('index.html'));
app.get('/informations', renderPage('info.html'));
app.get('/reglement', renderPage('rules.html'));

app.get('/map', (req, res) => {
  res.redirect(302, MAP_REDIRECT_URL);
});

app.get('/telechargement', renderPage('download.html'));
app.get('/download', renderPage('download.html'));

app.get('/api/download-manifest', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  fs.readFile(DOWNLOAD_MANIFEST_PATH, 'utf8', (err, data) => {
    if (err) {
      return res.json({
        ok: true,
        enabled: false,
        latest: '',
        license: 'CC BY-NC-SA 4.0',
        license_url: 'https://creativecommons.org/licenses/by-nc-sa/4.0/',
        versions: [],
        baseUrl: DOWNLOAD_PUBLIC_BASE,
        error: 'manifest_unavailable'
      });
    }
    try {
      const parsed = JSON.parse(data);
      res.json({
        ok: true,
        enabled: Boolean(parsed.enabled),
        latest: String(parsed.latest || ''),
        license: String(parsed.license || 'CC BY-NC-SA 4.0'),
        license_url: String(parsed.license_url || 'https://creativecommons.org/licenses/by-nc-sa/4.0/'),
        versions: Array.isArray(parsed.versions) ? parsed.versions : [],
        generated_at: Number(parsed.generated_at || 0),
        baseUrl: DOWNLOAD_PUBLIC_BASE
      });
    } catch (parseErr) {
      res.status(500).json({ ok: false, error: 'manifest_parse_error' });
    }
  });
});

app.get('/api/site-config', (req, res) => {
  res.json({
    ok: true,
    twitchUrl: TWITCH_URL,
    twitchChannelLogin: TWITCH_CHANNEL_LOGIN,
    serverDisplayName: SERVER_DISPLAY_NAME,
    serverJoinIp: SERVER_JOIN_IP,
    contactEmail: CONTACT_EMAIL,
    theme: {
      backgroundImage: BACKGROUND_IMAGE,
      blurPx: clamp(BACKGROUND_BLUR_PX, 0, 24),
      overlayOpacity: clamp(BACKGROUND_OVERLAY_OPACITY, 0.2, 0.9)
    }
  });
});

app.get('/api/twitch-status', async (req, res) => {
  try {
    const payload = await fetchTwitchLiveStatus();
    res.json(payload);
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: 'Failed to read Twitch status'
    });
  }
});

app.get('/api/status', async (req, res) => {
  try {
    const payload = await fetchServerStatus();
    res.json(payload);
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: 'Failed to read status'
    });
  }
});

// ---------------------------------------------------------------------------
//  Streaming download : /dl/survie/latest
//  Sert le zip courant en streaming avec suivi des DL actifs.
//  Coupe la connexion si .enabled disparaît pendant le transfert.
// ---------------------------------------------------------------------------
app.get('/dl/survie/latest', async (req, res) => {
  if (!fs.existsSync(DOWNLOAD_ENABLED_FLAG)) {
    return res.status(503).type('text').send('Map download currently disabled.');
  }

  const rawIp = req.headers['x-real-ip']
    || (req.headers['x-forwarded-for'] || '').split(',')[0]
    || req.socket.remoteAddress
    || '';
  const ip = rawIp.trim().replace(/^::ffff:/, '');
  const cfg = loadDlConfig();

  // --- Vérification captcha (token HMAC) ---
  const token = req.query.t;
  if (!token) {
    return sendDlError(res, 403, 'Verification requise', 'Lance le telechargement depuis la page officielle : un petit test anti-bot est necessaire avant de telecharger la map.', true);
  }
  const verif = verifyToken(token, ip, cfg.captcha_max_ms);
  if (!verif) {
    return sendDlError(res, 403, 'Lien expire', 'Ton jeton de telechargement n\'est plus valide. Retourne sur la page officielle pour en generer un nouveau.', true);
  }
  if (verif.ipChanged) {
    console.log(`[dl] token ip-changed signed=${verif.tokIp} used=${ip} (autorise, mobile/happy-eyeballs)`);
  }
  if (verif.age < cfg.captcha_min_ms) {
    return sendDlError(res, 429, 'Patiente un instant', 'Tu vas trop vite ! Un court delai anti-bot doit s\'ecouler avant de pouvoir telecharger la map.', true);
  }
  // Un token brule + header Range = reprise legitime apres coupure reseau.
  // On accepte alors le token meme s'il est marque comme deja utilise.
  if (isTokenBurned(token) && !req.headers.range) {
    return sendDlError(res, 403, 'Lien deja utilise', 'Ce lien de telechargement a deja ete utilise. Retourne sur la page officielle pour relancer le processus.', true);
  }

  // --- Vérification restriction IP (admin blacklist) ---
  const restriction = isRestricted(ip);
  if (restriction) {
    const remainingMs = restriction.until_ms ? Math.max(0, restriction.until_ms - Date.now()) : 0;
    let timeMsg;
    if (!restriction.until_ms) {
      timeMsg = 'Cette restriction est permanente.';
    } else {
      const h = Math.floor(remainingMs / 3600000);
      const m = Math.floor((remainingMs % 3600000) / 60000);
      timeMsg = `Restriction levee dans ${h}h${m.toString().padStart(2,'0')}.`;
    }
    const reason = restriction.reason ? ` Motif : ${restriction.reason}.` : '';
    console.log(`[dl] reject-restricted ip=${ip} until=${restriction.until_ms} reason=${restriction.reason}`);
    return sendDlError(res, 403, 'Acces restreint', `Le telechargement t'a ete refuse par un administrateur.${reason} ${timeMsg}`, false);
  }

  // --- Bypass admin auto-whitelist ---
  const adminBypass = (cfg.admin_whitelist_enabled !== false) && isAdminIp(ip);

  // --- Vérification ban LiteBans (synchrone, < 100 ms) ---
  if (cfg.block_banned && !adminBypass) {
    const banReason = isIpBanned(ip);
    if (banReason) {
      console.log(`[dl] reject-banned ip=${ip} reason=${banReason}`);
      return sendDlError(res, 403, 'Acces refuse', `Cette adresse IP est banni du serveur (${banReason}). Le telechargement est reserve aux joueurs en regle.`, false);
    }
  }

  // --- Vérification VPN (asynchrone, cached) ---
  if (cfg.block_vpn && !adminBypass && !(cfg.vpn_whitelist || []).includes(ip)) {
    const vpnInfo = await isVpnIp(ip);
    if (vpnInfo.proxy || vpnInfo.hosting) {
      console.log(`[dl] reject-vpn ip=${ip} proxy=${vpnInfo.proxy} hosting=${vpnInfo.hosting}`);
      return sendDlError(res, 403, 'VPN detecte', 'Le telechargement n\'est pas autorise depuis un VPN, proxy ou service d\'hebergement. Desactive ton VPN puis reessaie. Si tu penses que c\'est une erreur, contacte un administrateur sur Discord.', false);
    }
  }

  const latestZipPath = path.join(DOWNLOAD_SERVE_DIR, 'latest.zip');
  let stat;
  try {
    stat = fs.statSync(latestZipPath);
  } catch {
    return res.status(404).type('text').send('No download available.');
  }

  let realFilename = 'xeinoria-survie-map.zip';
  try {
    realFilename = path.basename(fs.realpathSync(latestZipPath));
  } catch { /* symlink non résolvable, fallback */ }

  const totalBytes = stat.size;
  const id = ++_dlIdSeq;

  // --- HTTP Range parsing : permet la reprise (resume) cote navigateur ---
  // Quand le stream se coupe (restart Node, glitch reseau, sleep mobile...),
  // les navigateurs modernes reprennent automatiquement avec un header
  // 'Range: bytes=N-'. On supporte uniquement les ranges simples (un segment).
  let rangeStart = 0;
  let rangeEnd = totalBytes - 1;
  let isPartial = false;
  const rangeHeader = req.headers.range;
  if (rangeHeader) {
    const m = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader.trim());
    if (m) {
      rangeStart = parseInt(m[1], 10);
      if (m[2]) rangeEnd = Math.min(parseInt(m[2], 10), totalBytes - 1);
      if (!Number.isFinite(rangeStart) || rangeStart >= totalBytes || rangeStart > rangeEnd) {
        res.setHeader('Content-Range', `bytes */${totalBytes}`);
        return res.status(416).end();
      }
      isPartial = true;
    }
  }
  const contentLength = rangeEnd - rangeStart + 1;

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Length', contentLength);
  res.setHeader('Content-Disposition', 'attachment; filename="xeinoria-survie-map.zip"');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Accept-Ranges', 'bytes');
  if (isPartial) {
    res.status(206);
    res.setHeader('Content-Range', `bytes ${rangeStart}-${rangeEnd}/${totalBytes}`);
  }

  // bytesTransferred reflete la position absolue dans le fichier pour que
  // le pourcentage de progression reste correct meme apres une reprise.
  const entry = { ip, filename: realFilename, startTime: Date.now(), bytesTransferred: rangeStart, totalBytes, cancel: null, token, lastProgressAt: Date.now(), adminCancel: false, disabledCancel: false, isResume: isPartial };
  activeDownloads.set(id, entry);
  _bumpDlVersion();
  // Brule le token : un retry automatique apres FIN normale doit re-passer
  // par le captcha. Mais on autorise la reprise via Range (voir check plus haut).
  burnToken(token, verif.ts + cfg.captcha_max_ms);
  if (isPartial) {
    console.log(`[dl] start id=${id} ip=${ip} file=${realFilename} size=${totalBytes} RESUME from=${rangeStart}`);
  } else {
    console.log(`[dl] start id=${id} ip=${ip} file=${realFilename} size=${totalBytes}`);
  }

  const stream = fs.createReadStream(latestZipPath, { start: rangeStart, end: rangeEnd });
  entry.cancel = () => {
    stream.destroy();
    try { if (res.socket) res.socket.destroy(); } catch { /* ignore */ }
  };

  stream.on('data', (chunk) => {
    const e = activeDownloads.get(id);
    if (e) {
      e.bytesTransferred += chunk.length;
      e.lastProgressAt = Date.now();
    }
  });

  // Vérifie le flag .enabled toutes les 3s — coupe si désactivé
  const poll = setInterval(() => {
    if (!fs.existsSync(DOWNLOAD_ENABLED_FLAG)) {
      clearInterval(poll);
      console.log(`[dl] cancel id=${id} ip=${ip} reason=disabled bytes=${entry.bytesTransferred}/${totalBytes}`);
      entry.disabledCancel = true;
      stream.destroy();
      try { if (res.socket) res.socket.destroy(); } catch { /* ignore */ }
      // cleanup() s'occupera de la suppression / bump / log
    }
  }, 3000);

  let _finished = false;
  const cleanup = (reason) => {
    if (_finished) return;
    _finished = true;
    clearInterval(poll);
    const e = activeDownloads.get(id) || entry;
    const done = e ? e.bytesTransferred : 0;
    const elapsedMs = e ? (Date.now() - e.startTime) : 0;
    if (activeDownloads.delete(id)) _bumpDlVersion();
    // Determine le vrai status :
    //   done        : transfert complet (bytes >= total)
    //   cancel_admin: /api/dl-cancel/:id a ete appele
    //   cancel_disabled : flag .enabled retire
    //   error       : erreur stream/response
    //   cancel_user : tout autre cas (navigateur ferme, perte de connexion cote client, etc.)
    let status;
    if (done >= totalBytes) status = 'done';
    else if (entry.adminCancel) status = 'cancel_admin';
    else if (entry.disabledCancel) status = 'cancel_disabled';
    else if (reason === 'error') status = 'error';
    else status = 'cancel_user';
    const pct = totalBytes > 0 ? Math.floor(done * 100 / totalBytes) : 0;
    console.log(`[dl] end id=${id} ip=${ip} status=${status} bytes=${done}/${totalBytes} pct=${pct} elapsed=${fmtElapsed(elapsedMs)}`);
    recentlyFinished.set(id, { ts: Date.now(), ip, status, doneBytes: done, totalBytes, elapsedMs, pct, filename: realFilename });
    _pruneRecentlyFinished();
    _bumpDlVersion();
  };

  res.on('close', () => { cleanup('closed'); stream.destroy(); });
  res.on('error', () => cleanup('error'));
  stream.on('error', () => cleanup('error'));
  stream.on('end', () => cleanup('done'));

  // Throttle adaptatif (token bucket) — vitesse recalculee a chaque chunk.
  // En mode 'unlimited', on bypasse completement le Transform stream pour
  // eviter l'overhead chunk-par-chunk (chaque chunk passe par un setImmediate
  // Node) et laisser le pipe TCP saturer le lien.
  const _initialRate = computeRateBytesPerSec();
  if (!Number.isFinite(_initialRate)) {
    // unlimited : pipe direct, vitesse maximale.
    stream.pipe(res);
  } else {
    const throttle = makeBandwidthThrottle(computeRateBytesPerSec);
    throttle.on('error', () => cleanup('error'));
    // Si le client coupe, on coupe aussi le throttle pour liberer le timer.
    res.on('close', () => { try { throttle.destroy(); } catch { /* ignore */ } });
    // En cas de cancel admin, on detruit aussi le throttle.
    const prevCancel = entry.cancel;
    entry.cancel = () => {
      try { throttle.destroy(); } catch { /* ignore */ }
      if (prevCancel) prevCancel();
    };
    stream.pipe(throttle).pipe(res);
  }
});

// ---------------------------------------------------------------------------
//  API : téléchargements actifs (localhost uniquement via nginx deny)
// ---------------------------------------------------------------------------
app.get('/api/dl-active', (req, res) => {
  const now = Date.now();
  const PAUSE_MS = 5000; // pas de progres pendant 5s = pause
  const downloads = [];
  for (const [id, e] of activeDownloads) {
    const elapsedMsRaw = now - e.startTime;
    const elapsedMs = elapsedMsRaw > 0 ? elapsedMsRaw : 1;
    const pct = e.totalBytes > 0 ? Math.floor(e.bytesTransferred * 100 / e.totalBytes) : 0;
    const paused = (now - (e.lastProgressAt || e.startTime)) > PAUSE_MS;
    const speedBps = paused ? 0 : Math.floor((e.bytesTransferred * 1000) / elapsedMs);
    let eta = '?';
    if (e.totalBytes > 0 && e.bytesTransferred >= e.totalBytes) {
      eta = '0s';
    } else if (paused) {
      eta = 'pause';
    } else if (speedBps > 0 && e.totalBytes > e.bytesTransferred) {
      const remainingBytes = e.totalBytes - e.bytesTransferred;
      eta = fmtElapsed(Math.floor((remainingBytes * 1000) / speedBps));
    }
    downloads.push({
      id,
      ip: e.ip,
      pct,
      done: fmtBytes(e.bytesTransferred),
      total: fmtBytes(e.totalBytes),
      elapsed: fmtElapsed(elapsedMsRaw),
      paused: paused ? 1 : 0,
      speed: fmtRate(speedBps),
      eta,
      filename: e.filename || ''
    });
  }

  const fmt = req.query.fmt;
  if (fmt === 'pipe') {
    // Format texte pipe-séparé pour le Skript :
    //   <version>|<count>|id~ip~pct~done~total~elapsed~paused~speed~eta~filename|...
    // Premier champ = version (compteur global, change quand la liste bouge).
    // 7e champ par DL = paused (0 ou 1), 8e = speed, 9e = eta, 10e = filename.
    const head = `${_dlVersion}|${downloads.length}`;
    if (downloads.length === 0) {
      return res.type('text').send(head);
    }
    const lines = downloads.map(d => `${d.id}~${d.ip}~${d.pct}~${d.done}~${d.total}~${d.elapsed}~${d.paused}~${d.speed}~${d.eta}~${String(d.filename||'').replace(/[~|\n\r]/g,'_')}`);
    return res.type('text').send(head + '|' + lines.join('|'));
  }

  res.setHeader('Cache-Control', 'no-store');
  res.json({ version: _dlVersion, count: downloads.length, downloads });
});

// ---------------------------------------------------------------------------
//  API : derniers téléchargements terminés (avec raison réelle de fin)
//  Le Skript poll cet endpoint pour completer son log local avec le bon status.
// ---------------------------------------------------------------------------
app.get('/api/dl-recent', (req, res) => {
  _pruneRecentlyFinished();
  const fmt = req.query.fmt;
  const items = [];
  for (const [id, e] of recentlyFinished) {
    items.push({
      id,
      ts: e.ts,
      ip: e.ip,
      status: e.status,
      pct: e.pct,
      elapsedMs: e.elapsedMs,
      doneBytes: e.doneBytes,
      totalBytes: e.totalBytes,
      doneHuman: fmtBytes(e.doneBytes),
      totalHuman: fmtBytes(e.totalBytes),
      filename: e.filename || ''
    });
  }
  if (fmt === 'pipe') {
    // Format : <count>|id~ts~ip~status~pct~elapsedMs~doneHuman~totalHuman~filename|...
    const head = `${items.length}`;
    if (items.length === 0) return res.type('text').send(head);
    const lines = items.map(d => `${d.id}~${d.ts}~${d.ip}~${d.status}~${d.pct}~${d.elapsedMs}~${d.doneHuman}~${d.totalHuman}~${String(d.filename||'').replace(/[~|\n\r]/g,'_')}`);
    return res.type('text').send(head + '|' + lines.join('|'));
  }
  res.setHeader('Cache-Control', 'no-store');
  res.json({ count: items.length, items });
});

// ---------------------------------------------------------------------------
//  API : interruption d'un téléchargement spécifique (localhost uniquement)
// ---------------------------------------------------------------------------
app.post('/api/dl-cancel/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ ok: false, error: 'invalid id' });
  }
  const entry = activeDownloads.get(id);
  if (!entry) {
    return res.status(404).json({ ok: false, error: 'not found' });
  }
  console.log(`[dl] admin-cancel id=${id} ip=${entry.ip}`);
  entry.adminCancel = true;
  if (entry.cancel) entry.cancel();
  res.json({ ok: true, id });
});

// ---------------------------------------------------------------------------
//  API : génération token captcha
// ---------------------------------------------------------------------------
app.post('/api/dl-token', express.json(), (req, res) => {
  const rawIp = req.headers['x-real-ip']
    || (req.headers['x-forwarded-for'] || '').split(',')[0]
    || req.socket.remoteAddress
    || '';
  const ip = rawIp.trim().replace(/^::ffff:/, '');
  if (!ip) return res.status(400).json({ ok: false });

  // Si le client fournit son IPv4 (récupérée via api4.ipify.org côté navigateur),
  // on l'utilise pour la vérification LiteBans (cas visiteur en IPv6 dont MC est en IPv4).
  // Validation stricte pour éviter tout abus.
  let banCheckIp = ip;
  const clientIpv4 = (req.body && typeof req.body.client_ipv4 === 'string')
    ? req.body.client_ipv4.trim()
    : '';
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(clientIpv4)) {
    const parts = clientIpv4.split('.').map(Number);
    if (parts.every(n => n >= 0 && n <= 255)) {
      banCheckIp = clientIpv4;
    }
  }

  // Refuse de generer un token pour une IP restreinte
  const restriction = isRestricted(ip);
  if (restriction) {
    return res.status(403).json({ ok: false, error: 'restricted', until_ms: restriction.until_ms || 0, reason: restriction.reason || '' });
  }
  // Vérifie LiteBans avec l'IPv4 fournie par le client si disponible
  const cfg = loadDlConfig();
  if (cfg.block_banned) {
    const banReason = isIpBanned(banCheckIp);
    if (banReason !== null) {
      return res.status(403).json({ ok: false, error: 'banned', reason: banReason });
    }
  }
  const ts = Date.now();
  const token = signToken(ts, ip);
  res.json({ ok: true, token, ts, min_wait_ms: cfg.captcha_min_ms });
});

app.post('/api/dl-cfg', express.json({ limit: '8kb' }), (req, res) => {
  // nginx bloque depuis l'extérieur, mais double protection
  const body = req.body || {};
  const cur = loadDlConfig();
  // Valide clé par clé
  if (typeof body.block_vpn === 'boolean') cur.block_vpn = body.block_vpn;
  if (typeof body.block_banned === 'boolean') cur.block_banned = body.block_banned;
  if (typeof body.admin_whitelist_enabled === 'boolean') cur.admin_whitelist_enabled = body.admin_whitelist_enabled;
  if (Array.isArray(body.vpn_whitelist)) {
    cur.vpn_whitelist = body.vpn_whitelist.filter(x => typeof x === 'string' && /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(x));
  }
  if (Number.isInteger(body.max_gb) && body.max_gb >= 10 && body.max_gb <= 1000) cur.max_gb = body.max_gb;
  if (Number.isInteger(body.captcha_min_ms) && body.captcha_min_ms >= 0 && body.captcha_min_ms <= 60000) cur.captcha_min_ms = body.captcha_min_ms;
  // ---- Bande passante ----
  if (typeof body.bandwidth_mode === 'string' && ['auto','manual','unlimited'].includes(body.bandwidth_mode)) {
    cur.bandwidth_mode = body.bandwidth_mode;
  }
  if (Number.isInteger(body.bandwidth_per_user_kbs) && body.bandwidth_per_user_kbs >= 64 && body.bandwidth_per_user_kbs <= 1048576) {
    cur.bandwidth_per_user_kbs = body.bandwidth_per_user_kbs;
  }
  if (Number.isInteger(body.bandwidth_total_kbs) && body.bandwidth_total_kbs >= 256 && body.bandwidth_total_kbs <= 10485760) {
    cur.bandwidth_total_kbs = body.bandwidth_total_kbs;
  }
  if (Number.isInteger(body.bandwidth_min_kbs) && body.bandwidth_min_kbs >= 64 && body.bandwidth_min_kbs <= 1048576) {
    cur.bandwidth_min_kbs = body.bandwidth_min_kbs;
  }
  if (Number.isInteger(body.bandwidth_max_kbs) && body.bandwidth_max_kbs >= 64 && body.bandwidth_max_kbs <= 10485760) {
    cur.bandwidth_max_kbs = body.bandwidth_max_kbs;
  }
  if (typeof body.bandwidth_load_threshold === 'number' && body.bandwidth_load_threshold >= 0 && body.bandwidth_load_threshold <= 64) {
    cur.bandwidth_load_threshold = body.bandwidth_load_threshold;
  }
  if (Number.isInteger(body.bandwidth_load_penalty_pct) && body.bandwidth_load_penalty_pct >= 0 && body.bandwidth_load_penalty_pct <= 95) {
    cur.bandwidth_load_penalty_pct = body.bandwidth_load_penalty_pct;
  }
  const saved = saveDlConfig(cur);
  // Invalide le cache VPN si whitelist change pour appliquer immediatement
  if (Array.isArray(body.vpn_whitelist)) vpnCache.clear();
  res.json({ ok: true, config: saved });
});

// ---------------------------------------------------------------------------
//  API : config DL (GET public, POST localhost only via nginx)
// ---------------------------------------------------------------------------
app.get('/api/dl-cfg', (req, res) => {
  const cfg = loadDlConfig();
  // GET ne retourne PAS la whitelist (info sensible)
  const { vpn_whitelist, ...publicCfg } = cfg;
  // Inclure infos admin_ips (count) pour affichage in-game
  const admins = loadAdminIps();
  pruneAdminIps(admins);
  publicCfg.admin_ips_count = Object.keys(admins).length;
  res.json(publicCfg);
});

// Auto-whitelist : Skript appelle ce endpoint pour les admins en ligne.
// nginx bloque l'acces externe (POST). TTL 7 jours, refresh a chaque appel.
app.post('/api/dl-admin-ip', express.json({ limit: '2kb' }), (req, res) => {
  const body = req.body || {};
  const ip = String(body.ip || '').trim();
  const name = String(body.name || '').trim();
  if (!recordAdminIp(ip, name)) {
    return res.status(400).json({ ok: false, error: 'invalid ip' });
  }
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
//  API : restrictions IP (blacklist temporaire) — localhost uniquement
// ---------------------------------------------------------------------------

// POST /api/dl-restrict body { ip, duration_seconds, reason, by }
// Si duration_seconds est absent => 86400 (24h). 0 => permanent.
// Interrompt aussi les DL actifs en cours pour cette IP.
app.post('/api/dl-restrict', express.json({ limit: '2kb' }), (req, res) => {
  const body = req.body || {};
  const ip = String(body.ip || '').trim();
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
    return res.status(400).json({ ok: false, error: 'invalid ip' });
  }
  const sec = Number.isFinite(body.duration_seconds) ? Math.floor(body.duration_seconds) : 86400;
  const entry = restrictIp(ip, sec, body.reason, body.by);
  if (!entry) return res.status(500).json({ ok: false });
  // Coupe les DL actifs sur cette IP (et brûle leurs tokens)
  let killed = 0;
  for (const [id, e] of activeDownloads) {
    if (e.ip === ip) {
      console.log(`[dl] admin-restrict-kill id=${id} ip=${ip}`);
      if (e.token) burnToken(e.token, Date.now() + 600000);
      if (e.cancel) e.cancel();
      killed++;
    }
  }
  console.log(`[dl] restrict ip=${ip} duration=${sec}s by=${entry.by} reason="${entry.reason}" killed=${killed}`);
  res.json({ ok: true, entry, killed });
});

// POST /api/dl-unrestrict body { ip }
app.post('/api/dl-unrestrict', express.json({ limit: '2kb' }), (req, res) => {
  const body = req.body || {};
  const ip = String(body.ip || '').trim();
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
    return res.status(400).json({ ok: false, error: 'invalid ip' });
  }
  const ok = unrestrictIp(ip);
  console.log(`[dl] unrestrict ip=${ip} ok=${ok}`);
  res.json({ ok, ip });
});

// GET /api/dl-restricted [?fmt=pipe]
// Retourne la liste des IP restreintes. Format pipe pour Skript :
//   <count>|ip§until_ms§since_ms§reason§by|...
app.get('/api/dl-restricted', (req, res) => {
  const map = loadRestrictedIps();
  if (pruneRestrictedIps(map)) { try { saveRestrictedIps(map); } catch { /* ignore */ } }
  const entries = Object.keys(map).map(ip => ({ ip, ...map[ip] }));
  if (req.query.fmt === 'pipe') {
    const head = String(entries.length);
    if (entries.length === 0) return res.type('text').send(head);
    const lines = entries.map(e => {
      const reason = String(e.reason || '').replace(/[|§\n\r]/g, ' ');
      const by = String(e.by || '').replace(/[|§\n\r]/g, ' ');
      return `${e.ip}~${e.until_ms || 0}~${e.since_ms || 0}~${reason}~${by}`;
    });
    return res.type('text').send(head + '|' + lines.join('|'));
  }
  res.json({ count: entries.length, restricted: entries });
});

// GET /api/dl-access [?fmt=pipe]
// Vue agrégée pour le menu Skript : whitelist VPN + admins + restreints.
// Format pipe :
//   W<count>|ip|ip|...||A<count>|ip~name~last_ms|...||R<count>|ip~until~since~reason~by|...
app.get('/api/dl-access', (req, res) => {
  const cfg = loadDlConfig();
  const wl = (cfg.vpn_whitelist || []).filter(x => typeof x === 'string');
  const admins = loadAdminIps();
  pruneAdminIps(admins);
  const adminList = Object.keys(admins).map(ip => {
    const e = admins[ip];
    const last = (typeof e === 'object') ? (e.last || 0) : e;
    const name = (typeof e === 'object') ? (e.name || '') : '';
    return { ip, name, last_ms: last };
  });
  const restMap = loadRestrictedIps();
  if (pruneRestrictedIps(restMap)) { try { saveRestrictedIps(restMap); } catch { /* ignore */ } }
  const restList = Object.keys(restMap).map(ip => ({ ip, ...restMap[ip] }));
  if (req.query.fmt === 'pipe') {
    const parts = [];
    parts.push('W' + wl.length + (wl.length ? '|' + wl.join('|') : ''));
    const aLines = adminList.map(a => `${a.ip}~${String(a.name||'').replace(/[|~\n\r]/g,' ')}~${a.last_ms || 0}`);
    parts.push('A' + adminList.length + (adminList.length ? '|' + aLines.join('|') : ''));
    const rLines = restList.map(r => {
      const reason = String(r.reason || '').replace(/[|~\n\r]/g,' ');
      const by = String(r.by || '').replace(/[|~\n\r]/g,' ');
      return `${r.ip}~${r.until_ms || 0}~${r.since_ms || 0}~${reason}~${by}`;
    });
    parts.push('R' + restList.length + (restList.length ? '|' + rLines.join('|') : ''));
    return res.type('text').send(parts.join('||'));
  }
  res.json({
    admin_whitelist_enabled: cfg.admin_whitelist_enabled !== false,
    vpn_whitelist: wl,
    admins: adminList,
    restricted: restList,
  });
});

app.listen(PORT, () => {
  console.log(`[norath-web] running on :${PORT}`);
});
