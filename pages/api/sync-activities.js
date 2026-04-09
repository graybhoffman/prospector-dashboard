/**
 * /api/sync-activities — POST
 *
 * Triggers an on-demand SFDC Tasks → Postgres activities sync
 * (last 30 days, subtypes: Call, Email, LinkedInMessage, Task).
 *
 * Returns: { synced: N, errors: M, completedAt: ISO_timestamp }
 * Also writes to sync_log on completion.
 */

import { query } from '../../lib/db';
import jsforce from 'jsforce';

// ── SFDC credentials ─────────────────────────────────────────────────────────
const SFDC_USER     = process.env.SFDC_USERNAME  || 'gray.hoffman@getathelas.com';
const SFDC_PASSWORD = process.env.SFDC_PASSWORD  || 'ctk0WZK*rzw@tyh!pnp';
const SFDC_TOKEN    = process.env.SFDC_TOKEN     || 'zK9vAeYocFwweG6zBmKDvO2F';
const SFDC_INSTANCE = process.env.SFDC_INSTANCE  || 'https://athelas.my.salesforce.com';

const SOQL = `
  SELECT Id, Subject, ActivityDate, TaskSubtype, CallType,
         CallDurationInSeconds, CallDisposition, Description,
         Status, WhoId, WhatId, Who.Name, What.Name,
         OwnerId, Owner.Name, CreatedDate, LastModifiedDate
  FROM Task
  WHERE ActivityDate >= LAST_N_DAYS:30
  AND TaskSubtype IN ('Call', 'Email', 'LinkedInMessage', 'Task')
  ORDER BY ActivityDate DESC
  LIMIT 5000
`;

function mapSubtype(subtype, subject) {
  if (subtype === 'Call')            return 'call';
  if (subtype === 'Email')           return 'email';
  if (subtype === 'LinkedInMessage') return 'linkedin';
  if (subtype === 'Task')            return 'task';
  const sl = (subject || '').toLowerCase();
  if (sl.includes('call'))     return 'call';
  if (sl.includes('email'))    return 'email';
  if (sl.includes('linkedin')) return 'linkedin';
  return 'task';
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed. Use POST.' });

  const startedAt = new Date();
  let synced = 0;
  let errors = 0;

  try {
    // 1. Connect to SFDC via jsforce
    const conn = new jsforce.Connection({ loginUrl: SFDC_INSTANCE });
    await conn.login(SFDC_USER, SFDC_PASSWORD + SFDC_TOKEN);

    // 2. Query tasks
    const result = await conn.query(SOQL);
    let records = result.records || [];

    // Handle queryMore if needed
    let queryResult = result;
    while (!queryResult.done && queryResult.nextRecordsUrl) {
      queryResult = await conn.queryMore(queryResult.nextRecordsUrl);
      records = records.concat(queryResult.records || []);
    }

    // 3. Build account/contact sfdc_id lookup sets
    const acctRes = await query('SELECT sfdc_id FROM accounts WHERE sfdc_id IS NOT NULL');
    const contRes = await query('SELECT sfdc_id FROM contacts WHERE sfdc_id IS NOT NULL');
    const accountIds = new Set(acctRes.rows.map(r => r.sfdc_id));
    const contactIds = new Set(contRes.rows.map(r => r.sfdc_id));

    // 4. Upsert in batches
    const UPSERT_SQL = `
      INSERT INTO activities (
        sfdc_id, account_sfdc_id, contact_sfdc_id,
        type, subject, activity_date,
        outcome, notes, rep,
        source_system, call_duration_seconds, call_disposition,
        created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'sfdc',$10,$11,NOW())
      ON CONFLICT (sfdc_id) DO UPDATE SET
        account_sfdc_id       = EXCLUDED.account_sfdc_id,
        contact_sfdc_id       = EXCLUDED.contact_sfdc_id,
        type                  = EXCLUDED.type,
        subject               = EXCLUDED.subject,
        activity_date         = EXCLUDED.activity_date,
        outcome               = EXCLUDED.outcome,
        notes                 = EXCLUDED.notes,
        rep                   = EXCLUDED.rep,
        call_duration_seconds = EXCLUDED.call_duration_seconds,
        call_disposition      = EXCLUDED.call_disposition,
        source_system         = 'sfdc'
    `;

    for (const rec of records) {
      try {
        const whatId      = rec.WhatId || null;
        const whoId       = rec.WhoId  || null;
        const actDate     = rec.ActivityDate ? new Date(rec.ActivityDate) : null;
        const ownerName   = rec.Owner?.Name || null;
        const acctSfdcId  = whatId && accountIds.has(whatId) ? whatId : null;
        const contSfdcId  = whoId  && contactIds.has(whoId)  ? whoId  : null;
        const duration    = rec.CallDurationInSeconds != null ? parseInt(rec.CallDurationInSeconds) : null;

        await query(UPSERT_SQL, [
          rec.Id,
          acctSfdcId,
          contSfdcId,
          mapSubtype(rec.TaskSubtype, rec.Subject),
          (rec.Subject || '').slice(0, 500),
          actDate,
          rec.CallDisposition || null,
          rec.Description ? rec.Description.slice(0, 2000) : null,
          ownerName,
          duration,
          rec.CallDisposition || null,
        ]);
        synced++;
      } catch (rowErr) {
        console.error(`[sync-activities] row error ${rec.Id}:`, rowErr.message);
        errors++;
      }
    }

    // 5. Write sync_log
    const completedAt = new Date();
    await query(
      `INSERT INTO sync_log (table_name, sync_type, completed_at, records_synced, errors, started_at)
       VALUES ('activities', 'incremental_30d', $1, $2, $3, $4)`,
      [completedAt, synced, errors, startedAt]
    );

    return res.status(200).json({
      synced,
      errors,
      total: records.length,
      completedAt: completedAt.toISOString(),
    });

  } catch (err) {
    console.error('[sync-activities] fatal error:', err);
    // Still try to log the failure
    try {
      await query(
        `INSERT INTO sync_log (table_name, sync_type, completed_at, records_synced, errors, started_at, notes)
         VALUES ('activities', 'incremental_30d', NOW(), $1, $2, $3, $4)`,
        [synced, errors + 1, startedAt, err.message]
      );
    } catch (_) { /* ignore log failure */ }

    return res.status(500).json({
      error: err.message,
      synced,
      errors: errors + 1,
      completedAt: new Date().toISOString(),
    });
  }
}
