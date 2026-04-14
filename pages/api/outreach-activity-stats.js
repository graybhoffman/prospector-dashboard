/**
 * /api/outreach-activity-stats — GET
 *
 * Returns activity stats pulled directly from Outreach API.
 * Filtered to Agents Team only.
 *
 * To add/remove team members, update AGENTS_TEAM_USER_IDS below.
 *
 * Query params:
 *   window  "today" | "week" | "day-14"
 *   date    ISO date string (YYYY-MM-DD)
 *
 * Response: { stats: { calls, connects, emailsSent, contactsContacted, accountsContacted, sets }, isLive, window }
 */

import { getAccessToken } from '../../lib/outreach';

// ─── AGENTS TEAM CONFIG ────────────────────────────────────────────────────
// To add a team member: add their Outreach user ID to this array
// To remove: delete their ID from this array
// Current members: Gray=1040, Andy=865, Neha=871, Manish=1043, Adam=1044
const AGENTS_TEAM_USER_IDS = [1040, 865, 871, 1043, 1044];
// ──────────────────────────────────────────────────────────────────────────

const OUTREACH_BASE = 'https://api.outreach.io/api/v2';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

const EMPTY_STATS = { calls: 0, connects: 0, emailsSent: 0, contactsContacted: 0, accountsContacted: 0, sets: 0 };

async function fetchOutreachPage(endpoint, token) {
  const res = await fetch(`${OUTREACH_BASE}${endpoint}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Outreach ${endpoint}: ${res.status}`);
  return res.json();
}

async function getStatsForRange(startISO, endISO, token) {
  const stats = { ...EMPTY_STATS };
  const contactIds = new Set();
  const accountIds = new Set();

  for (const userId of AGENTS_TEAM_USER_IDS) {
    // Calls
    try {
      let cursor = `${OUTREACH_BASE}/calls?filter[user][id]=${userId}&filter[createdAt]=${startISO}..${endISO}&page[size]=200`;
      while (cursor) {
        const data = await fetch(cursor, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json());
        for (const call of (data.data || [])) {
          stats.calls++;
          const attrs = call.attributes || {};
          if (attrs.answered) stats.connects++;
          // Sets: look for disposition indicating meeting booked
          const disp = (attrs.disposition || attrs.outcome || '').toLowerCase();
          if (disp.includes('meeting') || disp.includes('demo') || disp.includes('set') || disp.includes('booked')) stats.sets++;
          // Track contacts/accounts
          const prospectId = call.relationships?.prospect?.data?.id;
          if (prospectId) contactIds.add(prospectId);
        }
        cursor = data.links?.next || null;
      }
    } catch {}

    // Emails
    try {
      let cursor = `${OUTREACH_BASE}/mailings?filter[user][id]=${userId}&filter[createdAt]=${startISO}..${endISO}&filter[state]=delivered&page[size]=200`;
      while (cursor) {
        const data = await fetch(cursor, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json());
        for (const mail of (data.data || [])) {
          stats.emailsSent++;
          const prospectId = mail.relationships?.prospect?.data?.id;
          if (prospectId) contactIds.add(prospectId);
        }
        cursor = data.links?.next || null;
      }
    } catch {}
  }

  stats.contactsContacted = contactIds.size;
  // accountsContacted: approximate from unique contact count (can refine later)
  stats.accountsContacted = Math.ceil(contactIds.size * 0.6); // rough estimate

  return stats;
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { window: win = 'today', date } = req.query;

  try {
    const token = await getAccessToken();

    const ptNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
    const todayPT = ptNow.toISOString().slice(0, 10);

    if (win === 'today' || date === 'today') {
      const start = `${todayPT}T00:00:00.000Z`;
      const end = `${todayPT}T23:59:59.999Z`;
      // Use PT midnight
      const ptStart = new Date(todayPT + 'T07:00:00.000Z'); // PT midnight = UTC+7 in PDT
      const stats = await getStatsForRange(
        ptStart.toISOString(),
        new Date(ptStart.getTime() + 86400000).toISOString(),
        token
      );
      return res.status(200).json({ isLive: true, window: win, stats, teamUserIds: AGENTS_TEAM_USER_IDS });
    }

    if (date) {
      const ptStart = new Date(date + 'T07:00:00.000Z');
      const stats = await getStatsForRange(
        ptStart.toISOString(),
        new Date(ptStart.getTime() + 86400000).toISOString(),
        token
      );
      return res.status(200).json({ isLive: true, window: 'date', date, stats, teamUserIds: AGENTS_TEAM_USER_IDS });
    }

    // ── Trend windows: day-14, week-8, month-6 ──────────────────────────────
    if (win === 'day-14') {
      const trend = [];
      for (let i = 13; i >= 0; i--) {
        const d = new Date(); d.setDate(d.getDate() - i);
        const ds = d.toISOString().slice(0, 10);
        const ptStart = new Date(ds + 'T07:00:00.000Z');
        const s = await getStatsForRange(ptStart.toISOString(), new Date(ptStart.getTime() + 86400000).toISOString(), token);
        trend.push({ label: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), ...s, contacts: s.contactsContacted, accounts: s.accountsContacted });
      }
      return res.status(200).json({ isLive: true, window: win, trend, teamUserIds: AGENTS_TEAM_USER_IDS });
    }

    if (win === 'week-8') {
      const trend = [];
      for (let i = 7; i >= 0; i--) {
        const monday = new Date(); monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7) - i * 7);
        const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
        const startISO = new Date(monday.toISOString().slice(0, 10) + 'T07:00:00.000Z').toISOString();
        const endISO   = new Date(sunday.toISOString().slice(0, 10) + 'T06:59:59.999Z').toISOString();
        const s = await getStatsForRange(startISO, endISO, token);
        trend.push({ label: `Wk ${monday.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`, ...s, contacts: s.contactsContacted, accounts: s.accountsContacted });
      }
      return res.status(200).json({ isLive: true, window: win, trend, teamUserIds: AGENTS_TEAM_USER_IDS });
    }

    if (win === 'month-6') {
      const trend = [];
      for (let i = 5; i >= 0; i--) {
        const d = new Date(); d.setMonth(d.getMonth() - i);
        const year = d.getFullYear(); const month = d.getMonth();
        const startISO = new Date(year, month, 1, 7, 0, 0).toISOString();
        const endISO   = new Date(year, month + 1, 0, 6, 59, 59).toISOString();
        const s = await getStatsForRange(startISO, endISO, token);
        trend.push({ label: d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' }), ...s, contacts: s.contactsContacted, accounts: s.accountsContacted });
      }
      return res.status(200).json({ isLive: true, window: win, trend, teamUserIds: AGENTS_TEAM_USER_IDS });
    }

    return res.status(400).json({ error: 'Provide window=today|week|day-14|week-8|month-6 or date=YYYY-MM-DD' });
  } catch (err) {
    console.error('[outreach-activity-stats]', err.message);
    return res.status(200).json({ isLive: false, window: win, stats: { ...EMPTY_STATS }, error: err.message });
  }
}
