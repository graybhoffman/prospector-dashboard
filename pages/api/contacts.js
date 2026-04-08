/**
 * /api/contacts — GET
 *
 * Returns paginated contacts from Neon Postgres.
 *
 * Query params:
 *   search          text search on full_name, email, title
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
    targetPersona, inSfdc, inPipeline, source, connDegree,
  } = req.query;

  const params = [];
  function addParam(val) { params.push(val); return `$${params.length}`; }

  const conditions = [];

  // Global search
  if (search) {
    const p = addParam(`%${search}%`);
    conditions.push(`(full_name ILIKE ${p} OR email ILIKE ${p} OR title ILIKE ${p} OR account_name ILIKE ${p})`);
  }
  // Column filters
  if (name) {
    conditions.push(`full_name ILIKE ${addParam('%' + name + '%')}`);
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
    conditions.push(`phone ILIKE ${addParam('%' + phone + '%')}`);
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
    conditions.push("(phone IS NOT NULL AND phone != '')");
  }
  // Legacy params
  if (inSfdc === 'true') {
    conditions.push("sfdc_id IS NOT NULL");
  }
  if (source) {
    conditions.push(`source ILIKE ${addParam('%' + source + '%')}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  // Sort
  const safeSortCol = sortCol && SORTABLE_COLS.has(sortCol) ? sortCol : 'full_name';
  const safeSortDir = sortDir === 'desc' ? 'DESC' : 'ASC';
  const orderBy = `ORDER BY ${safeSortCol} ${safeSortDir} NULLS LAST`;

  const pg = Math.max(1, parseInt(page, 10));
  const ps = Math.min(500, parseInt(limit || pageSize, 10));
  const offset = (pg - 1) * ps;

  try {
    const [countResult, dataResult] = await Promise.all([
      query(`SELECT COUNT(*) FROM contacts ${where}`, params),
      query(`SELECT * FROM contacts ${where} ${orderBy} LIMIT ${ps} OFFSET ${offset}`, params),
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
