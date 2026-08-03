/**
 * http/chat.js — follow-up questions against a completed report. Fast
 * enough to answer synchronously most of the time (see agents/chat.js) —
 * no Cloud Task needed, unlike report generation.
 */
const { withCors, clientIp } = require('../lib/cors');
const db = require('../lib/db');
const cache = require('../lib/cache');
const chatAgent = require('../agents/chat');

const RATE_LIMIT_PER_IP = 30;
const RATE_LIMIT_WINDOW_S = 600;

const chat = withCors(async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

  const ip = clientIp(req);
  const allowed = await cache.checkRateLimit(ip, RATE_LIMIT_PER_IP, RATE_LIMIT_WINDOW_S);
  if (!allowed) { res.status(429).json({ code: 'rate_limited', error: 'Too many questions from this connection — please slow down.' }); return; }

  const { reportId, message } = req.body || {};
  if (!reportId || typeof reportId !== 'string') { res.status(400).json({ error: 'reportId is required' }); return; }
  if (!message || typeof message !== 'string' || !message.trim()) { res.status(400).json({ error: 'message is required' }); return; }
  if (message.length > 1000) { res.status(400).json({ error: 'Question is too long.' }); return; }

  const report = await db.getReport(reportId);
  if (!report) { res.status(404).json({ error: 'That report was not found.' }); return; }
  if (report.status !== 'done') { res.status(409).json({ error: 'This report is not ready yet.' }); return; }

  const { reply, researched } = await chatAgent.answer({ reportId, message: message.trim() });
  res.status(200).json({ reply, researched });
});

module.exports = { chat };
