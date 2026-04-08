/**
 * /api/teams/[id] — PATCH, DELETE
 */
import { query } from '../../../lib/db';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'id is required' });

  try {
    if (req.method === 'PATCH') {
      const { name, color, user_names, sfdc_user_ids } = req.body;
      const sets = [];
      const params = [];
      if (name !== undefined)         { params.push(name);          sets.push(`name = $${params.length}`); }
      if (color !== undefined)        { params.push(color);         sets.push(`color = $${params.length}`); }
      if (user_names !== undefined)   { params.push(user_names);    sets.push(`user_names = $${params.length}`); }
      if (sfdc_user_ids !== undefined){ params.push(sfdc_user_ids); sets.push(`sfdc_user_ids = $${params.length}`); }
      if (!sets.length) return res.status(400).json({ error: 'No fields to update' });
      params.push(id);
      const result = await query(
        `UPDATE teams SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
        params
      );
      if (!result.rows.length) return res.status(404).json({ error: 'Team not found' });
      return res.status(200).json({ team: result.rows[0] });
    }

    if (req.method === 'DELETE') {
      await query('DELETE FROM teams WHERE id = $1', [id]);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[teams/[id]]', err.message);
    return res.status(500).json({ error: err.message });
  }
}
