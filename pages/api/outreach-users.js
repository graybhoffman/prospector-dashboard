/**
 * /api/outreach-users — GET
 *
 * Returns list of active Outreach users: { id, name, email }
 * Uses the shared Outreach token from lib/outreach.js
 */

import { getAccessToken } from '../../lib/outreach';

const OUTREACH_API_BASE = 'https://api.outreach.io/api/v2';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const token = await getAccessToken();

    const users = [];
    let nextUrl = `${OUTREACH_API_BASE}/users?page[limit]=100&filter[isActive]=true`;
    let pageCount = 0;

    while (nextUrl && pageCount < 20) {
      const resp = await fetch(nextUrl, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        throw new Error(`Outreach /users failed (${resp.status}): ${body?.errors?.[0]?.detail || resp.statusText}`);
      }

      const data = await resp.json();
      for (const u of (data.data || [])) {
        const attrs = u.attributes || {};
        users.push({
          id:    u.id,
          name:  [attrs.firstName, attrs.lastName].filter(Boolean).join(' ') || attrs.username || '—',
          email: attrs.email || attrs.username || null,
        });
      }

      nextUrl = data.links?.next || null;
      pageCount++;
    }

    users.sort((a, b) => a.name.localeCompare(b.name));
    return res.status(200).json({ users, total: users.length });
  } catch (err) {
    console.error('[outreach-users]', err.message);
    return res.status(500).json({ error: err.message });
  }
}
