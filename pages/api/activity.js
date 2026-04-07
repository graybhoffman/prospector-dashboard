/**
 * /api/activity — GET
 *
 * Returns pipeline stage transition data based on Date → {Stage} fields.
 * Uses the shared pipeline cache.
 *
 * Response:
 *   {
 *     activity: [{ account_name, to_stage, transition_date, ehr }],
 *     weekly: { this_week: [...], prev_week: [...] },
 *     monthly: { this_month: { [stage]: count }, last_month: { [stage]: count } }
 *   }
 */

import { ensurePipelineCache, pipelineCache, startPipelineRefresh, CACHE_TTL } from '../../lib/pipelineCache';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

const STAGE_DATE_FIELDS = [
  { stage: 'Prospect',          field: 'Date → Prospect' },
  { stage: 'Outreach',          field: 'Date → Outreach' },
  { stage: 'Discovery',         field: 'Date → Discovery' },
  { stage: 'SQL',               field: 'Date → SQL' },
  { stage: 'Negotiations',      field: 'Date → Negotiations' },
  { stage: 'Closed-Won',        field: 'Date → Closed-Won' },
  { stage: 'Pilot Deployment',  field: 'Date → Pilot Deployment' },
  { stage: 'Full Deployment',   field: 'Date → Full Deployment' },
];

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const allRecords = await ensurePipelineCache();
  if (!allRecords) {
    return res.status(503).json({ error: 'Pipeline data still loading.', retryAfterMs: 5000 });
  }

  const age = Date.now() - pipelineCache.fetchedAt;
  if (age > CACHE_TTL) startPipelineRefresh();

  const now = new Date();
  const nowMs = now.getTime();

  // Day boundaries
  const d7  = new Date(now); d7.setDate(d7.getDate() - 7);   d7.setHours(0,0,0,0);
  const d14 = new Date(now); d14.setDate(d14.getDate() - 14); d14.setHours(0,0,0,0);
  const d30 = new Date(now); d30.setDate(d30.getDate() - 30); d30.setHours(0,0,0,0);

  // Month boundaries
  const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastMonthEnd   = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);

  const activity     = [];
  const thisWeek     = [];
  const prevWeek     = [];
  const thisMonthCounts = {};
  const lastMonthCounts = {};

  for (const { fields } of allRecords) {
    const accountName = fields['Account Name'] || 'Unknown';
    const ehr         = fields['EHR'] || null;

    for (const { stage, field } of STAGE_DATE_FIELDS) {
      const dateStr = fields[field];
      if (!dateStr) continue;

      const d = new Date(dateStr);
      if (isNaN(d.getTime())) continue;
      const dMs = d.getTime();

      const entry = { account_name: accountName, to_stage: stage, transition_date: dateStr, ehr };

      // Last 30 days for main activity feed
      if (dMs >= d30.getTime()) activity.push(entry);

      // Weekly
      if (dMs >= d7.getTime()) thisWeek.push(entry);
      else if (dMs >= d14.getTime() && dMs < d7.getTime()) prevWeek.push(entry);

      // Monthly
      if (d >= thisMonthStart) {
        thisMonthCounts[stage] = (thisMonthCounts[stage] || 0) + 1;
      } else if (d >= lastMonthStart && d <= lastMonthEnd) {
        lastMonthCounts[stage] = (lastMonthCounts[stage] || 0) + 1;
      }
    }
  }

  // Sort activity by date desc
  activity.sort((a, b) => new Date(b.transition_date) - new Date(a.transition_date));
  thisWeek.sort((a, b) => new Date(b.transition_date) - new Date(a.transition_date));
  prevWeek.sort((a, b) => new Date(b.transition_date) - new Date(a.transition_date));

  return res.status(200).json({
    cachedAt: new Date(pipelineCache.fetchedAt).toISOString(),
    activity: activity.slice(0, 200), // cap for response size
    weekly: {
      this_week: thisWeek.slice(0, 100),
      prev_week: prevWeek.slice(0, 100),
    },
    monthly: {
      this_month: thisMonthCounts,
      last_month: lastMonthCounts,
    },
  });
}
