/**
 * /api/outreach-activity-stats — GET
 *
 * Returns activity stats pulled directly from the Outreach API.
 * Much more accurate than SFDC (which lags 6-24h).
 *
 * ────────────────────────────────────────────────────────────
 * AGENTS TEAM CONFIG
 * ────────────────────────────────────────────────────────────
 * To add/remove team members, update the AGENTS_TEAM array below.
 * Each entry: { name: string, outreachUserId: number }
 *
 * Current team (as of 2026-04-14):
 *   Gray    → 1040
 *   Andy    → 865
 *   Neha    → 871
 *   Manish  → 1043
 *   Adam    → 1044
 * ────────────────────────────────────────────────────────────
 *
 * Query params:
 *   window  "today" | "week" | "day-14" | "week-4" | "month-4"
 *
 * Response:
 *   {
 *     isLive: boolean,
 *     window: string,
 *     source: "outreach",
 *     stats: { calls, connects, emailsSent, contactsContacted, accountsContacted, sets },
 *     teamMembers: [{ name, outreachUserId }],
 *     error?: string   // set if Outreach API call fails (e.g. missing scope)
 *   }
 *
 * ⚠️  SCOPE REQUIREMENT:
 *   The Outreach OAuth app needs 'calls.read' and 'mailings.read' scopes.
 *   If missing, stats will show zeros with an error message.
 *   To re-authorize: POST /api/outreach-reauth (see that file for instructions).
 */

import { fetchCalls, fetchMailings } from '../../lib/outreach.js';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// ────────────────────────────────────────────────────────────────────────────
// AGENTS TEAM CONFIG — Edit this list to add/remove team members
// ────────────────────────────────────────────────────────────────────────────
export const AGENTS_TEAM = [
  { name: 'Gray',   outreachUserId: 1040 },
  { name: 'Andy',   outreachUserId: 865  },
  { name: 'Neha',   outreachUserId: 871  },
  { name: 'Manish', outreachUserId: 1043 },
  { name: 'Adam',   outreachUserId: 1044 },
];
// ────────────────────────────────────────────────────────────────────────────

const EMPTY_STATS = { calls: 0, connects: 0, emailsSent: 0, contactsContacted: 0, accountsContacted: 0, sets: 0 };

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { window: win = 'today' } = req.query;

  // Compute date range based on window
  const ptDateStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const now = new Date(ptDateStr + 'T12:00:00');

  let startDate, endDate;

  if (win === 'today') {
    startDate = endDate = ptDateStr;
  } else if (win === 'week') {
    const day = now.getDay();
    const monday = new Date(now);
    monday.setDate(now.getDate() - ((day + 6) % 7));
    startDate = monday.toISOString().slice(0, 10);
    endDate = ptDateStr;
  } else if (win === 'day-14') {
    const start = new Date(now);
    start.setDate(now.getDate() - 13);
    startDate = start.toISOString().slice(0, 10);
    endDate = ptDateStr;
  } else if (win === 'week-4') {
    const start = new Date(now);
    start.setDate(now.getDate() - 27);
    startDate = start.toISOString().slice(0, 10);
    endDate = ptDateStr;
  } else if (win === 'month-4') {
    startDate = new Date(now.getFullYear(), now.getMonth() - 3, 1).toISOString().slice(0, 10);
    endDate = ptDateStr;
  } else {
    return res.status(400).json({ error: 'Invalid window param' });
  }

  const userIds = AGENTS_TEAM.map(m => m.outreachUserId);

  try {
    const [calls, mailings] = await Promise.all([
      fetchCalls(userIds, startDate, endDate),
      fetchMailings(userIds, startDate, endDate),
    ]);

    const stats = computeStats(calls, mailings);

    return res.status(200).json({
      isLive: true,
      source: 'outreach',
      window: win,
      stats,
      teamMembers: AGENTS_TEAM,
    });
  } catch (err) {
    const isScopeError = err.message.includes('unauthorizedOauthScope') || err.message.includes('calls.read') || err.message.includes('mailings.read');
    console.error('[outreach-activity-stats]', err.message);

    return res.status(200).json({
      isLive: false,
      source: 'outreach',
      window: win,
      stats: { ...EMPTY_STATS },
      teamMembers: AGENTS_TEAM,
      error: isScopeError
        ? 'Outreach OAuth needs calls.read + mailings.read scopes — re-authorize the app to enable live data.'
        : err.message,
    });
  }
}

// ── Compute stats from raw Outreach records ───────────────────────────────────

function computeStats(calls, mailings) {
  // Calls
  const totalCalls = calls.length;

  // Connects: calls where answered=true
  const connects = calls.filter(c => c.attributes?.answered === true).length;

  // Emails sent (delivered mailings)
  const emailsSent = mailings.length;

  // Unique contacts contacted (from calls + mailings)
  const contactIds = new Set();
  for (const c of calls) {
    const pid = c.relationships?.prospect?.data?.id;
    if (pid) contactIds.add(`call_${pid}`);
  }
  for (const m of mailings) {
    const pid = m.relationships?.prospect?.data?.id;
    if (pid) contactIds.add(`mail_${pid}`);
  }
  const contactsContacted = contactIds.size;

  // Unique accounts contacted (deduplicate by account relationship)
  const accountIds = new Set();
  for (const c of calls) {
    const aid = c.relationships?.account?.data?.id;
    if (aid) accountIds.add(aid);
  }
  for (const m of mailings) {
    const aid = m.relationships?.account?.data?.id;
    if (aid) accountIds.add(aid);
  }
  const accountsContacted = accountIds.size;

  // Sets: meetings booked — look for calls with meetingBooked=true or specific outcomes
  const sets = calls.filter(c =>
    c.attributes?.meetingBooked === true ||
    (c.attributes?.outcome || '').toLowerCase().includes('meeting') ||
    (c.attributes?.outcome || '').toLowerCase().includes('set')
  ).length;

  return { calls: totalCalls, connects, emailsSent, contactsContacted, accountsContacted, sets };
}
