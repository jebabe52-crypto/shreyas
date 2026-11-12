/**
 * WAHA (WhatsApp HTTP API) Service
 * ─────────────────────────────────────────────────────────────────────────
 * Drop-in alternative to baileysService.js that talks to a WAHA Docker
 * container over REST instead of running a WhatsApp Web client in-process.
 *
 * Exports the SAME interface as baileysService.js so the rest of the app
 * (notificationService, conversationService, settingsController, health,
 * index.js) does not need to know which backend is active:
 *
 *   startClient, stopClient, sendMessage, getSessionStatus,
 *   getQrCode, sendTestMessage, logout, emitter
 *
 * Config (read from app_settings, seeded defaults exist):
 *   waha_url        base URL of the WAHA server (default http://localhost:3000)
 *   waha_api_key    API key (sent as X-Api-Key). Also reused as the webhook
 *                  auth token. Leave empty only for an open localhost WAHA.
 *   waha_session    session name (default "default")
 *   waha_webhook_url optional explicit URL WAHA should call back. If empty we
 *                  compute http://host.docker.internal:<port>/api/webhooks/waha
 *
 * WAHA API reference: https://waha.devlike.pro/
 *   GET    /api/sessions/{name}            session status
 *   POST   /api/sessions/                  create + (optionally) start
 *   POST   /api/sessions/{name}/start      start a stopped session
 *   POST   /api/sessions/{name}/stop       stop
 *   POST   /api/sessions/logout            logout  ({ session })
 *   GET    /api/{session}/auth/qr          QR image (Accept: image/png)
 *   POST   /api/sendText                   { chatId, text, session }
 */

'use strict';

const axios = require('axios');
const { EventEmitter } = require('events');

const config = require('../config');
const logger = require('../config/logger');
const settingsRepo = require('../repositories/settingsRepository');

// ── Internal state ──────────────────────────────────────────────────────────
const emitter = new EventEmitter(); // kept for interface parity (unused by WAHA)

let _cfgCache = null;
let _cfgAt = 0;
const CFG_TTL_MS = 60_000;

async function getConfig() {
  const now = Date.now();
  if (_cfgCache && now - _cfgAt < CFG_TTL_MS) return _cfgCache;
  const s = await settingsRepo.getAllDecrypted();
  _cfgCache = {
    baseUrl: String(s.waha_url || 'http://localhost:3000').replace(/\/+$/, ''),
    apiKey: s.waha_api_key || '',
    session: s.waha_session || 'default',
    webhookUrl: s.waha_webhook_url || '',
  };
  _cfgAt = now;
  return _cfgCache;
}

// Force a settings re-read after the user edits WAHA config in the UI.
function invalidateConfig() {
  _cfgCache = null;
  _cfgAt = 0;
}

// ── HTTP helpers ────────────────────────────────────────────────────────────
function http(cfg) {
  return axios.create({
    baseURL: cfg.baseUrl,
    timeout: 20_000,
    headers: cfg.apiKey ? { 'X-Api-Key': cfg.apiKey } : {},
  });
}

const enc = encodeURIComponent;

function isUnreachable(e) {
  return (
    e.code === 'ECONNREFUSED' ||
    e.code === 'ENOTFOUND' ||
    e.code === 'ECONNABORTED' ||
    e.code === 'ETIMEDOUT'
  );
}

// ── chatId normalisation ────────────────────────────────────────────────────
// WAHA uses <digits>@c.us (NOT @s.whatsapp.net like Baileys).
function normaliseChatId(to) {
  const digits = String(to).replace(/\D/g, '');
  if (!digits) throw new Error('Invalid WhatsApp number');
  return String(to).includes('@') ? to : `${digits}@c.us`;
}

// ── Status mapping (WAHA → app vocabulary) ──────────────────────────────────
// App expects: WORKING | SCAN_QR_CODE | CONNECTING | STOPPED
function mapStatus(status) {
  switch (status) {
    case 'WORKING':           return { ok: true,  status: 'WORKING' };
    case 'SCAN_QR_CODE':      return { ok: true,  status: 'SCAN_QR_CODE' };
    case 'STARTING':          return { ok: false, status: 'CONNECTING' };
    case 'PASSKEY_REQUIRED':
    case 'PASSKEY_CONFIRMATION_REQUIRED':
                              return { ok: true,  status: 'SCAN_QR_CODE' };
    case 'STOPPED':
    case 'FAILED':
    default:                  return { ok: false, status: 'STOPPED' };
  }
}

// ── Webhook URL (WAHA → this backend) ───────────────────────────────────────
function buildWebhookUrl(cfg) {
  if (cfg.webhookUrl) return cfg.webhookUrl;
  const token = cfg.apiKey ? `?token=${encodeURIComponent(cfg.apiKey)}` : '';
  return `http://host.docker.internal:${config.server.port}/api/webhooks/waha${token}`;
}

// ── Session lifecycle ───────────────────────────────────────────────────────

/**
 * Ensure the WAHA session exists and is started. Optionally (re)register the
 * incoming-message webhook so replies reach conversationService.
 */
