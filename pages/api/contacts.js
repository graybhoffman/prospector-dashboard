/**
 * /api/contacts — GET
 *
 * Returns all records from the Contacts Notion database.
 * Fully dynamic — all fields returned for every record.
 *
 * Query params:
 *   page         (default 1)
 *   pageSize     (default 50, max 500)
 *   source       filter on Source field
 *   inSfdc       "true" = only contacts marked In SFDC
 *   inPipeline   "true" = only contacts marked In Pipeline
 *   search       text search on Full Name or Company Name
 *
 * Response:
 *   { meta, records: [{ id, fields }] }
 */

import { fetchAllPages } from '../../lib/notion';

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const CONTACTS_DB  = process.env.NOTION_CONTACTS_DB;
const CACHE_TTL    = 5 * 60 * 1000;

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
  console.log('[contacts] Background refresh started…');

  fetchAllPages(CONTACTS_DB, NOTION_TOKEN, (page, total) => {
    console.log(`[contacts] Page ${page} (${total} so far)`);
  })
    .then((records) => {
      cache.records   = records;
      cache.fetchedAt = Date.now();
      console.log(`[contacts] Cache updated: ${records.length} records`);
    })
    .catch((err) => console.error('[contacts] Refresh failed:', err.message))
    .finally(() => { cache.isFetching = false; });
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')     return res.status(405).json({ error: 'Method not allowed' });

  const now = Date.now();
  const age = now - cache.fetchedAt;

  if (!cache.records || age > CACHE_TTL) {
    startBackgroundRefresh();
  }

  // Wait on cold start (contacts DB likely smaller, 2min timeout)
  if (!cache.records) {
    console.log('[contacts] Cold start — waiting…');
    const deadline = Date.now() + 120_000;
    while (!cache.records && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!cache.records) {
      return res.status(503).json({ error: 'Contacts data not ready yet.' });
    }
  }

  let records = cache.records;

  // ─── Filtering ─────────────────────────────────────────────────────────────
  const { source, connDegree, inSfdc, inPipeline, search } = req.query;

  if (source)                records = records.filter((r) => r.fields['Source'] === source);
  if (connDegree)            records = records.filter((r) => r.fields['Connection Degree'] === connDegree);
  if (inSfdc      === 'true') records = records.filter((r) => r.fields['In SFDC']);
  if (inPipeline  === 'true') records = records.filter((r) => r.fields['In Pipeline']);
  if (search) {
    const q = search.toLowerCase();
    records = records.filter((r) =>
      (r.fields['Full Name']     || '').toLowerCase().includes(q) ||
      (r.fields['Company Name']  || '').toLowerCase().includes(q)
    );
  }

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
    records: paginated,
  });
}
