/**
 * /api/smart-search — POST
 *
 * AI natural language search over the Prospector DB and SFDC Closed-Won opps.
 * Accepts { query: string, scope: "pipeline" | "icp" | "all" | "references" }
 *
 * scope=references  → Queries SFDC directly for Closed-Won opps (real customer references).
 *                     Useful for finding credible names to drop in sales conversations.
 *
 * Parses the NL query to extract:
 *   - Geography: state names/codes, city names
 *   - EHR: eCW, eclinicalworks, athena, athenahealth, meditech, modmed, advancedmd
 *   - Size: "50+ employees", "large", "enterprise"
 *   - Stage: discovery, outreach, prospect, sql, negotiations, pilot, etc.
 *   - Owner: gray, neha, andy (fuzzy match)
 *   - Specialty: podiatry, orthopedics, cardiology, etc.
 *   - Partner: "partner", "partners" → is_partner=true
 *
 * Returns: { accounts, contacts, total, filtersApplied }
 */

import { query } from '../../lib/db';
import https from 'https';

// ── SFDC helper (for references scope) ──────────────────────────────────────
let _sfdcSession = null;
async function getSfdcSession() {
  if (_sfdcSession && _sfdcSession.expiresAt > Date.now() + 60000) return _sfdcSession;
  const soap = `<?xml version="1.0" encoding="utf-8"?>
    <env:Envelope xmlns:xsd="http://www.w3.org/2001/XMLSchema"
      xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
      xmlns:env="http://schemas.xmlsoap.org/soap/envelope/">
      <env:Body><n1:login xmlns:n1="urn:partner.soap.sforce.com">
        <n1:username>gray.hoffman@getathelas.com</n1:username>
        <n1:password>ctk0WZK*rzw@tyh!pnpzK9vAeYocFwweG6zBmKDvO2F</n1:password>
      </n1:login></env:Body></env:Envelope>`;
  const r = await fetch('https://athelas.my.salesforce.com/services/Soap/u/59.0', {
    method: 'POST', headers: { 'Content-Type': 'text/xml', 'SOAPAction': 'login' }, body: soap,
  });
  const text = await r.text();
  const sid = text.match(/<sessionId>(.*?)<\/sessionId>/)?.[1];
  const srv = text.match(/<serverUrl>(.*?)<\/serverUrl>/)?.[1];
  if (!sid || !srv) throw new Error('SFDC login failed');
  const base = srv.split('/services/')[0];
  _sfdcSession = { sid, base, expiresAt: Date.now() + 90 * 60 * 1000 };
  return _sfdcSession;
}