async function ensureStarted({ registerWebhook = false } = {}) {
  const cfg = await getConfig();
  const client = http(cfg);
  const name = cfg.session;

  const webhooks = registerWebhook
    ? [{ url: buildWebhookUrl(cfg), events: ['message'] }]
    : null;

  let status = null;

  try {
    const { data } = await client.get(`/api/sessions/${enc(name)}`);
    status = data?.status;
  } catch (e) {
    if (!e.response || e.response.status !== 404) {
      logger.warn({ err: e.message }, 'WAHA: cannot reach server');
      return;
    }
    // 404 → session does not exist yet; create it (with webhook config if any).
    try {
      await client.post('/api/sessions/', { name, config: webhooks ? { webhooks } : {} });
      logger.info({ session: name }, 'WAHA: session created');
    } catch (e2) {
      logger.warn({ err: e2.message }, 'WAHA: create session failed (may already exist)');
    }
    // Re-read the real status — WAHA versions differ on whether create auto-starts.
    try {
      const { data } = await client.get(`/api/sessions/${enc(name)}`);
      status = data?.status;
    } catch (_) {
      status = null;
    }
  }

  // (Re)register the webhook for an existing session so replies keep flowing.
  if (webhooks && status) {
    try {
      await client.post(`/api/sessions/${enc(name)}`, { config: { webhooks } });
    } catch (e) {
      logger.warn({ err: e.message }, 'WAHA: webhook registration failed');
    }
  }

  // Start if stopped / failed / unknown (covers "create left it STOPPED").
  if (status === 'STOPPED' || status === 'FAILED' || !status) {
    try {
      await client.post(`/api/sessions/${enc(name)}/start`, {});
      logger.info({ session: name }, 'WAHA: session start requested');
    } catch (e) {
      logger.warn({ err: e.message }, 'WAHA: start session failed (may already be starting)');
    }
  }
}

// ── Public API (matches baileysService.js) ──────────────────────────────────

async function startClient() {
  await ensureStarted({ registerWebhook: true });
}

async function stopClient() {
  try {
    const cfg = await getConfig();
    await http(cfg).post(`/api/sessions/${enc(cfg.session)}/stop`, {});
    logger.info('WAHA: session stopped');
  } catch (e) {
    // Best-effort; WAHA may already be down.
  }
}

async function sendMessage(to, text) {
  const cfg = await getConfig();
  const chatId = normaliseChatId(to);
  const { data } = await http(cfg).post('/api/sendText', {
    chatId,
    text,
    session: cfg.session,
  });
  const id = data?.id?.id || data?.key?.id || data?.id || null;
  logger.info({ to: chatId }, 'WAHA: message sent');
  return { id };
}

async function getSessionStatus() {
  const cfg = await getConfig();
  try {
    const { data } = await http(cfg).get(`/api/sessions/${enc(cfg.session)}`);
    return mapStatus(data?.status);
  } catch (e) {
    if (e.response && e.response.status === 404) return { ok: false, status: 'STOPPED' };
    // Unreachable / not running → treat as stopped so the UI prompts setup.
    if (isUnreachable(e) || !e.response) return { ok: false, status: 'STOPPED' };
    logger.warn({ err: e.message }, 'WAHA: getSessionStatus failed');
    return { ok: false, status: 'STOPPED' };
  }
}

async function getQrCode() {
  const cfg = await getConfig();

  // Already authenticated?
  const status = await getSessionStatus();
  if (status.status === 'WORKING') {
    return { ok: false, error: 'Already connected — no QR needed.' };
  }

  // Make sure a session is started so WAHA will emit a QR.
  await ensureStarted({ registerWebhook: true });

  try {
    // Request the QR as a PNG and convert to a data URI for the <img> tag.
    const resp = await http(cfg).get(`/api/${enc(cfg.session)}/auth/qr`, {
      responseType: 'arraybuffer',
      headers: { Accept: 'image/png' },
    });
    const b64 = Buffer.from(resp.data, 'binary').toString('base64');
    return { ok: true, qr: `data:image/png;base64,${b64}` };
  } catch (e) {
    const msg =
      (e.response && e.response.status === 404)
        ? 'WAHA session not found. Save the WAHA settings and retry.'
        : isUnreachable(e)
          ? 'Cannot reach WAHA. Is the Docker container running at the configured URL?'
          : (e.response?.data ? Buffer.from(e.response.data, 'binary').toString('utf8') : e.message);
    return { ok: false, error: msg };
  }
}

function sendTestMessage(to) {
  return sendMessage(to, '✅ Smart MSL Monitor – WhatsApp connection test successful!');
}

async function logout() {
  const cfg = await getConfig();
  try {
    await http(cfg).post('/api/sessions/logout', { session: cfg.session });
  } catch (e) {
    // Older/newer WAHA builds may expose logout differently — fall back to stop.
    try {
      await http(cfg).post(`/api/sessions/${enc(cfg.session)}/stop`, {});
    } catch (_) {
      /* ignore */
    }
  }
  logger.info('WAHA: logged out / session stopped');
}

module.exports = {
  startClient,
  stopClient,
  sendMessage,
  getSessionStatus,
  getQrCode,
  sendTestMessage,
  logout,
  emitter,
  invalidateConfig, // exported for tests / future hot-reload
};
