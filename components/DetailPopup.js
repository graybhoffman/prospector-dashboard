/**
 * DetailPopup — reusable detail modal for accounts and opportunities
 *
 * Props:
 *   type       'account' | 'opp'
 *   id         record id (DB id or sfdc_id)
 *   onClose    function to close the popup
 *   onSaved    (optional) called after a successful PATCH save (opp only)
 */

import { useState, useEffect, useCallback } from 'react';
import useSWR from 'swr';

const fetcher = (url) => fetch(url).then(r => r.json());

// ─── Theme ────────────────────────────────────────────────────────────────────
const C = {
  bg:        '#0a0a10',
  surface:   '#111119',
  card:      '#16161f',
  cardHover: '#1c1c28',
  border:    '#252535',
  textPri:   '#f0f4ff',
  textSec:   '#9ca3c8',
  textMuted: '#4b5280',
  accent:    '#6366f1',
  green:     '#10b981',
  amber:     '#f59e0b',
  red:       '#ef4444',
  blue:      '#3b82f6',
  purple:    '#8b5cf6',
  teal:      '#14b8a6',
};

// Fields to always skip (internal/noisy)
const SKIP_FIELDS = new Set([
  'notion_id', 'last_sfdc_sync', 'created_at', 'updated_at',
  'baa_nda_complete','template_msa_sent','detailed_scoping_sent',
  'detailed_scoping_signed_off','poc_language_signoff','full_msa_sent',
  'discovery_scheduled','discovery_complete','call_center_access',
  'health_analysis_complete','roi_analysis','detailed_scoping_milestone','pricing_sent',
]);

// Fields that can be edited on an opportunity
const OPP_EDITABLE = ['name', 'amount', 'close_date', 'owner', 'next_step', 'next_step_date'];

const OPP_STAGE_OPTIONS = [
  'Prospect', 'Outreach', 'Discovery', 'Disco Scheduled', 'SQL',
  'Negotiations', 'Pilot Deployment', 'Full Deployment', 'Closed-Won', 'Closed-Lost',
];

function formatFieldName(key) {
  return key
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
    .replace(/Sfdc/g, 'SFDC')
    .replace(/Ehr/g, 'EHR')
    .replace(/Icp/g, 'ICP')
    .replace(/Acv/g, 'ACV')
    .replace(/Roe/g, 'ROE')
    .replace(/Zi\b/g, 'ZI')
    .replace(/Dhc\b/g, 'DHC')
    .replace(/Npi\b/g, 'NPI');
}

function formatValue(key, val) {
  if (val === null || val === undefined || val === '') return null;
  if (typeof val === 'boolean') return val ? '✅ Yes' : '✗ No';
  if (key.includes('revenue') || key === 'amount' || key === 'acv') {
    const n = Number(val);
    if (!isNaN(n) && n > 0) {
      if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
      if (n >= 1_000)     return `$${n.toLocaleString()}`;
      return `$${n}`;
    }
  }
  if (key.includes('date') && typeof val === 'string' && val.match(/^\d{4}-\d{2}-\d{2}/)) {
    try {
      return new Date(val).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    } catch { return val; }
  }
  return String(val);
}

// ─── Account Detail / Edit Popup ─────────────────────────────────────────────
const ACCOUNT_EDITABLE_FIELDS = [
  // SFDC+DB
  { key: 'name',                 label: 'Name',                  type: 'text',     sfdc: true },
  { key: 'phone',                label: 'Phone',                 type: 'text',     sfdc: true },
  { key: 'billing_city',         label: 'Billing City',          type: 'text',     sfdc: true },
  { key: 'billing_state',        label: 'Billing State',         type: 'text',     sfdc: true },
  { key: 'billing_postal_code',  label: 'Billing Postal Code',   type: 'text',     sfdc: true },
  { key: 'industry',             label: 'Industry',              type: 'text',     sfdc: true },
  { key: 'num_employees',        label: 'Employees',             type: 'number',   sfdc: true },
  { key: 'annual_revenue',       label: 'Annual Revenue',        type: 'number',   sfdc: true },
  { key: 'ehr_system',           label: 'EHR System',            type: 'text',     sfdc: true },
  { key: 'specialty',            label: 'Specialty',             type: 'text',     sfdc: true },
  // DB-only
  { key: 'agents_stage',         label: 'Agents Stage',          type: 'select',   options: ['','Prospect','Outreach','Warm Intro','Discovery','SQL','Negotiations','Pilot Deployment','Full Deployment','Closed-Won','Nurture'] },
  { key: 'agents_owner',         label: 'Agents Owner',          type: 'text' },
  { key: 'enrichment_notes',     label: 'Enrichment Notes',      type: 'textarea' },
  { key: 'icp_rationale',        label: 'ICP Rationale',         type: 'textarea' },
  { key: 'override_icp_criteria',label: 'Override ICP Criteria', type: 'checkbox' },
  { key: 'override_icp_reason',  label: 'Override ICP Reason',   type: 'select',   options: ['','partner','strategic_importance','slow_burn','other'] },
  { key: 'next_step',            label: 'Next Step',             type: 'text' },
  { key: 'campaign_tag',         label: 'Campaign Tag',          type: 'text' },
  { key: 'db_status',            label: 'DB Status',             type: 'select',   options: ['','main','enrichment_queue','excluded'] },
  { key: 'est_monthly_call_volume', label: 'Est Monthly Call Volume', type: 'number' },
];

