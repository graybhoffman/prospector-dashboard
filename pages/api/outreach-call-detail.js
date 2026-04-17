/**
 * /api/outreach-call-detail — GET
 * Returns per-call records from Outreach API for the agents team.
 * Query params:
 *   window: "today" | "week" (default: today)
 *   connectedOnly: "true" to filter to answered calls only
 */
import { getAccessToken } from '../../lib/outreach';

const AGENTS_TEAM_USER_IDS = [1040, 865, 871, 1043, 1044];
const OUTREACH_BASE = 'https://api.outreach.io/api/v2';

const USER_NAMES = {
  1040: 'Gray Hoffman',
  865:  'Andrew Sapien',
  871:  'Neha Bhongir',
  1043: 'Manish',
  1044: 'Adam',
};

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const token = await getAccessToken();
    const { window: win = 'today', connectedOnly } = req.query;

    const now = new Date();
    let startISO, endISO;
    if (win === 'week') {
      // Monday 00:00 PT
      const monday = new Date(now);
      const day = monday.getDay(); // 0=Sun
      const diff = day === 0 ? 6 : day - 1;
      monday.setDate(monday.getDate() - diff);
      monday.setHours(7, 0, 0, 0); // Mon 00:00 PT = 07:00 UTC
      startISO = monday.toISOString();
    } else {
      // Today 00:00 PT = 07:00 UTC
      const today = new Date(now);
      today.setHours(7, 0, 0, 0);
      if (today > now) today.setDate(today.getDate() - 1);
      startISO = today.toISOString();
    }
    endISO = now.toISOString();

    const calls = [];

    for (const userId of AGENTS_TEAM_USER_IDS) {
      let cursor = `${OUTREACH_BASE}/calls?filter[user][id]=${userId}&filter[createdAt]=${startISO}..${endISO}&page[size]=200&include=callDisposition`;
      while (cursor) {
        const resp = await fetch(cursor, { headers: { Authorization: `Bearer ${token}` } });
        if (!resp.ok) break;
        const data = await resp.json();
        // Build disposition map from included
        const dispositionMap = {};
        for (const inc of (data.included || [])) {
          if (inc.type === 'callDisposition') dispositionMap[inc.id] = inc.attributes?.name || '';
        }
        for (const call of (data.data || [])) {
          const attrs = call.attributes || {};
          const dispId = call.relationships?.callDisposition?.data?.id;
          const dispName = dispositionMap[dispId] || null;
          const connected = dispName ? dispName.toLowerCase().startsWith('answered') : !!attrs.answeredAt;
          if (connectedOnly === 'true' && !connected) continue;

          const prospectId = call.relationships?.prospect?.data?.id;
          const outreachLink = prospectId
            ? `https://app2a.outreach.io/prospects/${prospectId}/activities`
            : null;

          calls.push({
            id: call.id,
            userId,
            rep: USER_NAMES[userId] || `User ${userId}`,
            createdAt: attrs.createdAt,
            duration: attrs.duration || null,
            connected,
            disposition: dispositionMap[dispId] || null,
            answeredAt: attrs.answeredAt || null,
            disposition: attrs.disposition || null,
            outcome: attrs.outcome || null,
            recordingUrl: attrs.recordingUrl || null,
            voicemailUrl: attrs.voicemailRecordingUrl || null,
            outreachLink,
            note: attrs.note || null,
            direction: attrs.direction || 'outbound',
          });
        }
        cursor = data.links?.next || null;
      }
    }

    // Sort newest first
    calls.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return res.status(200).json({ calls, total: calls.length, window: win });
  } catch (err) {
    console.error('[outreach-call-detail]', err.message);
    return res.status(500).json({ error: err.message });
  }
}