async function searchSfdcReferences(filters, limit) {
  const safeLimit = Math.min(limit || 50, 100);
  const { sid, base } = await getSfdcSession();
  const conditions = ["StageName = 'Closed Won'", "Amount > 0", "Account.Name NOT LIKE '%TERMINATED%'"];
  if (filters.state) {
    const stateName = STATE_NAMES[filters.state] || '';
    const stateFilter = stateName
      ? "(Account.BillingState = '" + filters.state + "' OR Account.BillingState = '" + stateName.replace(/'/g, "\'") + "')"
      : "Account.BillingState = '" + filters.state + "'";
    conditions.push(stateFilter);
  }
  if (filters.city) {
    conditions.push("Account.BillingCity LIKE '%" + filters.city.replace(/'/g, "\'") + "%'");
  }
  const soql = "SELECT Id, Name, Amount, CloseDate, Account.Id, Account.Name, Account.BillingCity, Account.BillingState, Account.EHR_System__c FROM Opportunity WHERE " + conditions.join(' AND ') + " ORDER BY Amount DESC, CloseDate DESC LIMIT " + safeLimit;
  const url = base + '/services/data/v59.0/query?q=' + encodeURIComponent(soql);
  const resp = await fetch(url, { headers: { Authorization: 'Bearer ' + sid } });
  const data = await resp.json();
  if (!resp.ok) throw new Error((data && data[0] && data[0].message) || 'SFDC query failed');
  return (data.records || []).map(function(r) {
    return {
      id: r.Id,
      name: r.Name,
      accountId: r.Account && r.Account.Id,
      accountName: r.Account && r.Account.Name,
      city: r.Account && r.Account.BillingCity,
      state: r.Account && r.Account.BillingState,
      ehr: r.Account && r.Account.EHR_System__c,
      amount: r.Amount,
      closeDate: r.CloseDate,
      sfdcLink: 'https://athelas.lightning.force.com/lightning/r/Opportunity/' + r.Id + '/view',
      accountSfdcLink: (r.Account && r.Account.Id) ? 'https://athelas.lightning.force.com/lightning/r/Account/' + r.Account.Id + '/view' : null,
    };
  });
}

// State name lookup for SFDC geo filtering
const STATE_NAMES = {
  AL:'Alabama',AK:'Alaska',AZ:'Arizona',AR:'Arkansas',CA:'California',CO:'Colorado',CT:'Connecticut',
  DE:'Delaware',FL:'Florida',GA:'Georgia',HI:'Hawaii',ID:'Idaho',IL:'Illinois',IN:'Indiana',IA:'Iowa',
  KS:'Kansas',KY:'Kentucky',LA:'Louisiana',ME:'Maine',MD:'Maryland',MA:'Massachusetts',MI:'Michigan',
  MN:'Minnesota',MS:'Mississippi',MO:'Missouri',MT:'Montana',NE:'Nebraska',NV:'Nevada',NH:'New Hampshire',
  NJ:'New Jersey',NM:'New Mexico',NY:'New York',NC:'North Carolina',ND:'North Dakota',OH:'Ohio',
  OK:'Oklahoma',OR:'Oregon',PA:'Pennsylvania',RI:'Rhode Island',SC:'South Carolina',SD:'South Dakota',
  TN:'Tennessee',TX:'Texas',UT:'Utah',VT:'Vermont',VA:'Virginia',WA:'Washington',WV:'West Virginia',
  WI:'Wisconsin',WY:'Wyoming',DC:'District of Columbia',
};

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

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
const CODE_TO_STATE = Object.fromEntries(Object.entries(STATE_CODES).map(([k, v]) => [v, k]));

// ─── EHR normalization ────────────────────────────────────────────────────────
const EHR_MAP = [
  { pattern: /\becw\b|eclinical|eclinicalworks/i, value: 'eClinicalWorks' },
  { pattern: /\bathena(health)?\b/i, value: 'athenahealth' },
  { pattern: /\bmeditech\b/i, value: 'MEDITECH' },
  { pattern: /\bmodmed\b|modernizing medicine/i, value: 'ModMed' },
  { pattern: /\badvancedmd\b/i, value: 'AdvancedMD' },
  { pattern: /\bepic\b/i, value: 'Epic' },
  { pattern: /\bcerner\b/i, value: 'Cerner' },
  { pattern: /\ballscripts\b/i, value: 'Allscripts' },
  { pattern: /\bnextech\b/i, value: 'Nextech' },
  { pattern: /\bdoctor\s?logic\b/i, value: 'DoctorLogic' },
];

// ─── Stage normalization ──────────────────────────────────────────────────────
const STAGE_MAP = [
  { pattern: /\bprospect\b/i, value: 'Prospect' },
  { pattern: /\boutreach\b/i, value: 'Outreach' },
  { pattern: /\bdiscovery\b|\bdisco\b/i, value: 'Discovery' },
  { pattern: /\bsql\b/i, value: 'SQL' },
  { pattern: /\bnegotiation/i, value: 'Negotiations' },
  { pattern: /\bclosed.won\b/i, value: 'Closed-Won' },
  { pattern: /\bpilot\b/i, value: 'Pilot Deployment' },
  { pattern: /\bfull.deploy/i, value: 'Full Deployment' },
];

// ─── Owner normalization ──────────────────────────────────────────────────────
const OWNER_MAP = [
  { pattern: /\bgray\b/i, value: 'Gray' },
  { pattern: /\bneha\b/i, value: 'Neha' },
  { pattern: /\bandy\b/i, value: 'Andy' },
];

// ─── Size thresholds ──────────────────────────────────────────────────────────
const SIZE_MAP = [
  { pattern: /(\d+)\+\s*employees?/i, extract: (m) => parseInt(m[1], 10) },
  { pattern: /\blarge\b|\benterprise\b/i, extract: () => 200 },
  { pattern: /\bmid.?size\b|\bmedium\b/i, extract: () => 50 },
  { pattern: /\bsmall\b/i, extract: () => null }, // too vague, skip
];

// ─── Specialty keywords ───────────────────────────────────────────────────────
const SPECIALTY_KEYWORDS = [
  'podiatry', 'podiatric', 'orthopedics', 'orthopedic', 'ortho',
  'cardiology', 'cardiac', 'dermatology', 'dermatology', 'dermatologic',
  'oncology', 'gastroenterology', 'gastro', 'neurology', 'neurology',
  'urology', 'gynecology', 'obstetrics', 'ophthalmology', 'ophthalmologic',
  'rheumatology', 'nephrology', 'pulmonology', 'endocrinology', 'hematology',
  'psychiatry', 'psychology', 'behavioral health', 'mental health',
  'primary care', 'internal medicine', 'family medicine', 'urgent care',
  'pediatrics', 'geriatrics', 'physical therapy', 'radiology',
  'ear nose throat', 'ent', 'pain management', 'sports medicine',
  'plastic surgery', 'vascular', 'allergy', 'immunology',
];

// ─── City extraction ─────────────────────────────────────────────────────────
// Common city triggers: "in LA", "in Los Angeles", "near Dallas", etc.
// Also handles abbreviations like "LA" that aren't state codes
const CITY_ABBREVS = {
  'la': 'Los Angeles',
  'nyc': 'New York',
  'sf': 'San Francisco',
  'dc': 'Washington',
  'chi': 'Chicago',
  'philly': 'Philadelphia',
  'phx': 'Phoenix',
  'dal': 'Dallas',
  'hou': 'Houston',
  'atl': 'Atlanta',
  'bos': 'Boston',
  'sea': 'Seattle',
  'min': 'Minneapolis',
  'den': 'Denver',
  'det': 'Detroit',
  'mia': 'Miami',
  'lvs': 'Las Vegas',
  'nash': 'Nashville',
  'por': 'Portland',
  'slc': 'Salt Lake City',
};

/**
 * Parse a natural language query and extract structured filters.
 */
function parseQuery(raw) {
  const filters = {};
  const s = raw.toLowerCase();

  // ── EHR ──
  for (const { pattern, value } of EHR_MAP) {
    if (pattern.test(s)) { filters.ehr = value; break; }
  }

  // ── Stage ──
  for (const { pattern, value } of STAGE_MAP) {
    if (pattern.test(s)) { filters.stage = value; break; }
  }

  // ── Owner ──
  for (const { pattern, value } of OWNER_MAP) {
    if (pattern.test(s)) { filters.owner = value; break; }
  }

  // ── Min employees ──
  for (const { pattern, extract } of SIZE_MAP) {
    const m = s.match(pattern);
    if (m) {
      const v = extract(m);
      if (v) { filters.minEmployees = v; break; }
    }
  }

  // ── Partner ──
  if (/\bpartner(s|ship)?\b/i.test(s)) {
    filters.isPartner = true;
  }

  // ── Specialty ──
  for (const kw of SPECIALTY_KEYWORDS) {
    if (s.includes(kw)) { filters.specialty = kw; break; }
  }

  // ── State ──
  // Check full state names first
  let stateCode = null;
  for (const [name, code] of Object.entries(STATE_CODES)) {
    if (s.includes(name)) { stateCode = code; break; }
  }
  // Then check for 2-letter code patterns (e.g. "in TX", "in NY")
  if (!stateCode) {
    const stateMatch = raw.match(/\bin\s+([A-Z]{2})\b/);
    if (stateMatch) {
      const code = stateMatch[1].toUpperCase();
      if (CODE_TO_STATE[code]) stateCode = code;
    }
  }
  if (stateCode) filters.state = stateCode;

  // ── City ──
  // Match "in <city>" patterns, but skip if it's a state code we already captured
  const cityPrepositions = ['in', 'near', 'around', 'from'];
  for (const prep of cityPrepositions) {
    const cityMatch = raw.match(new RegExp(`\\b${prep}\\s+([A-Za-z][A-Za-z\\s]{2,20})(?=\\s*(?:with|on|,|$))`, 'i'));
    if (cityMatch) {
      const candidate = cityMatch[1].trim().toLowerCase();
      // Skip if it's a known state name
      if (!STATE_CODES[candidate] && !CODE_TO_STATE[candidate.toUpperCase()]) {
        // Check city abbreviation map
        const expanded = CITY_ABBREVS[candidate] || null;
        if (expanded) {
          filters.city = expanded;
        } else if (candidate.length >= 3 && !/^(all|the|any|some)$/.test(candidate)) {
          // Capitalize properly
          filters.city = candidate.replace(/\b\w/g, (c) => c.toUpperCase());
        }
      }
      break;
    }
  }

  // Handle "in LA" where LA is city abbrev, not state
  if (!filters.city) {
    const abbrevMatch = raw.match(/\bin\s+([A-Za-z]{2,4})\b/i);
    if (abbrevMatch) {
      const abbrev = abbrevMatch[1].toLowerCase();
      if (CITY_ABBREVS[abbrev] && !CODE_TO_STATE[abbrev.toUpperCase()]) {
        filters.city = CITY_ABBREVS[abbrev];
        // Don't treat LA as a state
        if (filters.state === 'LA' && abbrev === 'la') delete filters.state;
      }
    }
  }

  // ── Name text search ──
  // If query has keywords that aren't filter-captured, treat leftover as name search
  // Strip known filter words and see what's left
  const stripPatterns = [
    /\b(in|near|around|from)\s+[a-z\s]{2,20}/gi,
    /\b(podiatry|orthopedic|cardiology|oncology|gastro|neurology|urology|gynecology|dermatology|psychiatry|primary care|family medicine|urgent care|pediatrics|physical therapy|radiology|ent|pain management|sports medicine|vascular|allergy|immunology)\b/gi,
    /\b(ecw|eclinicalworks|athena|athenahealth|meditech|modmed|advancedmd|epic|cerner)\b/gi,
    /\b(discovery|outreach|prospect|sql|negotiations|pilot|closed[- ]won)\b/gi,
    /\b(gray|neha|andy)\b/gi,
    /\b(partner|partners)\b/gi,
    /\d+\+?\s*employees?/gi,
    /\b(large|enterprise|mid-?size|medium|small)\b/gi,
    /\b(practices?|accounts?|in|on|with|owned by|by|and|or|the|a|an|for|of)\b/gi,
    /[,]/g,
  ];
  let nameQuery = raw;
  for (const p of stripPatterns) nameQuery = nameQuery.replace(p, ' ');
  nameQuery = nameQuery.replace(/\s+/g, ' ').trim();
  if (nameQuery.length >= 3) filters.nameSearch = nameQuery;

  return filters;
}

/**
 * Build WHERE conditions and params array from parsed filters + scope.
 */
function buildWhereClause(filters, scope) {
  const params = [];
  const conditions = [];
  let pIdx = 1;
  const add = (val) => { params.push(val); return `$${pIdx++}`; };

  // ── Scope filter ──
  if (scope === 'pipeline') {
    // Accounts with a real stage (not Prospect) — we'll also union with opp-linked accounts
    conditions.push("agents_stage IS NOT NULL AND agents_stage != '' AND agents_stage != 'Prospect'");
  } else if (scope === 'icp') {
    conditions.push("db_status = 'main'");
  }
  // scope === 'all': no db_status filter

  // Always exclude archived
  if (scope !== 'all') {
    conditions.push("(db_status IS NULL OR db_status NOT IN ('excluded', 'archived'))");
  }

  // ── EHR ──
  if (filters.ehr) {
    conditions.push(`(ehr ILIKE ${add('%' + filters.ehr + '%')} OR ehr_system ILIKE ${add('%' + filters.ehr + '%')})`);
    pIdx--; // we added 2 params already; pIdx was incremented twice, adjust
    // Actually let me redo this properly
  }

  // ── Stage ──
  if (filters.stage) {
    conditions.push(`agents_stage ILIKE ${add('%' + filters.stage + '%')}`);
  }

  // ── Owner ──
  if (filters.owner) {
    conditions.push(`agents_owner ILIKE ${add('%' + filters.owner + '%')}`);
  }

  // ── Min employees ──
  if (filters.minEmployees) {
    conditions.push(`num_employees >= ${add(filters.minEmployees)}`);
  }

  // ── Partner ──
  if (filters.isPartner) {
    conditions.push('is_partner = TRUE');
  }

  // ── Specialty ──
  if (filters.specialty) {
    conditions.push(`(specialty ILIKE ${add('%' + filters.specialty + '%')} OR sfdc_specialty ILIKE ${add('%' + filters.specialty + '%')})`);
  }

  // ── State ──
  if (filters.state) {
    conditions.push(`billing_state ILIKE ${add('%' + filters.state + '%')}`);
  }

  // ── City ──
  if (filters.city) {
    conditions.push(`billing_city ILIKE ${add('%' + filters.city + '%')}`);
  }

  // ── Name text search ──
  if (filters.nameSearch) {
    conditions.push(`name ILIKE ${add('%' + filters.nameSearch + '%')}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  return { where, params };
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { query: rawQuery = '', scope = 'all', limit = 100 } = req.body || {};

  if (!rawQuery.trim()) {
    return res.status(400).json({ error: 'query is required' });
  }

  try {
    const filters = parseQuery(rawQuery);

    // ── References scope: search SFDC Closed-Won opps directly ───────────────
    if (scope === 'references') {
      const results = await searchSfdcReferences(filters, Math.min(100, parseInt(limit, 10) || 50));
      const filtersApplied = {};
      if (filters.state) filtersApplied.state = filters.state;
      if (filters.city) filtersApplied.city = filters.city;
      if (filters.ehr) filtersApplied.ehr = filters.ehr;
      if (filters.specialty) filtersApplied.specialty = filters.specialty;
      return res.status(200).json({
        references: results,
        total: results.length,
        filtersApplied,
        scope,
        query: rawQuery,
      });
    }
    const safeLimit = Math.min(200, parseInt(limit, 10) || 100);

    // Build params with proper indexing
    const params = [];
    const conditions = [];
    let pIdx = 1;
    const add = (val) => { params.push(val); return `$${pIdx++}`; };

    // ── Scope filter ──
    if (scope === 'pipeline') {
      conditions.push(`(agents_stage IS NOT NULL AND agents_stage != '' AND agents_stage != 'Prospect')`);
    } else if (scope === 'icp') {
      conditions.push(`db_status = 'main'`);
    }

    // Exclude archived/excluded for pipeline and icp
    if (scope !== 'all') {
      conditions.push(`(db_status IS NULL OR db_status NOT IN ('excluded', 'archived'))`);
    }

    // ── EHR ──
    if (filters.ehr) {
      const ehrParam1 = add('%' + filters.ehr + '%');
      const ehrParam2 = add('%' + filters.ehr + '%');
      conditions.push(`(ehr ILIKE ${ehrParam1} OR ehr_system ILIKE ${ehrParam2})`);
    }

    // ── Stage ──
    if (filters.stage) {
      conditions.push(`agents_stage ILIKE ${add('%' + filters.stage + '%')}`);
    }

    // ── Owner ──
    if (filters.owner) {
      conditions.push(`agents_owner ILIKE ${add('%' + filters.owner + '%')}`);
    }

    // ── Min employees ──
    if (filters.minEmployees != null) {
      conditions.push(`num_employees >= ${add(filters.minEmployees)}`);
    }

    // ── Partner ──
    if (filters.isPartner) {
      conditions.push(`is_partner = TRUE`);
    }

    // ── Specialty ──
    if (filters.specialty) {
      const sp1 = add('%' + filters.specialty + '%');
      const sp2 = add('%' + filters.specialty + '%');
      conditions.push(`(specialty ILIKE ${sp1} OR sfdc_specialty ILIKE ${sp2})`);
    }

    // ── State ──
    if (filters.state) {
      conditions.push(`billing_state ILIKE ${add('%' + filters.state + '%')}`);
    }

    // ── City ──
    if (filters.city) {
      conditions.push(`billing_city ILIKE ${add('%' + filters.city + '%')}`);
    }

    // ── Name text search ──
    if (filters.nameSearch && filters.nameSearch.length >= 3) {
      conditions.push(`name ILIKE ${add('%' + filters.nameSearch + '%')}`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    // ── Query accounts ──
    const accountsSql = `
      SELECT
        id, sfdc_id, name, billing_city, billing_state,
        agents_stage, agents_owner, ehr, ehr_system, specialty,
        num_employees, num_providers, annual_revenue,
        db_status, is_partner, sfdc_link,
        agents_icp, source_category
      FROM accounts
      ${where}
      ORDER BY
        CASE WHEN agents_stage IS NOT NULL AND agents_stage != '' THEN 0 ELSE 1 END,
        name ASC
      LIMIT ${add(safeLimit)}
    `;

    const accountsResult = await query(accountsSql, params);
    const accounts = accountsResult.rows;

    // ── Count (for display) ──
    const countSql = `SELECT COUNT(*) AS total FROM accounts ${where}`;
    // Remove the LIMIT param for count
    const countParams = params.slice(0, -1);
    const countResult = await query(countSql, countParams);
    const total = parseInt(countResult.rows[0]?.total || 0, 10);

    // ── Fetch contacts for pipeline scope (top 3 contacts per account) ──
    let contacts = [];
    if (scope === 'pipeline' && accounts.length > 0) {
      const accountIds = accounts.slice(0, 30).map((a) => a.id);
      const placeholders = accountIds.map((_, i) => `$${i + 1}`).join(',');
      const contactsSql = `
        SELECT id, name, title, email, phone, account_id, linkedin_url
        FROM contacts
        WHERE account_id IN (${placeholders})
        ORDER BY account_id, name
        LIMIT 200
      `;
      const contactsResult = await query(contactsSql, accountIds);
      contacts = contactsResult.rows;
    }

    // ── Build filtersApplied summary ──
    const filtersApplied = {};
    if (filters.state) filtersApplied.state = filters.state;
    if (filters.city) filtersApplied.city = filters.city;
    if (filters.ehr) filtersApplied.ehr = filters.ehr;
    if (filters.stage) filtersApplied.stage = filters.stage;
    if (filters.owner) filtersApplied.owner = filters.owner;
    if (filters.minEmployees) filtersApplied.minEmployees = `${filters.minEmployees}+`;
    if (filters.specialty) filtersApplied.specialty = filters.specialty;
    if (filters.isPartner) filtersApplied.partner = true;
    if (filters.nameSearch && filters.nameSearch.length >= 3) filtersApplied.nameSearch = filters.nameSearch;

    return res.status(200).json({
      accounts,
      contacts,
      total,
      filtersApplied,
      scope,
      query: rawQuery,
    });

  } catch (err) {
    console.error('[smart-search]', err);
    return res.status(500).json({ error: err.message });
  }
}
