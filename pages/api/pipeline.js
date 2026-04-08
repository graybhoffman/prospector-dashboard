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
  let discoveryPlus = 0;
  let closedWon = 0;
  let deployedRevenue = 0;

  const discoveryDateFields = [
    'Date → Discovery','Date → SQL','Date → Negotiations',
    'Date → Closed-Won','Date → Pilot Deployment','Date → Full Deployment',
  ];

  for (const { fields } of allRecords) {
    // Discovery+: any stage date field is filled = ever reached Discovery or beyond
    const hasReachedDiscovery = discoveryDateFields.some((f) => {
      const v = fields[f];
      return v && String(v).trim();
    });
    if (hasReachedDiscovery) discoveryPlus++;

    // Closed-Won: Stage is Closed-Won, Pilot Deployment, or Full Deployment
    const stage = fields['Stage'];
    if (stage === 'Closed-Won' || stage === 'Pilot Deployment' || stage === 'Full Deployment') {
      closedWon++;
    }

    // Deployed Revenue: sum ACV for Pilot/Full Deployment; default $150K if blank
    if (stage === 'Pilot Deployment' || stage === 'Full Deployment') {
      const acv = fields['ACV ($)'] || fields['ACV'] || 0;
      deployedRevenue += (acv && acv > 0) ? acv : 150_000;
    }
  }

  // Floor at known confirmed minimum ($575K Nathan Littauer + $75K Medvanta)
  // deployedRevenue starts at 0 — no floor (Gray: Apr 8)

  return {
    discoveryPlus,
    closedWon,
    deployedRevenue,
    goal1Target: 50,
    goal2Target: 7,
    goal3Target: 300_000,
  };
}

// ─── Global stats (full dataset) ─────────────────────────────────────────────
function computeGlobalStats(allRecords) {
  const byStage    = {};
  const byEhr      = {};
  const bySpecialty = {};
  const bySource   = {};
  const byEmployeeBucket = { '1-25': 0, '26-100': 0, '101-500': 0, '500+': 0, 'Unknown': 0 };
  const byRevenueBucket  = { '<$1M': 0, '$1M-$5M': 0, '$5M-$10M': 0, '$10M-$25M': 0, '$25M+': 0, 'Unknown': 0 };
  const byProviderBucket = { '1-5': 0, '6-15': 0, '16-30': 0, '31-50': 0, '50+': 0, 'Unknown': 0 };
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

    // Revenue bucket
    const rev = fields['Annual Revenue ($)'];
    if (!rev || rev === 0) byRevenueBucket['Unknown']++;
    else if (rev < 1_000_000) byRevenueBucket['<$1M']++;
    else if (rev < 5_000_000) byRevenueBucket['$1M-$5M']++;
    else if (rev < 10_000_000) byRevenueBucket['$5M-$10M']++;
    else if (rev < 25_000_000) byRevenueBucket['$10M-$25M']++;
    else byRevenueBucket['$25M+']++;

    // Provider bucket
    const providers = fields['Providers #'];
    if (!providers || providers === 0) byProviderBucket['Unknown']++;
    else if (providers <= 5) byProviderBucket['1-5']++;
    else if (providers <= 15) byProviderBucket['6-15']++;
    else if (providers <= 30) byProviderBucket['16-30']++;
    else if (providers <= 50) byProviderBucket['31-50']++;
    else byProviderBucket['50+']++;

    if (fields['Not in RCM ICP']) notRcmCount++;

    const roe = fields['Potential ROE Issue'];
    if (roe === true || (typeof roe === 'string' && roe.trim() && roe.toLowerCase() !== 'none')) roeCount++;

    const employees = fields['Employees #'];
    const locations = fields['# of locations'];
    if (
      (rev && rev >= 10_000_000) ||
      (providers && providers >= 25) ||
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
    byRevenueBucket,
    byProviderBucket,
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

  // ─── Filter excluded accounts from all reporting ────────────────────────────
  const activeRecords = allRecords.filter(r => !r.fields['Exclude from Reporting']);

  // ─── Globals (always from full active dataset) ──────────────────────────────
  const goals       = computeGoals(activeRecords);
  const globalStats = computeGlobalStats(activeRecords);

  // ─── Filtering ─────────────────────────────────────────────────────────────
  let records = activeRecords;
  const { ehr, stage, specialty, source, nonRcm, roe, search, revenueBucket, providerBucket, employeeBucket } = req.query;

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
  if (revenueBucket) {
    const buckets = revenueBucket.split(',');
    records = records.filter((r) => {
      const rev = r.fields['Annual Revenue ($)'];
      return buckets.some((b) => {
        if (b === 'Unknown') return !rev || rev === 0;
        if (b === '<$1M') return rev > 0 && rev < 1_000_000;
        if (b === '$1M-$5M') return rev >= 1_000_000 && rev < 5_000_000;
        if (b === '$5M-$10M') return rev >= 5_000_000 && rev < 10_000_000;
        if (b === '$10M-$25M') return rev >= 10_000_000 && rev < 25_000_000;
        if (b === '$25M+') return rev >= 25_000_000;
        return false;
      });
    });
  }
  if (providerBucket) {
    const buckets = providerBucket.split(',');
    records = records.filter((r) => {
      const providers = r.fields['Providers #'];
      return buckets.some((b) => {
        if (b === 'Unknown') return !providers || providers === 0;
        if (b === '1-5') return providers >= 1 && providers <= 5;
        if (b === '6-15') return providers >= 6 && providers <= 15;
        if (b === '16-30') return providers >= 16 && providers <= 30;
        if (b === '31-50') return providers >= 31 && providers <= 50;
        if (b === '50+') return providers > 50;
        return false;
      });
    });
  }
  if (employeeBucket) {
    const buckets = employeeBucket.split(',');
    records = records.filter((r) => {
      const emp = r.fields['Employees #'];
      return buckets.some((b) => {
        if (b === 'Unknown') return !emp || emp === 0;
        if (b === '1-25') return emp >= 1 && emp <= 25;
        if (b === '26-100') return emp >= 26 && emp <= 100;
        if (b === '101-500') return emp >= 101 && emp <= 500;
        if (b === '500+') return emp > 500;
        return false;
      });
    });
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
