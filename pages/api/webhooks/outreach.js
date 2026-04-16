/**
 * /api/webhooks/outreach — POST
 *
 * Receives real-time call and mailing events from Outreach via webhooks.
 * Verifies HMAC-SHA256 signature and upserts into the Neon DB activities table.
 *
 * Register in Outreach:
 *   POST https://api.outreach.io/api/v2/webhooks
 *   url: https://prospector-dashboard-tau.vercel.app/api/webhooks/outreach
 *   resourceType: "call" | "mailing", action: "created"
 *
 * Env var required: OUTREACH_WEBHOOK_SECRET
 */

import crypto from 'crypto';
import { query } from '../../../lib/db';

// Disable default body parser so we can access rawBody for signature verification
export const config = {
  api: {
    bodyParser: false,
  },
};

/** Read raw body from request stream */
async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Verify HMAC-SHA256 signature from Outreach */
function verifySignature(secret, rawBody, signature) {
  if (!secret) return true; // skip if not configured
  if (!signature) return false;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');
  return crypto.timingSafeEqual(
    Buffer.from(expected, 'hex'),
    Buffer.from(signature.replace(/^sha256=/, ''), 'hex')
  );
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Read raw body
  const rawBody = await getRawBody(req);
  const signature = req.headers['outreach-webhook-signature'] || '';
  const secret = process.env.OUTREACH_WEBHOOK_SECRET || '';

  // Verify signature
  if (secret && !verifySignature(secret, rawBody, signature)) {
    console.error('[outreach-webhook] Signature verification failed');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch (err) {
    console.error('[outreach-webhook] Failed to parse JSON body:', err.message);
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const eventName = payload?.meta?.eventName || 'unknown';
  const dataType = payload?.data?.type || 'unknown';

  console.log(`[outreach-webhook] Received: eventName=${eventName} type=${dataType} id=${payload?.data?.id}`);

  // Track last webhook event timestamp for health monitoring
  query(`
    UPDATE outreach_tokens SET
      last_webhook_event_at = NOW(),
      last_webhook_type = $1,
      webhook_events_today = COALESCE(webhook_events_today, 0) + 1
    WHERE id = 1
  `, [eventName]).catch(() => {});

  // Always return 200 so Outreach doesn't retry valid deliveries
  try {
    await processEvent(eventName, dataType, payload);
    return res.status(200).json({ ok: true, event: eventName });
  } catch (err) {
    console.error('[outreach-webhook] Processing error:', err.message, JSON.stringify(payload).slice(0, 500));
    // Still return 200 to prevent Outreach retries for permanent errors
    return res.status(200).json({ ok: false, error: err.message });
  }
}

async function processEvent(eventName, dataType, payload) {
  const data = payload?.data || {};
  const attrs = data?.attributes || {};
  const rels = data?.relationships || {};
  const outreachId = String(data.id || '');

  if (!outreachId) {
    console.log(`[outreach-webhook] No data.id in payload — skipping`);
    return;
  }

  // Extract common relationship IDs
  const outreachUserId = rels.user?.data?.id ? String(rels.user.data.id) : null;
  const prospectId = rels.prospect?.data?.id ? String(rels.prospect.data.id) : null;
  const accountId = rels.account?.data?.id ? String(rels.account.data.id) : null;
  const sequenceId = rels.sequence?.data?.id ? String(rels.sequence.data.id) : null;

  // Resolve rep name from outreach_user_id
  let repName = null;
  if (outreachUserId) {
    const r = await query(
      `SELECT DISTINCT rep FROM activities WHERE outreach_user_id = $1 LIMIT 1`,
      [outreachUserId]
    ).catch(() => ({ rows: [] }));
    repName = r.rows[0]?.rep || null;
  }

  // Resolve account_sfdc_id and contact_sfdc_id
  let accountSfdcId = null;
  let contactSfdcId = null;

  if (accountId) {
    const r = await query(
      `SELECT sfdc_id FROM accounts WHERE outreach_account_id = $1 LIMIT 1`,
      [accountId]
    ).catch(() => ({ rows: [] }));
    accountSfdcId = r.rows[0]?.sfdc_id || null;
  }

  if (prospectId) {
    const r = await query(
      `SELECT sfdc_id, account_sfdc_id FROM contacts WHERE outreach_prospect_id = $1 LIMIT 1`,
      [prospectId]
    ).catch(() => ({ rows: [] }));
    contactSfdcId = r.rows[0]?.sfdc_id || null;
    if (!accountSfdcId) accountSfdcId = r.rows[0]?.account_sfdc_id || null;
  }

  // ── CALL events ──────────────────────────────────────────────────────────
  if (eventName.startsWith('call.') || dataType === 'call') {
    const activityDate = attrs.createdAt || new Date().toISOString();

    // Compute duration_seconds
    let durationSeconds = null;
    if (attrs.returnedAt && attrs.dialedAt) {
      durationSeconds = Math.round(
        (new Date(attrs.returnedAt) - new Date(attrs.dialedAt)) / 1000
      );
    } else if (attrs.duration != null) {
      durationSeconds = Number(attrs.duration);
    }

    const outcome = attrs.outcome || attrs.dispositionName || null;
    const direction = attrs.direction || null;
    const notes = attrs.note || null;
    const subject = `Call${direction ? ' (' + direction + ')' : ''}`;

    await query(`
      INSERT INTO activities (
        outreach_id, type, subject, outcome, activity_date,
        duration_seconds, notes, rep, outreach_user_id,
        account_sfdc_id, contact_sfdc_id, outreach_sequence_id,
        source_system, created_at, updated_at
      ) VALUES (
        $1, 'call', $2, $3, $4,
        $5, $6, $7, $8,
        $9, $10, $11,
        'outreach_webhook', NOW(), NOW()
      )
      ON CONFLICT (outreach_id) DO UPDATE SET
        outcome          = EXCLUDED.outcome,
        duration_seconds = EXCLUDED.duration_seconds,
        notes            = EXCLUDED.notes,
        account_sfdc_id  = COALESCE(EXCLUDED.account_sfdc_id, activities.account_sfdc_id),
        updated_at       = NOW()
    `, [
      outreachId, subject, outcome, activityDate,
      durationSeconds, notes, repName, outreachUserId,
      accountSfdcId, contactSfdcId, sequenceId,
    ]);

    console.log(`[outreach-webhook] ✅ call upserted | outreach_id=${outreachId} | outcome=${outcome} | rep=${repName}`);
    return;
  }

  // ── MAILING events ───────────────────────────────────────────────────────
  if (eventName.startsWith('mailing.') || dataType === 'mailing') {
    const activityDate = attrs.createdAt || new Date().toISOString();
    const subject = attrs.subject || '(no subject)';
    const outcome = attrs.state || null;

    await query(`
      INSERT INTO activities (
        outreach_id, type, subject, outcome, activity_date,
        rep, outreach_user_id,
        account_sfdc_id, contact_sfdc_id, outreach_sequence_id,
        source_system, created_at, updated_at
      ) VALUES (
        $1, 'email', $2, $3, $4,
        $5, $6,
        $7, $8, $9,
        'outreach_webhook', NOW(), NOW()
      )
      ON CONFLICT (outreach_id) DO UPDATE SET
        outcome         = EXCLUDED.outcome,
        account_sfdc_id = COALESCE(EXCLUDED.account_sfdc_id, activities.account_sfdc_id),
        updated_at      = NOW()
    `, [
      outreachId, subject, outcome, activityDate,
      repName, outreachUserId,
      accountSfdcId, contactSfdcId, sequenceId,
    ]);

    console.log(`[outreach-webhook] ✅ mailing upserted | outreach_id=${outreachId} | state=${outcome} | rep=${repName}`);
    return;
  }

  // Unhandled event type — log and ignore
  console.log(`[outreach-webhook] ℹ️ Unhandled event type: ${eventName} (${dataType}) — ignored`);
}
