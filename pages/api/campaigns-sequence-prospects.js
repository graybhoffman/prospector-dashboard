/**
 * /api/campaigns-sequence-prospects — GET
 *
 * Returns prospects in a given sequence state (with pagination).
 *
 * Query params:
 *   sequenceId   required — Outreach sequence ID
 *   state        default "active" — active | finished | bounced | opted_out
 *   page         default 1
 *   limit        default 25 (max 50)
 *
 * Response: { prospects: [...], total, page, pageSize }
 */

import { getAccessToken } from '../../lib/outreach';

const OUTREACH_BASE = 'https://api.outreach.io/api/v2';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { sequenceId, state = 'active', page = '1', limit = '25' } = req.query;
  if (!sequenceId) return res.status(400).json({ error: 'sequenceId is required' });

  const pageNum  = Math.max(1, parseInt(page, 10) || 1);
  const pageSize = Math.min(50, Math.max(1, parseInt(limit, 10) || 25));

  try {
    const token = await getAccessToken();

    // Fetch sequenceStates for this sequence + state
    const url = new URL(`${OUTREACH_BASE}/sequenceStates`);
    url.searchParams.set('filter[sequence][id]', String(sequenceId));
    url.searchParams.set('filter[state]', state);
    url.searchParams.set('page[size]', String(pageSize));
    url.searchParams.set('page[number]', String(pageNum));
    // Include prospect relationship data
    url.searchParams.set('include', 'prospect');

    const resp = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) {
      const body = await resp.text();
      return res.status(resp.status).json({ error: `Outreach API error: ${body.slice(0, 200)}` });
    }

    const data = await resp.json();
    const states = data.data || [];
    const total = data.meta?.count ?? data.meta?.total ?? states.length;

    // Build prospect lookup from included resources
    const prospectMap = {};
    for (const inc of (data.included || [])) {
      if (inc.type === 'prospect') {
        prospectMap[inc.id] = inc;
      }
    }

    // Map each sequenceState to a prospect record
    const prospects = states.map((s) => {
      const prospectId = s.relationships?.prospect?.data?.id;
      const prospect = prospectMap[prospectId] || null;
      const attrs = prospect?.attributes || {};
      const seqAttrs = s.attributes || {};

      // Calculate days in sequence
      const addedAt = seqAttrs.createdAt || seqAttrs.activatedAt;
      const daysInSequence = addedAt
        ? Math.floor((Date.now() - new Date(addedAt).getTime()) / (1000 * 60 * 60 * 24))
        : null;

      return {
        stateId: s.id,
        sequenceState: seqAttrs.state || state,
        daysInSequence,
        addedAt,
        prospectId: prospectId || null,
        name: [attrs.firstName, attrs.lastName].filter(Boolean).join(' ') || attrs.name || 'Unknown',
        email: attrs.emails?.[0]?.email || attrs.email || null,
        title: attrs.title || null,
        accountName: attrs.accountName || attrs.company || null,
      };
    });

    return res.status(200).json({ prospects, total, page: pageNum, pageSize });

  } catch (err) {
    console.error('[campaigns-sequence-prospects] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