function AccountDetailPopup({ id, onClose, onSaved }) {
  const { data, isLoading, mutate } = useSWR(`/api/accounts/${id}`, fetcher, { revalidateOnFocus: false });
  const acc = data?.account;

  const [editing, setEditing]       = useState(false);
  const [form, setForm]             = useState({});
  const [saving, setSaving]         = useState(false);
  const [saveMsg, setSaveMsg]       = useState(null); // { ok, text }

  // Sync form when acc loads or edit opens
  useEffect(() => {
    if (acc && editing) {
      const initial = {};
      for (const f of ACCOUNT_EDITABLE_FIELDS) {
        initial[f.key] = acc[f.key] != null ? acc[f.key] : (f.type === 'checkbox' ? false : '');
      }
      setForm(initial);
    }
  }, [acc, editing]);

  // Close on Escape
  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape') {
        if (editing) { setEditing(false); setSaveMsg(null); }
        else onClose();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose, editing]);

  async function handleSave() {
    setSaving(true);
    setSaveMsg(null);
    try {
      const resp = await fetch(`/api/accounts/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const result = await resp.json();
      if (!resp.ok) throw new Error(result.error || 'Save failed');
      await mutate({ account: result.account }, false);
      const sfdcNote = result.sfdcUpdated
        ? ' (synced to SFDC)'
        : result.sfdcError ? ` (SFDC: ${result.sfdcError.slice(0, 60)})` : '';
      setSaveMsg({ ok: true, text: '✓ Saved' + sfdcNote });
      setEditing(false);
      if (onSaved) onSaved(result.account);
    } catch (err) {
      setSaveMsg({ ok: false, text: '⚠ ' + err.message });
    } finally {
      setSaving(false);
    }
  }

  // Priority fields order for accounts (read mode)
  const PRIORITY_FIELDS = [
    'name', 'ehr_system', 'agents_stage', 'agents_owner', 'specialty',
    'num_employees', 'num_locations', 'num_providers', 'annual_revenue',
    'est_monthly_call_volume', 'agents_icp', 'icp_rationale', 'db_status',
    'enrichment_notes', 'billing_city', 'billing_state', 'source_category',
    'date_entered_discovery', 'date_entered_sql', 'date_entered_negotiations',
    'date_entered_closed_won', 'next_step', 'last_touch_date',
  ];

  const renderReadFields = () => {
    if (!acc) return null;
    const rendered = new Set();
    const sections = [];

    for (const key of PRIORITY_FIELDS) {
      if (acc[key] != null && acc[key] !== '' && acc[key] !== false) {
        const display = formatValue(key, acc[key]);
        if (display) { sections.push({ key, display }); rendered.add(key); }
      }
    }
    for (const [key, val] of Object.entries(acc)) {
      if (rendered.has(key)) continue;
      if (SKIP_FIELDS.has(key)) continue;
      if (key === 'sfdc_link' || key === 'id' || key === 'sfdc_id') continue;
      if (val === null || val === undefined || val === '' || val === false) continue;
      const display = formatValue(key, val);
      if (display) sections.push({ key, display });
    }

    return sections.map(({ key, display }) => (
      <div key={key} style={{
        display: 'grid', gridTemplateColumns: '160px 1fr', gap: 8,
        padding: '7px 0', borderBottom: `1px solid ${C.border}1a`,
        alignItems: 'start',
      }}>
        <span style={{ color: C.textMuted, fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.3px', paddingTop: 1 }}>
          {formatFieldName(key)}
        </span>
        <span style={{ color: C.textSec, fontSize: 13, wordBreak: 'break-word' }}>{display}</span>
      </div>
    ));
  };

  const inputStyle = {
    background: C.surface, border: `1px solid ${C.border}`, borderRadius: 6,
    color: C.textPri, padding: '5px 9px', fontSize: 12, outline: 'none', width: '100%',
    boxSizing: 'border-box',
  };
  const labelStyle = { color: C.textMuted, fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.3px', marginBottom: 3, display: 'block' };

  const renderEditFields = () => (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 16px' }}>
      {ACCOUNT_EDITABLE_FIELDS.map(f => {
        const val = form[f.key];
        const hasSfdc = f.sfdc;
        return (
          <div key={f.key} style={{ gridColumn: (f.type === 'textarea') ? '1 / -1' : undefined }}>
            <label style={labelStyle}>
              {f.label}{hasSfdc ? <span style={{ color: C.blue, marginLeft: 4, fontSize: 9 }}>SFDC</span> : null}
            </label>
            {f.type === 'select' ? (
              <select
                value={val ?? ''}
                onChange={e => setForm(p => ({ ...p, [f.key]: e.target.value }))}
                style={{ ...inputStyle, cursor: 'pointer' }}
              >
                {f.options.map(o => <option key={o} value={o}>{o || '—'}</option>)}
              </select>
            ) : f.type === 'textarea' ? (
              <textarea
                value={val ?? ''}
                onChange={e => setForm(p => ({ ...p, [f.key]: e.target.value }))}
                rows={3}
                style={{ ...inputStyle, resize: 'vertical' }}
              />
            ) : f.type === 'checkbox' ? (
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={!!val}
                  onChange={e => setForm(p => ({ ...p, [f.key]: e.target.checked }))}
                  style={{ width: 14, height: 14, cursor: 'pointer' }}
                />
                <span style={{ color: C.textSec, fontSize: 12 }}>{val ? 'Yes' : 'No'}</span>
              </label>
            ) : (
              <input
                type={f.type === 'number' ? 'number' : 'text'}
                value={val ?? ''}
                onChange={e => setForm(p => ({ ...p, [f.key]: e.target.value }))}
                style={inputStyle}
              />
            )}
          </div>
        );
      })}
    </div>
  );

  return (
    <Overlay onClose={onClose} wide>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 16 }}>
        <div>
          <div style={{ color: C.textMuted, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.4px', marginBottom: 4 }}>
            Account Detail {editing && <span style={{ color: C.amber, marginLeft: 6 }}>— Editing</span>}
          </div>
          <h2 style={{ margin: 0, color: C.textPri, fontSize: 18, fontWeight: 700 }}>
            {isLoading ? '…' : (acc?.name || 'Account')}
          </h2>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {!isLoading && acc && !editing && (
            <button
              onClick={() => { setEditing(true); setSaveMsg(null); }}
              style={{
                background: C.accent + '22', color: C.accent,
                border: `1px solid ${C.accent}55`, borderRadius: 7,
                padding: '6px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer',
              }}
            >
              ✎ Edit
            </button>
          )}
          <CloseBtn onClose={onClose} />
        </div>
      </div>

      {isLoading && <LoadingSpinner />}

      {!isLoading && acc && (
        <>
          {/* SFDC link (read mode) */}
          {!editing && acc.sfdc_link && (
            <a
              href={acc.sfdc_link}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                background: C.blue + '22', color: C.blue,
                border: `1px solid ${C.blue}44`, borderRadius: 7,
                padding: '6px 14px', fontSize: 12, fontWeight: 600,
                textDecoration: 'none', marginBottom: 16,
              }}
            >
              ↗ Open in Salesforce
            </a>
          )}

          {/* Save result banner */}
          {saveMsg && (
            <div style={{
              marginBottom: 12, padding: '7px 12px', borderRadius: 7, fontSize: 12,
              background: saveMsg.ok ? C.green + '22' : C.red + '22',
              color: saveMsg.ok ? C.green : C.red,
              border: `1px solid ${saveMsg.ok ? C.green : C.red}44`,
            }}>
              {saveMsg.text}
            </div>
          )}

          {/* Edit mode */}
          {editing ? (
            <>
              <div style={{ maxHeight: '58vh', overflowY: 'auto', paddingRight: 4, marginBottom: 14 }}>
                {renderEditFields()}
              </div>
              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                <button
                  onClick={() => { setEditing(false); setSaveMsg(null); }}
                  style={{
                    background: 'transparent', color: C.textMuted,
                    border: `1px solid ${C.border}`, borderRadius: 7,
                    padding: '7px 16px', fontSize: 12, cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
                <button
                  onClick={handleSave}
                  disabled={saving}
                  style={{
                    background: saving ? C.surface : C.accent + '33',
                    color: saving ? C.textMuted : C.accent,
                    border: `1px solid ${saving ? C.border : C.accent + '66'}`,
                    borderRadius: 7, padding: '7px 20px', fontSize: 12, fontWeight: 700,
                    cursor: saving ? 'not-allowed' : 'pointer',
                  }}
                >
                  {saving ? '⟳ Saving…' : '💾 Save to DB + SFDC'}
                </button>
              </div>
            </>
          ) : (
            <div style={{ maxHeight: '62vh', overflowY: 'auto', paddingRight: 4 }}>
              {renderReadFields()}
            </div>
          )}
        </>
      )}

      {!isLoading && !acc && (
        <div style={{ color: C.red, fontSize: 13 }}>Could not load account details.</div>
      )}
    </Overlay>
  );
}

// ─── Opp Detail / Edit Popup ──────────────────────────────────────────────────
function OppEditPopup({ opp: initialOpp, id, onClose, onSaved }) {
  // If we have an id but not full opp, fetch it; otherwise use what we have
  const shouldFetch = !initialOpp && id;
  const { data, isLoading } = useSWR(
    shouldFetch ? `/api/opportunities/${id}` : null,
    fetcher,
    { revalidateOnFocus: false }
  );

  const opp = initialOpp || data?.opportunity;

  const [editing, setEditing]   = useState(false);
  const [form, setForm]         = useState({});
  const [saving, setSaving]     = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [sfdcResult, setSfdcResult] = useState(null);

  // Sync form when opp loads
  useEffect(() => {
    if (opp) {
      setForm({
        name:             opp.name             || '',
        stage_normalized: opp.stage_normalized || opp.stage || '',
        amount:           opp.amount           != null ? String(opp.amount) : '',
        close_date:       opp.close_date       ? String(opp.close_date).slice(0, 10) : '',
        owner:            opp.owner            || '',
        next_step:        opp.next_step        || '',
        next_step_date:   opp.next_step_date   ? String(opp.next_step_date).slice(0, 10) : '',
        practice_size:    opp.practice_size    || '',
        specialty:        opp.specialty        || '',
        lead_source:      opp.lead_source      || '',
        source_sub_category: opp.source_sub_category || '',
        demo_status:      opp.demo_status      || '',
        first_demo_date:  opp.first_demo_date  ? String(opp.first_demo_date).slice(0,10) : '',
        iqm_notes:        opp.iqm_notes        || '',
        booked_by:        opp.booked_by        || '',
      });
    }
  }, [opp]);

  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  async function handleSave() {
    setSaving(true);
    setSaveError(null);
    try {
      // Get cached SFDC users to look up owner ID
      let ownerSfdcId = null;
      try {
        const users = JSON.parse(localStorage.getItem('wt_sfdc_users_cache') || '[]');
        const matched = users.find(u =>
          u.Name && u.Name.toLowerCase() === form.owner.toLowerCase()
        );
        if (matched) ownerSfdcId = matched.Id;
      } catch {}

      const body = { ...form };
      if (ownerSfdcId) body.owner_sfdc_id = ownerSfdcId;
      if (body.amount !== '') body.amount = Number(body.amount);

      const resp = await fetch(`/api/opportunities/${opp.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const result = await resp.json();
      if (!resp.ok) throw new Error(result.error || 'Save failed');

      setSfdcResult(result.sfdc);
      setEditing(false);
      if (onSaved) onSaved(result.opportunity);
    } catch (err) {
      setSaveError(err.message);
    } finally {
      setSaving(false);
    }
  }

  const labelStyle = { color: C.textMuted, fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.3px', marginBottom: 4 };
  const inputStyle = { background: C.surface, border: `1px solid ${C.border}`, borderRadius: 6, color: C.textPri, padding: '6px 10px', fontSize: 12, outline: 'none', width: '100%' };

  const PRIORITY_DISPLAY = [
    'account_name', 'name', 'stage_normalized', 'amount', 'close_date',
    'owner', 'ehr', 'source_category', 'agents_icp', 'discovery_scheduled',
    'agents_stage',
  ];

  const renderDisplayFields = () => {
    if (!opp) return null;
    const rendered = new Set();
    const items = [];

    for (const key of PRIORITY_DISPLAY) {
      if (opp[key] != null && opp[key] !== '') {
        const display = formatValue(key, opp[key]);
        if (display) { items.push({ key, display }); rendered.add(key); }
      }
    }
    for (const [key, val] of Object.entries(opp)) {
      if (rendered.has(key)) continue;
      if (SKIP_FIELDS.has(key)) continue;
      if (key === 'sfdc_link' || key === 'id' || key === 'sfdc_id') continue;
      if (key === 'agents_stage' || key === 'is_partner' || key === 'override_icp_reason') continue;
      if (key.startsWith('account_')) continue; // skip joined account fields except account_name
      if (val === null || val === undefined || val === '' || val === false) continue;
      const display = formatValue(key, val);
      if (display) items.push({ key, display });
    }

    return items.map(({ key, display }) => (
      <div key={key} style={{
        display: 'grid', gridTemplateColumns: '160px 1fr', gap: 8,
        padding: '6px 0', borderBottom: `1px solid ${C.border}1a`, alignItems: 'start',
      }}>
        <span style={{ color: C.textMuted, fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.3px', paddingTop: 1 }}>
          {formatFieldName(key)}
        </span>
        <span style={{ color: C.textSec, fontSize: 13 }}>{display}</span>
      </div>
    ));
  };

  return (
    <Overlay onClose={onClose} wide>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 16 }}>
        <div>
          <div style={{ color: C.textMuted, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.4px', marginBottom: 4 }}>Opportunity</div>
          <h2 style={{ margin: 0, color: C.textPri, fontSize: 18, fontWeight: 700, lineHeight: 1.3 }}>
            {isLoading ? '…' : (opp?.name || opp?.account_name || 'Opportunity')}
          </h2>
          {opp?.account_name && opp.account_name !== opp?.name && (
            <div style={{ color: C.textMuted, fontSize: 12, marginTop: 4 }}>{opp.account_name}</div>
          )}
        </div>
        <CloseBtn onClose={onClose} />
      </div>

      {(isLoading) && <LoadingSpinner />}

      {!isLoading && opp && (
        <>
          {/* SFDC link + Edit toggle */}
          <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
            {opp.sfdc_link && (
              <a
                href={opp.sfdc_link}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  background: C.blue + '22', color: C.blue,
                  border: `1px solid ${C.blue}44`, borderRadius: 7,
                  padding: '6px 14px', fontSize: 12, fontWeight: 600, textDecoration: 'none',
                }}
              >
                ↗ Open in Salesforce
              </a>
            )}
            <button
              onClick={() => { setEditing(e => !e); setSaveError(null); setSfdcResult(null); }}
              style={{
                background: editing ? C.amber + '22' : C.accent + '22',
                color: editing ? C.amber : C.accent,
                border: `1px solid ${editing ? C.amber + '44' : C.accent + '44'}`,
                borderRadius: 7, padding: '6px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer',
              }}
            >
              {editing ? '✕ Cancel Edit' : '✏️ Edit'}
            </button>
          </div>

          {/* SFDC result toast */}
          {sfdcResult && (
            <div style={{
              background: sfdcResult.success ? C.green + '15' : C.amber + '15',
              border: `1px solid ${sfdcResult.success ? C.green + '44' : C.amber + '44'}`,
              borderRadius: 8, padding: '8px 12px', fontSize: 12,
              color: sfdcResult.success ? C.green : C.amber, marginBottom: 12,
            }}>
              {sfdcResult.success
                ? '✅ Salesforce updated successfully'
                : `⚠️ DB saved, but SFDC update failed: ${sfdcResult.error || JSON.stringify(sfdcResult.body)}`}
            </div>
          )}

          {/* Edit form */}
          {editing && (
            <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: '16px', marginBottom: 16 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                {/* Row: Name | Stage */}
                <div>
                  <div style={labelStyle}>Name</div>
                  <input style={inputStyle} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
                </div>
                <div>
                  <div style={labelStyle}>Stage</div>
                  <div style={{...inputStyle, background:'#f5f5f5', color:'#666', cursor:'default', display:'flex', alignItems:'center'}}>
                    {form.stage_normalized || '—'}
                    <span style={{marginLeft:6, fontSize:10, color:'#999'}}>(edit in SFDC)</span>
                  </div>
                </div>
                {/* Row: Amount | Close Date */}
                <div>
                  <div style={labelStyle}>Amount ($)</div>
                  <input style={inputStyle} type="number" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} placeholder="e.g. 50000" />
                </div>
                <div>
                  <div style={labelStyle}>Close Date</div>
                  <input style={inputStyle} type="date" value={form.close_date} onChange={e => setForm(f => ({ ...f, close_date: e.target.value }))} />
                </div>
                {/* Row: Owner | (spacer — or use full row) */}
                <div>
                  <div style={labelStyle}>Owner</div>
                  <select style={inputStyle} value={form.owner} onChange={e => setForm(f => ({ ...f, owner: e.target.value }))}>
                    <option value="">— Select —</option>
                    <option>Gray Hoffman</option>
                    <option>Andrew Sapien</option>
                    <option>Neha Bhongir</option>
                    <option>Adam Mohiuddin</option>
                    <option>Manish</option>
                  </select>
                </div>
                <div />
                {/* Row: Practice Size | Demo Status */}
                <div>
                  <div style={labelStyle}>Practice Size</div>
                  <select style={inputStyle} value={form.practice_size} onChange={e => setForm(f => ({ ...f, practice_size: e.target.value }))}>
                    <option value="">— Select —</option>
                    {['1-5','6-20','21-50','51-100','101+'].map(o => <option key={o} value={o}>{o}</option>)}
                  </select>
                </div>
                <div>
                  <div style={labelStyle}>Demo Status</div>
                  <select style={inputStyle} value={form.demo_status} onChange={e => setForm(f => ({ ...f, demo_status: e.target.value }))}>
                    <option value="">— Select —</option>
                    {['Scheduled','Cancelled','No Show','Pending Reschedule','Completed','Unqualified'].map(o => <option key={o} value={o}>{o}</option>)}
                  </select>
                </div>
                {/* Row: First Demo Meeting Date | Lead Source */}
                <div>
                  <div style={labelStyle}>First Demo Meeting Date</div>
                  <input style={inputStyle} type="date" value={form.first_demo_date} onChange={e => setForm(f => ({ ...f, first_demo_date: e.target.value }))} />
                </div>
                <div>
                  <div style={labelStyle}>Lead Source</div>
                  <select style={inputStyle} value={form.lead_source} onChange={e => setForm(f => ({ ...f, lead_source: e.target.value }))}>
                    <option value="">— Select —</option>
                    {['Advisor Outreach','Commure Scribe','Content Syndication','Cross Sell','Digital Event','Direct Traffic','Email','Event','Expansion Opportunity','Inbound','Other'].map(o => <option key={o} value={o}>{o}</option>)}
                  </select>
                </div>
                <div>
                  <div style={labelStyle}>Source Sub-Category</div>
                  <select style={inputStyle} value={form.source_sub_category} onChange={e => setForm(f => ({ ...f, source_sub_category: e.target.value }))}>
                    <option value="">— Select —</option>
                    {['Direct - all','Direct - Network','MM Scribe - Customers (x-sell)','MM Scribe - Co-sell','MM Scribe - Lead-gen','MM RCM - Customers (x-sell)','MM AIR - Customers (x-sell)','MM RCM & AIR - Co-sell (Bundle)','MM RCM & AIR - Lead-gen (Bundle)','Meditech Design Partner','Enterprise Customers - Ambient + PXP','Enterprise New Biz Co-sell - Ambient + PXP','Enterprise Sales Motion (Lead-gen)'].map(o => <option key={o} value={o}>{o}</option>)}
                  </select>
                </div>
                {/* Row: Provider Specialty | Booked By */}
                <div>
                  <div style={labelStyle}>Provider Specialty</div>
                  <input style={inputStyle} value={form.specialty} onChange={e => setForm(f => ({ ...f, specialty: e.target.value }))} />
                </div>
                <div>
                  <div style={labelStyle}>Booked By</div>
                  <select style={inputStyle} value={form.booked_by} onChange={e => setForm(f => ({ ...f, booked_by: e.target.value }))}>
                    <option value="">— Select —</option>
                    <option>Gray Hoffman</option>
                    <option>Andrew Sapien</option>
                    <option>Neha Bhongir</option>
                    <option>Adam Mohiuddin</option>
                    <option>Manish</option>
                  </select>
                </div>
                {/* Full width: Pre Demo Notes */}
                <div style={{ gridColumn: '1 / -1' }}>
                  <div style={labelStyle}>Pre Demo Notes</div>
                  <textarea style={{ ...inputStyle, minHeight: 70, resize: 'vertical' }} value={form.iqm_notes} onChange={e => setForm(f => ({ ...f, iqm_notes: e.target.value }))} placeholder="Pre-demo notes..." />
                </div>
                {/* Row: Next Step | Next Step Date */}
                <div style={{ gridColumn: '1 / -1' }}>
                  <div style={labelStyle}>Next Step</div>
                  <textarea style={{ ...inputStyle, minHeight: 60, resize: 'vertical' }} value={form.next_step} onChange={e => setForm(f => ({ ...f, next_step: e.target.value }))} placeholder="Next step notes..." />
                </div>
                <div>
                  <div style={labelStyle}>Next Step Date</div>
                  <input style={inputStyle} type="date" value={form.next_step_date} onChange={e => setForm(f => ({ ...f, next_step_date: e.target.value }))} />
                </div>
              </div>
              {saveError && (
                <div style={{ color: C.red, fontSize: 12, marginTop: 10 }}>⚠ {saveError}</div>
              )}
              <div style={{ display: 'flex', gap: 10, marginTop: 14, justifyContent: 'flex-end' }}>
                <button onClick={() => { setEditing(false); setSaveError(null); }}
                  style={{ background: 'transparent', color: C.textMuted, border: `1px solid ${C.border}`, borderRadius: 7, padding: '7px 16px', fontSize: 12, cursor: 'pointer' }}>
                  Cancel
                </button>
                <button onClick={handleSave} disabled={saving}
                  style={{
                    background: saving ? C.surface : C.accent + '33',
                    color: saving ? C.textMuted : C.accent,
                    border: `1px solid ${saving ? C.border : C.accent + '66'}`,
                    borderRadius: 7, padding: '7px 20px', fontSize: 12, fontWeight: 700,
                    cursor: saving ? 'not-allowed' : 'pointer',
                  }}>
                  {saving ? '⟳ Saving…' : '💾 Save to DB + SFDC'}
                </button>
              </div>
            </div>
          )}

          {/* Full field display */}
          <div style={{ maxHeight: '50vh', overflowY: 'auto', paddingRight: 4 }}>
            {renderDisplayFields()}
          </div>
        </>
      )}

      {!isLoading && !opp && (
        <div style={{ color: C.red, fontSize: 13 }}>Could not load opportunity details.</div>
      )}
    </Overlay>
  );
}

// ─── Shared Overlay ───────────────────────────────────────────────────────────
function Overlay({ children, onClose, wide = false }) {
  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed', inset: 0,
          background: 'rgba(0,0,0,0.65)',
          backdropFilter: 'blur(2px)',
          zIndex: 9998,
        }}
      />
      {/* Modal */}
      <div style={{
        position: 'fixed',
        top: '50%', left: '50%',
        transform: 'translate(-50%, -50%)',
        background: C.card,
        border: `1px solid ${C.border}`,
        borderRadius: 14,
        padding: '22px 26px',
        width: wide ? 620 : 520,
        maxWidth: '94vw',
        maxHeight: '90vh',
        overflowY: 'auto',
        zIndex: 9999,
        boxShadow: '0 20px 60px rgba(0,0,0,0.8)',
      }}>
        {children}
      </div>
    </>
  );
}

function CloseBtn({ onClose }) {
  return (
    <button
      onClick={onClose}
      style={{
        background: 'none', border: 'none',
        color: C.textMuted, cursor: 'pointer',
        fontSize: 20, lineHeight: 1, padding: '0 2px',
        flexShrink: 0,
      }}
      title="Close"
    >
      ✕
    </button>
  );
}

function LoadingSpinner() {
  return (
    <div style={{ textAlign: 'center', padding: '40px 0', color: C.textMuted, fontSize: 13 }}>
      ⟳ Loading…
    </div>
  );
}

export { AccountDetailPopup, OppEditPopup };
export default AccountDetailPopup;
