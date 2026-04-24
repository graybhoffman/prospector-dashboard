/**
 * /api/outreach-activity-stats - GET
 *
 * Returns activity stats pulled directly from Outreach API.
 * Filtered to Agents Team only.
 *
 * Query params:
 *   window  "today" | "yesterday" | "week" | "day-14" | "week-8" | "month-6"
 *   date    ISO date string (YYYY-MM-DD)
 *   userId  optional Outreach user ID to filter trend windows to a single person
 *
 * Response: { stats, perUser, isLive, window }
 */

import { getAccessToken } from '../../lib/outreach';
import { query } from '../../lib/db';

// Current members: Gray=1040, Andy=865, Neha=871, Manish=1043, Adam=1044
const AGENTS_TEAM_USER_IDS = [1040, 865, 871, 1043, 1044, 866, 1045];

const OUTREACH_BASE = 'https://api.outreach.io/api/v2';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

const EMPTY_STATS = { calls: 0, connects: 0, emailsSent: 0, contactsContacted: 0, accountsContacted: 0, sets: 0 };

async function getStatsForRange(startISO, endISO, token, userIds = AGENTS_TEAM_USER_IDS) {
  const stats = { ...EMPTY_STATS };
  const contactIds = new Set();
  const perUser = {};

  for (const userId of userIds) {
    const userStats = { ...EMPTY_STATS };
    const userContactIds = new Set();

    // Calls
    try {
      let cursor = `${OUTREACH_BASE}/calls?filter[user][id]=${userId}&filter[createdAt]=${startISO}..${endISO}&page[size]=200&include=callDisposition`;
      while (cursor) {
        const data = await fetch(cursor, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json());
        const dispMap = {};
        for (const inc of (data.included || [])) {
          if (inc.type === 'callDisposition') dispMap[inc.id] = (inc.attributes?.name || '').toLowerCase();
        }
        for (const call of (data.data || [])) {
          stats.calls++; userStats.calls++;
          const dispId = call.relationships?.callDisposition?.data?.id;
          const dispName = dispMap[dispId] || '';
          if (dispName.startsWith('answered')) { stats.connects++; userStats.connects++; }
          if (dispName.includes('meeting set') || dispName.includes('meeting booked') || dispName.includes('demo set')) {
            stats.sets++; userStats.sets++;
          }
          const prospectId = call.relationships?.prospect?.data?.id;
          if (prospectId) { contactIds.add(prospectId); userContactIds.add(prospectId); }
        }
        cursor = data.links?.next || null;
      }
    } catch (e) { console.error(`[activity-stats] calls uid=${userId}:`, e.message); }

    // Emails
    try {
      let cursor = `${OUTREACH_BASE}/mailings?filter[user][id]=${userId}&filter[createdAt]=${startISO}..${endISO}&filter[state]=delivered&page[size]=200`;
      while (cursor) {
        const resp = await fetch(cursor, { headers: { Authorization: `Bearer ${token}` } });
        if (!resp.ok) { console.error(`[activity-stats] mailings uid=${userId} HTTP ${resp.status}`); break; }
        const data = await resp.json();
        if (data.errors) { console.error(`[activity-stats] mailings uid=${userId}:`, JSON.stringify(data.errors[0])); break; }
        for (const mail of (data.data || [])) {
          stats.emailsSent++; userStats.emailsSent++;
          const prospectId = mail.relationships?.prospect?.data?.id;
          if (prospectId) { contactIds.add(prospectId); userContactIds.add(prospectId); }
        }
        cursor = data.links?.next || null;
      }
    } catch (e) { console.error(`[activity-stats] mailings uid=${userId}:`, e.message); }

    userStats.contactsContacted = userContactIds.size;
    userStats.accountsContacted = Math.ceil(userContactIds.size * 0.6);
    perUser[userId] = userStats;
  }

  stats.contactsContacted = contactIds.size;
  stats.accountsContacted = Math.ceil(contactIds.size * 0.6);

  // Discovery Sets: count new opportunities created in this period
  try {
    const oppRes = await query(
      `SELECT COUNT(*) FROM opportunities WHERE created_at >= $1 AND created_at < $2`,
      [startISO, endISO]
    );
    stats.sets = parseInt(oppRes.rows[0].count, 10) || 0;
  } catch (e) {
    console.error('[activity-stats] sets from opps:', e.message);
  }

  return { stats, perUser };
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { window: win = 'today', date, userId: userIdParam } = req.query;
  const filterUserIds = userIdParam
    ? [parseInt(userIdParam, 10)].filter(id => AGENTS_TEAM_USER_IDS.includes(id))
    : AGENTS_TEAM_USER_IDS;

  try {
    const token = await getAccessToken();
    const ptNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
    const todayPT = ptNow.toISOString().slice(0, 10);

    if (win === 'today' || date === 'today') {
      const ptStart = new Date(todayPT + 'T07:00:00.000Z');
      const result = await getStatsForRange(ptStart.toISOString(), new Date(ptStart.getTime() + 86400000).toISOString(), token);
      return res.status(200).json({ isLive: true, window: win, stats: result.stats, perUser: result.perUser, teamUserIds: AGENTS_TEAM_USER_IDS });
    }

    if (win === 'yesterday') {
      const yesterday = new Date(ptNow); yesterday.setDate(ptNow.getDate() - 1);
      const yDate = yesterday.toISOString().slice(0, 10);
      const ptStart = new Date(yDate + 'T07:00:00.000Z');
      const result = await getStatsForRange(ptStart.toISOString(), new Date(ptStart.getTime() + 86400000).toISOString(), token);
      return res.status(200).json({ isLive: true, window: win, stats: result.stats, perUser: result.perUser, teamUserIds: AGENTS_TEAM_USER_IDS });
    }

    if (win === 'week') {
      const now = new Date();
      const dayOfWeek = now.getUTCDay();
      const daysFromMon = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
      const monday = new Date(now);
      monday.setUTCDate(now.getUTCDate() - daysFromMon);
      const weekStart = monday.toISOString().slice(0, 10) + 'T07:00:00.000Z';
      const weekEnd = now.toISOString();
      const result = await getStatsForRange(weekStart, weekEnd, token);
      return res.status(200).json({ isLive: true, window: win, stats: result.stats, perUser: result.perUser, teamUserIds: AGENTS_TEAM_USER_IDS });
    }

    if (date) {
      const ptStart = new Date(date + 'T07:00:00.000Z');
      const result = await getStatsForRange(ptStart.toISOString(), new Date(ptStart.getTime() + 86400000).toISOString(), token);
      return res.status(200).json({ isLive: true, window: 'date', date, stats: result.stats, perUser: result.perUser, teamUserIds: AGENTS_TEAM_USER_IDS });
    }

    // Trend windows
    if (win === 'day-14') {
      const trend = [];
      for (let i = 13; i >= 0; i--) {
        const d = new Date(); d.setDate(d.getDate() - i);
        const ds = d.toISOString().slice(0, 10);
        const ptStart = new Date(ds + 'T07:00:00.000Z');
        const r = await getStatsForRange(ptStart.toISOString(), new Date(ptStart.getTime() + 86400000).toISOString(), token, filterUserIds);
        const s = r.stats;
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
        const endISO = new Date(sunday.toISOString().slice(0, 10) + 'T06:59:59.999Z').toISOString();
        const r = await getStatsForRange(startISO, endISO, token, filterUserIds);
        const s = r.stats;
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
        const endISO = new Date(year, month + 1, 0, 6, 59, 59).toISOString();
        const r = await getStatsForRange(startISO, endISO, token, filterUserIds);
        const s = r.stats;
        trend.push({ label: d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' }), ...s, contacts: s.contactsContacted, accounts: s.accountsContacted });
      }
      return res.status(200).json({ isLive: true, window: win, trend, teamUserIds: AGENTS_TEAM_USER_IDS });
    }

    return res.status(400).json({ error: 'Provide window=today|yesterday|week|day-14|week-8|month-6 or date=YYYY-MM-DD' });
  } catch (err) {
    console.error('[outreach-activity-stats]', err.message);
    return res.status(200).json({ isLive: false, window: win, stats: { ...EMPTY_STATS }, error: err.message });
  }
}
