/**
 * /api/accounts/[id] — GET + PATCH
 *
 * GET  — full account detail
 * PATCH — update any editable fields in DB, and write SFDC-mapped fields to Salesforce
 *
 * PATCH body (all optional):
 *   DB-only: agents_stage, agents_owner, enrichment_notes, icp_rationale,
 *            override_icp_criteria, override_icp_reason, next_step, campaign_tag,
 *            db_status, est_monthly_call_volume
 *   SFDC+DB: name, phone, billing_city, billing_state, billing_postal_code,
 *            industry, num_employees, annual_revenue, ehr_system, specialty
 *
 * Returns: { ok: true, account, sfdcUpdated: bool, sfdcError? }
 */

import { query } from '../../../lib/db';

const SF_USERNAME = 'gray.hoffman@getathelas.com';
const SF_PASSWORD = 'ctk0WZK*rzw@tyh!pnp';
const SF_TOKEN    = 'zK9vAeYocFwweG6zBmKDvO2F';
const LOGIN_URL   = 'https://login.salesforce.com/services/Soap/u/59.0';

// In-memory SFDC session cache (lives for the lifetime of this serverless instance)
let _sfdcSession = null;

async function getSfdcSession() {
  if (_sfdcSession && Date.now() < _sfdcSession.expiresAt) return _sfdcSession;
  const loginEnvelope = `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                  xmlns:urn="urn:partner.soap.sforce.com">
  <soapenv:Body>
    <urn:login>
      <urn:username>${SF_USERNAME}</urn:username>
      <urn:password>${SF_PASSWORD}${SF_TOKEN}</urn:password>
    </urn:login>
  </soapenv:Body>
</soapenv:Envelope>`;

  const resp = await fetch(LOGIN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset=utf-8', 'SOAPAction': 'login' },
    body: loginEnvelope,
  });
  const xml = await resp.text();
  if (!resp.ok || xml.includes('<faultcode>')) {
    const m = xml.match(/<faultstring>(.*?)<\/faultstring>/s);
    throw new Error('SFDC login failed: ' + (m?.[1] || xml.slice(0, 300)));
  }
  const sessionMatch  = xml.match(/<sessionId>(.*?)<\/sessionId>/s);
  const serverMatch   = xml.match(/<serverUrl>(.*?)<\/serverUrl>/s);
  if (!sessionMatch || !serverMatch) throw new Error('Could not parse SFDC session');
  const sessionId   = sessionMatch[1].trim();
  const instanceUrl = (serverMatch[1].trim().match(/^(https:\/\/[^/]+)/)?.[1]) || 'https://athelas.my.salesforce.com';
  // Cache for 90 minutes
  _sfdcSession = { sessionId, instanceUrl, expiresAt: Date.now() + 90 * 60 * 1000 };
  return _sfdcSession;
}

// All DB columns this endpoint may write
const ALL_EDITABLE = new Set([
  // DB-only
  'agents_stage', 'agents_owner', 'enrichment_notes', 'icp_rationale',
  'override_icp_criteria', 'override_icp_reason', 'next_step', 'campaign_tag',
  'db_status', 'est_monthly_call_volume',
  // SFDC+DB
  'name', 'phone', 'billing_city', 'billing_state', 'billing_postal_code',
  'industry', 'num_employees', 'annual_revenue', 'ehr_system', 'specialty',
]);

