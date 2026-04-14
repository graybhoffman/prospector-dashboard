/**
 * /api/icp-ownership — GET
 *
 * Returns account ownership distribution for the ICP accounts ownership bar chart.
 * Groups by agents_owner, top 8 + "Other" bucket.
 *
 * Response: { owners: [{name, count}], total }
 */

import { query } from '../../lib/db';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const result = await query(`
      SELECT
        COALESCE(NULLIF(TRIM(agents_owner), ''), 'Unassigned') AS owner_name,
        COUNT(*) AS count
      FROM accounts
      WHERE db_status = 'main'
        AND (exclude_from_reporting IS NOT TRUE)
      GROUP BY 1
      ORDER BY count DESC
      LIMIT 50
    `);

    const rows = result.rows.map(r => ({
      name:  r.owner_name,
      value: parseInt(r.count, 10),
    }));

    // Top 8 + Other bucket
    const TOP_N = 8;
    const top   = rows.slice(0, TOP_N);
    const rest  = rows.slice(TOP_N);
    const otherCount = rest.reduce((s, r) => s + r.value, 0);
    if (otherCount > 0) top.push({ name: 'Other', value: otherCount });

    const total = rows.reduce((s, r) => s + r.value, 0);
    return res.status(200).json({ owners: top, total });
  } catch (err) {
    console.error('[icp-ownership GET]', err.message);
    return res.status(500).json({ error: err.message });
  }
}
