/**
 * /api/pipeline — GET
 *
 * Returns ALL fields for every Notion pipeline record — fully dynamic.
 * New fields added to Notion appear automatically without code changes.
 *
 * EHR field: reads props["EHR"]["select"]["name"]
 *   (NOT Source Sub-category — that's for lead source tracking)
 *
 * In-memory cache: 5 minutes. Background refresh so requests stay fast.
 * On cold start, waits up to 5 minutes for initial load of large DBs.
 *
 * Query params:
 *   page       (default 1)
 *   pageSize   (default 50, max 500)
 *   ehr        filter exact match on EHR field
 *   stage      filter exact match on Stage field
 *   specialty  filter on Specialty field (select or multi_select)
 *   source     filter on Source Category field
 *   priority   filter on Priority field
 *   market     filter on MM / Ent field
 *   nonRcm     "true" = only Not in RCM ICP accounts
 *   roe        "true" = only ROE-flagged accounts (Potential ROE Issue truthy)
 *   search     text search on Account Name
 *
 * Response:
 *   { meta, aggregations, records: [{ id, fields }] }
 */

import { fetchAllPages } from '../../lib/notion';

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const PIPELINE_DB  = process.env.NOTION_PIPELINE_DB;
const CACHE_TTL    = 5 * 60 * 1000; // 5 minutes

let cache = {
  records:    null,
  fetchedAt:  0,
  isFetching: false,
};

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function startBackgroundRefresh() {
  if (cache.isFetching) return;
  cache.isFetching = true;
  console.log('[pipeline] Background refresh started…');

  fetchAllPages(PIPELINE_DB, NOTION_TOKEN, (page, total) => {
    console.log(`[pipeline] Page ${page} fetched (${total} records so far)`);
  })
    .then((records) => {
      cache.records   = records;
      cache.fetchedAt = Date.now();
      console.log(`[pipeline] Cache updated: ${records.length} records`);
    })
    .catch((err) => console.error('[pipeline] Refresh failed:', err.message))
    .finally(() => { cache.isFetching = false; });
}

// ─── Aggregations (computed over filtered record set) ─────────────────────────
function aggregate(records) {
  const byStage     = {};
  const byEhr       = {};
  const bySpecialty = {};
  const bySource    = {};
  let notRcmCount   = 0;
  let roeCount      = 0;
  let specialtiesTagged = 0;

  for (const { fields } of records) {
    // Stage
    const stage = fields['Stage'] || 'Unknown';
    byStage[stage] = (byStage[stage] || 0) + 1;

    // EHR — dedicated select field
    const ehr = fields['EHR'] || 'Unknown';
    byEhr[ehr] = (byEhr[ehr] || 0) + 1;

    // Specialty (select or multi_select)
    const spec = fields['Specialty'];
    if (spec) {
      specialtiesTagged++;
      const items = Array.isArray(spec) ? spec : [spec];
      for (const s of items) {
        if (s) bySpecialty[s] = (bySpecialty[s] || 0) + 1;
      }
    }

    // Source Category
    const src = fields['Source Category'] || 'Unknown';
    bySource[src] = (bySource[src] || 0) + 1;

    // Flags
    if (fields['Not in RCM ICP']) notRcmCount++;

    // ROE: handle both checkbox (legacy) and select
    const roe = fields['Potential ROE Issue'];
    if (
      roe === true ||
      (typeof roe === 'string' && roe.trim() && roe.toLowerCase() !== 'none')
    ) roeCount++;
  }

  const topSpecialties = Object.entries(bySpecialty)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([name, count]) => ({ name, count }));

  return {
    total:    records.length,
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
  if (req.method !== 'GET')     return res.status(405).json({ error: 'Method not allowed' });

  const now = Date.now();
  const age = now - cache.fetchedAt;

  // Trigger refresh if stale/empty
  if (!cache.records || age > CACHE_TTL) {
    startBackgroundRefresh();
  }

  // Cold start: wait for first load (up to 5 minutes for large DBs)
  if (!cache.records) {
    console.log('[pipeline] Cold start — waiting for initial fetch…');
    const deadline = Date.now() + 300_000;
    while (!cache.records && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!cache.records) {
      return res.status(503).json({
        error: 'Pipeline data is still loading — please retry in a moment.',
        retryAfterMs: 5000,
      });
    }
  }

  let records = cache.records; // Array<{ id, fields }>

  // ─── Filtering ─────────────────────────────────────────────────────────────
  const { ehr, stage, specialty, source, priority, market, nonRcm, roe, search } = req.query;

  if (ehr)      records = records.filter((r) => r.fields['EHR'] === ehr);
  if (stage)    records = records.filter((r) => r.fields['Stage'] === stage);
  if (specialty) records = records.filter((r) => {
    const s = r.fields['Specialty'];
    return Array.isArray(s) ? s.includes(specialty) : s === specialty;
  });
  if (source)   records = records.filter((r) => r.fields['Source Category'] === source);
  if (priority) records = records.filter((r) => r.fields['Priority'] === priority);
  if (market)   records = records.filter((r) => r.fields['MM / Ent'] === market);

  if (nonRcm === 'true') records = records.filter((r) => r.fields['Not in RCM ICP']);
  if (roe === 'true') records = records.filter((r) => {
    const v = r.fields['Potential ROE Issue'];
    return v === true || (typeof v === 'string' && v.trim() && v.toLowerCase() !== 'none');
  });

  if (search) {
    const q = search.toLowerCase();
    records = records.filter((r) =>
      (r.fields['Account Name'] || '').toLowerCase().includes(q)
    );
  }

  // ─── Aggregations ──────────────────────────────────────────────────────────
  const agg = aggregate(records);

  // ─── Pagination ────────────────────────────────────────────────────────────
  const page     = Math.max(1, parseInt(req.query.page     || '1',  10));
  const pageSize = Math.min(500, parseInt(req.query.pageSize || '50', 10));
  const start    = (page - 1) * pageSize;
  const paginated = records.slice(start, start + pageSize);

  return res.status(200).json({
    meta: {
      total:      records.length,
      page,
      pageSize,
      totalPages: Math.ceil(records.length / pageSize),
      cachedAt:   new Date(cache.fetchedAt).toISOString(),
      cacheAge:   Math.round(age / 1000),
    },
    aggregations: agg,
    records: paginated,
  });
}