// Map DB column → SFDC field name
const SFDC_MAP = {
  name:                 'Name',
  phone:                'Phone',
  billing_city:         'BillingCity',
  billing_state:        'BillingState',
  billing_postal_code:  'BillingPostalCode',
  industry:             'Industry',
  num_employees:        'NumberOfEmployees',
  annual_revenue:       'AnnualRevenue',
  ehr_system:           'EHR_System__c',
  specialty:            'Account_Specialty__c',
};

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'id required' });

  // ── GET ───────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    try {
      const result = await query(
        `SELECT * FROM accounts WHERE id::text = $1 OR sfdc_id = $1 LIMIT 1`,
        [String(id)]
      );
      if (!result.rows.length) return res.status(404).json({ error: 'Account not found' });
      return res.status(200).json({ account: result.rows[0] });
    } catch (err) {
      console.error('[accounts/[id] GET]', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  // ── PATCH ─────────────────────────────────────────────────────────────────
  if (req.method === 'PATCH') {
    const body = req.body || {};
    try {
      // 1. Fetch current record for sfdc_id
      const current = await query(
        `SELECT id, sfdc_id FROM accounts WHERE id::text = $1 OR sfdc_id = $1 LIMIT 1`,
        [String(id)]
      );
      if (!current.rows.length) return res.status(404).json({ error: 'Account not found' });
      const accountId = current.rows[0].id;
      const sfdcId    = current.rows[0].sfdc_id;

      // 2. Build DB update — only allowed fields
      const setClauses = [];
      const dbParams   = [];
      function addSet(col, val) {
        dbParams.push(val);
        setClauses.push(`${col} = $${dbParams.length}`);
      }

      for (const [col, val] of Object.entries(body)) {
        if (!ALL_EDITABLE.has(col)) continue;
        // Coerce numeric fields
        let coerced = val;
        if (col === 'num_employees' || col === 'est_monthly_call_volume') {
          coerced = val === '' || val === null ? null : Number(val);
        }
        if (col === 'annual_revenue') {
          coerced = val === '' || val === null ? null : Number(val);
        }
        if (col === 'override_icp_criteria') {
          coerced = Boolean(val);
        }
        addSet(col, coerced);
      }

      let updatedAccount = null;
      if (setClauses.length > 0) {
        setClauses.push(`updated_at = NOW()`);
        dbParams.push(accountId);
        const upResult = await query(
          `UPDATE accounts SET ${setClauses.join(', ')} WHERE id = $${dbParams.length} RETURNING *`,
          dbParams
        );
        updatedAccount = upResult.rows[0];
      } else {
        const fetchResult = await query(`SELECT * FROM accounts WHERE id = $1`, [accountId]);
        updatedAccount = fetchResult.rows[0];
      }

      // 3. SFDC write-through (best-effort)
      let sfdcUpdated = false;
      let sfdcError   = null;
      const sfdcPayload = {};
      for (const [col, sfdcField] of Object.entries(SFDC_MAP)) {
        if (body[col] !== undefined) {
          let v = body[col];
          if (col === 'num_employees' || col === 'annual_revenue') {
            v = v === '' || v === null ? null : Number(v);
          }
          sfdcPayload[sfdcField] = v;
        }
      }

      if (sfdcId && Object.keys(sfdcPayload).length > 0) {
        try {
          const { sessionId, instanceUrl } = await getSfdcSession();
          const sfdcResp = await fetch(
            `${instanceUrl}/services/data/v59.0/sobjects/Account/${sfdcId}`,
            {
              method: 'PATCH',
              headers: {
                'Authorization': `Bearer ${sessionId}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(sfdcPayload),
            }
          );
          if (sfdcResp.status === 204) {
            sfdcUpdated = true;
          } else {
            const sfBody = await sfdcResp.json().catch(() => ({}));
            sfdcError = `SFDC ${sfdcResp.status}: ${JSON.stringify(sfBody).slice(0, 200)}`;
            console.warn('[accounts/[id] PATCH] SFDC update failed', sfdcError);
          }
        } catch (sfdcErr) {
          sfdcError = sfdcErr.message;
          console.warn('[accounts/[id] PATCH] SFDC error (non-fatal):', sfdcErr.message);
          // If session expired, clear cache so next call re-logins
          _sfdcSession = null;
        }
      }

      return res.status(200).json({ ok: true, account: updatedAccount, sfdcUpdated, ...(sfdcError ? { sfdcError } : {}) });
    } catch (err) {
      console.error('[accounts/[id] PATCH]', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
