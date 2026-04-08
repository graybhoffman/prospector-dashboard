/**
 * /api/stats — GET (Postgres-backed)
 *
 * Migrated from Notion pipelineCache → Neon Postgres.
 * Same response shape preserved for frontend compatibility.
 *
 * Returns goals + stats for the full main accounts dataset.
 * No loading state / cache TTL — every request hits Postgres directly.
 * (Neon serverless queries are fast; no warm-up needed.)
 *
 * Response:
 *   { loading, stale, recordCount, fetchedAt, goals, stats }
 *
 * stats.total / recordCount = total main accounts = 3,419 (Postgres source of truth)
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

  try {
    const BASE = `WHERE db_status = 'main' AND (exclude_from_reporting IS NOT TRUE)`;

    const [
      // Goals
      discoveryPlusRes,
      closedWonRes,
      deployedArrRes,
      // Stats
      totalRes,
      stageRes,
      ehrRes,
      specialtyRes,
      sourceRes,
      empBucketRes,
      revBucketRes,
      provBucketRes,
      roeRes,
    ] = await Promise.all([

      // ── Goals ─────────────────────────────────────────────────────────────
      query(`SELECT COUNT(*) FROM accounts
        WHERE db_status = 'main'
          AND agents_stage IN ('Discovery','SQL','Disco Scheduled','Negotiations','Pilot Deployment','Full Deployment')
          AND (exclude_from_reporting IS NOT TRUE)`),

      query(`SELECT COUNT(*) FROM opportunities WHERE stage ILIKE '%won%'`)
        .catch(() => ({ rows: [{ count: '0' }] })),

      query(`SELECT COALESCE(SUM(acv), 0) AS total FROM opportunities WHERE stage ILIKE '%won%' OR stage ILIKE '%deployment%'`)
        .catch(() => ({ rows: [{ total: '0' }] })),

      // ── Stats ─────────────────────────────────────────────────────────────
      query(`SELECT COUNT(*) FROM accounts ${BASE}`),

      query(`SELECT agents_stage   AS val, COUNT(*) FROM accounts ${BASE} GROUP BY 1 ORDER BY COUNT(*) DESC`),
      query(`SELECT ehr_system     AS val, COUNT(*) FROM accounts ${BASE} GROUP BY 1 ORDER BY COUNT(*) DESC`),
      query(`SELECT specialty      AS val, COUNT(*) FROM accounts ${BASE} AND specialty IS NOT NULL GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 20`),
      query(`SELECT source_category AS val, COUNT(*) FROM accounts ${BASE} GROUP BY 1 ORDER BY COUNT(*) DESC`),

      query(`SELECT
          CASE
            WHEN num_employees >= 500 THEN '500+'
            WHEN num_employees >= 101 THEN '101-500'
            WHEN num_employees >= 26  THEN '26-100'
            WHEN num_employees >  0   THEN '1-25'
            ELSE 'Unknown'
          END AS bucket, COUNT(*)
        FROM accounts ${BASE} GROUP BY 1`),

      query(`SELECT
          CASE
            WHEN annual_revenue >= 25000000 THEN '$25M+'
            WHEN annual_revenue >= 10000000 THEN '$10M-$25M'
            WHEN annual_revenue >=  5000000 THEN '$5M-$10M'
            WHEN annual_revenue >=  1000000 THEN '$1M-$5M'
            WHEN annual_revenue >         0 THEN '<$1M'
            ELSE 'Unknown'
          END AS bucket, COUNT(*)
        FROM accounts ${BASE} GROUP BY 1`),

      query(`SELECT
          CASE
            WHEN COALESCE(dhc_num_physicians, num_providers, 0) > 50  THEN '50+'
            WHEN COALESCE(dhc_num_physicians, num_providers, 0) >= 31 THEN '31-50'
            WHEN COALESCE(dhc_num_physicians, num_providers, 0) >= 16 THEN '16-30'
            WHEN COALESCE(dhc_num_physicians, num_providers, 0) >= 6  THEN '6-15'
            WHEN COALESCE(dhc_num_physicians, num_providers, 0) >= 1  THEN '1-5'
            ELSE 'Unknown'
          END AS bucket, COUNT(*)
        FROM accounts ${BASE} GROUP BY 1`),

      query(`SELECT COUNT(*) FROM accounts ${BASE}
        AND potential_roe_issue IS NOT NULL
        AND potential_roe_issue::text NOT IN ('', 'null', '[]')`),
    ]);

    // ── Build response ─────────────────────────────────────────────────────
    const total            = parseInt(totalRes.rows[0].count, 10);
    const discoveryPlus    = parseInt(discoveryPlusRes.rows[0].count, 10);
    const closedWon        = parseInt(closedWonRes.rows[0].count, 10);
    const deployedRevenue  = parseFloat(deployedArrRes.rows[0].total) || 0;
    const roeCount         = parseInt(roeRes.rows[0].count, 10);

    const toObj  = (rows) => Object.fromEntries(rows.map(r => [r.val    || 'Unknown', parseInt(r.count, 10)]));
    const toBObj = (rows) => Object.fromEntries(rows.map(r => [r.bucket || 'Unknown', parseInt(r.count, 10)]));

    const goals = {
      discoveryPlus,
      closedWon,
      deployedRevenue,
      goal1Target:  50,
      goal2Target:  7,
      goal3Target:  300_000,
    };

    const stats = {
      total,
      notRcmCount:       0, // not tracked in Postgres
      confirmedIcpCount: total, // all db_status='main' accounts are ICP
      roeCount,
      byStage:           toObj(stageRes.rows),
      byEhr:             toObj(ehrRes.rows),
      bySpecialty:       toObj(specialtyRes.rows),
      bySource:          toObj(sourceRes.rows),
      employeeBuckets:   toBObj(empBucketRes.rows),
      byRevenueBucket:   toBObj(revBucketRes.rows),
      byProviderBucket:  toBObj(provBucketRes.rows),
    };

    return res.status(200).json({
      loading:     false,
      stale:       false,
      recordCount: total,
      fetchedAt:   new Date().toISOString(),
      source:      'postgres',
      goals,
      stats,
    });
  } catch (err) {
    console.error('[stats GET]', err.message, err.stack);
    return res.status(500).json({
      loading: false,
      stale:   true,
      error:   err.message,
      recordCount: 0,
      fetchedAt:   null,
      goals:  { discoveryPlus: null, closedWon: null, deployedRevenue: null, goal1Target: 50, goal2Target: 7, goal3Target: 300_000 },
      stats:  { total: null, notRcmCount: null, confirmedIcpCount: null, roeCount: null },
    });
  }
}
