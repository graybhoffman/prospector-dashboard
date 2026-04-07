/**
 * /api/pipeline — GET
 * Fetches all pages from the Notion pipeline DB, caches them in memory
 * for 5 minutes, and returns aggregated stats + paginated records.
 *
 * EHR field: Notion property named "EHR" (type: select)
 *   → props["EHR"]["select"]["name"]
 *   (NOT Source Sub-category — that's for lead source tracking)
 *
 * Query params:
 *   page       (default 1)
 *   pageSize   (default 50)
 *   ehr        filter by EHR name
 *   stage      filter by Stage
 *   specialty  filter by Specialty
 *   source     filter by Source Category
 *   nonRcm     "true" = only Non-RCM ICP accounts
 *   roe        "true" = only ROE-flagged accounts
 *   search     text search on account name
 */

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const PIPELINE_DB  = process.env.NOTION_PIPELINE_DB;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// In-memory cache
let cache = {
  records:     null,
  fetchedAt:   0,
  isFetching:  false,
};

// ─── CORS helper ─────────────────────────────────────────────────────────────
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// ─── Notion helpers ───────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Pull a plain text or select value from a Notion property */
function getProp(props, name, type) {
  const p = props[name];
  if (!p) return null;
  switch (type) {
    case 'title':
      return p.title?.map((t) => t.plain_text).join('') || null;
    case 'rich_text':
      return p.rich_text?.map((t) => t.plain_text).join('') || null;
    case 'select':
      return p.select?.name || null;
    case 'multi_select':
      return p.multi_select?.map((s) => s.name).join(', ') || null;
    case 'number':
      return p.number ?? null;
    case 'checkbox':
      return p.checkbox ?? false;
    case 'date':
      return p.date?.start || null;
    case 'formula':
      return p.formula?.string || p.formula?.number || p.formula?.boolean || null;
    default:
      return null;
  }
}

