/**
 * /api/pipeline — GET
 *
 * Returns paginated pipeline records + pre-computed aggregations.
 * Always includes `globals` (goals + full-dataset stats) regardless of filters.
 *
 * Query params:
 *   page, pageSize
 *   ehr        comma-separated EHR values
 *   stage      comma-separated Stage values
 *   specialty  comma-separated Specialty values
 *   source     Source Category
 *   nonRcm     "true"
 *   roe        "true"
 *   search     text search on Account Name
 *
 * Response:
 *   { meta, globals: { goals, stats }, aggregations, records }
 */

import { pipelineCache, startPipelineRefresh, ensurePipelineCache, CACHE_TTL } from '../../lib/pipelineCache';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// ─── Goal computation (always from full dataset) ──────────────────────────────
function computeGoals(allRecords) {
  const now = new Date();
  const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  let discoveryPlusThisMonth = 0;
  let closedWonThisMonth = 0;

  for (const { fields } of allRecords) {
    const discDate = fields['Date → Discovery'];
    if (discDate && String(discDate).startsWith(yearMonth)) discoveryPlusThisMonth++;

    const cwDate = fields['Date → Closed-Won'];
    if (cwDate && String(cwDate).startsWith(yearMonth)) closedWonThisMonth++;
  }

  return {
    discoveryPlusThisMonth,
    closedWonThisMonth,
    goal1Target: 35,
    goal2Target: 7,
  };
}

// ─── Global stats (full dataset) ─────────────────────────────────────────────
function computeGlobalStats(allRecords) {
  const byStage    = {};
  const byEhr      = {};
  const bySpecialty = {};
  const bySource   = {};
  const byEmployeeBucket = { '1-25': 0, '26-100': 0, '101-500': 0, '500+': 0, 'Unknown': 0 };
  let notRcmCount = 0, roeCount = 0, confirmedIcpCount = 0;

  for (const { fields } of allRecords) {
    const stage = fields['Stage'] || 'Unknown';
    byStage[stage] = (byStage[stage] || 0) + 1;

    const ehr = fields['EHR'] || 'Unknown';
    byEhr[ehr] = (byEhr[ehr] || 0) + 1;

    const spec = fields['Specialty'];
    if (spec) {
      const items = Array.isArray(spec) ? spec : [spec];
      for (const s of items) {
        if (s) bySpecialty[s] = (bySpecialty[s] || 0) + 1;
      }
    }

    const src = fields['Source Category'] || 'Unknown';
    bySource[src] = (bySource[src] || 0) + 1;

    const emp = fields['Employees #'];
    if (!emp || emp === 0) byEmployeeBucket['Unknown']++;
    else if (emp <= 25) byEmployeeBucket['1-25']++;
    else if (emp <= 100) byEmployeeBucket['26-100']++;
    else if (emp <= 500) byEmployeeBucket['101-500']++;
    else byEmployeeBucket['500+']++;

    if (fields['Not in RCM ICP']) notRcmCount++;

    const roe = fields['Potential ROE Issue'];
    if (roe === true || (typeof roe === 'string' && roe.trim() && roe.toLowerCase() !== 'none')) roeCount++;

    const rev = fields['Annual Revenue ($)'];
    const providers = fields['Providers #'];
    const employees = fields['Employees #'];
    const locations = fields['# of locations'];
    if (
      (rev && rev >= 10_000_000) ||
      (providers && providers >= 50) ||
      (employees && employees >= 100) ||
      (locations && locations >= 10)
    ) confirmedIcpCount++;
  }

  return {
    total: allRecords.length,
    byStage,
    byEhr,
    bySpecialty,
    bySource,
    byEmployeeBucket,
    notRcmCount,
    roeCount,
    confirmedIcpCount,
  };
}

