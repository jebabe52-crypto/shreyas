/**
 * Webhooks router.
 *
 * POST /api/webhooks/waha — incoming WhatsApp messages from a WAHA Docker
 * container. WAHA POSTs an event payload for each received message; we map it
 * to the same conversation state machine that Baileys drives in-process.
 *
 * Auth: the `token` query param must match the configured `waha_api_key`
 * (the same key used for the WAHA REST API). If no key is configured (open
 * localhost WAHA) the webhook is accepted without a token.
 *
 * The old in-process Baileys path does not use this route — it receives
 * messages via the `messages.upsert` event in baileysService.js.
 */

const { Router } = require('express');
const asyncHandler = require('../utils/asyncHandler');
const settingsRepo = require('../repositories/settingsRepository');
const logger = require('../config/logger');

const router = Router();

router.post(
  '/waha',
  asyncHandler(async (req, res) => {
    // ── Auth: token query param == waha_api_key ──────────────────────────────
    const settings = await settingsRepo.getAllDecrypted();
    const expected = settings.waha_api_key || '';
    const got = req.query.token || '';
    if (expected && got !== expected) {
      logger.warn({ ip: req.ip }, 'WAHA webhook: invalid token — rejected');
      return res.status(401).json({ ok: false, error: 'invalid token' });
    }

    const { event, payload } = req.body || {};

    // Only inbound text messages drive the conversation state machine.
    if (event !== 'message' || !payload) {
      return res.json({ ok: true, ignored: true });
    }
    if (payload.fromMe) {
      return res.json({ ok: true, ignored: true });
    }

    // WAHA uses <digits>@c.us; strip to plain digits (same format Baileys path
    // passes to conversationService.handleIncoming).
    const from = String(payload.from || '')
      .replace(/@c\.us|@s\.whatsapp\.net/g, '')
      .replace(/\D/g, '');
    const text = (payload.body || '').toString().trim();
    const waMessageId = payload.id || '';

    if (!from || !text) {
      return res.json({ ok: true, ignored: true });
    }

    try {
      const convSvc = require('../services/conversationService');
      await convSvc.handleIncoming({ from, messageId: waMessageId, text, waMessageId });
    } catch (e) {
      logger.error({ err: e }, 'WAHA webhook: handleIncoming error');
    }

    res.json({ ok: true });
  })
);

module.exports = router;
