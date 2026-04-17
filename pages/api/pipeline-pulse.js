/**
 * /api/pipeline-pulse — GET
 * Returns pipeline opportunities with last touch info and days since touch.
 * Supports: owner filter, ownerType filter
 */
import { query } from '../../lib/db';

const PIPELINE_STAGES = [
  'Discovery', 'SQL', 'Negotiations', 'Pilot Deployment', 'Full Deployment',
];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // Ensure next_step and last_touch_date columns exist
    await query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS next_step TEXT`);
    await query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS last_touch_date DATE`);

    // Recompute last_touch_date for all relevant accounts
    const stagePlaceholders = PIPELINE_STAGES.map((_, i) => `$${i + 1}`).join(',');
    await query(
      `UPDATE accounts a
       SET last_touch_date = (
         SELECT MAX(activity_date)::date FROM activities
         WHERE account_sfdc_id = a.sfdc_id
       )
       WHERE a.sfdc_id IN (
         SELECT DISTINCT o.account_sfdc_id FROM opportunities o
         WHERE o.stage_normalized IN (${stagePlaceholders})
           AND o.stage_normalized NOT ILIKE '%lost%'
       )`,
      PIPELINE_STAGES
    );

    const { owner, ownerType } = req.query;

    // Build WHERE clause
    const params = [...PIPELINE_STAGES]; // $1..$N for stage placeholders
    let ownerClause = '';
    if (owner && owner.trim()) {
      const ownerParam = `%${owner.trim()}%`;
      const idx = params.length + 1;
      params.push(ownerParam);
      if (ownerType === 'opp') {
        ownerClause = `AND o.owner ILIKE $${idx}`;
      } else if (ownerType === 'account') {
        ownerClause = `AND a.sfdc_owner_name ILIKE $${idx}`;
      } else {
        ownerClause = `AND (o.owner ILIKE $${idx} OR a.sfdc_owner_name ILIKE $${idx})`;
      }
    }

    const sql = `
      SELECT
        o.id,
        o.sfdc_id                          AS opp_sfdc_id,
        o.account_sfdc_id,
        o.name                             AS opp_name,
        o.account_name,
        o.stage_normalized                 AS stage,
        o.owner                            AS opp_owner,
        o.booked_by,
        o.ehr,
        o.acv,
        o.close_date,
        a.sfdc_owner_name                  AS account_owner,
        a.next_step,
        a.last_touch_date,
        a.specialty,
        a.num_employees,
        (CURRENT_DATE - a.last_touch_date) AS days_since_touch
      FROM opportunities o
      LEFT JOIN accounts a ON a.sfdc_id = o.account_sfdc_id
      WHERE o.stage_normalized IN (${stagePlaceholders})
        AND o.stage_normalized NOT ILIKE '%lost%'
        ${ownerClause}
      ORDER BY days_since_touch DESC NULLS LAST, o.account_name ASC
    `;

    const result = await query(sql, params);

    // Fetch all distinct opp owners (no stage filter) for dropdown
    const ownersResult = await query(
      `SELECT DISTINCT o.owner FROM opportunities o WHERE o.owner IS NOT NULL AND o.owner <> '' ORDER BY o.owner ASC`
    );
    const allOwners = ownersResult.rows.map((r) => r.owner);
    const owners = [...new Set(result.rows.map((r) => r.opp_owner).filter(Boolean))].sort();

    return res.status(200).json({
      opps: result.rows,
      count: result.rows.length,
      owners,
      allOwners,
    });
  } catch (err) {
    console.error('[pipeline-pulse GET]', err.message);
    return res.status(500).json({ error: err.message });
  }
}
