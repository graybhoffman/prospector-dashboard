/**
 * /api/accounts/[id] — GET full account detail
 * Returns SELECT * FROM accounts WHERE id = $1 (or sfdc_id = $1)
 */

import { query } from '../../../lib/db';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'id required' });

  try {
    const result = await query(
      `SELECT * FROM accounts WHERE id::text = $1 OR sfdc_id = $1 LIMIT 1`,
      [String(id)]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Account not found' });
    return res.status(200).json({ account: result.rows[0] });
  } catch (err) {
    console.error('[accounts/[id] GET]', err.message);
    return res.status(500).json({ error: err.message });
  }
}
