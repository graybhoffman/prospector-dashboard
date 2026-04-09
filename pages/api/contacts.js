/**
 * /api/contacts — GET
 *
 * Returns paginated contacts from Neon Postgres.
 *
 * Query params:
 *   search          text search on full_name / first+last, email, title
 *   name            column filter on full_name
 *   title           column filter on title
 *   account_name    column filter on account_name
 *   email           column filter on email
 *   phone           column filter on phone
 *   target_persona  "true" = only target personas
 *   agents_icp      "true" = only ICP contacts
 *   has_email       "true" = only contacts with email
 *   has_phone       "true" = only contacts with phone
 *   sort            column to sort by (whitelisted)
 *   dir             "asc" | "desc"
 *   page            (default 1)
 *   limit / pageSize (default 50, max 500)
 *
 * Response: { contacts, total, page, pageSize }
 */

import { query } from '../../lib/db';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// full_name expression — works whether or not the table has a full_name column
const FULL_NAME_EXPR = `COALESCE(full_name, TRIM(CONCAT(COALESCE(first_name,''), ' ', COALESCE(last_name,''))))`;

const SORTABLE_COLS = new Set([
  'full_name', 'first_name', 'last_name', 'title', 'account_name',
  'email', 'phone', 'target_persona', 'agents_icp',
]);

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const {
    search, name, title, account_name, email, phone,
    target_persona, agents_icp,
    has_email, has_phone,
    sort: sortCol, dir: sortDir,
    page = '1', limit, pageSize = '50',
    // Legacy params
    targetPersona, inSfdc, source,
  } = req.query;

  const params = [];
  function addParam(val) { params.push(val); return `$${params.length}`; }

  const conditions = [];

  // Global search — use FULL_NAME_EXPR so it works with or without full_name column
  if (search) {
    const p = addParam(`%${search}%`);
    conditions.push(`(${FULL_NAME_EXPR} ILIKE ${p} OR COALESCE(email,'') ILIKE ${p} OR COALESCE(title,'') ILIKE ${p} OR COALESCE(account_name,'') ILIKE ${p})`);
  }
  // Column filters
  if (name) {
    conditions.push(`${FULL_NAME_EXPR} ILIKE ${addParam('%' + name + '%')}`);
  }
  if (title) {
    conditions.push(`title ILIKE ${addParam('%' + title + '%')}`);
  }
  if (account_name) {
    conditions.push(`account_name ILIKE ${addParam('%' + account_name + '%')}`);
  }
  if (email) {
    conditions.push(`email ILIKE ${addParam('%' + email + '%')}`);
  }
  if (phone) {
    conditions.push(`(COALESCE(phone,'') ILIKE ${addParam('%' + phone + '%')} OR COALESCE(mobile_phone,'') ILIKE ${params[params.length - 1]})`);
  }
  // Boolean filters
  if (target_persona === 'true' || targetPersona === 'true') {
    conditions.push('target_persona = TRUE');
  }
  if (agents_icp === 'true') {
    conditions.push('agents_icp = TRUE');
  }
  // Presence filters
  if (has_email === 'true') {
    conditions.push("(email IS NOT NULL AND email != '')");
  }
  if (has_phone === 'true') {
    conditions.push("(COALESCE(phone,'') != '' OR COALESCE(mobile_phone,'') != '')");
  }
  // Legacy params
  if (inSfdc === 'true') {
    conditions.push("sfdc_id IS NOT NULL");
  }
  if (source) {
    conditions.push(`source ILIKE ${addParam('%' + source + '%')}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  // Sort — map full_name → expression, others direct
  let orderBy;
  const safeDir = sortDir === 'desc' ? 'DESC' : 'ASC';
  if (!sortCol || sortCol === 'full_name') {
    orderBy = `ORDER BY ${FULL_NAME_EXPR} ${safeDir} NULLS LAST`;
  } else if (SORTABLE_COLS.has(sortCol)) {
    orderBy = `ORDER BY ${sortCol} ${safeDir} NULLS LAST`;
  } else {
    orderBy = `ORDER BY ${FULL_NAME_EXPR} ASC NULLS LAST`;
  }

  const pg = Math.max(1, parseInt(page, 10));
  const ps = Math.min(500, parseInt(limit || pageSize, 10));
  const offset = (pg - 1) * ps;

  // Build SELECT — add computed full_name so front-end always gets it
  const selectSql = `
    SELECT *,
      ${FULL_NAME_EXPR} AS full_name,
      CASE WHEN sfdc_id IS NOT NULL
        THEN 'https://athelas.lightning.force.com/lightning/r/Contact/' || sfdc_id || '/view'
        ELSE NULL
      END AS sfdc_link
    FROM contacts
  `;

  try {
    const [countResult, dataResult] = await Promise.all([
      query(`SELECT COUNT(*) FROM contacts ${where}`, params),
      query(`${selectSql} ${where} ${orderBy} LIMIT ${ps} OFFSET ${offset}`, params),
    ]);

    return res.status(200).json({
      contacts: dataResult.rows,
      total: parseInt(countResult.rows[0].count, 10),
      page: pg,
      pageSize: ps,
    });
  } catch (err) {
    console.error('[contacts GET]', err.message, err.stack);
    return res.status(500).json({ error: err.message, contacts: [], total: 0, page: pg, pageSize: ps });
  }
}
