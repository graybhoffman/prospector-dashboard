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
 *   includeExcluded      "true" = show ALL accounts (no db_status filter); "false" (default) = hide excluded only
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
  'est_monthly_call_volume', 'next_step', 'db_status',
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
    const body = req.body || {};
    // Support both:
    //   { accountId, field, value }   — inline cell edit (existing)
    //   { accountId, db_status }      — promote/update db_status shorthand
    const accountId = body.accountId;
    const field     = body.db_status !== undefined ? 'db_status' : body.field;
    const value     = body.db_status !== undefined ? body.db_status : body.value;

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
    source_category,
    sort: sortCol, dir: sortDir,
    page = '1', limit, pageSize = '50',
    includeExcluded,
    queue,
  } = req.query;

  const params = [];
  function addParam(val) { params.push(val); return `$${params.length}`; }

  const conditions = [];

  // ── db_status filtering ────────────────────────────────────────────────────
  // ?queue=enrichment     → show enrichment_queue accounts only
  // ?includeExcluded=true → show ALL accounts (no db_status filter — "Show Excluded" toggle ON)
  // default               → hide excluded accounts only (db_status != 'excluded')
  // Special manage-tab case: exclude_from_reporting=true&includeExcluded=true → show flagged accounts
  if (queue === 'enrichment') {
    conditions.push("db_status = 'enrichment_queue'");
  } else if (exclude_from_reporting === 'true' && includeExcluded === 'true') {
    // Special case: manage tab showing excluded accounts (existing behaviour)
    conditions.push('exclude_from_reporting = TRUE');
  } else if (includeExcluded === 'true') {
    // Show Excluded toggle ON: no db_status filter — show everything
    // (no condition pushed)
  } else {
    // Default: hide excluded accounts, but show main, NULL, enrichment_queue, etc.
    conditions.push("(db_status IS NULL OR db_status != 'excluded')");
  }

  // Legacy exclude_from_reporting filter (only applies outside db_status mode)
  if (queue !== 'enrichment' && exclude_from_reporting === 'true' && includeExcluded !== 'true') {
    conditions.push('exclude_from_reporting = TRUE');
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
  // Source category filter
  if (source_category) {
    conditions.push(`source_category ILIKE ${addParam('%' + source_category + '%')}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  // Sort
  const safeSortCol = sortCol && SORTABLE_COLS.has(sortCol) ? sortCol : 'name';
  const safeSortDir = sortDir === 'desc' ? 'DESC' : 'ASC';
  const orderBy = `ORDER BY ${safeSortCol} ${safeSortDir} NULLS LAST`;

  const pg = Math.max(1, parseInt(page, 10));
  const ps = Math.min(200, parseInt(limit || pageSize, 10));
  const offset = (pg - 1) * ps;

  // BUG 3 FIX: Deduplicate accounts that share the same sfdc_id or same name+null-sfdc_id.
  // Duplicate rows exist in the DB (same name, sfdc_id=NULL) from multiple import sources.
  // We use ROW_NUMBER() to keep the best row per logical account:
  //   - Prefer rows with a sfdc_id set (SFDC-synced data)
  //   - Among ties, prefer rows with db_status = 'main' (more enriched)
  //   - Finally, keep the row with the lowest id (oldest / first imported)
  // The dedup key is COALESCE(sfdc_id, name) so:
  //   - Rows with the same sfdc_id → deduplicated to one row
  //   - Rows with sfdc_id=NULL + same name → deduplicated to one row
  //   - Different sfdc_ids with same name → kept separately (legitimately different accounts)
  const dedupCTE = `
    WITH ranked AS (
      SELECT *,
        ROW_NUMBER() OVER (
          PARTITION BY COALESCE(sfdc_id, name)
          ORDER BY
            (sfdc_id IS NOT NULL) DESC,
            (db_status = 'main') DESC,
            (agents_stage IS NOT NULL AND agents_stage != '') DESC,
            id ASC
        ) AS _dedup_rn
      FROM accounts
      ${where}
    )
  `;

  try {
    const [countResult, dataResult] = await Promise.all([
      query(`${dedupCTE} SELECT COUNT(*) FROM ranked WHERE _dedup_rn = 1`, params),
      query(`${dedupCTE} SELECT * FROM ranked WHERE _dedup_rn = 1 ${orderBy} LIMIT ${ps} OFFSET ${offset}`, params),
    ]);

    // Strip the internal dedup column from results
    const accounts = dataResult.rows.map(({ _dedup_rn, ...rest }) => rest);

    return res.status(200).json({
      accounts,
      total: parseInt(countResult.rows[0].count, 10),
      page: pg,
      pageSize: ps,
    });
  } catch (err) {
    console.error('[accounts GET]', err.message);
    return res.status(500).json({ error: err.message });
  }
}
