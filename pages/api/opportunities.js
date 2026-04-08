/**
 * /api/opportunities — GET
 *
 * Returns paginated opportunities from data/pipeline_opps.json.
 *
 * Query params:
 *   search    text search on opp name, account name
 *   stage     comma-separated Stage Bucket values
 *   ehr       comma-separated EHR values
 *   owner     comma-separated Owner values
 *   page      (default 1)
 *   pageSize  (default 50)
 *
 * Response: { opportunities, total, page, pageSize }
 */

import fs from 'fs';
import path from 'path';

const JSON_PATH = path.join(process.cwd(), 'data', 'pipeline_opps.json');
const ACCOUNTS_PATH = path.join(process.cwd(), 'data', 'pipeline_accounts.json');

const STAGE_MAP = {
  // Prospect
  'prospect': 'Prospect',
  // Outreach
  'outreach': 'Outreach',
  'iqm set': 'Outreach',
  'fha': 'Outreach',
  '1. qualifying': 'Outreach',
  // Discovery
  'discovery': 'Discovery',
  'active evaluation': 'Discovery',
  '2. needs analysis': 'Discovery',
  // SQL
  'sql': 'SQL',
  '3. scoping': 'SQL',
  // Negotiations
  'negotiations': 'Negotiations',
  '4. proposal/price quote': 'Negotiations',
  '5. negotiate/contract sent': 'Negotiations',
  '6. contract red-line received': 'Negotiations',
  '7. final contract execution': 'Negotiations',
  'contract negotiation': 'Negotiations',
  // Pilot Deployment
  'pilot': 'Pilot Deployment',
  'pilot deployment': 'Pilot Deployment',
  // Full Deployment
  'full deployment': 'Full Deployment',
  // Closed-Won
  'closed won': 'Closed-Won',
  '8. close won': 'Closed-Won',
  'closed won - live': 'Closed-Won',
  'contract signed/closed won': 'Closed-Won',
  // Closed-Lost
  'closed lost': 'Closed-Lost',
  '9. lost/nurture': 'Closed-Lost',
};

function normalizeStage(raw) {
  if (!raw) return null;
  return STAGE_MAP[raw.toLowerCase().trim()] || raw;
}

let cache = null;
let cacheLoadedAt = 0;
const CACHE_TTL = 60 * 60 * 1000;

function loadOpps() {
  const now = Date.now();
  if (cache && now - cacheLoadedAt < CACHE_TTL) return cache;
  try {
    const rows = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
    cache = rows.map(r => ({
      opportunityId:  r['Opportunity ID'] || '',
      oppName:        r['Opportunity Name'] || '',
      sfdcUrl:        r['SFDC URL'] || '',
      accountName:    r['Account Name'] || '',
      accountId:      r['Account ID'] || '',
      stage:          normalizeStage(r['Stage (Raw)'] || r['Stage Bucket'] || ''),
      stageBucket:    normalizeStage(r['Stage Bucket'] || r['Stage (Raw)'] || ''),
      ehr:            r['EHR (Normalized)'] || r['EHR (Raw)'] || '',
      acv:            parseFloat(r['ACV / Amount ($)']) || null,
      closeDate:      r['Close Date'] || '',
      createdDate:    r['Created Date'] || '',
      owner:          r['Owner'] || '',
      employees:      r['Employees'] || '',
      employeeBucket: r['Employee Bucket'] || '',
    }));
    cacheLoadedAt = now;
    return cache;
  } catch (err) {
    console.error('[opportunities] Failed to load pipeline_opps.json:', err.message);
    return [];
  }
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// Build a set of excluded account identifiers (names + IDs) from pipeline_accounts.json
let _excludedAccountCache = null;
function getExcludedAccounts() {
  if (_excludedAccountCache) return _excludedAccountCache;
  try {
    const raw = JSON.parse(fs.readFileSync(ACCOUNTS_PATH, 'utf8'));
    const excluded = new Set();
    for (const a of raw) {
      if (a.excludeFromReporting) {
        if (a.accountName) excluded.add(a.accountName.toLowerCase());
        if (a.sfdcAccountId) excluded.add(a.sfdcAccountId);
        if (a.notionPageId)  excluded.add(a.notionPageId);
      }
    }
    _excludedAccountCache = excluded;
    return excluded;
  } catch {
    return new Set();
  }
}

export default function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  let opps = loadOpps();

  // ── Filter excluded accounts ───────────────────────────────────────────────
  const includeExcluded = req.query.includeExcluded === 'true';
  if (!includeExcluded) {
    const excludedAccounts = getExcludedAccounts();
    opps = opps.filter(o => {
      const name = (o.accountName || '').toLowerCase();
      const id   = o.accountId || '';
      return !excludedAccounts.has(name) && !excludedAccounts.has(id);
    });
  }

  const { search, stage, ehr, owner } = req.query;

  if (search) {
    const q = search.toLowerCase();
    opps = opps.filter(o =>
      (o.oppName || '').toLowerCase().includes(q) ||
      (o.accountName || '').toLowerCase().includes(q)
    );
  }
  if (stage) {
    const vals = stage.split(',');
    opps = opps.filter(o => vals.some(v => o.stageBucket === v || o.stage === v));
  }
  if (ehr) {
    const vals = ehr.split(',').map(v => v.toLowerCase());
    opps = opps.filter(o => vals.some(v => (o.ehr || '').toLowerCase().includes(v)));
  }
  if (owner) {
    const vals = owner.split(',').map(v => v.toLowerCase());
    opps = opps.filter(o => vals.some(v => (o.owner || '').toLowerCase().includes(v)));
  }

  const page     = Math.max(1, parseInt(req.query.page     || '1',  10));
  const pageSize = Math.min(200, parseInt(req.query.pageSize || '50', 10));
  const total    = opps.length;
  const start    = (page - 1) * pageSize;
  const paginated = opps.slice(start, start + pageSize);

  return res.status(200).json({ opportunities: paginated, total, page, pageSize });
}
