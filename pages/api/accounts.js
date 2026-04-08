/**
 * /api/accounts — GET / PATCH
 *
 * GET: Returns paginated accounts from the pipeline cache, merged with local overrides.
 * PATCH: Writes an inline edit override to data/watchtower_account_overrides.json
 *
 * GET Query params:
 *   search     text search on account name
 *   ehr        comma-separated EHR values
 *   stage      comma-separated Stage values
 *   icp        "true" = only ICP-qualified accounts
 *   page       (default 1)
 *   pageSize   (default 50)
 *
 * Response: { accounts, total, page, pageSize }
 */

import fs from 'fs';
import path from 'path';
import { ensurePipelineCache } from '../../lib/pipelineCache';

const OVERRIDES_PATH = path.join(process.cwd(), 'data', 'watchtower_account_overrides.json');

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function loadOverrides() {
  try {
    const raw = fs.readFileSync(OVERRIDES_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function saveOverrides(overrides) {
  fs.writeFileSync(OVERRIDES_PATH, JSON.stringify(overrides, null, 2), 'utf8');
}

function isICP(fields, overrides = {}) {
  const rev = overrides.annualRevenue ?? fields['Annual Revenue ($)'] ?? 0;
  const prov = overrides.providers ?? fields['Providers #'] ?? 0;
  const emp = overrides.employees ?? fields['Employees #'] ?? 0;
  const locs = overrides.locations ?? fields['# of locations'] ?? 0;
  const ehr = fields['EHR'] || '';
  const targetEHRs = ['eCW', 'eClinicalWorks', 'Athena', 'AthenaHealth', 'ModMed', 'Modernizing Medicine', 'AdvancedMD', 'MEDITECH'];
  const hasTargetEHR = targetEHRs.some(t => ehr.toLowerCase().includes(t.toLowerCase()));
  const hasSize = rev >= 10_000_000 || prov >= 25 || emp >= 100 || locs >= 10;
  return hasSize && hasTargetEHR;
}

function mapRecord(record, overrides) {
  const f = record.fields || {};
  const accountId = record.id || f['Account ID'] || '';
  const ov = overrides[accountId] || {};

  const accountName = f['Account Name'] || '';
  // Build SFDC URL if we have account ID, otherwise use Notion URL
  const sfdcUrl = f['SFDC Account URL'] || f['SFDC URL'] || null;

  const mapped = {
    accountId,
    accountName,
    sfdcUrl,
    stage: f['Stage'] || '',
    ehr: f['EHR'] || '',
    employees: ov.employees ?? f['Employees #'] ?? null,
    providers: ov.providers ?? f['Providers #'] ?? null,
    locations: ov.locations ?? f['# of locations'] ?? null,
    annualRevenue: ov.annualRevenue ?? f['Annual Revenue ($)'] ?? null,
    monthlyCallVolume: ov.monthlyCallVolume ?? f['Est. Monthly Call Volume'] ?? null,
    specialty: ov.specialty ?? (Array.isArray(f['Specialty']) ? f['Specialty'].join(', ') : f['Specialty']) ?? '',
    sourceCategory: f['Source Category'] || '',
    agentsTeamOwner: f['Agents Team Owner'] || f['Owner'] || '',
    enrichmentNotes: ov.enrichmentNotes ?? f['Enrichment Notes'] ?? '',
    roeFlagNotes: f['Potential ROE Issue'] || '',
    notInRcmIcp: f['Not in RCM ICP'] || false,
  };

  mapped.isICP = isICP(f, ov);
  return mapped;
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── PATCH: save override ────────────────────────────────────────────────────
  if (req.method === 'PATCH') {
    const { accountId, field, value } = req.body || {};
    if (!accountId || !field) return res.status(400).json({ error: 'accountId and field required' });

    const overrides = loadOverrides();
    if (!overrides[accountId]) overrides[accountId] = {};
    overrides[accountId][field] = value;
    try {
      saveOverrides(overrides);
    } catch (err) {
      // Vercel: filesystem is read-only — return success but note it's ephemeral
      console.warn('[accounts] Could not save overrides (ephemeral fs):', err.message);
    }
    return res.status(200).json({ ok: true, accountId, field, value });
  }

  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // ── GET: return accounts ────────────────────────────────────────────────────
  const allRecords = await ensurePipelineCache();
  if (!allRecords) {
    return res.status(503).json({ error: 'Pipeline data still loading — retry in a moment.' });
  }

  const overrides = loadOverrides();

  // Map all records
  let accounts = allRecords.map((r) => mapRecord(r, overrides));

  // ── Filtering ──────────────────────────────────────────────────────────────
  const { search, ehr, stage, icp } = req.query;

  if (search) {
    const q = search.toLowerCase();
    accounts = accounts.filter((a) => a.accountName.toLowerCase().includes(q));
  }
  if (ehr) {
    const vals = ehr.split(',').map(v => v.toLowerCase());
    accounts = accounts.filter((a) => vals.some(v => (a.ehr || '').toLowerCase().includes(v)));
  }
  if (stage) {
    const vals = stage.split(',');
    accounts = accounts.filter((a) => vals.includes(a.stage));
  }
  if (icp === 'true') {
    accounts = accounts.filter((a) => a.isICP);
  }

  // ── Pagination ─────────────────────────────────────────────────────────────
  const page     = Math.max(1, parseInt(req.query.page     || '1',  10));
  const pageSize = Math.min(200, parseInt(req.query.pageSize || '50', 10));
  const total    = accounts.length;
  const start    = (page - 1) * pageSize;
  const paginated = accounts.slice(start, start + pageSize);

  return res.status(200).json({ accounts: paginated, total, page, pageSize });
}
