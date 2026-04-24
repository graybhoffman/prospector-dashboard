import { query } from '../../lib/db';
import assignments from '../../lib/territory-assignments.json';

export default async function handler(req, res) {
  try {
    // Totals
    const totalsResult = await query(`
      SELECT 
        a.territory,
        COUNT(DISTINCT a.id) AS total_accounts,
        COUNT(DISTINCT c.id) AS total_contacts
      FROM accounts a
      LEFT JOIN contacts c ON c.account_id = a.id
      WHERE a.territory IS NOT NULL
      GROUP BY a.territory
      ORDER BY a.territory
    `);

    const AGENTS_TEAM_REPS = ['Gray Hoffman', 'Andrew Sapien', 'Neha Bhongir', 'Manish Allamsetti', 'Adam Kelleher', 'Arya Davey', 'Zareen Tabibzadegan'];
    const repPlaceholders = AGENTS_TEAM_REPS.map((_, i) => `$${i + 1}`).join(', ');

    // Activity stats per territory + time window
    const statsResult = await query(`
      SELECT
        acc.territory,
        -- TODAY
        COUNT(DISTINCT CASE WHEN act.activity_date::date = (NOW() AT TIME ZONE 'America/Los_Angeles')::date AND act.type = 'call' THEN act.id END) AS calls_today,
        COUNT(DISTINCT CASE WHEN act.activity_date::date = (NOW() AT TIME ZONE 'America/Los_Angeles')::date AND act.type = 'email' THEN act.id END) AS emails_today,
        COUNT(DISTINCT CASE WHEN act.activity_date::date = (NOW() AT TIME ZONE 'America/Los_Angeles')::date AND act.contact_sfdc_id IS NOT NULL THEN act.contact_sfdc_id END) AS contacts_today,
        COUNT(DISTINCT CASE WHEN act.activity_date::date = (NOW() AT TIME ZONE 'America/Los_Angeles')::date AND act.account_sfdc_id IS NOT NULL THEN act.account_sfdc_id END) AS accounts_today,
        -- 1D (last 24h rolling)
        COUNT(DISTINCT CASE WHEN act.activity_date >= NOW() - INTERVAL '1 day' AND act.type = 'call' THEN act.id END) AS calls_1d,
        COUNT(DISTINCT CASE WHEN act.activity_date >= NOW() - INTERVAL '1 day' AND act.type = 'email' THEN act.id END) AS emails_1d,
        COUNT(DISTINCT CASE WHEN act.activity_date >= NOW() - INTERVAL '1 day' AND act.contact_sfdc_id IS NOT NULL THEN act.contact_sfdc_id END) AS contacts_1d,
        COUNT(DISTINCT CASE WHEN act.activity_date >= NOW() - INTERVAL '1 day' AND act.account_sfdc_id IS NOT NULL THEN act.account_sfdc_id END) AS accounts_1d,
        -- 7D
        COUNT(DISTINCT CASE WHEN act.activity_date >= NOW() - INTERVAL '7 days' AND act.type = 'call' THEN act.id END) AS calls_7d,
        COUNT(DISTINCT CASE WHEN act.activity_date >= NOW() - INTERVAL '7 days' AND act.type = 'email' THEN act.id END) AS emails_7d,
        COUNT(DISTINCT CASE WHEN act.activity_date >= NOW() - INTERVAL '7 days' AND act.contact_sfdc_id IS NOT NULL THEN act.contact_sfdc_id END) AS contacts_7d,
        COUNT(DISTINCT CASE WHEN act.activity_date >= NOW() - INTERVAL '7 days' AND act.account_sfdc_id IS NOT NULL THEN act.account_sfdc_id END) AS accounts_7d,
        -- 30D
        COUNT(DISTINCT CASE WHEN act.activity_date >= NOW() - INTERVAL '30 days' AND act.type = 'call' THEN act.id END) AS calls_30d,
        COUNT(DISTINCT CASE WHEN act.activity_date >= NOW() - INTERVAL '30 days' AND act.type = 'email' THEN act.id END) AS emails_30d,
        COUNT(DISTINCT CASE WHEN act.activity_date >= NOW() - INTERVAL '30 days' AND act.contact_sfdc_id IS NOT NULL THEN act.contact_sfdc_id END) AS contacts_30d,
        COUNT(DISTINCT CASE WHEN act.activity_date >= NOW() - INTERVAL '30 days' AND act.account_sfdc_id IS NOT NULL THEN act.account_sfdc_id END) AS accounts_30d
      FROM accounts acc
      JOIN activities act ON act.account_sfdc_id = acc.sfdc_id
      WHERE acc.territory IS NOT NULL
        AND act.rep = ANY($1)
        AND act.source_system = 'outreach'
      GROUP BY acc.territory
    `, [AGENTS_TEAM_REPS]);

    // Top owner per territory (last 30d, by accounts contacted)
    const ownerResult = await query(`
      SELECT DISTINCT ON (acc.territory)
        acc.territory,
        act.rep,
        COUNT(DISTINCT act.account_sfdc_id) AS accts_touched
      FROM accounts acc
      JOIN activities act ON act.account_sfdc_id = acc.sfdc_id
      WHERE acc.territory IS NOT NULL
        AND act.activity_date >= NOW() - INTERVAL '30 days'
        AND act.rep = ANY($1)
        AND act.source_system = 'outreach'
      GROUP BY acc.territory, act.rep
      ORDER BY acc.territory, accts_touched DESC
    `, [AGENTS_TEAM_REPS]);

    const totals = totalsResult.rows;
    const statsMap = {};
    for (const row of statsResult.rows) statsMap[row.territory] = row;
    const ownerMap = {};
    for (const row of ownerResult.rows) ownerMap[row.territory] = row.rep;

    const allTerritories = totals.map(t => t.territory);
    const ordered = [
      ...allTerritories.filter(t => t.toLowerCase() === 't11a'),
      ...allTerritories.filter(t => t.toLowerCase() === 't12a'),
      ...allTerritories.filter(t => !['t11a', 't12a'].includes(t.toLowerCase())).sort(),
    ];

    const territories = ordered.map(name => {
      const t = totals.find(r => r.territory === name) || {};
      const s = statsMap[name] || {};
      return {
        name,
        total_accounts: parseInt(t.total_accounts || 0),
        total_contacts: parseInt(t.total_contacts || 0),
        assigned_rep: assignments[name] || assignments[name.toLowerCase()] || null,
        top_owner: ownerMap[name] || null,
        stats: {
          'today': {
            calls: parseInt(s.calls_today || 0),
            emails: parseInt(s.emails_today || 0),
            contacts_contacted: parseInt(s.contacts_today || 0),
            accounts_contacted: parseInt(s.accounts_today || 0),
          },
          '1d': {
            calls: parseInt(s.calls_1d || 0),
            emails: parseInt(s.emails_1d || 0),
            contacts_contacted: parseInt(s.contacts_1d || 0),
            accounts_contacted: parseInt(s.accounts_1d || 0),
          },
          '7d': {
            calls: parseInt(s.calls_7d || 0),
            emails: parseInt(s.emails_7d || 0),
            contacts_contacted: parseInt(s.contacts_7d || 0),
            accounts_contacted: parseInt(s.accounts_7d || 0),
          },
          '30d': {
            calls: parseInt(s.calls_30d || 0),
            emails: parseInt(s.emails_30d || 0),
            contacts_contacted: parseInt(s.contacts_30d || 0),
            accounts_contacted: parseInt(s.accounts_30d || 0),
          },
        },
      };
    });

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
    res.json({ territories });
  } catch (err) {
    console.error('territory-stats error:', err);
    res.status(500).json({ error: err.message });
  }
}
