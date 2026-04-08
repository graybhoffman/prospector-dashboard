/**
 * /api/contacts — GET
 *
 * Returns paginated contacts from Neon Postgres.
 *
 * Query params:
 *   search    text search on full_name, email
 *   page      (default 1)
 *   pageSize  (default 50, max 500)
 *
 * Response: { contacts, total, page, pageSize }
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

  const { search, page = '1', pageSize = '50' } = req.query;

  const params = [];
  function addParam(val) { params.push(val); return `$${params.length}`; }

  const conditions = [];

  if (search) {
    const p = addParam(`%${search}%`);
    conditions.push(`(full_name ILIKE ${p} OR email ILIKE ${p} OR title ILIKE ${p})`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const pg = Math.max(1, parseInt(page, 10));
  const ps = Math.min(500, parseInt(pageSize, 10));
  const offset = (pg - 1) * ps;

  try {
    const [countResult, dataResult] = await Promise.all([
      query(`SELECT COUNT(*) FROM contacts ${where}`, params),
      query(`SELECT * FROM contacts ${where} ORDER BY full_name LIMIT ${ps} OFFSET ${offset}`, params),
    ]);

    return res.status(200).json({
      contacts: dataResult.rows,
      total: parseInt(countResult.rows[0].count, 10),
      page: pg,
      pageSize: ps,
    });
  } catch (err) {
    console.error('[contacts GET]', err.message);
    return res.status(500).json({ error: err.message });
  }
}
