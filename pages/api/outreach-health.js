/**
 * /api/outreach-health — GET
 * Returns Outreach token status + webhook health for monitoring.
 * Used by heartbeat and dashboard status indicators.
 */

import { query } from '../../lib/db';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const r = await query(`
      SELECT access_token, expires_at, updated_at,
             last_webhook_event_at, last_webhook_type, webhook_events_today
      FROM outreach_tokens WHERE id = 1 LIMIT 1
    `);

    if (!r.rows.length) {
      return res.status(200).json({ ok: false, error: 'No token row found', tokenStatus: 'missing' });
    }

    const row = r.rows[0];
    const now = new Date();
    const expiresAt = new Date(row.expires_at);
    const minutesUntilExpiry = Math.round((expiresAt - now) / 60000);
    const tokenStatus = minutesUntilExpiry < 0 ? 'expired'
      : minutesUntilExpiry < 30 ? 'expiring_soon'
      : 'ok';

    const lastWebhookAt = row.last_webhook_event_at ? new Date(row.last_webhook_event_at) : null;
    const hoursSinceWebhook = lastWebhookAt ? (now - lastWebhookAt) / 3600000 : null;
    const webhookStatus = lastWebhookAt === null ? 'no_data'
      : hoursSinceWebhook > 24 ? 'stale'
      : 'ok';

    return res.status(200).json({
      ok: tokenStatus === 'ok',
      tokenStatus,
      minutesUntilExpiry,
      tokenUpdatedAt: row.updated_at,
      webhookStatus,
      lastWebhookEventAt: row.last_webhook_event_at,
      lastWebhookType: row.last_webhook_type,
      webhookEventsToday: row.webhook_events_today || 0,
      hoursSinceWebhook: hoursSinceWebhook ? Math.round(hoursSinceWebhook) : null,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}
