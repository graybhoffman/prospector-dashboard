/**
 * /api/stats — GET
 * Returns globals (goals + stats) as fast as possible.
 * If cache is warm → returns real data immediately.
 * If cache is cold → starts background refresh, returns placeholder with loading:true
 * so the frontend can show skeletons and re-poll until data arrives.
 */

import { pipelineCache, startPipelineRefresh, CACHE_TTL } from '../../lib/pipelineCache';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

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

function computeStats(allRecords) {
  const total = allRecords.length;
  let notRcmCount = 0, confirmedIcpCount = 0, roeCount = 0;
  const byStage = {}, byEhr = {}, bySpecialty = {}, bySource = {};
  const employeeBuckets = { '1-25': 0, '26-100': 0, '101-500': 0, '500+': 0 };
  const byRevenueBucket  = { '<$1M': 0, '$1M-$5M': 0, '$5M-$10M': 0, '$10M-$25M': 0, '$25M+': 0, 'Unknown': 0 };
  const byProviderBucket = { '1-5': 0, '6-15': 0, '16-30': 0, '31-50': 0, '50+': 0, 'Unknown': 0 };

  for (const { fields } of allRecords) {
    if (fields['Not in RCM ICP'] === true) notRcmCount++;
    const rev = fields['Annual Revenue ($)'] || 0;
    const prov = fields['Providers #'] || 0;
    const emp = fields['Employees #'] || 0;
    const locs = fields['# of locations'] || 0;
    if (rev >= 10_000_000 || prov >= 25 || emp >= 100 || locs >= 10) confirmedIcpCount++;
    if (fields['Potential ROE Issue']) roeCount++;

    const stage = fields['Stage'] || 'Unknown';
    byStage[stage] = (byStage[stage] || 0) + 1;

    const ehr = fields['EHR'] || 'Unknown';
    byEhr[ehr] = (byEhr[ehr] || 0) + 1;

    const spec = fields['Specialty'] || 'Unknown';
    bySpecialty[spec] = (bySpecialty[spec] || 0) + 1;

    const src = fields['Source Category'] || 'Unknown';
    bySource[src] = (bySource[src] || 0) + 1;

    const e = emp || 0;
    if (e <= 25) employeeBuckets['1-25']++;
    else if (e <= 100) employeeBuckets['26-100']++;
    else if (e <= 500) employeeBuckets['101-500']++;
    else if (e > 500) employeeBuckets['500+']++;

    // Revenue bucket
    if (!rev || rev === 0) byRevenueBucket['Unknown']++;
    else if (rev < 1_000_000) byRevenueBucket['<$1M']++;
    else if (rev < 5_000_000) byRevenueBucket['$1M-$5M']++;
    else if (rev < 10_000_000) byRevenueBucket['$5M-$10M']++;
    else if (rev < 25_000_000) byRevenueBucket['$10M-$25M']++;
    else byRevenueBucket['$25M+']++;

    // Provider bucket
    if (!prov || prov === 0) byProviderBucket['Unknown']++;
    else if (prov <= 5) byProviderBucket['1-5']++;
    else if (prov <= 15) byProviderBucket['6-15']++;
    else if (prov <= 30) byProviderBucket['16-30']++;
    else if (prov <= 50) byProviderBucket['31-50']++;
    else byProviderBucket['50+']++;
  }

  return { total, notRcmCount, confirmedIcpCount, roeCount, byStage, byEhr, bySpecialty, bySource, employeeBuckets, byRevenueBucket, byProviderBucket };
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const age = Date.now() - pipelineCache.fetchedAt;
  const isStale = !pipelineCache.records || age > CACHE_TTL;

  if (isStale && !pipelineCache.isFetching) {
    startPipelineRefresh();
  }

  // If cache is warm (even if slightly stale), return real data immediately
  if (pipelineCache.records) {
    const goals = computeGoals(pipelineCache.records);
    const stats = computeStats(pipelineCache.records);
    return res.status(200).json({
      loading: false,
      stale: isStale,
      recordCount: pipelineCache.records.length,
      fetchedAt: new Date(pipelineCache.fetchedAt).toISOString(),
      goals,
      stats,
    });
  }

  // Cache is cold — return placeholder so frontend can show skeleton
  return res.status(200).json({
    loading: true,
    stale: true,
    recordCount: 0,
    fetchedAt: null,
    goals: { discoveryPlus: null, closedWon: null, deployedRevenue: null, goal1Target: 50, goal2Target: 7, goal3Target: 300_000 },
    stats: { total: null, notRcmCount: null, confirmedIcpCount: null, roeCount: null },
  });
}
