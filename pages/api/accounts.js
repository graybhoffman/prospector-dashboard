/**
 * /api/accounts — GET / PATCH
 *
 * GET: Returns paginated accounts from Neon Postgres.
 * PATCH: Updates account fields directly in Postgres (persistent inline edits).
 *
 * GET Query params:
 *   search               text search on account name
 *   name                 column filter on name
 *   domain               column filter on domain
 *   billing_state        column filter on billing_state
 *   industry             column filter on industry
 *   agents_icp           "true" / "false" filter
 *   agents_stage         comma-separated stage values (or column filter string)
 *   agents_owner         column filter on agents_owner
 *   ehr                  comma-separated EHR values
 *   exclude_from_reporting  "true" = only excluded accounts
 *   has_roe              "true" = only accounts with non-empty potential_roe_issue
 *   has_stage            "true" = only accounts with a stage set
 *   sort                 column to sort by (whitelisted)
 *   dir                  "asc" | "desc"
 *   page                 (default 1)
 *   limit / pageSize     (default 50, max 200)
 *   includeExcluded      "true" = include excluded accounts (overrides default hide)
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

// Whitelist of columns that can be used in ORDER BY (prevent SQL injection)
const SORTABLE_COLS = new Set([
  'name', 'domain', 'billing_state', 'industry', 'agents_stage', 'agents_owner',
  'agents_icp', 'num_providers', 'num_employees', 'annual_revenue',
  'exclude_from_reporting', 'source_category', 'specialty', 'ehr',
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
    search, name, domain, billing_state, industry,
    agents_icp, agents_stage, agents_owner, ehr,
    exclude_from_reporting, has_roe, has_stage,
    sort: sortCol, dir: sortDir,
    page = '1', limit, pageSize = '50',
    includeExcluded,
  } = req.query;

  const params = [];
  function addParam(val) { params.push(val); return `$${params.length}`; }

  const conditions = [];

  // Default: hide excluded accounts (unless explicitly requested)
  if (exclude_from_reporting === 'true') {
    conditions.push('exclude_from_reporting = TRUE');
  } else if (includeExcluded !== 'true') {
    conditions.push('(exclude_from_reporting = FALSE OR exclude_from_reporting IS NULL)');
  }

  // Global search (OR across name)
  if (search) {
    conditions.push(`name ILIKE ${addParam('%' + search + '%')}`);
  }
  // Column filter: name
  if (name) {
    conditions.push(`name ILIKE ${addParam('%' + name + '%')}`);
  }
  // Column filter: domain
  if (domain) {
    conditions.push(`domain ILIKE ${addParam('%' + domain + '%')}`);
  }
  // Column filter: billing_state
  if (billing_state) {
    conditions.push(`billing_state ILIKE ${addParam('%' + billing_state + '%')}`);
  }
  // Column filter: industry
  if (industry) {
    conditions.push(`industry ILIKE ${addParam('%' + industry + '%')}`);
  }
  // Column filter: agents_owner
  if (agents_owner) {
    conditions.push(`agents_owner ILIKE ${addParam('%' + agents_owner + '%')}`);
  }
  // EHR (comma-separated or single)
  if (ehr) {
    const ehrVals = ehr.split(',').map((v) => v.trim()).filter(Boolean);
    if (ehrVals.length === 1) {
      conditions.push(`ehr ILIKE ${addParam('%' + ehrVals[0] + '%')}`);
    } else if (ehrVals.length > 1) {
      const clauses = ehrVals.map((v) => `ehr ILIKE ${addParam('%' + v + '%')}`);
      conditions.push(`(${clauses.join(' OR ')})`);
    }
  }
  // Stage (comma-separated for multi-select, or single string for column filter)
  if (agents_stage) {
    const stageVals = agents_stage.split(',').map((v) => v.trim()).filter(Boolean);
    if (stageVals.length === 1 && !agents_stage.includes(',')) {
      // Could be a column text filter
      conditions.push(`agents_stage ILIKE ${addParam('%' + stageVals[0] + '%')}`);
    } else if (stageVals.length > 1) {
      const placeholders = stageVals.map((v) => addParam(v));
      conditions.push(`agents_stage IN (${placeholders.join(',')})`);
    }
  }
  // ICP boolean
  if (agents_icp === 'true') {
    conditions.push('agents_icp = TRUE');
  } else if (agents_icp === 'false') {
    conditions.push('(agents_icp = FALSE OR agents_icp IS NULL)');
  }
  // ROE flagged
  if (has_roe === 'true') {
    conditions.push("(potential_roe_issue IS NOT NULL AND potential_roe_issue::text NOT IN ('[]', 'null', ''))");
  }
  // Has stage
  if (has_stage === 'true') {
    conditions.push("(agents_stage IS NOT NULL AND agents_stage != '')");
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  // Sort
  const safeSortCol = sortCol && SORTABLE_COLS.has(sortCol) ? sortCol : 'name';
  const safeSortDir = sortDir === 'desc' ? 'DESC' : 'ASC';
  const orderBy = `ORDER BY ${safeSortCol} ${safeSortDir} NULLS LAST`;

  const pg = Math.max(1, parseInt(page, 10));
  const ps = Math.min(200, parseInt(limit || pageSize, 10));
  const offset = (pg - 1) * ps;

  try {
    const [countResult, dataResult] = await Promise.all([
      query(`SELECT COUNT(*) FROM accounts ${where}`, params),
      query(`SELECT * FROM accounts ${where} ${orderBy} LIMIT ${ps} OFFSET ${offset}`, params),
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
