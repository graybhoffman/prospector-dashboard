/**
 * /api/campaigns-sequences — GET
 *
 * Returns active sequences owned by the agents team, with state counts.
 *
 * Response: Array of {
 *   id, name, ownerName, enabled,
 *   activeCount, finishedCount, bouncedCount, optedOutCount
 * }
 *
 * Uses meta.count from sequenceStates responses to avoid fetching all records.
 */

import { getAccessToken } from '../../lib/outreach';

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

/**
 * Fetch a single page with page[size]=1 to get meta.count.
 */
async function fetchCount(sequenceId, state, token) {
  try {
    const url = new URL(`${OUTREACH_BASE}/sequenceStates`);
    url.searchParams.set('filter[sequence][id]', String(sequenceId));
    url.searchParams.set('filter[state]', state);
    url.searchParams.set('page[size]', '1');

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return 0;
    const data = await res.json();
    // Outreach returns meta.count for total matching records
    return data.meta?.count ?? data.meta?.total ?? (data.data?.length ?? 0);
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

    // Fetch all enabled sequences
    const allSequences = [];
    let currentUrl = `${OUTREACH_BASE}/sequences?page[limit]=100`;
    let pages = 0;
    while (currentUrl && pages < 20) {
      const res2 = await fetch(currentUrl, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res2.ok) break;
      const data = await res2.json();
      if (Array.isArray(data.data)) allSequences.push(...data.data);
      currentUrl = data.links?.next || null;
      pages++;
    }

    // Filter to agents team
    const agentsSequences = allSequences
      .filter(s => AGENTS_TEAM_USER_IDS.includes(Number(s.relationships?.owner?.data?.id)))
      .slice(0, 20); // cap at 20

    // For each sequence, get counts in parallel
    const results = await Promise.all(agentsSequences.map(async (seq) => {
      const seqId = Number(seq.id);
      const ownerId = Number(seq.relationships?.owner?.data?.id);
      const ownerName = OWNER_NAMES[ownerId] || `User ${ownerId}`;

      const [activeCount, finishedCount, bouncedCount, optedOutCount] = await Promise.all([
        fetchCount(seqId, 'active', token),
        fetchCount(seqId, 'finished', token),
        fetchCount(seqId, 'bounced', token),
        fetchCount(seqId, 'opted_out', token),
      ]);

      return {
        id: seqId,
        name: seq.attributes?.name || `Sequence ${seqId}`,
        ownerName,
        enabled: seq.attributes?.enabled !== false,
        activeCount,
        finishedCount,
        bouncedCount,
        optedOutCount,
      };
    }));

    // Sort by activeCount descending
    results.sort((a, b) => b.activeCount - a.activeCount);

    return res.status(200).json(results);

  } catch (err) {
    console.error('[campaigns-sequences] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
