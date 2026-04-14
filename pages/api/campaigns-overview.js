/**
 * /api/campaigns-overview — GET
 *
 * Returns high-level campaign metrics for the Campaigns tab.
 *
 * Response: {
 *   activeContacts,    — unique prospects in active sequence states (agents team)
 *   activeAccounts,    — unique accounts for those prospects (estimated)
 *   prospectsReached30d, — unique prospects touched by calls or emails in last 30d
 *   totalTouchpoints30d, — total calls + delivered emails in last 30d
 *   updatedAt
 * }
 *
 * Cached in-memory for 5 minutes.
 */

import { getAccessToken } from '../../lib/outreach';

const AGENTS_TEAM_USER_IDS = [1040, 865, 871, 1043, 1044];
const OUTREACH_BASE = 'https://api.outreach.io/api/v2';
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

let _cache = { data: null, fetchedAt: 0 };

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function outreachGet(path, token) {
  const res = await fetch(`${OUTREACH_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Outreach GET ${path} → ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * Paginate all pages of an Outreach endpoint.
 * Uses page[limit] param and follows links.next.
 */
async function fetchAllPages(path, token, extraParams = {}, maxPages = 50) {
  const results = [];
  const url = new URL(`${OUTREACH_BASE}${path}`);
  url.searchParams.set('page[limit]', '100');
  for (const [k, v] of Object.entries(extraParams)) {
    url.searchParams.set(k, String(v));
  }

  let currentUrl = url.toString();
  let page = 0;

  while (currentUrl && page < maxPages) {
    const data = await fetch(currentUrl, {
      headers: { Authorization: `Bearer ${token}` },
    }).then(r => {
      if (!r.ok) throw new Error(`Outreach ${path} → ${r.status}`);
      return r.json();
    });

    if (Array.isArray(data.data)) results.push(...data.data);
    currentUrl = data.links?.next || null;
    page++;
  }

  return results;
}

/**
 * Fetch agents-team sequences (owner in AGENTS_TEAM_USER_IDS).
 * Returns array of sequence IDs.
 */
async function fetchAgentsTeamSequenceIds(token) {
  const sequences = await fetchAllPages('/sequences', token, { 'filter[enabled]': 'true' });
  return sequences
    .filter(s => AGENTS_TEAM_USER_IDS.includes(Number(s.relationships?.owner?.data?.id)))
    .map(s => Number(s.id));
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // Serve cache if fresh
  if (_cache.data && Date.now() - _cache.fetchedAt < CACHE_TTL) {
    return res.status(200).json(_cache.data);
  }

  try {
    const token = await getAccessToken();

    // ── 1. Active sequence states for agents-team sequences ──────────────────
    const agentsSeqIds = await fetchAgentsTeamSequenceIds(token);

    const activeProspectIds = new Set();
    // Fetch active sequenceStates for all agents-team sequences in parallel (batched)
    const batchSize = 5;
    for (let i = 0; i < agentsSeqIds.length; i += batchSize) {
      const batch = agentsSeqIds.slice(i, i + batchSize);
      await Promise.all(batch.map(async (seqId) => {
        try {
          const states = await fetchAllPages('/sequenceStates', token, {
            'filter[sequence][id]': seqId,
            'filter[state]': 'active',
          }, 20);
          for (const s of states) {
            const pid = s.relationships?.prospect?.data?.id;
            if (pid) activeProspectIds.add(String(pid));
          }
        } catch (err) {
          console.warn(`[campaigns-overview] sequenceStates for seq ${seqId}: ${err.message}`);
        }
      }));
    }

    const activeContacts = activeProspectIds.size;
    // Estimate accounts as ~65% of unique contacts (multiple contacts per account)
    const activeAccounts = Math.round(activeContacts * 0.65);

    // ── 2. Last 30 days reach ─────────────────────────────────────────────────
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const startISO = thirtyDaysAgo.toISOString();
    const endISO   = now.toISOString();

    const reachedProspectIds = new Set();
    let totalTouchpoints30d = 0;

    // Fetch calls and mailings for each agent in parallel
    await Promise.all(AGENTS_TEAM_USER_IDS.map(async (userId) => {
      try {
        // Calls
        const callUrl = new URL(`${OUTREACH_BASE}/calls`);
        callUrl.searchParams.set('filter[user][id]', String(userId));
        callUrl.searchParams.set(`filter[createdAt]`, `${startISO}..${endISO}`);
        callUrl.searchParams.set('page[size]', '200');

        let callCursor = callUrl.toString();
        let callPages = 0;
        while (callCursor && callPages < 20) {
          const data = await fetch(callCursor, {
            headers: { Authorization: `Bearer ${token}` },
          }).then(r => r.ok ? r.json() : Promise.resolve({ data: [] }));
          for (const call of (data.data || [])) {
            totalTouchpoints30d++;
            const pid = call.relationships?.prospect?.data?.id;
            if (pid) reachedProspectIds.add(String(pid));
          }
          callCursor = data.links?.next || null;
          callPages++;
        }
      } catch (err) {
        console.warn(`[campaigns-overview] calls for user ${userId}: ${err.message}`);
      }

      try {
        // Mailings (delivered)
        const mailUrl = new URL(`${OUTREACH_BASE}/mailings`);
        mailUrl.searchParams.set('filter[user][id]', String(userId));
        mailUrl.searchParams.set(`filter[createdAt]`, `${startISO}..${endISO}`);
        mailUrl.searchParams.set('filter[state]', 'delivered');
        mailUrl.searchParams.set('page[size]', '200');

        let mailCursor = mailUrl.toString();
        let mailPages = 0;
        while (mailCursor && mailPages < 20) {
          const data = await fetch(mailCursor, {
            headers: { Authorization: `Bearer ${token}` },
          }).then(r => r.ok ? r.json() : Promise.resolve({ data: [] }));
          for (const mail of (data.data || [])) {
            totalTouchpoints30d++;
            const pid = mail.relationships?.prospect?.data?.id;
            if (pid) reachedProspectIds.add(String(pid));
          }
          mailCursor = data.links?.next || null;
          mailPages++;
        }
      } catch (err) {
        console.warn(`[campaigns-overview] mailings for user ${userId}: ${err.message}`);
      }
    }));

    const prospectsReached30d = reachedProspectIds.size;

    const result = {
      activeContacts,
      activeAccounts,
      prospectsReached30d,
      totalTouchpoints30d,
      updatedAt: new Date().toISOString(),
    };

    _cache = { data: result, fetchedAt: Date.now() };
    return res.status(200).json(result);

  } catch (err) {
    console.error('[campaigns-overview] Error:', err.message);
    // Return stale cache if available
    if (_cache.data) {
      return res.status(200).json({ ..._cache.data, stale: true });
    }
    return res.status(500).json({ error: err.message });
  }
}
