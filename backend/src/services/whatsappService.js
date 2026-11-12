/**
 * WhatsApp backend dispatcher.
 * ─────────────────────────────────────────────────────────────────────────
 * The app talks to WhatsApp through this module only. It reads the
 * `whatsapp_backend` app setting ("baileys" | "waha") and delegates to the
 * matching service, both of which expose the same interface:
 *
 *   startClient, stopClient, sendMessage, getSessionStatus,
 *   getQrCode, sendTestMessage, logout, emitter
 *
 *   baileys → in-process WhatsApp Web client (no Docker) — default
 *   waha    → external WAHA Docker container (more stable, needs Docker)
 *
 * The chosen backend is cached for a short time so the per-message /
 * per-status-poll code paths don't hit the DB on every call.
 */

'use strict';

const { EventEmitter } = require('events');
const settingsRepo = require('../repositories/settingsRepository');
const logger = require('../config/logger');

let _backend = null;   // 'baileys' | 'waha'
let _impl = null;       // loaded service module
let _decisionAt = 0;
const DECISION_TTL_MS = 30_000;

async function resolve() {
  if (_impl && Date.now() - _decisionAt < DECISION_TTL_MS) return _impl;

  let name = 'baileys';
  try {
    const s = await settingsRepo.getAllDecrypted();
    name = String(s.whatsapp_backend || 'baileys').toLowerCase();
    if (name !== 'baileys' && name !== 'waha') name = 'baileys';
  } catch (e) {
    // DB not ready at boot — fall back to Baileys, will re-read on next call.
    name = 'baileys';
  }

  if (_backend !== name) {
    _backend = name;
    _impl = name === 'waha' ? require('./wahaService') : require('./baileysService');
    logger.info({ whatsappBackend: name }, 'WhatsApp backend selected');
  }
  _decisionAt = Date.now();
  return _impl;
}

// ── Public API (delegates to the active backend) ────────────────────────────

async function startClient() {
  const i = await resolve();
  return i.startClient();
}

async function stopClient() {
  try {
    const i = await resolve();
    return i.stopClient();
  } catch (e) {
    /* best-effort during shutdown */
  }
}

async function sendMessage(to, text) {
  const i = await resolve();
  return i.sendMessage(to, text);
}

async function getSessionStatus() {
  const i = await resolve();
  const result = await i.getSessionStatus();
  // Annotate so the UI can show which engine is active.
  if (result && typeof result === 'object' && !('backend' in result)) {
    result.backend = _backend || 'baileys';
  }
  return result;
}

async function getQrCode() {
  const i = await resolve();
  return i.getQrCode();
}

async function sendTestMessage(to) {
  const i = await resolve();
  return i.sendTestMessage(to);
}

async function logout() {
  const i = await resolve();
  return i.logout();
}

function getBackend() {
  return _backend || 'baileys';
}

// Passthrough emitter (Baileys uses one internally; WAHA does not). Kept for
// interface parity so consumers that may import it don't break.
const emitter = new EventEmitter();

module.exports = {
  startClient,
  stopClient,
  sendMessage,
  getSessionStatus,
  getQrCode,
  sendTestMessage,
  logout,
  getBackend,
  emitter,
};
