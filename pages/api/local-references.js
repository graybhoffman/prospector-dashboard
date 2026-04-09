/**
 * /api/local-references — GET
 *
 * Finds nearby Closed Won SFDC accounts for call-prep name-dropping.
 *
 * Query params:
 *   state   (required) — 2-letter state code OR full state name (e.g. "NY", "New York")
 *   city    (optional) — city name for tighter filtering
 *
 * Response: [{ accountName, city, state, amount, closeDate, sfdc_link, contacts: [{name, title, phone, email}] }]
 *
 * Data source: SFDC REST API (live query, ~1–2s)
 * Caches results in-memory for 10 minutes per state.
 */

// ─── State name ↔ code lookup ────────────────────────────────────────────────
const STATE_CODES = {
  'alabama': 'AL', 'alaska': 'AK', 'arizona': 'AZ', 'arkansas': 'AR',
  'california': 'CA', 'colorado': 'CO', 'connecticut': 'CT', 'delaware': 'DE',
  'florida': 'FL', 'georgia': 'GA', 'hawaii': 'HI', 'idaho': 'ID',
  'illinois': 'IL', 'indiana': 'IN', 'iowa': 'IA', 'kansas': 'KS',
  'kentucky': 'KY', 'louisiana': 'LA', 'maine': 'ME', 'maryland': 'MD',
  'massachusetts': 'MA', 'michigan': 'MI', 'minnesota': 'MN', 'mississippi': 'MS',
  'missouri': 'MO', 'montana': 'MT', 'nebraska': 'NE', 'nevada': 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', 'ohio': 'OH', 'oklahoma': 'OK',
  'oregon': 'OR', 'pennsylvania': 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', 'tennessee': 'TN', 'texas': 'TX', 'utah': 'UT',
  'vermont': 'VT', 'virginia': 'VA', 'washington': 'WA', 'west virginia': 'WV',
  'wisconsin': 'WI', 'wyoming': 'WY', 'district of columbia': 'DC',
};

// Reverse: code → full name
const CODE_TO_NAME = Object.fromEntries(Object.entries(STATE_CODES).map(([k, v]) => [v, k]));

/** Resolve a fuzzy state string (e.g. "upstate NY", "ohio", "NY") → 2-letter code or null */
function resolveState(raw) {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  // Direct 2-letter code
  const upper = raw.trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(upper) && CODE_TO_NAME[upper]) return upper;
  // Full name match
  if (STATE_CODES[s]) return STATE_CODES[s];
  // Partial match (e.g. "upstate ny" → "ny")
  for (const [name, code] of Object.entries(STATE_CODES)) {
    if (s.includes(name)) return code;
  }
  // Check if a 2-letter code appears anywhere in the string
  const codeMatch = raw.match(/\b([A-Za-z]{2})\b/g);
  if (codeMatch) {
    for (const m of codeMatch) {
      const c = m.toUpperCase();
      if (CODE_TO_NAME[c]) return c;
    }
  }
  return null;
}

const SFDC_USERNAME = process.env.SFDC_USERNAME || 'gray.hoffman@getathelas.com';
const SFDC_PASSWORD = process.env.SFDC_PASSWORD || 'ctk0WZK*rzw@tyh!pnp';
const SFDC_TOKEN    = process.env.SFDC_TOKEN    || 'zK9vAeYocFwweG6zBmKDvO2F';
const SFDC_INSTANCE = process.env.SFDC_INSTANCE_URL || 'https://athelas.my.salesforce.com';
const SFDC_API_VER  = 'v59.0';

// In-memory SFDC session cache (avoids re-logging in on every request)
let _sfdcSession = null; // { accessToken, instanceUrl, expiresAt }

async function getSfdcSession() {
  if (_sfdcSession && Date.now() < _sfdcSession.expiresAt) return _sfdcSession;

  const loginUrl = `${SFDC_INSTANCE}/services/Soap/u/${SFDC_API_VER}`;
  const soapBody = `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                  xmlns:urn="urn:partner.soap.sforce.com">
  <soapenv:Body>
    <urn:login>
      <urn:username>${SFDC_USERNAME}</urn:username>
      <urn:password>${SFDC_PASSWORD}${SFDC_TOKEN}</urn:password>
    </urn:login>
  </soapenv:Body>
</soapenv:Envelope>`;

  const resp = await fetch(loginUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml', 'SOAPAction': 'login' },
    body: soapBody,
  });

  const xml = await resp.text();
  const sessionId = xml.match(/<sessionId>(.*?)<\/sessionId>/)?.[1];
  const serverUrl = xml.match(/<serverUrl>(.*?)<\/serverUrl>/)?.[1];

  if (!sessionId) {
    const fault = xml.match(/<faultstring>(.*?)<\/faultstring>/)?.[1] || 'Unknown SFDC error';
    throw new Error(`SFDC login failed: ${fault}`);
  }

  // Derive instance URL from serverUrl
  const instanceUrl = serverUrl
    ? new URL(serverUrl).origin
    : SFDC_INSTANCE;

  _sfdcSession = {
    accessToken: sessionId,
    instanceUrl,
    expiresAt: Date.now() + 110 * 60 * 1000, // 110 minutes (SFDC sessions last 2h by default)
  };
  return _sfdcSession;
}

