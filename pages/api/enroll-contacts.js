/**
 * /api/enroll-contacts — POST
 *
 * Enrolls contacts from specified account IDs into an Outreach sequence.
 *
 * Body: { accountIds: number[], sequenceId: number }
 *
 * Steps:
 * 1. Look up contacts from DB for given account IDs (contacts with email)
 * 2. For each contact: find or create Outreach prospect, then POST sequenceState
 * 3. Rate limit: 150ms between each enrollment
 *
 * Response: { enrolled: number, skipped: number, errors: string[] }
 */

import { query } from '../../lib/db';
import { getAccessToken } from '../../lib/outreach';

const OUTREACH_BASE = 'https://api.outreach.io/api/v2';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Look up an Outreach prospect by email. Returns prospect ID or null.
 */
async function findProspectByEmail(email, token) {
  try {
    const url = new URL(`${OUTREACH_BASE}/prospects`);
    url.searchParams.set('filter[emails]', email);
    url.searchParams.set('page[size]', '1');
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.data?.[0]?.id || null;
  } catch {
    return null;
  }
}

/**
 * Create an Outreach prospect. Returns prospect ID or null.
 */
async function createProspect(contact, token) {
  try {
    const nameParts = (contact.full_name || contact.name || '').trim().split(/\s+/);
    const firstName = nameParts[0] || '';
    const lastName  = nameParts.slice(1).join(' ') || '';

    const body = {
      data: {
        type: 'prospect',
        attributes: {
          emails: [{ email: contact.email, emailType: 'work', unsubscribed: false }],
          firstName,
          lastName,
          title: contact.title || null,
          company: contact.account_name || null,
        },
      },
    };

    const res = await fetch(`${OUTREACH_BASE}/prospects`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/vnd.api+json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.warn('[enroll-contacts] createProspect failed:', res.status, JSON.stringify(err).slice(0, 200));
      return null;
    }
    const data = await res.json();
    return data.data?.id || null;
  } catch (err) {
    console.warn('[enroll-contacts] createProspect error:', err.message);
    return null;
  }
}

/**
 * Enroll an Outreach prospect into a sequence. Returns true if successful.
 */
async function enrollProspect(prospectId, sequenceId, token) {
  try {
    const body = {
      data: {
        type: 'sequenceState',
        attributes: { state: 'active' },
        relationships: {
          prospect:  { data: { type: 'prospect',  id: String(prospectId)  } },
          sequence:  { data: { type: 'sequence',  id: String(sequenceId)  } },
        },
      },
    };
    const res = await fetch(`${OUTREACH_BASE}/sequenceStates`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/vnd.api+json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      // 422 often means already enrolled — treat as skip, not error
      const detail = err?.errors?.[0]?.detail || '';
      if (res.status === 422 || detail.toLowerCase().includes('already')) {
        return { result: 'skipped', reason: detail || 'Already enrolled' };
      }
      return { result: 'error', reason: `${res.status}: ${detail || JSON.stringify(err).slice(0, 200)}` };
    }
    return { result: 'enrolled' };
  } catch (err) {
    return { result: 'error', reason: err.message };
  }
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  const { accountIds, sequenceId } = body || {};
  if (!Array.isArray(accountIds) || accountIds.length === 0) {
    return res.status(400).json({ error: 'accountIds array is required' });
  }
  if (!sequenceId) {
    return res.status(400).json({ error: 'sequenceId is required' });
  }

  try {
    // 1. Look up contacts from DB for these account IDs
    const placeholders = accountIds.map((_, i) => `$${i + 1}`).join(',');
    const contactsResult = await query(
      `SELECT id, full_name, first_name, last_name, email, title, account_name, account_id
       FROM contacts
       WHERE account_id IN (${placeholders})
         AND email IS NOT NULL
         AND email != ''
       ORDER BY account_id, id`,
      accountIds
    );
    const contacts = contactsResult.rows;

    if (contacts.length === 0) {
      return res.status(200).json({
        enrolled: 0,
        skipped: 0,
        errors: [],
        message: 'No contacts with email found for the selected accounts.',
      });
    }

    const token = await getAccessToken();
    let enrolled = 0;
    let skipped  = 0;
    const errors = [];

    for (const contact of contacts) {
      try {
        // Find or create Outreach prospect
        let prospectId = await findProspectByEmail(contact.email, token);
        await sleep(100);

        if (!prospectId) {
          prospectId = await createProspect(contact, token);
          await sleep(100);
        }

        if (!prospectId) {
          errors.push(`Could not find/create prospect for ${contact.email}`);
          continue;
        }

        // Enroll prospect in sequence
        const result = await enrollProspect(prospectId, sequenceId, token);
        if (result.result === 'enrolled') {
          enrolled++;
        } else if (result.result === 'skipped') {
          skipped++;
        } else {
          errors.push(`${contact.email}: ${result.reason}`);
        }

      } catch (err) {
        errors.push(`${contact.email}: ${err.message}`);
      }

      // Rate limit: 150ms between each enrollment
      await sleep(150);
    }

    return res.status(200).json({
      enrolled,
      skipped,
      errors: errors.slice(0, 50), // cap errors list
      total: contacts.length,
    });

  } catch (err) {
    console.error('[enroll-contacts] Error:', err.message);
    return res.status(500).json({ error: err.message, enrolled: 0, skipped: 0, errors: [] });
  }
}
