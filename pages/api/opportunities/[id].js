/**
 * /api/opportunities/[id] — GET + PATCH
 *
 * GET  — full opportunity detail (joins account for agents_stage, is_partner, etc.)
 * PATCH — update editable fields in DB AND Salesforce simultaneously
 *
 * PATCH body: { name?, stage_normalized?, amount?, close_date?, owner?, owner_sfdc_id? }
 * SFDC updates: StageName, Amount, CloseDate, Name, OwnerId
 */

import { query } from '../../../lib/db';

const SF_USERNAME = 'gray.hoffman@getathelas.com';
const SF_PASSWORD = 'ctk0WZK*rzw@tyh!pnp';
const SF_TOKEN    = 'zK9vAeYocFwweG6zBmKDvO2F';
const LOGIN_URL   = 'https://login.salesforce.com/services/Soap/u/59.0';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function sfdcLogin() {
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
    const faultMatch = xml.match(/<faultstring>(.*?)<\/faultstring>/s);
    throw new Error('SFDC login failed: ' + (faultMatch?.[1] || xml.slice(0, 300)));
  }
  const sessionMatch = xml.match(/<sessionId>(.*?)<\/sessionId>/s);
  const serverMatch  = xml.match(/<serverUrl>(.*?)<\/serverUrl>/s);
  if (!sessionMatch || !serverMatch) throw new Error('Could not parse SFDC session');

  const sessionId  = sessionMatch[1].trim();
  const serverUrl  = serverMatch[1].trim();
  // Extract instance URL from serverUrl: https://athelas.my.salesforce.com/services/...
  const instanceUrl = serverUrl.match(/^(https:\/\/[^/]+)/)?.[1] || 'https://athelas.my.salesforce.com';
  return { sessionId, instanceUrl };
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'id required' });

  // ── GET ──────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    try {
      const result = await query(
        `SELECT o.*,
                a.agents_stage,
                a.is_partner,
                a.override_icp_reason,
                a.specialty       AS account_specialty,
                a.ehr_system      AS account_ehr
         FROM opportunities o
         LEFT JOIN accounts a ON (o.account_sfdc_id = a.sfdc_id OR o.account_id = a.id)
         WHERE o.id::text = $1 OR o.sfdc_id = $1
         LIMIT 1`,
        [String(id)]
      );
      if (!result.rows.length) return res.status(404).json({ error: 'Opportunity not found' });
      return res.status(200).json({ opportunity: result.rows[0] });
    } catch (err) {
      console.error('[opportunities/[id] GET]', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  // ── PATCH ─────────────────────────────────────────────────────────────────
  if (req.method === 'PATCH') {
    const { name, stage_normalized, amount, close_date, owner, owner_sfdc_id, next_step, next_step_date,
            practice_size, specialty, lead_source, demo_status, first_demo_date, iqm_notes, booked_by } = req.body || {};

    try {
      // 1. Fetch current opp for sfdc_id
      const current = await query(
        `SELECT id, sfdc_id FROM opportunities WHERE id::text = $1 OR sfdc_id = $1 LIMIT 1`,
        [String(id)]
      );
      if (!current.rows.length) return res.status(404).json({ error: 'Opportunity not found' });
      const oppId   = current.rows[0].id;
      const sfdcId  = current.rows[0].sfdc_id;

      // 2. Build DB update
      const setClauses = [];
      const dbParams   = [];
      function addSet(col, val) {
        dbParams.push(val);
        setClauses.push(`${col} = $${dbParams.length}`);
      }
      if (name            != null) addSet('name',             name);
      if (stage_normalized != null) addSet('stage_normalized', stage_normalized);
      if (amount           != null) addSet('amount',           amount === '' ? null : Number(amount));
      if (close_date       != null) addSet('close_date',       close_date === '' ? null : close_date);
      if (owner            != null) addSet('owner',            owner);
      if (next_step        != null) addSet('next_step',        next_step === '' ? null : next_step);
      if (next_step_date   != null) addSet('next_step_date',   next_step_date === '' ? null : next_step_date);
      if (practice_size    != null) addSet('practice_size',    practice_size === '' ? null : practice_size);
      if (specialty        != null) addSet('specialty',        specialty === '' ? null : specialty);
      if (lead_source      != null) addSet('lead_source',      lead_source === '' ? null : lead_source);
      if (demo_status      != null) addSet('demo_status',      demo_status === '' ? null : demo_status);
      if (first_demo_date  != null) addSet('first_demo_date',  first_demo_date === '' ? null : first_demo_date);
      if (iqm_notes        != null) addSet('iqm_notes',        iqm_notes === '' ? null : iqm_notes);
      if (booked_by        != null) addSet('booked_by',        booked_by === '' ? null : booked_by);

      let updatedOpp = null;
      if (setClauses.length > 0) {
        setClauses.push(`updated_at = NOW()`);
        dbParams.push(oppId);
        const upResult = await query(
          `UPDATE opportunities SET ${setClauses.join(', ')} WHERE id = $${dbParams.length} RETURNING *`,
          dbParams
        );
        updatedOpp = upResult.rows[0];
      } else {
        const fetchResult = await query(`SELECT * FROM opportunities WHERE id = $1`, [oppId]);
        updatedOpp = fetchResult.rows[0];
      }

      // 3. Push to SFDC (best-effort — don't fail DB update if SFDC fails)
      let sfdcResult = null;
      if (sfdcId) {
        try {
          const { sessionId, instanceUrl } = await sfdcLogin();

          const sfdcPayload = {};
          if (name            != null) sfdcPayload.Name       = name;
          if (stage_normalized != null) sfdcPayload.StageName  = stage_normalized;
          if (amount           != null && amount !== '') sfdcPayload.Amount    = Number(amount);
          if (close_date       != null && close_date !== '') sfdcPayload.CloseDate  = close_date;
          if (owner_sfdc_id)                              sfdcPayload.OwnerId   = owner_sfdc_id;
          if (next_step        != null) sfdcPayload.NextStep          = next_step === '' ? null : next_step;
          if (next_step_date   != null && next_step_date !== '') sfdcPayload.Next_Step_Date__c = next_step_date;
          if (practice_size    != null && practice_size !== '')   sfdcPayload.Practice_Size__c          = practice_size;
          if (specialty        != null)                           sfdcPayload.Specialty__c               = specialty === '' ? null : specialty;
          if (lead_source      != null && lead_source !== '')     sfdcPayload.LeadSource                 = lead_source;
          if (demo_status      != null && demo_status !== '')     sfdcPayload.Demo_Status__c             = demo_status;
          if (first_demo_date  != null && first_demo_date !== '') sfdcPayload.First_Demo_Meeting_Date__c = first_demo_date;
          if (iqm_notes        != null)                           sfdcPayload.IQM_Notes__c               = iqm_notes === '' ? null : iqm_notes;

          if (Object.keys(sfdcPayload).length > 0) {
            const sfdcResp = await fetch(
              `${instanceUrl}/services/data/v59.0/sobjects/Opportunity/${sfdcId}`,
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
              sfdcResult = { success: true };
            } else {
              const sfdcBody = await sfdcResp.json().catch(() => ({}));
              sfdcResult = { success: false, status: sfdcResp.status, body: sfdcBody };
              console.warn('[opportunities/[id] PATCH] SFDC update failed', sfdcResult);
            }
          }
        } catch (sfdcErr) {
          console.warn('[opportunities/[id] PATCH] SFDC error (non-fatal):', sfdcErr.message);
          sfdcResult = { success: false, error: sfdcErr.message };
        }
      }

      return res.status(200).json({
        opportunity: updatedOpp,
        sfdc: sfdcResult,
      });
    } catch (err) {
      console.error('[opportunities/[id] PATCH]', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
