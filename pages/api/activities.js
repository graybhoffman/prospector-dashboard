/**
 * /api/activities — GET
 *
 * Returns raw activity records for the Daily Activity Detail tables.
 *
 * Query params:
 *   window   "today" — filter to CURRENT_DATE
 *   date     ISO date string or "today"
 *   type     "call" | "connects" | "sets" | "all"
 *   limit    max rows (default 200)
 *
 * Response: { activities: [...], count: number }
 */

import { query } from '../../lib/db';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

const AGENTS_TEAM_OUTREACH_IDS = ['1040', '865', '871', '1043', '1044'];

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { date, type, window: win, limit = 200, teamUserNames, agentsTeam } = req.query;

  let dateFilter = '';
  const params = [];

  if (win === 'today' || date === 'today') {
    dateFilter = `AND DATE(a.activity_date AT TIME ZONE 'America/Los_Angeles') = (NOW() AT TIME ZONE 'America/Los_Angeles')::date`;
  } else if (date) {
    dateFilter = `AND DATE(a.activity_date AT TIME ZONE 'America/Los_Angeles') = $1`;
    params.push(date);
  }

  let typeFilter = '';
  let extraFilter = '';
  let teamFilter = '';

  // Agents team filter: filter by Outreach user IDs
  if (agentsTeam === 'true') {
    const placeholders = AGENTS_TEAM_OUTREACH_IDS.map((_, i) => `$${params.length + i + 1}`).join(', ');
    teamFilter = `AND a.source_system = 'outreach' AND a.outreach_user_id IN (${placeholders})`;
    params.push(...AGENTS_TEAM_OUTREACH_IDS);
  } else if (teamUserNames) {
    // Team filter: filter by rep names
    const names = teamUserNames.split(',').map(n => n.trim()).filter(Boolean);
    if (names.length > 0) {
      const placeholders = names.map((_, i) => `$${params.length + i + 1}`).join(', ');
      teamFilter = `AND a.rep IN (${placeholders})`;
      params.push(...names);
    }
  }

  if (type === 'sets') {
    typeFilter = '';
    extraFilter = `AND (a.type = 'meeting' OR LOWER(a.subject) LIKE '%disco%' OR LOWER(a.subject) LIKE '%discovery%' OR LOWER(a.subject) LIKE '%set%')`;
  } else if (type === 'connects') {
    typeFilter = `AND a.type = 'call'`;
    extraFilter = `AND (LOWER(a.outcome) LIKE '%connect%' OR LOWER(a.outcome) LIKE 'answer%' OR LOWER(a.outcome) LIKE '%spoke%') AND LOWER(a.outcome) NOT LIKE '%no answer%' AND LOWER(a.outcome) NOT LIKE 'no_%' AND LOWER(a.outcome) NOT LIKE 'did not%'`;
  } else if (type && type !== 'all') {
    typeFilter = `AND a.type = $${params.length + 1}`;
    params.push(type);
  }

  const limitInt = Math.min(parseInt(limit) || 200, 500);

  const sql = `
    SELECT
      a.id,
      a.sfdc_id,
      a.type,
      a.subject,
      a.activity_date,
      a.outcome,
      a.rep,
      a.duration_seconds,
      a.source_system,
      a.notes,
      a.account_sfdc_id,
      a.contact_sfdc_id,
      acc.name AS account_name,
      acc.agents_stage AS account_stage,
      acc.ehr_system AS account_ehr,
      CONCAT(c.first_name, ' ', c.last_name) AS contact_name,
      c.title AS contact_title
    FROM activities a
    LEFT JOIN accounts acc ON acc.sfdc_id = a.account_sfdc_id
    LEFT JOIN contacts c ON c.sfdc_id = a.contact_sfdc_id
    WHERE 1=1
      ${dateFilter}
      ${typeFilter}
      ${extraFilter}
      ${teamFilter}
    ORDER BY a.activity_date DESC
    LIMIT ${limitInt}
  `;

  try {
    const result = await query(sql, params);
    return res.status(200).json({ activities: result.rows, count: result.rows.length });
  } catch (err) {
    console.error('[activities]', err.message);
    return res.status(500).json({ error: err.message, activities: [], count: 0 });
  }
}
