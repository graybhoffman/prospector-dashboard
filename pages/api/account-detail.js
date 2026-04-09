/**
 * /api/account-detail — GET
 *
 * Returns full account record + top 5 contacts from Neon Postgres.
 *
 * Query params:
 *   id   account id (numeric id or sfdc_id)
 *
 * Response: { account: {...}, contacts: [{full_name, title, phone, email, target_persona}] }
 */

import { query } from '../../lib/db';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'id is required' });

  try {
    // Fetch the account
    const accountResult = await query(
      `SELECT * FROM accounts WHERE id::text = $1 OR sfdc_id = $1 LIMIT 1`,
      [String(id)]
    );
    if (!accountResult.rows.length) {
      return res.status(404).json({ error: 'Account not found' });
    }
    const account = accountResult.rows[0];

    // Fetch top 5 contacts linked to this account by sfdc_id or name
    let contacts = [];
    try {
      const FULL_NAME_EXPR = `COALESCE(full_name, TRIM(CONCAT(COALESCE(first_name,''), ' ', COALESCE(last_name,''))))`;
      const contactsResult = await query(
        `SELECT
           ${FULL_NAME_EXPR} AS full_name,
           title,
           phone,
           email,
           target_persona
         FROM contacts
         WHERE
           ($1::text IS NOT NULL AND account_sfdc_id = $1::text)
           OR ($2::text IS NOT NULL AND LOWER(account_name) = LOWER($2::text))
         ORDER BY target_persona DESC NULLS LAST, ${FULL_NAME_EXPR} ASC
         LIMIT 5`,
        [account.sfdc_id || null, account.name || null]
      );
      contacts = contactsResult.rows;
    } catch (contactErr) {
      // contacts table may not exist or have different schema — non-fatal
      console.warn('[account-detail] contacts query failed:', contactErr.message);
      contacts = [];
    }

    return res.status(200).json({ account, contacts });
  } catch (err) {
    console.error('[account-detail]', err.message);
    return res.status(500).json({ error: err.message });
  }
}
