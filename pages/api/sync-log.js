/**
 * /api/sync-log — GET
 * Returns recent sync_log entries.
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
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // Last sync per table
    const lastSync = await query(`
      SELECT DISTINCT ON (table_name) table_name, sync_type, records_synced, records_created,
        records_updated, errors, completed_at, notes
      FROM sync_log
      ORDER BY table_name, completed_at DESC
    `);

    // Recent 20 entries
    const recent = await query(`
      SELECT * FROM sync_log ORDER BY completed_at DESC LIMIT 20
    `);

    return res.status(200).json({
      lastSyncByTable: lastSync.rows,
      recentEntries: recent.rows,
    });
  } catch (err) {
    console.error('[sync-log]', err.message);
    return res.status(500).json({ error: err.message });
  }
}