/** Fetch all pages from Notion DB using cursor pagination */
async function fetchAllNotionPages() {
  if (!NOTION_TOKEN || !PIPELINE_DB) {
    throw new Error('Missing NOTION_TOKEN or NOTION_PIPELINE_DB env vars');
  }

  const records = [];
  let cursor    = undefined;
  let hasMore   = true;
  let page      = 0;

  while (hasMore) {
    page++;
    const body = {
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    };

    const resp = await fetch(
      `https://api.notion.com/v1/databases/${PIPELINE_DB}/query`,
      {
        method: 'POST',
        headers: {
          Authorization:    `Bearer ${NOTION_TOKEN}`,
          'Notion-Version': '2022-06-28',
          'Content-Type':   'application/json',
        },
        body: JSON.stringify(body),
      }
    );

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Notion API error ${resp.status}: ${err}`);
    }

    const data = await resp.json();

    for (const item of data.results) {
      const props = item.properties || {};
      records.push({
        id:            item.id,
        accountName:   getProp(props, 'Account Name',              'title')
                    || getProp(props, 'Name',                      'title')
                    || getProp(props, 'Company',                   'title')
                    || '(unnamed)',
        stage:         getProp(props, 'Stage',                     'select'),
        sourceCategory:getProp(props, 'Source Category',           'select'),
        // EHR is a dedicated select field — NOT Source Sub-category
        ehr:           getProp(props, 'EHR',                       'select'),
        specialty:     getProp(props, 'Specialty',                 'select')
                    || getProp(props, 'Specialties',               'multi_select'),
        notInRcmIcp:   getProp(props, 'Not in RCM ICP',           'checkbox'),
        potentialRoe:  getProp(props, 'Potential ROE Issue',       'checkbox')
                    || getProp(props, 'Potential ROE issue',       'checkbox'),
        providers:     getProp(props, 'Providers #',               'number')
                    || getProp(props, '# Providers',               'number'),
        employees:     getProp(props, 'Employees #',               'number')
                    || getProp(props, '# Employees',               'number'),
        annualRevenue: getProp(props, 'Annual Revenue ($)',        'number')
                    || getProp(props, 'Annual Revenue',            'number'),
        locations:     getProp(props, '# of locations',           'number')
                    || getProp(props, 'Locations',                 'number'),
        lastSfdc:      getProp(props, 'Last interaction from SFDC','date')
                    || getProp(props, 'Last SFDC Interaction',     'date'),
      });
    }

    hasMore = data.has_more;
    cursor  = data.next_cursor;

    // Rate-limit: 0.35s between calls
    if (hasMore) await sleep(350);

    console.log(`[pipeline] Fetched page ${page} (${records.length} records so far)`);
  }

  console.log(`[pipeline] Done. Total records: ${records.length}`);
  return records;
}

/** Kick off a background fetch and store in cache when done */
function backgroundRefresh() {
  if (cache.isFetching) return;
  cache.isFetching = true;
  fetchAllNotionPages()
    .then((records) => {
      cache.records   = records;
      cache.fetchedAt = Date.now();
    })
    .catch((err) => {
      console.error('[pipeline] Background fetch failed:', err);
    })
    .finally(() => {
      cache.isFetching = false;
    });
}

// ─── Aggregation ──────────────────────────────────────────────────────────────
function aggregate(records) {
  const byStage     = {};
  const byEhr       = {};
  const bySpecialty = {};
  const bySource    = {};
  let notRcmCount   = 0;
  let roeCount      = 0;
  let specialtiesTagged = 0;

  for (const r of records) {
    // Stage
    const stage = r.stage || 'Unknown';
    byStage[stage] = (byStage[stage] || 0) + 1;

    // EHR
    const ehr = r.ehr || 'Unknown';
    byEhr[ehr] = (byEhr[ehr] || 0) + 1;

    // Specialty (comma-separated from multi_select)
    if (r.specialty) {
      specialtiesTagged++;
      for (const s of r.specialty.split(',')) {
        const sp = s.trim();
        if (sp) bySpecialty[sp] = (bySpecialty[sp] || 0) + 1;
      }
    }

    // Source
    const src = r.sourceCategory || 'Unknown';
    bySource[src] = (bySource[src] || 0) + 1;

    if (r.notInRcmIcp) notRcmCount++;
    if (r.potentialRoe) roeCount++;
  }

  // Top 20 specialties
  const topSpecialties = Object.entries(bySpecialty)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([name, count]) => ({ name, count }));

  return {
    total:            records.length,
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

// ─── Handler ──────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')     return res.status(405).json({ error: 'Method not allowed' });

  const now = Date.now();
  const cacheAge = now - cache.fetchedAt;

  // If cache is stale or empty, initiate background refresh
  if (!cache.records || cacheAge > CACHE_TTL_MS) {
    if (!cache.isFetching) {
      console.log('[pipeline] Cache miss — starting background fetch');
      backgroundRefresh();
    }
    // If we have nothing cached at all, wait for the first fetch
    if (!cache.records) {
      console.log('[pipeline] No cache yet — waiting for initial fetch…');
      // Poll up to 300s
      const deadline = Date.now() + 300_000;
      while (!cache.records && Date.now() < deadline) {
        await sleep(1000);
      }
      if (!cache.records) {
        return res.status(503).json({ error: 'Data not ready yet, try again in a moment' });
      }
    }
  }

  let records = cache.records;

  // ── Filtering ──────────────────────────────────────────────────────────────
  const { ehr, stage, specialty, source, nonRcm, roe, search } = req.query;

  if (ehr)       records = records.filter((r) => r.ehr === ehr);
  if (stage)     records = records.filter((r) => r.stage === stage);
  if (specialty) records = records.filter((r) => r.specialty?.includes(specialty));
  if (source)    records = records.filter((r) => r.sourceCategory === source);
  if (nonRcm === 'true') records = records.filter((r) => r.notInRcmIcp);
  if (roe    === 'true') records = records.filter((r) => r.potentialRoe);
  if (search) {
    const q = search.toLowerCase();
    records = records.filter((r) => r.accountName?.toLowerCase().includes(q));
  }

  // ── Aggregation ────────────────────────────────────────────────────────────
  const agg = aggregate(records);

  // ── Pagination ─────────────────────────────────────────────────────────────
  const page     = Math.max(1, parseInt(req.query.page     || '1', 10));
  const pageSize = Math.min(500, parseInt(req.query.pageSize || '100', 10));
  const start    = (page - 1) * pageSize;
  const end      = start + pageSize;
  const paginated = records.slice(start, end);

  return res.status(200).json({
    meta: {
      total:      records.length,
      page,
      pageSize,
      totalPages: Math.ceil(records.length / pageSize),
      cachedAt:   new Date(cache.fetchedAt).toISOString(),
      cacheAge:   Math.round(cacheAge / 1000),
    },
    aggregations: agg,
    records: paginated,
  });
}
