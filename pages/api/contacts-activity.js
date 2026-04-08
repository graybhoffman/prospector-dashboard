/**
 * /api/contacts-activity — GET
 *
 * Returns contacts created counts for WoW and MoM tracking.
 * Queries the Postgres contacts table using created_at field.
 *
 * Response:
 *   {
 *     weeks: [{ label, start, end, count }],  // 4 trailing ISO weeks
 *     months: [{ label, start, end, count }], // 4 trailing months
 *   }
 */

import { query } from '../../lib/db';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function isoWeekStart(date) {
  const d = new Date(date);
  const day = d.getUTCDay();
  const diff = (day === 0 ? -6 : 1 - day);
  d.setUTCDate(d.getUTCDate() + diff);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function formatWeekLabel(start) {
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);
  return `${start.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}–${end.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}`;
}

function formatMonthLabel(date) {
  return date.toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' });
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const now = new Date();

    // Build 4 trailing ISO weeks
    const weeks = [];
    for (let i = 3; i >= 0; i--) {
      const weekDate = new Date(now);
      weekDate.setUTCDate(weekDate.getUTCDate() - i * 7);
      const start = isoWeekStart(weekDate);
      const end = new Date(start);
      end.setUTCDate(end.getUTCDate() + 7);
      weeks.push({ label: formatWeekLabel(start), start, end });
    }

    // Build 4 trailing months
    const months = [];
    for (let i = 3; i >= 0; i--) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
      const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
      const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
      months.push({ label: formatMonthLabel(start), start, end });
    }

    const allPeriods = [...weeks, ...months];

    // Batch query: count contacts created in each period
    const results = await Promise.all(
      allPeriods.map(({ start, end }) =>
        query(
          `SELECT COUNT(*) FROM contacts WHERE created_at >= $1 AND created_at < $2`,
          [start.toISOString(), end.toISOString()]
        ).then((r) => parseInt(r.rows[0].count, 10)).catch(() => null)
      )
    );

    const weeksOut = weeks.map((w, i) => ({ label: w.label, count: results[i] }));
    const monthsOut = months.map((m, i) => ({ label: m.label, count: results[4 + i] }));

    return res.status(200).json({ weeks: weeksOut, months: monthsOut });
  } catch (err) {
    console.error('[contacts-activity GET]', err.message);
    return res.status(500).json({ error: err.message });
  }
}
