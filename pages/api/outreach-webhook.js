/**
 * /api/outreach-webhook — POST
 *
 * Receives real-time activity events from Outreach and writes them to the DB.
 * Register this URL in Outreach: Admin → Plugins → Webhooks
 *
 * Events handled:
 *   task.completed  → calls, emails
 *   call.created    → outbound calls
 *   email.created   → outbound emails
 */

import { query } from '../../lib/db';

// Verify Outreach webhook secret (set OUTREACH_WEBHOOK_SECRET in Vercel env)
function verifySecret(req) {
  const secret = process.env.OUTREACH_WEBHOOK_SECRET;
  if (!secret) return true; // skip verification if not set
  const incoming = req.headers['x-outreach-webhook-secret'] || req.headers['x-webhook-secret'];
  return incoming === secret;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!verifySecret(req)) {
    console.error('[outreach-webhook] Secret mismatch');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const payload = req.body;
  const eventName = payload?.meta?.eventName || payload?.data?.type || 'unknown';

  try {
    await processEvent(eventName, payload);
    return res.status(200).json({ ok: true, event: eventName });
  } catch (err) {
    console.error('[outreach-webhook] Error:', err.message, JSON.stringify(payload).slice(0, 500));
    return res.status(500).json({ error: err.message });
  }
}

async function processEvent(eventName, payload) {
  const data = payload?.data || {};
  const attrs = data?.attributes || {};
  const rels = data?.relationships || {};

  // Determine activity type
  let actType = null;
  if (eventName.includes('call')) actType = 'call';
  else if (eventName.includes('email')) actType = 'email';
  else if (eventName.includes('task')) {
    const taskType = (attrs.taskType || attrs.action || '').toLowerCase();
    if (taskType.includes('call')) actType = 'call';
    else if (taskType.includes('email')) actType = 'email';
    else actType = 'task';
  } else {
    actType = eventName.split('.')[0] || 'other';
  }

  const outreachId = String(data.id || '');
  const subject = attrs.subject || attrs.bodyText?.slice(0, 200) || eventName;
  const outcome = attrs.outcome || attrs.state || attrs.taskType || null;
  const activityDate = attrs.completedAt || attrs.createdAt || new Date().toISOString();
  const durationSec = attrs.returnedAt && attrs.calledAt
    ? Math.round((new Date(attrs.returnedAt) - new Date(attrs.calledAt)) / 1000)
    : (attrs.callDuration || null);
  const notes = attrs.note || attrs.bodyText?.slice(0, 1000) || null;

  // Rep info
  const userId = rels.user?.data?.id || rels.owner?.data?.id || null;
  const prospectId = rels.prospect?.data?.id || null;
  const accountId = rels.account?.data?.id || null;
  const sequenceId = rels.sequence?.data?.id || null;

  // Try to resolve rep name from DB activities (best effort)
  let repName = null;
  if (userId) {
    const r = await query(
      `SELECT DISTINCT rep FROM activities WHERE outreach_user_id = $1 LIMIT 1`,
      [String(userId)]
    ).catch(() => ({ rows: [] }));
    repName = r.rows[0]?.rep || null;
  }

  // Try to resolve account/contact SFDC IDs
  let accountSfdcId = null;
  let contactSfdcId = null;

  if (accountId) {
    const r = await query(
      `SELECT sfdc_id FROM accounts WHERE outreach_account_id = $1 LIMIT 1`,
      [String(accountId)]
    ).catch(() => ({ rows: [] }));
    accountSfdcId = r.rows[0]?.sfdc_id || null;
  }

  if (prospectId) {
    const r = await query(
      `SELECT sfdc_id, account_sfdc_id FROM contacts WHERE outreach_prospect_id = $1 LIMIT 1`,
      [String(prospectId)]
    ).catch(() => ({ rows: [] }));
    contactSfdcId = r.rows[0]?.sfdc_id || null;
    if (!accountSfdcId) accountSfdcId = r.rows[0]?.account_sfdc_id || null;
  }

  // Upsert into activities table
  await query(`
    INSERT INTO activities (
      sfdc_id, outreach_id, type, subject, outcome, activity_date,
      duration_seconds, notes, rep, outreach_user_id,
      account_sfdc_id, contact_sfdc_id, outreach_sequence_id,
      source_system, created_at, updated_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6,
      $7, $8, $9, $10,
      $11, $12, $13,
      'outreach_webhook', NOW(), NOW()
    )
    ON CONFLICT (outreach_id) DO UPDATE SET
      outcome = EXCLUDED.outcome,
      duration_seconds = EXCLUDED.duration_seconds,
      notes = EXCLUDED.notes,
      updated_at = NOW()
  `, [
    null, outreachId, actType, subject, outcome, activityDate,
    durationSec, notes, repName, userId ? String(userId) : null,
    accountSfdcId, contactSfdcId, sequenceId ? String(sequenceId) : null
  ]);

  console.log(`[outreach-webhook] ✅ ${eventName} | type=${actType} | outreach_id=${outreachId} | rep=${repName}`);
}
