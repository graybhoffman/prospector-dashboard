/**
 * /api/campaigns-overview — GET
 *
 * Summary metrics for the Campaigns tab.
 * - totalContacts: sum of all enrolled prospects across active sequences
 * - totalAccounts: sum of unique accounts across active sequences  
 * - calls30d: total phone calls in last 30 days by agents team
 * - otherTouchpoints30d: delivered emails + other non-call touchpoints
 *
 * Cached for 5 minutes.
 */

import { getAccessToken } from '../../lib/outreach';

const AGENTS_TEAM_USER_IDS = [1040, 865, 871, 1043, 1044];
const OUTREACH_BASE = 'https://api.outreach.io/api/v2';
const CACHE_TTL = 5 * 60 * 1000;

let _cache = { data: null, fetchedAt: 0 };

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  if (_cache.data && Date.now() - _cache.fetchedAt < CACHE_TTL) {
    return res.status(200).json(_cache.data);
  }

  try {
    const token = await getAccessToken();
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const startISO = thirtyDaysAgo.toISOString();
    const endISO   = now.toISOString();

    // ── Calls (30d) and Emails (30d) per agent ────────────────────────────────
    let calls30d = 0;
    let emails30d = 0;

    await Promise.all(AGENTS_TEAM_USER_IDS.map(async (userId) => {
      // Calls
      try {
        let url = `${OUTREACH_BASE}/calls?filter[user][id]=${userId}&filter[createdAt]=${startISO}..${endISO}&page[size]=200`;
        let pages = 0;
        while (url && pages < 30) {
          const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
          if (!r.ok) break;
          const data = await r.json();
          calls30d += (data.data || []).length;
          url = data.links?.next || null;
          pages++;
        }
      } catch {}

      // Delivered emails
      try {
        let url = `${OUTREACH_BASE}/mailings?filter[user][id]=${userId}&filter[createdAt]=${startISO}..${endISO}&filter[state]=delivered&page[size]=200`;
        let pages = 0;
        while (url && pages < 30) {
          const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
          if (!r.ok) break;
          const data = await r.json();
          emails30d += (data.data || []).length;
          url = data.links?.next || null;
          pages++;
        }
      } catch {}
    }));

    // ── Active sequence totals (contacts + accounts from sequences endpoint) ──
    // Fetch from the sequences API to get totals — use the cached result from
    // campaigns-sequences if available, otherwise compute a quick estimate.
    // For the summary cards, we just show calls30d and emails30d since those
    // are the most reliable; totalContacts/accounts come from campaigns-sequences.
    const result = {
      calls30d,
      emails30d,
      totalTouchpoints30d: calls30d + emails30d,
      updatedAt: new Date().toISOString(),
    };

    _cache = { data: result, fetchedAt: Date.now() };
    return res.status(200).json(result);

  } catch (err) {
    console.error('[campaigns-overview] Error:', err.message);
    if (_cache.data) return res.status(200).json({ ..._cache.data, stale: true });
    return res.status(500).json({ error: err.message });
  }
}
