/**
 * /api/accounts — GET / PATCH
 *
 * GET: Returns paginated accounts from pipeline_accounts.json (full Notion export),
 *      merged with local overrides.
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

const ACCOUNTS_PATH  = path.join(process.cwd(), 'data', 'pipeline_accounts.json');
const OVERRIDES_PATH = path.join(process.cwd(), 'data', 'watchtower_account_overrides.json');

// ICP EHR targets (normalized)
const ICP_EHRS = ['ecw', 'eclinicalworks', 'athena', 'athenahealth', 'modmed', 'modernizing medicine', 'advancedmd', 'meditech'];

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function loadOverrides() {
  try {
    return JSON.parse(fs.readFileSync(OVERRIDES_PATH, 'utf8'));
  } catch { return {}; }
}

function saveOverrides(overrides) {
  fs.writeFileSync(OVERRIDES_PATH, JSON.stringify(overrides, null, 2), 'utf8');
}

// In-memory cache for accounts JSON (warm once per cold start)
let _accountsCache = null;
let _accountsLoadedAt = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 min

function loadAccounts() {
  const now = Date.now();
  if (_accountsCache && now - _accountsLoadedAt < CACHE_TTL) return _accountsCache;
  try {
    _accountsCache = JSON.parse(fs.readFileSync(ACCOUNTS_PATH, 'utf8'));
    _accountsLoadedAt = now;
    return _accountsCache;
  } catch (err) {
    console.error('[accounts] Failed to load pipeline_accounts.json:', err.message);
    return [];
  }
}

function computeICP(a) {
  const rev   = a.annualRevenue ?? 0;
  const prov  = a.providers     ?? 0;
  const emp   = a.employees     ?? 0;
  const locs  = a.locations     ?? 0;
  const ehr   = (a.ehr || '').toLowerCase();
  const hasTargetEHR = ICP_EHRS.some(t => ehr.includes(t));
  const hasSize = rev >= 10_000_000 || prov >= 25 || emp >= 100 || locs >= 10;
  return hasSize && hasTargetEHR;
}

function applyOverrides(account, ov) {
  if (!ov) return account;
  return {
    ...account,
    employees:           ov.employees           ?? account.employees,
    providers:           ov.providers           ?? account.providers,
    locations:           ov.locations           ?? account.locations,
    annualRevenue:       ov.annualRevenue        ?? account.annualRevenue,
    estMonthlyCallVolume:ov.monthlyCallVolume    ?? account.estMonthlyCallVolume,
    specialty:           ov.specialty            ?? account.specialty,
    enrichmentNotes:     ov.enrichmentNotes      ?? account.enrichmentNotes,
  };
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
      console.warn('[accounts] Could not save overrides (ephemeral fs):', err.message);
    }
    return res.status(200).json({ ok: true, accountId, field, value });
  }

  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // ── GET: return accounts ────────────────────────────────────────────────────
  const rawAccounts = loadAccounts();
  const overrides   = loadOverrides();

  // Apply overrides + compute ICP
  let accounts = rawAccounts.map((a) => {
    const key = a.sfdcAccountId || a.notionPageId;
    const merged = applyOverrides(a, overrides[key]);
    return { ...merged, accountId: key, isICP: computeICP(merged) };
  });

  // ── Filtering ──────────────────────────────────────────────────────────────
  const { search, ehr, stage, icp } = req.query;

  if (search) {
    const q = search.toLowerCase();
    accounts = accounts.filter(a => (a.accountName || '').toLowerCase().includes(q));
  }
  if (ehr) {
    const vals = ehr.split(',').map(v => v.toLowerCase());
    accounts = accounts.filter(a => vals.some(v => (a.ehr || '').toLowerCase().includes(v)));
  }
  if (stage) {
    const vals = stage.split(',');
    accounts = accounts.filter(a => vals.includes(a.stage));
  }
  if (icp === 'true') {
    accounts = accounts.filter(a => a.isICP);
  }

  // ── Pagination ─────────────────────────────────────────────────────────────
  const page     = Math.max(1, parseInt(req.query.page     || '1',  10));
  const pageSize = Math.min(200, parseInt(req.query.pageSize || '50', 10));
  const total    = accounts.length;
  const start    = (page - 1) * pageSize;
  const paginated = accounts.slice(start, start + pageSize);

  return res.status(200).json({ accounts: paginated, total, page, pageSize });
}
