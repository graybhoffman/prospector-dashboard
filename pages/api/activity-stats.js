/**
 * /api/activity-stats — GET
 *
 * Returns aggregated activity statistics for different time windows.
 *
 * Query params:
 *   window  "today" | "week" | "day-14" | "week-4" | "month-4"
 *
 * Response:
 *   {
 *     isLive: boolean,   // true if activities table has data
 *     window: string,
 *     stats: {
 *       calls, connects, contactsContacted, accountsContacted, sets
 *     },
 *     daily: {           // only for window=week
 *       mon: { calls, connects, ... },
 *       tue: { ... }, ...
 *     },
 *     trend: [           // for day-14 / week-4 / month-4
 *       { label, calls, connects, contacts, accounts, sets }
 *     ]
 *   }
 */

import { query } from '../../lib/db';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

const EMPTY_STATS = { calls: 0, connects: 0, contactsContacted: 0, accountsContacted: 0, sets: 0 };

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')    return res.status(405).json({ error: 'Method not allowed' });

  const { window: win = 'today' } = req.query;

  try {
    // Check if activities table exists and has data
    let isLive = false;
    let tableExists = false;
    try {
      const checkResult = await query(
        `SELECT EXISTS (
           SELECT FROM information_schema.tables
           WHERE table_schema = 'public' AND table_name = 'activities'
         ) AS exists`
      );
      tableExists = checkResult.rows[0]?.exists === true;

      if (tableExists) {
        const countResult = await query('SELECT COUNT(*) FROM activities');
        isLive = parseInt(countResult.rows[0].count, 10) > 0;
      }
    } catch {
      // Table might not exist
    }

    if (!tableExists || !isLive) {
      // Return zeros gracefully
      const result = {
        isLive: false,
        window: win,
        stats: { ...EMPTY_STATS },
      };

      if (win === 'week') {
        result.daily = {
          mon: { ...EMPTY_STATS }, tue: { ...EMPTY_STATS },
          wed: { ...EMPTY_STATS }, thu: { ...EMPTY_STATS },
          fri: { ...EMPTY_STATS },
        };
      }

      if (['day-14', 'week-4', 'month-4'].includes(win)) {
        result.trend = buildEmptyTrend(win);
      }

      return res.status(200).json(result);
    }

    // ── Live queries ────────────────────────────────────────────────────────
    // Determine date range
    const now = new Date();

    if (win === 'today') {
      const stats = await getStats('today', null, null);
      return res.status(200).json({ isLive: true, window: win, stats });
    }

    if (win === 'week') {
      // ISO week: Monday–Sunday
      const day = now.getDay(); // 0=Sun
      const monday = new Date(now);
      monday.setDate(now.getDate() - ((day + 6) % 7));
      monday.setHours(0, 0, 0, 0);

      const dayNames = ['mon', 'tue', 'wed', 'thu', 'fri'];
      const daily = {};
      for (let i = 0; i < 5; i++) {
        const d = new Date(monday);
        d.setDate(monday.getDate() + i);
        const ds = d.toISOString().slice(0, 10);
        daily[dayNames[i]] = await getStatsForDate(ds);
      }

      // Week totals
      const stats = await getStats('range',
        monday.toISOString().slice(0, 10),
        now.toISOString().slice(0, 10)
      );

      return res.status(200).json({ isLive: true, window: win, stats, daily });
    }

    if (win === 'day-14') {
      const trend = [];
      for (let i = 13; i >= 0; i--) {
        const d = new Date(now);
        d.setDate(now.getDate() - i);
        const ds = d.toISOString().slice(0, 10);
        const s = await getStatsForDate(ds);
        trend.push({
          label: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
          ...s,
        });
      }
      return res.status(200).json({ isLive: true, window: win, stats: trend[trend.length - 1] || EMPTY_STATS, trend });
    }

    if (win === 'week-4') {
      const trend = [];
      for (let i = 3; i >= 0; i--) {
        const monday = new Date(now);
        const dayOfWeek = now.getDay();
        monday.setDate(now.getDate() - ((dayOfWeek + 6) % 7) - i * 7);
        monday.setHours(0, 0, 0, 0);
        const sunday = new Date(monday);
        sunday.setDate(monday.getDate() + 6);
        sunday.setHours(23, 59, 59, 999);
        const s = await getStats('range', monday.toISOString().slice(0, 10), sunday.toISOString().slice(0, 10));
        trend.push({
          label: `Wk ${monday.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`,
          ...s,
        });
      }
      return res.status(200).json({ isLive: true, window: win, stats: trend[trend.length - 1] || EMPTY_STATS, trend });
    }

    if (win === 'month-4') {
      const trend = [];
      for (let i = 3; i >= 0; i--) {
        const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 0);
        const s = await getStats('range', start.toISOString().slice(0, 10), end.toISOString().slice(0, 10));
        trend.push({
          label: start.toLocaleDateString('en-US', { month: 'short' }),
          ...s,
        });
      }
      return res.status(200).json({ isLive: true, window: win, stats: trend[trend.length - 1] || EMPTY_STATS, trend });
    }

    return res.status(400).json({ error: 'Invalid window param' });
  } catch (err) {
    console.error('[activity-stats]', err.message);
    return res.status(200).json({ isLive: false, window: win, stats: { ...EMPTY_STATS }, error: err.message });
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getStatsForDate(dateStr) {
  return getStats('date', dateStr, null);
}

async function getStats(mode, start, end) {
  let dateClause;
  if (mode === 'today') {
    dateClause = `DATE(activity_date AT TIME ZONE 'UTC') = CURRENT_DATE`;
  } else if (mode === 'date') {
    dateClause = `DATE(activity_date AT TIME ZONE 'UTC') = '${start}'`;
  } else {
    dateClause = `DATE(activity_date AT TIME ZONE 'UTC') BETWEEN '${start}' AND '${end}'`;
  }

  try {
    const result = await query(`
      SELECT
        COUNT(*) FILTER (WHERE type = 'call') AS calls,
        COUNT(*) FILTER (
          WHERE type = 'call'
          AND (LOWER(outcome) LIKE '%connect%' OR LOWER(outcome) LIKE '%answer%' OR LOWER(outcome) LIKE '%spoke%')
        ) AS connects,
        COUNT(DISTINCT contact_sfdc_id) FILTER (WHERE contact_sfdc_id IS NOT NULL) AS contacts_contacted,
        COUNT(DISTINCT account_sfdc_id) FILTER (WHERE account_sfdc_id IS NOT NULL) AS accounts_contacted,
        COUNT(*) FILTER (
          WHERE type = 'meeting'
          OR LOWER(subject) LIKE '%disco%'
          OR LOWER(subject) LIKE '%discovery%'
        ) AS sets
      FROM activities
      WHERE ${dateClause}
    `);

    const r = result.rows[0] || {};
    return {
      calls:              parseInt(r.calls, 10) || 0,
      connects:           parseInt(r.connects, 10) || 0,
      contactsContacted:  parseInt(r.contacts_contacted, 10) || 0,
      accountsContacted:  parseInt(r.accounts_contacted, 10) || 0,
      sets:               parseInt(r.sets, 10) || 0,
    };
  } catch {
    return { ...EMPTY_STATS };
  }
}

function buildEmptyTrend(win) {
  const now = new Date();
  if (win === 'day-14') {
    return Array.from({ length: 14 }, (_, i) => {
      const d = new Date(now);
      d.setDate(now.getDate() - (13 - i));
      return { label: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), ...EMPTY_STATS };
    });
  }
  if (win === 'week-4') {
    return Array.from({ length: 4 }, (_, i) => {
      const d = new Date(now);
      d.setDate(now.getDate() - (3 - i) * 7);
      const mon = new Date(d);
      mon.setDate(d.getDate() - ((d.getDay() + 6) % 7));
      return { label: `Wk ${mon.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`, ...EMPTY_STATS };
    });
  }
  if (win === 'month-4') {
    return Array.from({ length: 4 }, (_, i) => {
      const d = new Date(now.getFullYear(), now.getMonth() - (3 - i), 1);
      return { label: d.toLocaleDateString('en-US', { month: 'short' }), ...EMPTY_STATS };
    });
  }
  return [];
}
