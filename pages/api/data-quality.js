/**
 * /api/data-quality — GET
 * Returns data quality metrics for the dashboard banner.
 * { agents_icp_pct, target_persona_pct, outcomes_pct, icp_count, persona_count, outcomes_count }
 */
import { query } from '../../lib/db';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const [accounts, icp, contacts, persona, callActivities, outcomes] = await Promise.all([
      query('SELECT COUNT(*) FROM accounts WHERE exclude_from_reporting IS NOT TRUE'),
      query('SELECT COUNT(*) FROM accounts WHERE agents_icp = TRUE'),
      query('SELECT COUNT(*) FROM contacts'),
      query('SELECT COUNT(*) FROM contacts WHERE target_persona = TRUE'),
      query("SELECT COUNT(*) FROM activities WHERE type = 'call'"),
      query("SELECT COUNT(*) FROM activities WHERE type = 'call' AND outcome IS NOT NULL"),
    ]);

    const accountCount  = parseInt(accounts.rows[0].count, 10);
    const icpCount      = parseInt(icp.rows[0].count, 10);
    const contactCount  = parseInt(contacts.rows[0].count, 10);
    const personaCount  = parseInt(persona.rows[0].count, 10);
    const callCount     = parseInt(callActivities.rows[0].count, 10);
    const outcomeCount  = parseInt(outcomes.rows[0].count, 10);

    return res.status(200).json({
      agents_icp_pct:      Math.round(100 * icpCount      / Math.max(accountCount, 1)),
      target_persona_pct:  Math.round(100 * personaCount  / Math.max(contactCount, 1)),
      outcomes_pct:        Math.round(100 * outcomeCount  / Math.max(callCount,    1)),
      icp_count:       icpCount,
      persona_count:   personaCount,
      outcomes_count:  outcomeCount,
      total_accounts:  accountCount,
      total_contacts:  contactCount,
      total_calls:     callCount,
    });
  } catch (err) {
    console.error('[data-quality GET]', err.message);
    return res.status(500).json({ error: err.message });
  }
}
