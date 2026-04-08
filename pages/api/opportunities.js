/**
 * /api/opportunities — GET
 *
 * Returns paginated opportunities from Neon Postgres.
 *
 * Query params:
 *   search    text search on opp name, account name
 *   stage     comma-separated Stage values
 *   ehr       comma-separated EHR values
 *   owner     comma-separated Owner values
 *   page      (default 1)
 *   pageSize  (default 50)
 *
 * Response: { opportunities, total, page, pageSize }
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

  const {
    search, stage, ehr, owner,
    page = '1', pageSize = '50',
    includeExcluded,
  } = req.query;

  const params = [];
  function addParam(val) { params.push(val); return `$${params.length}`; }

  const conditions = [];

  // Exclude accounts marked as excluded (via subquery)
  if (includeExcluded !== 'true') {
    conditions.push(`
      (account_sfdc_id IS NULL OR account_sfdc_id NOT IN (
        SELECT sfdc_id FROM accounts WHERE exclude_from_reporting = TRUE AND sfdc_id IS NOT NULL
      ))
    `);
  }

  if (search) {
    const p = addParam(`%${search}%`);
    conditions.push(`(name ILIKE ${p} OR account_name ILIKE ${p})`);
  }
  if (stage) {
    const stageVals = stage.split(',').map(v => v.trim()).filter(Boolean);
    if (stageVals.length) {
      const placeholders = stageVals.map(v => addParam(v));
      conditions.push(`stage_normalized IN (${placeholders.join(',')})`);
    }
  }
  if (ehr) {
    const ehrVals = ehr.split(',').map(v => v.trim()).filter(Boolean);
    if (ehrVals.length) {
      const clauses = ehrVals.map(v => `ehr ILIKE ${addParam('%' + v + '%')}`);
      conditions.push(`(${clauses.join(' OR ')})`);
    }
  }
  if (owner) {
    const ownerVals = owner.split(',').map(v => v.trim().toLowerCase()).filter(Boolean);
    if (ownerVals.length) {
      const clauses = ownerVals.map(v => `LOWER(owner) LIKE ${addParam('%' + v + '%')}`);
      conditions.push(`(${clauses.join(' OR ')})`);
    }
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const pg = Math.max(1, parseInt(page, 10));
  const ps = Math.min(200, parseInt(pageSize, 10));
  const offset = (pg - 1) * ps;

  try {
    const [countResult, dataResult] = await Promise.all([
      query(`SELECT COUNT(*) FROM opportunities ${where}`, params),
      query(`SELECT * FROM opportunities ${where} ORDER BY account_name, name LIMIT ${ps} OFFSET ${offset}`, params),
    ]);

    return res.status(200).json({
      opportunities: dataResult.rows,
      total: parseInt(countResult.rows[0].count, 10),
      page: pg,
      pageSize: ps,
    });
  } catch (err) {
    console.error('[opportunities GET]', err.message);
    return res.status(500).json({ error: err.message });
  }
}
