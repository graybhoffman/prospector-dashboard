/**
 * /api/pipeline-pulse — GET
 * Returns Discovery+ accounts with last touch info and days since touch.
 * Supports: stage filter, owner filter
 */
import { query } from '../../lib/db';

const PIPELINE_STAGES = [
  'Discovery', 'SQL', 'Disco Scheduled', 'Negotiations',
  'Pilot Deployment', 'Full Deployment',
];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // Ensure columns exist
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
       WHERE a.agents_stage IN (${stagePlaceholders})`,
      PIPELINE_STAGES
    );

    const sql = `
      SELECT
        a.id,
        a.name,
        a.agents_stage,
        a.sfdc_id,
        a.sfdc_link,
        a.agents_owner,
        a.next_step,
        a.last_touch_date,
        CASE
          WHEN a.last_touch_date IS NULL THEN NULL
          ELSE (CURRENT_DATE - a.last_touch_date)
        END AS days_since_touch,
        (
          SELECT o.acv FROM opportunities o
          WHERE o.account_sfdc_id = a.sfdc_id
            AND o.stage_normalized NOT IN (
              'Closed-Won','Closed Won','Closed-Lost','Closed Lost','Closed Lost / Nurture'
            )
          ORDER BY o.acv DESC NULLS LAST
          LIMIT 1
        ) AS acv
      FROM accounts a
      WHERE a.agents_stage IN (${stagePlaceholders})
        AND (a.exclude_from_reporting IS NOT TRUE)
      ORDER BY days_since_touch DESC NULLS LAST, a.name ASC
    `;

    const result = await query(sql, PIPELINE_STAGES);

    return res.status(200).json({
      accounts: result.rows,
      count: result.rows.length,
    });
  } catch (err) {
    console.error('[pipeline-pulse GET]', err.message);
    return res.status(500).json({ error: err.message });
  }
}
