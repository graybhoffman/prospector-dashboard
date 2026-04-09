/**
 * /api/pipeline — GET (Postgres-backed)
 *
 * Migrated from Notion pipelineCache → Neon Postgres accounts table.
 * Same response shape preserved for frontend compatibility.
 *
 * Query params:
 *   page, pageSize
 *   ehr        comma-separated EHR values
 *   stage      comma-separated Stage values
 *   specialty  comma-separated Specialty values
 *   source     Source Category (comma-separated)
 *   roe        "true"
 *   search     text search on account name
 *
 * Response:
 *   { meta, globals: { goals, stats }, aggregations, records }
 *
 * records are in Notion-compatible { id, fields: { 'Account Name': ..., 'EHR': ... } } format
 * so existing frontend components continue to work unchanged.
 */

import { query } from '../../lib/db';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// Map a Postgres account row → Notion-compatible record shape
function rowToRecord(row) {
  return {
    id: String(row.id),
    fields: {
      'Account Name':        row.name,
      'EHR':                 row.ehr_system,
      'Stage':               row.agents_stage,
      'Specialty':           row.specialty,
      'Source Category':     row.source_category,
      'Source Sub-Category': row.source_sub_category,
      'Employees #':         row.num_employees    != null ? Number(row.num_employees)    : null,
      'Annual Revenue ($)':  row.annual_revenue   != null ? Number(row.annual_revenue)   : null,
      'Providers #': (
        row.dhc_num_physicians != null ? Number(row.dhc_num_physicians) :
        row.num_providers      != null ? Number(row.num_providers)      : null
      ),
      '# of locations':      row.num_locations    != null ? Number(row.num_locations)    : null,
      'Potential ROE Issue':  row.potential_roe_issue,
      'Exclude from Reporting': row.exclude_from_reporting,
      'SFDC Link':            row.sfdc_link,
      'agents_icp':           row.agents_icp,
      'Not in RCM ICP':       false, // not tracked in Postgres
    },
  };
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const {
      ehr, stage, specialty, source, roe, search,
      page: pageQ, pageSize: pageSizeQ,
    } = req.query;

    const page     = Math.max(1, parseInt(pageQ     || '1',  10));
    const pageSize = Math.min(500, parseInt(pageSizeQ || '50', 10));

    // ── Param builder (shared across all filtered queries) ─────────────────
    const params = [];
    function addParam(val) { params.push(val); return `$${params.length}`; }

    // Static base conditions (no params needed)
    const BASE_WHERE = `WHERE db_status = 'main' AND (exclude_from_reporting IS NOT TRUE)`;

    // Filter conditions (may add params)
    const filterConds = [`db_status = 'main'`, `(exclude_from_reporting IS NOT TRUE)`];

    if (ehr) {
      const vals = ehr.split(',').map(v => v.trim()).filter(Boolean);
      if (vals.length === 1) {
        filterConds.push(`ehr_system = ${addParam(vals[0])}`);
      } else if (vals.length > 1) {
        filterConds.push(`ehr_system IN (${vals.map(v => addParam(v)).join(',')})`);
      }
    }
    if (stage) {
      const vals = stage.split(',').map(v => v.trim()).filter(Boolean);
      if (vals.length === 1) {
        filterConds.push(`agents_stage = ${addParam(vals[0])}`);
      } else if (vals.length > 1) {
        filterConds.push(`agents_stage IN (${vals.map(v => addParam(v)).join(',')})`);
      }
    }
    if (specialty) {
      const vals = specialty.split(',').map(v => v.trim()).filter(Boolean);
      if (vals.length === 1) {
        filterConds.push(`specialty = ${addParam(vals[0])}`);
      } else if (vals.length > 1) {
        filterConds.push(`specialty IN (${vals.map(v => addParam(v)).join(',')})`);
      }
    }
    if (source) {
      const vals = source.split(',').map(v => v.trim()).filter(Boolean);
      if (vals.length === 1) {
        filterConds.push(`source_category = ${addParam(vals[0])}`);
      } else if (vals.length > 1) {
        filterConds.push(`source_category IN (${vals.map(v => addParam(v)).join(',')})`);
      }
    }
    if (roe === 'true') {
      filterConds.push(`(potential_roe_issue IS NOT NULL AND potential_roe_issue::text NOT IN ('', 'null', '[]'))`);
    }
    if (search) {
      filterConds.push(`name ILIKE ${addParam('%' + search + '%')}`);
    }

    const FILTER_WHERE = `WHERE ${filterConds.join(' AND ')}`;

    // ── 1. Goals (opportunities + accounts) ───────────────────────────────
    const [discoveryPlusRes, closedWonRes, deployedArrRes] = await Promise.all([
      query(`SELECT COUNT(*) FROM accounts
        WHERE db_status = 'main'
          AND agents_stage IN ('Discovery','SQL','Disco Scheduled','Negotiations','Pilot Deployment','Full Deployment')
          AND (exclude_from_reporting IS NOT TRUE)`),
      query(`SELECT COUNT(*) FROM opportunities WHERE stage ILIKE '%won%'`).catch(() => ({ rows: [{ count: '0' }] })),
      query(`SELECT COALESCE(SUM(acv), 0) AS total FROM opportunities WHERE stage ILIKE '%won%' OR stage ILIKE '%deployment%'`).catch(() => ({ rows: [{ total: '0' }] })),
    ]);

    const goals = {
      discoveryPlus:   parseInt(discoveryPlusRes.rows[0].count, 10),
      closedWon:       parseInt(closedWonRes.rows[0].count, 10),
      deployedRevenue: parseFloat(deployedArrRes.rows[0].total) || 0,
      goal1Target:  50,
      goal2Target:  7,
      goal3Target:  300_000,
    };

    // ── 2. Global stats (full main dataset) ────────────────────────────────
    const [
      globalTotalRes,
      globalStageRes,
      globalEhrRes,
      globalSpecialtyRes,
      globalSourceRes,
      globalEmpBucketRes,
      globalRevBucketRes,
      globalProvBucketRes,
    ] = await Promise.all([
      query(`SELECT COUNT(*) FROM accounts ${BASE_WHERE}`),
      query(`SELECT agents_stage AS val, COUNT(*) FROM accounts ${BASE_WHERE} GROUP BY 1 ORDER BY COUNT(*) DESC`),
      query(`SELECT ehr_system     AS val, COUNT(*) FROM accounts ${BASE_WHERE} GROUP BY 1 ORDER BY COUNT(*) DESC`),
      query(`SELECT specialty      AS val, COUNT(*) FROM accounts ${BASE_WHERE} AND specialty IS NOT NULL GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 20`),
      query(`SELECT source_category AS val, COUNT(*) FROM accounts ${BASE_WHERE} GROUP BY 1 ORDER BY COUNT(*) DESC`),
      query(`SELECT
          CASE
            WHEN num_employees >= 500 THEN '500+'
            WHEN num_employees >= 101 THEN '101-500'
            WHEN num_employees >= 26  THEN '26-100'
            WHEN num_employees >  0   THEN '1-25'
            ELSE 'Unknown'
          END AS bucket, COUNT(*)
        FROM accounts ${BASE_WHERE} GROUP BY 1`),
      query(`SELECT
          CASE
            WHEN annual_revenue >= 25000000 THEN '$25M+'
            WHEN annual_revenue >= 10000000 THEN '$10M-$25M'
            WHEN annual_revenue >=  5000000 THEN '$5M-$10M'
            WHEN annual_revenue >=  1000000 THEN '$1M-$5M'
            WHEN annual_revenue >         0 THEN '<$1M'
            ELSE 'Unknown'
          END AS bucket, COUNT(*)
        FROM accounts ${BASE_WHERE} GROUP BY 1`),
      query(`SELECT
          CASE
            WHEN COALESCE(dhc_num_physicians, num_providers, 0) > 50  THEN '50+'
            WHEN COALESCE(dhc_num_physicians, num_providers, 0) >= 31 THEN '31-50'
            WHEN COALESCE(dhc_num_physicians, num_providers, 0) >= 16 THEN '16-30'
            WHEN COALESCE(dhc_num_physicians, num_providers, 0) >= 6  THEN '6-15'
            WHEN COALESCE(dhc_num_physicians, num_providers, 0) >= 1  THEN '1-5'
            ELSE 'Unknown'
          END AS bucket, COUNT(*)
        FROM accounts ${BASE_WHERE} GROUP BY 1`),
    ]);

    const globalTotal = parseInt(globalTotalRes.rows[0].count, 10);

    const toObj  = (rows) => Object.fromEntries(rows.map(r => [r.val || 'Unknown', parseInt(r.count, 10)]));
    const toBObj = (rows) => Object.fromEntries(rows.map(r => [r.bucket,           parseInt(r.count, 10)]));

    const globalStats = {
      total:             globalTotal,
      byStage:           toObj(globalStageRes.rows),
      byEhr:             toObj(globalEhrRes.rows),
      bySpecialty:       toObj(globalSpecialtyRes.rows),
      bySource:          toObj(globalSourceRes.rows),
      byEmployeeBucket:  toBObj(globalEmpBucketRes.rows),
      byRevenueBucket:   toBObj(globalRevBucketRes.rows),
      byProviderBucket:  toBObj(globalProvBucketRes.rows),
      notRcmCount:       0,
      roeCount:          0,
      confirmedIcpCount: parseInt((await query(`SELECT COUNT(*) FROM accounts ${BASE_WHERE} AND agents_icp = TRUE`)).rows[0].count, 10),
    };

    // ── 3. Filtered aggregations ───────────────────────────────────────────
    const [
      filtTotalRes,
      filtStageRes,
      filtEhrRes,
      filtSpecialtyRes,
      filtSourceRes,
      filtSpecTaggedRes,
    ] = await Promise.all([
      query(`SELECT COUNT(*) FROM accounts ${FILTER_WHERE}`, params),
      query(`SELECT agents_stage  AS val, COUNT(*) FROM accounts ${FILTER_WHERE} GROUP BY 1 ORDER BY COUNT(*) DESC`, params),
      query(`SELECT ehr_system    AS val, COUNT(*) FROM accounts ${FILTER_WHERE} GROUP BY 1 ORDER BY COUNT(*) DESC`, params),
      query(`SELECT specialty     AS val, COUNT(*) FROM accounts ${FILTER_WHERE} AND specialty IS NOT NULL GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 20`, params),
      query(`SELECT source_category AS val, COUNT(*) FROM accounts ${FILTER_WHERE} GROUP BY 1 ORDER BY COUNT(*) DESC`, params),
      query(`SELECT COUNT(*) FROM accounts ${FILTER_WHERE} AND specialty IS NOT NULL AND specialty != ''`, params),
    ]);

    const filteredTotal       = parseInt(filtTotalRes.rows[0].count, 10);
    const specialtiesTagged   = parseInt(filtSpecTaggedRes.rows[0].count, 10);
    const specialtiesTaggedPct = filteredTotal
      ? Math.round((specialtiesTagged / filteredTotal) * 100)
      : 0;

    const aggregations = {
      total:        filteredTotal,
      byStage:      toObj(filtStageRes.rows),
      byEhr:        toObj(filtEhrRes.rows),
      topSpecialties: filtSpecialtyRes.rows.map(r => ({ name: r.val, count: parseInt(r.count, 10) })),
      bySource:     toObj(filtSourceRes.rows),
      notRcmCount:  0,
      roeCount:     0,
      specialtiesTaggedPct,
    };

    // ── 4. Paginated records ───────────────────────────────────────────────
    const offset = (page - 1) * pageSize;
    // Append LIMIT and OFFSET as additional params
    const recordsParams = [...params, pageSize, offset];
    const limitPH  = `$${params.length + 1}`;
    const offsetPH = `$${params.length + 2}`;

    const recordsRes = await query(
      `SELECT * FROM accounts ${FILTER_WHERE} ORDER BY name ASC LIMIT ${limitPH} OFFSET ${offsetPH}`,
      recordsParams,
    );

    const records = recordsRes.rows.map(rowToRecord);

    const now       = new Date();
    const monthName = now.toLocaleString('en-US', { month: 'long', year: 'numeric' });

    return res.status(200).json({
      meta: {
        total:        filteredTotal,
        page,
        pageSize,
        totalPages:   Math.ceil(filteredTotal / pageSize),
        cachedAt:     now.toISOString(),
        cacheAge:     0,
        currentMonth: monthName,
        source:       'postgres',
      },
      globals: {
        goals,
        stats: globalStats,
      },
      aggregations,
      records,
    });
  } catch (err) {
    console.error('[pipeline GET]', err.message, err.stack);
    return res.status(500).json({ error: err.message });
  }
}
