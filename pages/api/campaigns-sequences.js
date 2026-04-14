/**
 * /api/campaigns-sequences — GET
 *
 * Returns sequences owned by the agents team with accurate counts.
 * Filters to only sequences with at least 1 enrolled prospect.
 *
 * Response: Array of {
 *   id, name, ownerName,
 *   activeCount, totalContacts, accountCount,
 *   finishedCount, bouncedCount, optedOutCount, pausedCount
 * }
 */

import { getAccessToken } from '../../lib/outreach';
import { query } from '../../lib/db';

const AGENTS_TEAM_USER_IDS = [1040, 865, 871, 1043, 1044];
const OUTREACH_BASE = 'https://api.outreach.io/api/v2';

const OWNER_NAMES = {
  1040: 'Gray Hoffman',
  865:  'Andy',
  871:  'Neha',
  1043: 'Manish',
  1044: 'Adam',
};

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

/** Paginate all sequenceStates for a given sequence + state. Returns array of states. */
async function fetchStates(seqId, state, token, maxPages = 30) {
  const results = [];
  let url = `${OUTREACH_BASE}/sequenceStates?filter[sequence][id]=${seqId}&filter[state]=${state}&page[size]=200`;
  let pages = 0;
  while (url && pages < maxPages) {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) break;
    const data = await r.json();
    results.push(...(data.data || []));
    url = data.links?.next || null;
    pages++;
  }
  return results;
}

/** Get unique account count from DB for a set of prospect (Outreach) IDs */
async function getAccountCount(prospectIds) {
  if (!prospectIds.length) return 0;
  try {
    // Look up contacts by outreach_id, then count unique account_sfdc_ids
    const placeholders = prospectIds.map((_, i) => `$${i + 1}`).join(',');
    const result = await query(
      `SELECT COUNT(DISTINCT account_sfdc_id) as cnt FROM contacts
       WHERE outreach_id = ANY($1::text[]) AND account_sfdc_id IS NOT NULL`,
      [prospectIds.map(String)]
    );
    return parseInt(result.rows[0]?.cnt || 0, 10);
  } catch {
    return 0;
  }
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const token = await getAccessToken();

    // Fetch all sequences (no filter[enabled] — that causes 400)
    const allSequences = [];
    let currentUrl = `${OUTREACH_BASE}/sequences?page[limit]=100`;
    let pages = 0;
    while (currentUrl && pages < 20) {
      const r = await fetch(currentUrl, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) break;
      const data = await r.json();
      if (Array.isArray(data.data)) allSequences.push(...data.data);
      currentUrl = data.links?.next || null;
      pages++;
    }

    // Filter to agents team only
    const agentsSequences = allSequences.filter(s =>
      AGENTS_TEAM_USER_IDS.includes(Number(s.relationships?.owner?.data?.id))
    );

    // For each sequence, get state counts
    const results = await Promise.all(agentsSequences.map(async (seq) => {
      const seqId = Number(seq.id);
      const ownerId = Number(seq.relationships?.owner?.data?.id);
      const ownerName = OWNER_NAMES[ownerId] || `User ${ownerId}`;

      // Fetch active states — we need prospect IDs for account lookup
      const activeStates = await fetchStates(seqId, 'active', token);
      const activeCount = activeStates.length;

      // Only fetch other states if there are any actives (performance)
      // For total contacts we need all states
      const [finishedStates, bouncedStates, optedOutStates, pausedStates] = await Promise.all([
        fetchStates(seqId, 'finished', token, 10),
        fetchStates(seqId, 'bounced', token, 5),
        fetchStates(seqId, 'opted_out', token, 5),
        fetchStates(seqId, 'paused', token, 5),
      ]);

      const finishedCount  = finishedStates.length;
      const bouncedCount   = bouncedStates.length;
      const optedOutCount  = optedOutStates.length;
      const pausedCount    = pausedStates.length;
      const totalContacts  = activeCount + finishedCount + bouncedCount + optedOutCount + pausedCount;

      // Skip sequences with no enrolled prospects
      if (totalContacts === 0) return null;

      // Get unique account count from DB using active prospect IDs
      const activeProspectIds = activeStates
        .map(s => s.relationships?.prospect?.data?.id)
        .filter(Boolean)
        .map(String);
      const accountCount = await getAccountCount(activeProspectIds);

      return {
        id: seqId,
        name: seq.attributes?.name || `Sequence ${seqId}`,
        ownerName,
        enabled: seq.attributes?.enabled !== false,
        activeCount,
        totalContacts,
        accountCount,
        finishedCount,
        bouncedCount,
        optedOutCount,
        pausedCount,
      };
    }));

    // Filter nulls, sort by activeCount desc
    const filtered = results.filter(Boolean).sort((a, b) => b.activeCount - a.activeCount);

    return res.status(200).json(filtered);

  } catch (err) {
    console.error('[campaigns-sequences] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
