/**
 * /api/pipeline — GET (Postgres-backed, hybrid data source)
 *
 * Stage routing:
 *   Prospect / Outreach         → accounts table (agents_stage)
 *   Discovery+ (Discovery, SQL, Negotiations, Closed-Won,
 *               Pilot Deployment, Full Deployment)  → opportunities table (stage_normalized)
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
 */

import { query } from '../../lib/db';

const PROSPECT_OUTREACH_STAGES = ['Prospect', 'Outreach', 'Warm Intro'];
const DISCOVERY_PLUS_STAGES    = ['Discovery', 'SQL', 'Negotiations', 'Closed-Won', 'Pilot Deployment', 'Full Deployment'];

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// Map a Postgres account row → Notion-compatible record shape
function accountToRecord(row) {
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
      'Not in RCM ICP':       false,
      '_type':                'account',
    },
  };
}

const SFDC_USER_NAMES = {
  '005Vo000007stN7IAI': 'Gray Hoffman',
  '005Vo00000rj133IAA': 'Neha Bhongir',
  '005Vo000004CeUCIA0': 'Andrew Jin',
  '005Vo00000EsyK5IAJ': 'Adam Mohiuddin',
  '005Vo00000p5vwOIAQ': 'Andy Sapien',
  '005Vo00000URBUMIA5': 'Andy Sapien',
  '0057V00000AminrQAB': 'Deepika Bodapati',
  '005Vo0000073OzSIAU': 'Sean Edrington',
  '005Vo00000UQiKIIA1': 'Daniel Carter',
  '0055e000004xDZrAAM': 'Vishnu Gettu',
};
function resolveUserName(val) {
  if (!val) return null;
  return SFDC_USER_NAMES[val] || val;
}

