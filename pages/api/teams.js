/**
 * /api/teams — GET, POST
 * Manage teams for activity dashboard filtering.
 */
import { query } from '../../lib/db';

async function ensureTeamsTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS teams (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT DEFAULT '#3b82f6',
      sfdc_user_ids TEXT[] DEFAULT '{}',
      user_names TEXT[] DEFAULT '{}',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  // Seed the Agents Team if empty
  await query(`
    INSERT INTO teams (name, color, user_names, sfdc_user_ids)
    SELECT 'Agents Team', '#6366f1', ARRAY[]::TEXT[], ARRAY[]::TEXT[]
    WHERE NOT EXISTS (SELECT 1 FROM teams WHERE name = 'Agents Team')
  `);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    await ensureTeamsTable();

    if (req.method === 'GET') {
      const result = await query('SELECT * FROM teams ORDER BY created_at ASC');
      // Also return list of reps for autocomplete
      const repsResult = await query(`
        SELECT DISTINCT rep FROM activities
        WHERE rep IS NOT NULL AND rep != ''
        ORDER BY rep ASC
        LIMIT 200
      `);
      return res.status(200).json({
        teams: result.rows,
        reps: repsResult.rows.map(r => r.rep),
      });
    }

    if (req.method === 'POST') {
      const { name, color = '#3b82f6', user_names = [], sfdc_user_ids = [] } = req.body;
      if (!name) return res.status(400).json({ error: 'name is required' });
      const result = await query(
        `INSERT INTO teams (name, color, user_names, sfdc_user_ids)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [name, color, user_names, sfdc_user_ids]
      );
      return res.status(201).json({ team: result.rows[0] });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[teams]', err.message);
    return res.status(500).json({ error: err.message });
  }
}