// ─── Filtered aggregations ────────────────────────────────────────────────────
function aggregate(records) {
  const byStage     = {};
  const byEhr       = {};
  const bySpecialty = {};
  const bySource    = {};
  let notRcmCount = 0, roeCount = 0, specialtiesTagged = 0;

  for (const { fields } of records) {
    const stage = fields['Stage'] || 'Unknown';
    byStage[stage] = (byStage[stage] || 0) + 1;

    const ehr = fields['EHR'] || 'Unknown';
    byEhr[ehr] = (byEhr[ehr] || 0) + 1;

    const spec = fields['Specialty'];
    if (spec) {
      specialtiesTagged++;
      const items = Array.isArray(spec) ? spec : [spec];
      for (const s of items) {
        if (s) bySpecialty[s] = (bySpecialty[s] || 0) + 1;
      }
    }

    const src = fields['Source Category'] || 'Unknown';
    bySource[src] = (bySource[src] || 0) + 1;

    if (fields['Not in RCM ICP']) notRcmCount++;

    const roe = fields['Potential ROE Issue'];
    if (roe === true || (typeof roe === 'string' && roe.trim() && roe.toLowerCase() !== 'none')) roeCount++;
  }

  const topSpecialties = Object.entries(bySpecialty)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([name, count]) => ({ name, count }));

  return {
    total: records.length,
    byStage,
    byEhr,
    topSpecialties,
    bySource,
    notRcmCount,
    roeCount,
    specialtiesTaggedPct: records.length
      ? Math.round((specialtiesTagged / records.length) * 100)
      : 0,
  };
}

// ─── Handler ─────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const allRecords = await ensurePipelineCache();
  if (!allRecords) {
    return res.status(503).json({ error: 'Pipeline data still loading — retry in a moment.', retryAfterMs: 5000 });
  }

  // Trigger refresh if stale
  const age = Date.now() - pipelineCache.fetchedAt;
  if (age > CACHE_TTL) startPipelineRefresh();

  // ─── Globals (always from full dataset) ────────────────────────────────────
  const goals       = computeGoals(allRecords);
  const globalStats = computeGlobalStats(allRecords);

  // ─── Filtering ─────────────────────────────────────────────────────────────
  let records = allRecords;
  const { ehr, stage, specialty, source, nonRcm, roe, search } = req.query;

  if (ehr) {
    const vals = ehr.split(',');
    records = records.filter((r) => vals.includes(r.fields['EHR']));
  }
  if (stage) {
    const vals = stage.split(',');
    records = records.filter((r) => vals.includes(r.fields['Stage']));
  }
  if (specialty) {
    const vals = specialty.split(',');
    records = records.filter((r) => {
      const s = r.fields['Specialty'];
      return Array.isArray(s) ? s.some((sv) => vals.includes(sv)) : vals.includes(s);
    });
  }
  if (source) {
    const vals = source.split(',');
    records = records.filter((r) => vals.includes(r.fields['Source Category']));
  }
  if (nonRcm === 'true') records = records.filter((r) => r.fields['Not in RCM ICP']);
  if (roe === 'true') {
    records = records.filter((r) => {
      const v = r.fields['Potential ROE Issue'];
      return v === true || (typeof v === 'string' && v.trim() && v.toLowerCase() !== 'none');
    });
  }
  if (search) {
    const q = search.toLowerCase();
    records = records.filter((r) => (r.fields['Account Name'] || '').toLowerCase().includes(q));
  }

  // ─── Filtered aggregations ─────────────────────────────────────────────────
  const agg = aggregate(records);

  // ─── Pagination ────────────────────────────────────────────────────────────
  const page     = Math.max(1, parseInt(req.query.page     || '1',  10));
  const pageSize = Math.min(500, parseInt(req.query.pageSize || '50', 10));
  const start    = (page - 1) * pageSize;
  const paginated = records.slice(start, start + pageSize);

  const now = new Date();
  const monthName = now.toLocaleString('en-US', { month: 'long', year: 'numeric' });

  return res.status(200).json({
    meta: {
      total:        records.length,
      page,
      pageSize,
      totalPages:   Math.ceil(records.length / pageSize),
      cachedAt:     new Date(pipelineCache.fetchedAt).toISOString(),
      cacheAge:     Math.round(age / 1000),
      currentMonth: monthName,
    },
    globals: {
      goals,
      stats: globalStats,
    },
    aggregations: agg,
    records: paginated,
  });
}
