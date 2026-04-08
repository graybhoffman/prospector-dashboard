/**
 * /api/opportunities — GET
 *
 * Returns paginated opportunities from Neon Postgres.
 *
 * Query params:
 *   search           text search on opp name, account name
 *   account_name     column filter on account_name
 *   stage_normalized column filter on stage (also accepts `stage` param)
 *   acv              column filter on acv
 *   owner            column filter on owner
 *   close_date       column filter on close_date
 *   source_category  column filter on source_category
 *   agents_icp       "true" = only ICP
 *   active_only      "true" = exclude Closed-Won/Closed-Lost
 *   closed_won       "true" = only Closed-Won
 *   closed_lost      "true" = only Closed-Lost
 *   missing_acv      "true" = only records with NULL/zero ACV
 *   ehr              comma-separated EHR filter
 *   sort             column to sort by (whitelisted)
 *   dir              "asc" | "desc"
 *   page             (default 1)
 *   limit / pageSize (default 50, max 200)
 *   includeExcluded  "true" = include opps for excluded accounts
 *
 * Response: { opportunities, total, page, pageSize }
 */

import { query } from '../../lib/db';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

const SORTABLE_COLS = new Set([
  'account_name', 'name', 'stage_normalized', 'stage', 'acv', 'owner',
  'close_date', 'source_category', 'agents_icp', 'ehr',
]);

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const {
    search, account_name, stage_normalized, stage, acv, owner,
    close_date, source_category, agents_icp,
    active_only, closed_won, closed_lost, missing_acv,
    ehr,
    sort: sortCol, dir: sortDir,
    page = '1', limit, pageSize = '50',
    includeExcluded,
  } = req.query;

  const params = [];
  function addParam(val) { params.push(val); return `$${params.length}`; }

  const conditions = [];

  // Default: exclude opps linked to excluded accounts
  if (includeExcluded !== 'true') {
    conditions.push(`
      (account_sfdc_id IS NULL OR account_sfdc_id NOT IN (
        SELECT sfdc_id FROM accounts WHERE exclude_from_reporting = TRUE AND sfdc_id IS NOT NULL
      ))
    `);
  }

  // Global search
  if (search) {
    const p = addParam(`%${search}%`);
    conditions.push(`(name ILIKE ${p} OR account_name ILIKE ${p})`);
  }
  // Column filters
  if (account_name) {
    conditions.push(`account_name ILIKE ${addParam('%' + account_name + '%')}`);
  }
  // Stage — accepts comma-separated list (multi-select) or text (column filter)
  const stageParam = stage_normalized || stage;
  if (stageParam) {
    const vals = stageParam.split(',').map((v) => v.trim()).filter(Boolean);
    if (vals.length === 1) {
      conditions.push(`stage_normalized ILIKE ${addParam('%' + vals[0] + '%')}`);
    } else if (vals.length > 1) {
      const placeholders = vals.map((v) => addParam(v));
      conditions.push(`stage_normalized IN (${placeholders.join(',')})`);
    }
  }
  if (owner) {
    const ownerVals = owner.split(',').map((v) => v.trim().toLowerCase()).filter(Boolean);
    if (ownerVals.length === 1) {
      conditions.push(`LOWER(owner) LIKE ${addParam('%' + ownerVals[0] + '%')}`);
    } else if (ownerVals.length > 1) {
      const clauses = ownerVals.map((v) => `LOWER(owner) LIKE ${addParam('%' + v + '%')}`);
      conditions.push(`(${clauses.join(' OR ')})`);
    }
  }
  if (source_category) {
    conditions.push(`source_category ILIKE ${addParam('%' + source_category + '%')}`);
  }
  if (ehr) {
    const ehrVals = ehr.split(',').map((v) => v.trim()).filter(Boolean);
    if (ehrVals.length) {
      const clauses = ehrVals.map((v) => `ehr ILIKE ${addParam('%' + v + '%')}`);
      conditions.push(`(${clauses.join(' OR ')})`);
    }
  }
  if (close_date) {
    conditions.push(`close_date::text ILIKE ${addParam('%' + close_date + '%')}`);
  }
  // Boolean / quick filters
  if (agents_icp === 'true') {
    conditions.push('agents_icp = TRUE');
  }
  if (active_only === 'true') {
    const CLOSED_STAGES = [
      'Closed-Won', 'Closed Won', 'Closed-Lost', 'Closed Lost',
      'Closed Lost / Nurture', 'Lost', 'Disqualified',
    ];
    const closedPlaceholders = CLOSED_STAGES.map((s) => addParam(s));
    conditions.push(`(stage_normalized NOT IN (${closedPlaceholders.join(',')}) OR stage_normalized IS NULL)`);
  }
  if (closed_won === 'true') {
    conditions.push(`stage_normalized ILIKE '%Closed%Won%'`);
  }
  if (closed_lost === 'true') {
    conditions.push(`stage_normalized ILIKE '%Closed%Lost%'`);
  }
  if (missing_acv === 'true') {
    conditions.push('(acv IS NULL OR acv = 0)');
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  // Sort
  const safeSortCol = sortCol && SORTABLE_COLS.has(sortCol) ? sortCol : 'account_name';
  const safeSortDir = sortDir === 'desc' ? 'DESC' : 'ASC';
  const orderBy = `ORDER BY ${safeSortCol} ${safeSortDir} NULLS LAST`;

  const pg = Math.max(1, parseInt(page, 10));
  const ps = Math.min(200, parseInt(limit || pageSize, 10));
  const offset = (pg - 1) * ps;

  try {
    const [countResult, dataResult] = await Promise.all([
      query(`SELECT COUNT(*) FROM opportunities ${where}`, params),
      query(`SELECT * FROM opportunities ${where} ${orderBy} LIMIT ${ps} OFFSET ${offset}`, params),
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
