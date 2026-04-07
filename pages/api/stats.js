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
  const now = new Date();
  const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  let discoveryPlusThisMonth = 0;
  let closedWonThisMonth = 0;
  for (const { fields } of allRecords) {
    const stages = ['Discovery','SQL','Negotiations','Closed-Won','Pilot Deployment','Full Deployment'];
    for (const stage of stages) {
      const d = fields[`Date → ${stage}`];
      if (d && String(d).startsWith(yearMonth)) { discoveryPlusThisMonth++; break; }
    }
    const cwDate = fields['Date → Closed-Won'];
    if (cwDate && String(cwDate).startsWith(yearMonth)) closedWonThisMonth++;
  }
  return { discoveryPlusThisMonth, closedWonThisMonth, goal1Target: 35, goal2Target: 7 };
}

function computeStats(allRecords) {
  const total = allRecords.length;
  let notRcmCount = 0, confirmedIcpCount = 0, roeCount = 0;
  const byStage = {}, byEhr = {}, bySpecialty = {}, bySource = {};
  const employeeBuckets = { '1-25': 0, '26-100': 0, '101-500': 0, '500+': 0 };

  for (const { fields } of allRecords) {
    if (fields['Not in RCM ICP'] === true) notRcmCount++;
    const rev = fields['Annual Revenue ($)'] || 0;
    const prov = fields['Providers #'] || 0;
    const emp = fields['Employees #'] || 0;
    const locs = fields['# of locations'] || 0;
    if (rev >= 10_000_000 || prov >= 50 || emp >= 100 || locs >= 10) confirmedIcpCount++;
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
  }

  return { total, notRcmCount, confirmedIcpCount, roeCount, byStage, byEhr, bySpecialty, bySource, employeeBuckets };
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
    goals: { discoveryPlusThisMonth: null, closedWonThisMonth: null, goal1Target: 35, goal2Target: 7 },
    stats: { total: null, notRcmCount: null, confirmedIcpCount: null, roeCount: null },
  });
}
