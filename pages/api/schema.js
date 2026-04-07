/**
 * /api/schema — GET
 * Returns the full property schema for both the Pipeline and Contacts
 * Notion databases. Cached in memory for 10 minutes.
 *
 * Response:
 *  {
 *    pipeline: { id, title, properties, propOrder },
 *    contacts: { id, title, properties, propOrder },
 *    hash: string,       ← changes when schema changes (for auto-detect)
 *    cachedAt: ISO string,
 *    cacheAge: seconds
 *  }
 *
 * Frontend polls this and compares hash to detect schema changes.
 * When hash changes, filter dropdowns & column lists auto-refresh.
 */

import { fetchDbSchema, hashObject } from '../../lib/notion';

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const PIPELINE_DB  = process.env.NOTION_PIPELINE_DB;
const CONTACTS_DB  = process.env.NOTION_CONTACTS_DB;
const CACHE_TTL    = 10 * 60 * 1000; // 10 minutes

let cache = { data: null, fetchedAt: 0 };

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')     return res.status(405).json({ error: 'Method not allowed' });

  const now = Date.now();
  const age = now - cache.fetchedAt;

  if (cache.data && age < CACHE_TTL) {
    return res.status(200).json({ ...cache.data, cacheAge: Math.round(age / 1000) });
  }

  try {
    // Fetch both schemas in parallel
    const [pipeline, contacts] = await Promise.all([
      fetchDbSchema(PIPELINE_DB, NOTION_TOKEN),
      fetchDbSchema(CONTACTS_DB, NOTION_TOKEN),
    ]);

    const data = {
      pipeline,
      contacts,
      hash:     hashObject({ pipeline, contacts }),
      cachedAt: new Date().toISOString(),
    };

    cache = { data, fetchedAt: now };
    console.log(`[schema] Fetched. Pipeline: ${Object.keys(pipeline.properties).length} props, Contacts: ${Object.keys(contacts.properties).length} props`);

    return res.status(200).json({ ...data, cacheAge: 0 });
  } catch (err) {
    console.error('[schema] Error:', err.message);
    // Serve stale data if available rather than failing
    if (cache.data) {
      return res.status(200).json({ ...cache.data, stale: true, cacheAge: Math.round(age / 1000) });
    }
    return res.status(500).json({ error: err.message });
  }
}
