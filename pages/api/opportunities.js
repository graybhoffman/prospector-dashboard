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
      stage:          r['Stage (Raw)'] || r['Stage Bucket'] || '',
      stageBucket:    r['Stage Bucket'] || '',
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

export default function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  let opps = loadOpps();

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
