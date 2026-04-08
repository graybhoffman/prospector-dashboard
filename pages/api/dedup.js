/**
 * /api/dedup — GET
 * Returns pending dedup_queue items.
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

  const { status = 'pending' } = req.query;

  try {
    const result = await query(
      `SELECT * FROM dedup_queue WHERE status = $1 ORDER BY created_at DESC LIMIT 100`,
      [status]
    );
    return res.status(200).json({ items: result.rows, total: result.rows.length });
  } catch (err) {
    console.error('[dedup]', err.message);
    return res.status(500).json({ error: err.message });
  }
}