// Map a Postgres opportunity row → Notion-compatible record shape
function oppToRecord(row) {
  return {
    id: 'opp_' + String(row.id),
    fields: {
      'Account Name': row.account_name,
      'Stage':        row.stage_normalized,
      'EHR':          row.ehr_system || row.acct_ehr_system || null,
      'ACV':          row.acv != null ? Number(row.acv) : 0,
      'Close Date':   row.close_date,
      'Owner':        row.owner || null,
      'Specialty':    row.acct_specialty || null,
      'Source Category': row.acct_source_category || row.source_category || null,
      'Source Sub-Category': row.source_sub_category || null,
      'Est. Calls/Month': row.est_monthly_call_volume != null ? Number(row.est_monthly_call_volume) : null,
      'Booked By':    resolveUserName(row.booked_by) || null,
      'Opp Name':      row.name || null,
      'Account SFDC ID': row.account_sfdc_id || null,
      'SFDC Link':    row.sfdc_id
        ? `https://athelas.lightning.force.com/lightning/r/Opportunity/${row.sfdc_id}/view`
        : (row.sfdc_link || null),
      'Next Step':    row.acct_next_step || row.next_step || null,
      'Next Step Date': row.next_step_date ? (row.next_step_date instanceof Date ? row.next_step_date.toISOString().slice(0, 10) : String(row.next_step_date).slice(0, 10)) : null,
      'Date Created': row.created_at || null,
      '_type':        'opportunity',
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
      hide_partners, close_date_days, next_step_days,
    } = req.query;

    const hidePartners   = hide_partners === 'true';
    const closeDateDays  = parseInt(close_date_days || '0', 10) || 0;
    const nextStepDays   = parseInt(next_step_days  || '0', 10) || 0;

    const page     = Math.max(1, parseInt(pageQ     || '1',  10));
    const pageSize = Math.min(500, parseInt(pageSizeQ || '50', 10));

    // ── Stage routing ──────────────────────────────────────────────────────
    const stageVals      = stage ? stage.split(',').map(v => v.trim()).filter(Boolean) : [];
    const onlyProspect   = stageVals.length > 0 && stageVals.every(s => PROSPECT_OUTREACH_STAGES.includes(s));
    const onlyDiscovery  = stageVals.length > 0 && stageVals.every(s => DISCOVERY_PLUS_STAGES.includes(s));
    // If stageVals is empty or mixed → query both
    const queryAccounts  = stageVals.length === 0 || stageVals.some(s => PROSPECT_OUTREACH_STAGES.includes(s));
    const queryOpps      = stageVals.length === 0 || stageVals.some(s => DISCOVERY_PLUS_STAGES.includes(s));

    // ── Param builder helpers ──────────────────────────────────────────────
    // Account-side filter conditions + params
    function buildAccountFilters() {
      const params = [];
      function p(val) { params.push(val); return `$${params.length}`; }
      const conds = [`db_status = 'main'`, `(exclude_from_reporting IS NOT TRUE)`];

      if (ehr) {
        const vals = ehr.split(',').map(v => v.trim()).filter(Boolean);
        if (vals.length === 1) conds.push(`ehr_system = ${p(vals[0])}`);
        else if (vals.length > 1) conds.push(`ehr_system IN (${vals.map(v => p(v)).join(',')})`);
      }
      if (stageVals.length > 0) {
        const accountStages = stageVals.filter(s => PROSPECT_OUTREACH_STAGES.includes(s));
        if (accountStages.length === 1) conds.push(`agents_stage = ${p(accountStages[0])}`);
        else if (accountStages.length > 1) conds.push(`agents_stage IN (${accountStages.map(v => p(v)).join(',')})`);
        else conds.push(`agents_stage IN ('Prospect','Outreach')`);
      } else {
        conds.push(`agents_stage IN ('Prospect','Outreach')`);
      }
      if (specialty) {
        const vals = specialty.split(',').map(v => v.trim()).filter(Boolean);
        if (vals.length === 1) conds.push(`specialty = ${p(vals[0])}`);
        else if (vals.length > 1) conds.push(`specialty IN (${vals.map(v => p(v)).join(',')})`);
      }
      if (source) {
        const vals = source.split(',').map(v => v.trim()).filter(Boolean);
        if (vals.length === 1) conds.push(`source_category = ${p(vals[0])}`);
        else if (vals.length > 1) conds.push(`source_category IN (${vals.map(v => p(v)).join(',')})`);
      }
      if (roe === 'true') {
        conds.push(`(potential_roe_issue IS NOT NULL AND potential_roe_issue::text NOT IN ('', 'null', '[]'))`);
      }
      if (search) {
        conds.push(`name ILIKE ${p('%' + search + '%')}`);
      }
      if (hidePartners) {
        conds.push(`(override_icp_reason IS NULL OR override_icp_reason != 'partner')`);
      }
      return { where: `WHERE ${conds.join(' AND ')}`, params };
    }

    // Opportunity-side filter conditions + params
    function buildOppFilters() {
      const params = [];
      function p(val) { params.push(val); return `$${params.length}`; }
      const conds = [`stage_normalized IS NOT NULL`, `stage_normalized NOT ILIKE '%lost%'`];

      if (stageVals.length > 0) {
        const oppStages = stageVals.filter(s => DISCOVERY_PLUS_STAGES.includes(s));
        if (oppStages.length === 1) conds.push(`stage_normalized = ${p(oppStages[0])}`);
        else if (oppStages.length > 1) conds.push(`stage_normalized IN (${oppStages.map(v => p(v)).join(',')})`);
      }
      if (search) {
        conds.push(`account_name ILIKE ${p('%' + search + '%')}`);
      }
      if (hidePartners) {
        conds.push(`(account_sfdc_id IS NULL OR account_sfdc_id NOT IN (SELECT sfdc_id FROM accounts WHERE override_icp_reason = 'partner' AND sfdc_id IS NOT NULL))`);
      }
      if (closeDateDays > 0) {
        conds.push(`close_date IS NOT NULL AND close_date <= (CURRENT_DATE + INTERVAL '${closeDateDays} days')`);
      }
      if (nextStepDays > 0) {
        conds.push(`next_step_date IS NOT NULL AND next_step_date <= (CURRENT_DATE + INTERVAL '${nextStepDays} days')`);
      }
      // EHR, specialty, source don't have matching fields in opportunities — skip
      return { where: `WHERE ${conds.join(' AND ')}`, params };
    }

    const accFilter = buildAccountFilters();
    const oppFilter = buildOppFilters();

    // ── 1. Goals ───────────────────────────────────────────────────────────
    const [discoveryPlusRes, closedWonRes, deployedArrRes] = await Promise.all([
      query(`SELECT COUNT(*) FROM opportunities
        WHERE stage_normalized IS NOT NULL
          AND stage_normalized NOT ILIKE '%lost%'
          AND (account_sfdc_id IS NULL OR account_sfdc_id NOT IN (SELECT sfdc_id FROM accounts WHERE override_icp_reason = 'partner' AND sfdc_id IS NOT NULL))`),
      query(`SELECT COUNT(*) FROM opportunities WHERE stage_normalized ILIKE '%won%'`).catch(() => ({ rows: [{ count: '0' }] })),
      query(`SELECT COALESCE(SUM(acv), 0) AS total FROM opportunities
        WHERE stage_normalized ILIKE '%won%' OR stage_normalized ILIKE '%deployment%'`).catch(() => ({ rows: [{ total: '0' }] })),
    ]);

    const goals = {
      discoveryPlus:   parseInt(discoveryPlusRes.rows[0].count, 10),
      closedWon:       parseInt(closedWonRes.rows[0].count, 10),
      deployedRevenue: parseFloat(deployedArrRes.rows[0].total) || 0,
      goal1Target:  50,
      goal2Target:  7,
      goal3Target:  300_000,
    };

    // ── 2. Global stats — byStage uses UNION hybrid ────────────────────────
    const GLOBAL_STAGE_SQL = `
      SELECT agents_stage AS stage, COUNT(*)::int AS cnt
      FROM accounts
      WHERE db_status = 'main' AND (exclude_from_reporting IS NOT TRUE)
        AND agents_stage IN ('Prospect', 'Outreach', 'Warm Intro')
      GROUP BY 1
      UNION ALL
      SELECT stage_normalized AS stage, COUNT(*)::int AS cnt
      FROM opportunities
      WHERE stage_normalized IS NOT NULL AND stage_normalized NOT ILIKE '%lost%'
      GROUP BY 1
    `;

    const BASE_WHERE_ACCOUNTS = `WHERE db_status = 'main' AND (exclude_from_reporting IS NOT TRUE)`;

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
      query(`SELECT COUNT(*) FROM accounts ${BASE_WHERE_ACCOUNTS}`),
      query(GLOBAL_STAGE_SQL),
      query(`SELECT ehr_system     AS val, COUNT(*) FROM accounts ${BASE_WHERE_ACCOUNTS} GROUP BY 1 ORDER BY COUNT(*) DESC`),
      query(`SELECT specialty      AS val, COUNT(*) FROM accounts ${BASE_WHERE_ACCOUNTS} AND specialty IS NOT NULL GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 20`),
      query(`SELECT source_category AS val, COUNT(*) FROM accounts ${BASE_WHERE_ACCOUNTS} GROUP BY 1 ORDER BY COUNT(*) DESC`),
      query(`SELECT
          CASE
            WHEN num_employees >= 500 THEN '500+'
            WHEN num_employees >= 101 THEN '101-500'
            WHEN num_employees >= 26  THEN '26-100'
            WHEN num_employees >  0   THEN '1-25'
            ELSE 'Unknown'
          END AS bucket, COUNT(*)
        FROM accounts ${BASE_WHERE_ACCOUNTS} GROUP BY 1`),
      query(`SELECT
          CASE
            WHEN annual_revenue >= 25000000 THEN '$25M+'
            WHEN annual_revenue >= 10000000 THEN '$10M-$25M'
            WHEN annual_revenue >=  5000000 THEN '$5M-$10M'
            WHEN annual_revenue >=  1000000 THEN '$1M-$5M'
            WHEN annual_revenue >         0 THEN '<$1M'
            ELSE 'Unknown'
          END AS bucket, COUNT(*)
        FROM accounts ${BASE_WHERE_ACCOUNTS} GROUP BY 1`),
      query(`SELECT
          CASE
            WHEN COALESCE(dhc_num_physicians, num_providers, 0) > 50  THEN '50+'
            WHEN COALESCE(dhc_num_physicians, num_providers, 0) >= 31 THEN '31-50'
            WHEN COALESCE(dhc_num_physicians, num_providers, 0) >= 16 THEN '16-30'
            WHEN COALESCE(dhc_num_physicians, num_providers, 0) >= 6  THEN '6-15'
            WHEN COALESCE(dhc_num_physicians, num_providers, 0) >= 1  THEN '1-5'
            ELSE 'Unknown'
          END AS bucket, COUNT(*)
        FROM accounts ${BASE_WHERE_ACCOUNTS} GROUP BY 1`),
    ]);

    const globalTotal = parseInt(globalTotalRes.rows[0].count, 10);

    const toObj  = (rows) => Object.fromEntries(rows.map(r => [r.val   || 'Unknown', parseInt(r.count, 10)]));
    const toBObj = (rows) => Object.fromEntries(rows.map(r => [r.bucket,             parseInt(r.count, 10)]));

    // globalStageRes rows have {stage, cnt}
    const globalByStage = Object.fromEntries(
      globalStageRes.rows.map(r => [r.stage || 'Unknown', parseInt(r.cnt, 10)])
    );

    const globalStats = {
      total:             globalTotal,
      byStage:           globalByStage,
      byEhr:             toObj(globalEhrRes.rows),
      bySpecialty:       toObj(globalSpecialtyRes.rows),
      bySource:          toObj(globalSourceRes.rows),
      byEmployeeBucket:  toBObj(globalEmpBucketRes.rows),
      byRevenueBucket:   toBObj(globalRevBucketRes.rows),
      byProviderBucket:  toBObj(globalProvBucketRes.rows),
      notRcmCount:       0,
      roeCount:          0,
      confirmedIcpCount: parseInt(
        (await query(`SELECT COUNT(*) FROM accounts ${BASE_WHERE_ACCOUNTS} AND agents_icp = TRUE`)).rows[0].count,
        10
      ),
    };

    // ── 3. Filtered aggregations ───────────────────────────────────────────
    // byStage: hybrid UNION with filters applied to each side
    // For the stage funnel in aggregations we always want the hybrid count
    // (filter by ehr/search/specialty/source, but always show all stage buckets)
    const FILT_STAGE_SQL = `
      SELECT agents_stage AS stage, COUNT(*)::int AS cnt
      FROM accounts
      ${accFilter.where}
      GROUP BY 1
      UNION ALL
      SELECT stage_normalized AS stage, COUNT(*)::int AS cnt
      FROM opportunities
      ${oppFilter.where}
      GROUP BY 1
    `;

    // For accounts-only aggregations (total, ehr, specialty, source)
    // we use the account filter params but without the stage restriction forced to Prospect/Outreach
    // Build a general account filter (with all non-stage filters)
    function buildAccountFiltersNoStage() {
      const params = [];
      function p(val) { params.push(val); return `$${params.length}`; }
      const conds = [`db_status = 'main'`, `(exclude_from_reporting IS NOT TRUE)`];
      if (ehr) {
        const vals = ehr.split(',').map(v => v.trim()).filter(Boolean);
        if (vals.length === 1) conds.push(`ehr_system = ${p(vals[0])}`);
        else if (vals.length > 1) conds.push(`ehr_system IN (${vals.map(v => p(v)).join(',')})`);
      }
      if (specialty) {
        const vals = specialty.split(',').map(v => v.trim()).filter(Boolean);
        if (vals.length === 1) conds.push(`specialty = ${p(vals[0])}`);
        else if (vals.length > 1) conds.push(`specialty IN (${vals.map(v => p(v)).join(',')})`);
      }
      if (source) {
        const vals = source.split(',').map(v => v.trim()).filter(Boolean);
        if (vals.length === 1) conds.push(`source_category = ${p(vals[0])}`);
        else if (vals.length > 1) conds.push(`source_category IN (${vals.map(v => p(v)).join(',')})`);
      }
      if (roe === 'true') {
        conds.push(`(potential_roe_issue IS NOT NULL AND potential_roe_issue::text NOT IN ('', 'null', '[]'))`);
      }
      if (search) {
        conds.push(`name ILIKE ${p('%' + search + '%')}`);
      }
      return { where: `WHERE ${conds.join(' AND ')}`, params };
    }
    const accFilterNoStage = buildAccountFiltersNoStage();

    // For bar charts: reflect active stage filter properly
    // onlyDiscovery → JOIN opps→accounts; onlyProspect → accFilter (stage applied); else → accFilterNoStage
    const filtEhrPromise = onlyDiscovery
      ? query(`SELECT a.ehr_system AS val, COUNT(*) FROM opportunities o LEFT JOIN accounts a ON a.sfdc_id = o.account_sfdc_id ${oppFilter.where} GROUP BY 1 ORDER BY COUNT(*) DESC`, oppFilter.params)
      : onlyProspect
        ? query(`SELECT ehr_system AS val, COUNT(*) FROM accounts ${accFilter.where} GROUP BY 1 ORDER BY COUNT(*) DESC`, accFilter.params)
        : query(`SELECT ehr_system    AS val, COUNT(*) FROM accounts ${accFilterNoStage.where} GROUP BY 1 ORDER BY COUNT(*) DESC`, accFilterNoStage.params);
    const filtSpecialtyPromise = onlyDiscovery
      ? query(`SELECT a.specialty AS val, COUNT(*) FROM opportunities o LEFT JOIN accounts a ON a.sfdc_id = o.account_sfdc_id ${oppFilter.where} AND a.specialty IS NOT NULL GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 20`, oppFilter.params)
      : onlyProspect
        ? query(`SELECT specialty AS val, COUNT(*) FROM accounts ${accFilter.where} AND specialty IS NOT NULL GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 20`, accFilter.params)
        : query(`SELECT specialty     AS val, COUNT(*) FROM accounts ${accFilterNoStage.where} AND specialty IS NOT NULL GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 20`, accFilterNoStage.params);
    const filtSourcePromise = onlyDiscovery
      ? query(`SELECT a.source_category AS val, COUNT(*) FROM opportunities o LEFT JOIN accounts a ON a.sfdc_id = o.account_sfdc_id ${oppFilter.where} GROUP BY 1 ORDER BY COUNT(*) DESC`, oppFilter.params)
      : onlyProspect
        ? query(`SELECT source_category AS val, COUNT(*) FROM accounts ${accFilter.where} GROUP BY 1 ORDER BY COUNT(*) DESC`, accFilter.params)
        : query(`SELECT source_category AS val, COUNT(*) FROM accounts ${accFilterNoStage.where} GROUP BY 1 ORDER BY COUNT(*) DESC`, accFilterNoStage.params);

    // Run all filtered aggregation queries in parallel
    // Note: FILT_STAGE_SQL uses accFilter.params for accounts side and oppFilter.params for opps side
    // We run them as two separate queries and merge
    const [
      filtAccStageRes,
      filtOppStageRes,
      filtTotalRes,
      filtEhrRes,
      filtSpecialtyRes,
      filtSourceRes,
      filtSpecTaggedRes,
    ] = await Promise.all([
      query(
        `SELECT agents_stage AS stage, COUNT(*)::int AS cnt FROM accounts ${accFilter.where} GROUP BY 1`,
        accFilter.params
      ),
      query(
        `SELECT stage_normalized AS stage, COUNT(*)::int AS cnt FROM opportunities ${oppFilter.where} GROUP BY 1`,
        oppFilter.params
      ),
      onlyDiscovery
        ? query(`SELECT COUNT(*) FROM opportunities ${oppFilter.where}`, oppFilter.params)
        : query(`SELECT COUNT(*) FROM accounts ${accFilterNoStage.where}`, accFilterNoStage.params),
      filtEhrPromise,
      filtSpecialtyPromise,
      filtSourcePromise,
      onlyDiscovery
        ? query(`SELECT COUNT(*) FROM opportunities o LEFT JOIN accounts a ON a.sfdc_id = o.account_sfdc_id ${oppFilter.where} AND a.specialty IS NOT NULL AND a.specialty != ''`, oppFilter.params)
        : query(`SELECT COUNT(*) FROM accounts ${accFilterNoStage.where} AND specialty IS NOT NULL AND specialty != ''`, accFilterNoStage.params),
    ]);

    // Merge stage counts from both sides
    const filtByStage = {};
    for (const r of filtAccStageRes.rows)  filtByStage[r.stage || 'Unknown'] = parseInt(r.cnt, 10);
    for (const r of filtOppStageRes.rows)  filtByStage[r.stage || 'Unknown'] = (filtByStage[r.stage || 'Unknown'] || 0) + parseInt(r.cnt, 10);

    const filteredTotal     = parseInt(filtTotalRes.rows[0].count, 10);
    const specialtiesTagged = parseInt(filtSpecTaggedRes.rows[0].count, 10);
    const specialtiesTaggedPct = filteredTotal
      ? Math.round((specialtiesTagged / filteredTotal) * 100)
      : 0;

    const aggregations = {
      total:          filteredTotal,
      byStage:        filtByStage,
      byEhr:          toObj(filtEhrRes.rows),
      topSpecialties: filtSpecialtyRes.rows.map(r => ({ name: r.val, count: parseInt(r.count, 10) })),
      bySource:       toObj(filtSourceRes.rows),
      notRcmCount:    0,
      roeCount:       0,
      specialtiesTaggedPct,
    };

    // ── 4. Paginated records (hybrid) ──────────────────────────────────────
    const offset = (page - 1) * pageSize;
    let records = [];
    let paginationTotal = 0;

    if (onlyProspect) {
      // Accounts only
      const rParams = [...accFilter.params, pageSize, offset];
      const lPH = `$${accFilter.params.length + 1}`;
      const oPH = `$${accFilter.params.length + 2}`;
      const [cntRes, rowsRes] = await Promise.all([
        query(`SELECT COUNT(*) FROM accounts ${accFilter.where}`, accFilter.params),
        query(
          `SELECT DISTINCT ON (COALESCE(sfdc_id, id::text)) * FROM accounts ${accFilter.where}
           ORDER BY COALESCE(sfdc_id, id::text), name ASC LIMIT ${lPH} OFFSET ${oPH}`,
          rParams
        ),
      ]);
      paginationTotal = parseInt(cntRes.rows[0].count, 10);
      records = rowsRes.rows.map(accountToRecord);

    } else if (onlyDiscovery) {
      // Opportunities only
      const rParams = [...oppFilter.params, pageSize, offset];
      const lPH = `$${oppFilter.params.length + 1}`;
      const oPH = `$${oppFilter.params.length + 2}`;
      const [cntRes, rowsRes] = await Promise.all([
        query(`SELECT COUNT(*) FROM opportunities ${oppFilter.where}`, oppFilter.params),
        query(
          `SELECT o.*, a.ehr_system AS acct_ehr_system, a.specialty AS acct_specialty, a.source_category AS acct_source_category, a.est_monthly_call_volume, a.sfdc_owner_name AS acct_owner_name, a.next_step AS acct_next_step FROM opportunities o LEFT JOIN accounts a ON a.sfdc_id = o.account_sfdc_id ${oppFilter.where}
           ORDER BY account_name ASC LIMIT ${lPH} OFFSET ${oPH}`,
          rParams
        ),
      ]);
      paginationTotal = parseInt(cntRes.rows[0].count, 10);
      records = rowsRes.rows.map(oppToRecord);

    } else {
      // Mixed / all stages — combine both
      // Get counts
      const [accCntRes, oppCntRes] = await Promise.all([
        query(`SELECT COUNT(*) FROM accounts ${accFilter.where}`, accFilter.params),
        query(`SELECT COUNT(*) FROM opportunities ${oppFilter.where}`, oppFilter.params),
      ]);
      const accTotal = parseInt(accCntRes.rows[0].count, 10);
      const oppTotal = parseInt(oppCntRes.rows[0].count, 10);
      paginationTotal = accTotal + oppTotal;

      // Paginate: opportunities first (smaller set), then accounts
      let oppOffset  = Math.min(offset, oppTotal);
      let accOffset  = Math.max(0, offset - oppTotal);
      let remaining  = pageSize;

      if (oppOffset < oppTotal) {
        const oppLimit = Math.min(remaining, oppTotal - oppOffset);
        const rParams = [...oppFilter.params, oppLimit, oppOffset];
        const lPH = `$${oppFilter.params.length + 1}`;
        const oPH = `$${oppFilter.params.length + 2}`;
        const rowsRes = await query(
          `SELECT o.*, a.ehr_system AS acct_ehr_system, a.specialty AS acct_specialty, a.source_category AS acct_source_category, a.est_monthly_call_volume, a.sfdc_owner_name AS acct_owner_name, a.next_step AS acct_next_step FROM opportunities o LEFT JOIN accounts a ON a.sfdc_id = o.account_sfdc_id ${oppFilter.where} ORDER BY account_name ASC LIMIT ${lPH} OFFSET ${oPH}`,
          rParams
        );
        records.push(...rowsRes.rows.map(oppToRecord));
        remaining -= rowsRes.rows.length;
      }

      if (remaining > 0) {
        const rParams = [...accFilter.params, remaining, accOffset];
        const lPH = `$${accFilter.params.length + 1}`;
        const oPH = `$${accFilter.params.length + 2}`;
        const rowsRes = await query(
          `SELECT DISTINCT ON (COALESCE(sfdc_id, id::text)) * FROM accounts ${accFilter.where}
           ORDER BY COALESCE(sfdc_id, id::text), name ASC LIMIT ${lPH} OFFSET ${oPH}`,
          rParams
        );
        records.push(...rowsRes.rows.map(accountToRecord));
      }
    }

    const now       = new Date();
    const monthName = now.toLocaleString('en-US', { month: 'long', year: 'numeric' });

    return res.status(200).json({
      meta: {
        total:        paginationTotal,
        page,
        pageSize,
        totalPages:   Math.ceil(paginationTotal / pageSize),
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
