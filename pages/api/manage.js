/**
 * /api/manage — POST
 *
 * Bulk operations on accounts/contacts/opps in Postgres.
 *
 * Body: { action, ids, payload }
 *
 * Actions:
 *   bulk_update_accounts — update fields for multiple accounts
 *   approve_dedup        — approve a dedup_queue item
 *   reject_dedup         — reject a dedup_queue item
 */

import { query } from '../../lib/db';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

const BULK_EDITABLE = new Set([
  'agents_stage', 'agents_owner', 'exclude_from_reporting', 'agents_icp',
]);

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action, ids, payload } = req.body || {};

  try {
    if (action === 'bulk_update_accounts') {
      if (!ids?.length || !payload) return res.status(400).json({ error: 'ids and payload required' });
      const sets = [];
      const params = [];
      for (const [field, value] of Object.entries(payload)) {
        if (!BULK_EDITABLE.has(field)) continue;
        params.push(value);
        sets.push(`${field} = $${params.length}`);
      }
      if (!sets.length) return res.status(400).json({ error: 'No valid fields to update' });
      sets.push('updated_at = NOW()');
      params.push(ids);
      const result = await query(
        `UPDATE accounts SET ${sets.join(', ')} WHERE sfdc_id = ANY($${params.length}) OR id::text = ANY($${params.length})`,
        params
      );
      return res.status(200).json({ ok: true, rowsAffected: result.rowCount });
    }

    if (action === 'approve_dedup') {
      const { id } = payload || {};
      if (!id) return res.status(400).json({ error: 'id required' });
      await query(`UPDATE dedup_queue SET status = 'approved', reviewed_at = NOW() WHERE id = $1`, [id]);
      return res.status(200).json({ ok: true });
    }

    if (action === 'reject_dedup') {
      const { id } = payload || {};
      if (!id) return res.status(400).json({ error: 'id required' });
      await query(`UPDATE dedup_queue SET status = 'rejected', reviewed_at = NOW() WHERE id = $1`, [id]);
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (err) {
    console.error('[manage]', err.message);
    return res.status(500).json({ error: err.message });
  }
}
