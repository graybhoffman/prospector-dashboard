/**
 * /api/sfdc-contacts — GET
 *
 * Returns paginated SFDC contacts from the bundled export.
 *
 * Query params:
 *   search         text search on name, title, email, account
 *   accountId      filter by SFDC account ID
 *   targetPersona  "true" = only target persona contacts
 *   page           (default 1)
 *   pageSize       (default 50)
 *
 * Response: { contacts, total, page, pageSize }
 */

import fs from 'fs';
import path from 'path';

const DATA_PATH = path.join(process.cwd(), 'data', 'sfdc_contacts_export.json');

// Target persona titles (operations, admin, clinical leadership, IT)
const TARGET_TITLE_KEYWORDS = [
  'ceo','coo','cio','cto','chief','president','vp','vice president',
  'director','administrator','manager','operations','practice manager',
  'office manager','medical director','revenue cycle','rcm','billing',
  'scheduling','call center','patient access','front desk','registration',
  'it director','it manager','information technology','health information',
];

function isTargetPersona(title) {
  if (!title) return false;
  const t = title.toLowerCase();
  return TARGET_TITLE_KEYWORDS.some(kw => t.includes(kw));
}

let cache = null;
let cacheLoadedAt = 0;
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

function loadContacts() {
  const now = Date.now();
  if (cache && now - cacheLoadedAt < CACHE_TTL) return cache;
  try {
    const raw = fs.readFileSync(DATA_PATH, 'utf8');
    const raw_contacts = JSON.parse(raw);
    cache = raw_contacts.map(c => ({
      contactId:      c.Id,
      firstName:      c.FirstName || '',
      lastName:       c.LastName  || '',
      title:          c.Title     || '',
      email:          c.Email     || '',
      phone:          c.Phone || c.MobilePhone || '',
      accountId:      c.AccountId || '',
      accountName:    c.Account?.Name || '',
      targetPersona:  isTargetPersona(c.Title),
      enrichmentNotes: '',
    }));
    cacheLoadedAt = now;
    return cache;
  } catch (err) {
    console.error('[sfdc-contacts] Failed to load:', err.message);
    return [];
  }
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export default function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  let contacts = loadContacts();

  const { search, accountId, targetPersona } = req.query;

  if (search) {
    const q = search.toLowerCase();
    contacts = contacts.filter(c =>
      `${c.firstName} ${c.lastName}`.toLowerCase().includes(q) ||
      (c.title || '').toLowerCase().includes(q) ||
      (c.email || '').toLowerCase().includes(q) ||
      (c.accountName || '').toLowerCase().includes(q)
    );
  }
  if (accountId) {
    contacts = contacts.filter(c => c.accountId === accountId);
  }
  if (targetPersona === 'true') {
    contacts = contacts.filter(c => c.targetPersona);
  }

  const page     = Math.max(1, parseInt(req.query.page     || '1',  10));
  const pageSize = Math.min(200, parseInt(req.query.pageSize || '50', 10));
  const total    = contacts.length;
  const start    = (page - 1) * pageSize;
  const paginated = contacts.slice(start, start + pageSize);

  return res.status(200).json({ contacts: paginated, total, page, pageSize });
}