async function sfdcQuery(soql) {
  const session = await getSfdcSession();
  const url = `${session.instanceUrl}/services/data/${SFDC_API_VER}/query?q=${encodeURIComponent(soql)}`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${session.accessToken}` },
  });
  if (!resp.ok) {
    // Try refreshing session once
    _sfdcSession = null;
    const session2 = await getSfdcSession();
    const resp2 = await fetch(url.replace(session.instanceUrl, session2.instanceUrl), {
      headers: { Authorization: `Bearer ${session2.accessToken}` },
    });
    if (!resp2.ok) {
      const errText = await resp2.text();
      throw new Error(`SFDC query failed (${resp2.status}): ${errText.slice(0, 200)}`);
    }
    return (await resp2.json()).records || [];
  }
  const data = await resp.json();
  return data.records || [];
}

// Per-state result cache (10 min TTL)
const resultCache = new Map(); // key: `${stateCode}|${city}` → { data, expiresAt }

const SENIORITY_KEYWORDS = ['ceo','cmo','cio','cfo','coo','cto','chief','president','vp','vice president','svp','evp','director'];

function seniorityScore(title) {
  if (!title) return 0;
  const t = title.toLowerCase();
  for (let i = 0; i < SENIORITY_KEYWORDS.length; i++) {
    if (t.includes(SENIORITY_KEYWORDS[i])) return SENIORITY_KEYWORDS.length - i;
  }
  return 0;
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { state: rawState, city: rawCity } = req.query;
  if (!rawState) return res.status(400).json({ error: 'state is required' });

  const stateCode = resolveState(rawState);
  if (!stateCode) return res.status(400).json({ error: `Could not resolve state from: "${rawState}"` });

  const city = rawCity?.trim() || '';
  const cacheKey = `${stateCode}|${city.toLowerCase()}`;

  // Serve from cache if fresh
  const cached = resultCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return res.status(200).json({ results: cached.data, stateCode, fromCache: true });
  }

  try {
    // ── 1. Fetch Closed Won opportunities in this state ─────────────────────
    // Use LIKE to match state code (BillingState may be stored as "NY" or "New York")
    const stateFullName = CODE_TO_NAME[stateCode] || '';
    const stateFilter = stateFullName
      ? `(Account.BillingState = '${stateCode}' OR Account.BillingState = '${stateFullName.replace(/'/g, "\\'")}')`
      : `Account.BillingState = '${stateCode}'`;

    const cityFilter = city ? ` AND (Account.BillingCity LIKE '%${city.replace(/'/g, "\\'")}%')` : '';

    const oppSoql = `
      SELECT Id, Name, Amount, CloseDate,
             Account.Id, Account.Name, Account.BillingCity, Account.BillingState
      FROM Opportunity
      WHERE StageName = 'Closed Won'
        AND ${stateFilter}${cityFilter}
        AND Amount > 0
        AND NOT Account.Name LIKE '%TERMINATED%'
      ORDER BY Amount DESC, CloseDate DESC
      LIMIT 20
    `.replace(/\s+/g, ' ').trim();

    const opps = await sfdcQuery(oppSoql);

    if (!opps.length) {
      resultCache.set(cacheKey, { data: [], expiresAt: Date.now() + 10 * 60 * 1000 });
      return res.status(200).json({ results: [], stateCode });
    }

    // De-dupe by account (keep best opp per account = already sorted by Amount DESC)
    const seenAccounts = new Set();
    const topOpps = [];
    for (const opp of opps) {
      const accId = opp.Account?.Id;
      if (!accId || seenAccounts.has(accId)) continue;
      seenAccounts.add(accId);
      topOpps.push(opp);
      if (topOpps.length >= 3) break;
    }

    // ── 2. Fetch top 2 senior contacts per account ──────────────────────────
    const accountIds = topOpps.map((o) => o.Account.Id).filter(Boolean);
    const idList = accountIds.map((id) => `'${id}'`).join(',');

    const seniorityWhere = SENIORITY_KEYWORDS
      .map((kw) => `Title LIKE '%${kw}%'`)
      .join(' OR ');

    const contactSoql = `
      SELECT Id, Name, Title, Phone, Email, AccountId
      FROM Contact
      WHERE AccountId IN (${idList})
        AND (${seniorityWhere})
      ORDER BY AccountId, Name ASC
      LIMIT 50
    `.replace(/\s+/g, ' ').trim();

    let contactsByAccount = {};
    if (accountIds.length) {
      const contacts = await sfdcQuery(contactSoql);
      for (const c of contacts) {
        if (!contactsByAccount[c.AccountId]) contactsByAccount[c.AccountId] = [];
        contactsByAccount[c.AccountId].push(c);
      }
      // Sort each account's contacts by seniority and keep top 2
      for (const [accId, list] of Object.entries(contactsByAccount)) {
        list.sort((a, b) => seniorityScore(b.Title) - seniorityScore(a.Title));
        contactsByAccount[accId] = list.slice(0, 2);
      }
    }

    // ── 3. Build response ───────────────────────────────────────────────────
    const results = topOpps.map((opp) => {
      const accId = opp.Account?.Id;
      return {
        accountName: opp.Account?.Name || opp.Name,
        city:        opp.Account?.BillingCity || '',
        state:       opp.Account?.BillingState || stateCode,
        amount:      opp.Amount || 0,
        closeDate:   opp.CloseDate || null,
        sfdc_link:   `https://athelas.lightning.force.com/lightning/r/Account/${accId}/view`,
        contacts:    (contactsByAccount[accId] || []).map((c) => ({
          name:  c.Name,
          title: c.Title || '',
          phone: c.Phone || '',
          email: c.Email || '',
        })),
      };
    });

    resultCache.set(cacheKey, { data: results, expiresAt: Date.now() + 10 * 60 * 1000 });
    return res.status(200).json({ results, stateCode });

  } catch (err) {
    console.error('[local-references]', err.message);
    return res.status(500).json({ error: err.message });
  }
}
