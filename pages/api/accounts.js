/**
 * /api/accounts — GET / PATCH
 *
 * GET: Returns paginated accounts from Neon Postgres.
 * PATCH: Updates account fields directly in Postgres (persistent inline edits).
 *
 * GET Query params:
 *   search           text search on account name
 *   ehr              comma-separated EHR values
 *   stage            comma-separated Stage values
 *   icp              "true" = only ICP-qualified accounts
 *   page             (default 1)
 *   pageSize         (default 50)
 *   includeExcluded  "true" = include excluded-from-reporting accounts
 *
 * Response: { accounts, total, page, pageSize }
 */

import { query } from '../../lib/db';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

const EDITABLE_FIELDS = new Set([
  'agents_stage', 'agents_owner', 'enrichment_notes', 'agents_icp',
  'exclude_from_reporting', 'roe_flag_notes', 'specialty', 'ehr',
  'num_employees', 'num_providers', 'num_locations', 'annual_revenue',
  'est_monthly_call_volume',
]);

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── PATCH: inline edit ────────────────────────────────────────────────────
  if (req.method === 'PATCH') {
    const { accountId, field, value } = req.body || {};
    if (!accountId || !field) return res.status(400).json({ error: 'accountId and field required' });
    if (!EDITABLE_FIELDS.has(field)) return res.status(400).json({ error: `Field '${field}' is not editable` });

    try {
      await query(
        `UPDATE accounts SET ${field} = $1, updated_at = NOW() WHERE sfdc_id = $2 OR id::text = $2`,
        [value, String(accountId)]
      );
      return res.status(200).json({ ok: true, accountId, field, value });
    } catch (err) {
      console.error('[accounts PATCH]', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // ── GET: paginated accounts ───────────────────────────────────────────────
  const {
    search, ehr, stage, icp,
    page = '1', pageSize = '50',
    includeExcluded,
  } = req.query;

  const params = [];

  function addParam(val) {
    params.push(val);
    return `$${params.length}`;
  }

  const conditions = [];

  if (includeExcluded !== 'true') {
    conditions.push('exclude_from_reporting = FALSE');
  }
  if (search) {
    conditions.push(`name ILIKE ${addParam('%' + search + '%')}`);
  }
  if (ehr) {
    const ehrVals = ehr.split(',').map(v => v.trim()).filter(Boolean);
    if (ehrVals.length) {
      const clauses = ehrVals.map(v => `ehr ILIKE ${addParam('%' + v + '%')}`);
      conditions.push(`(${clauses.join(' OR ')})`);
    }
  }
  if (stage) {
    const stageVals = stage.split(',').map(v => v.trim()).filter(Boolean);
    if (stageVals.length) {
      const placeholders = stageVals.map(v => addParam(v));
      conditions.push(`agents_stage IN (${placeholders.join(',')})`);
    }
  }
  if (icp === 'true') {
    conditions.push('agents_icp = TRUE');
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const pg = Math.max(1, parseInt(page, 10));
  const ps = Math.min(200, parseInt(pageSize, 10));
  const offset = (pg - 1) * ps;

  try {
    const [countResult, dataResult] = await Promise.all([
      query(`SELECT COUNT(*) FROM accounts ${where}`, params),
      query(`SELECT * FROM accounts ${where} ORDER BY name LIMIT ${ps} OFFSET ${offset}`, params),
    ]);

    return res.status(200).json({
      accounts: dataResult.rows,
      total: parseInt(countResult.rows[0].count, 10),
      page: pg,
      pageSize: ps,
    });
  } catch (err) {
    console.error('[accounts GET]', err.message);
    return res.status(500).json({ error: err.message });
  }
}
