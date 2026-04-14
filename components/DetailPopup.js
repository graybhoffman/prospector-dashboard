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
const OPP_EDITABLE = ['name', 'stage_normalized', 'amount', 'close_date', 'owner'];

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

// ─── Account Detail Popup ─────────────────────────────────────────────────────
function AccountDetailPopup({ id, onClose }) {
  const { data, isLoading } = useSWR(`/api/accounts/${id}`, fetcher, { revalidateOnFocus: false });
  const acc = data?.account;

  // Close on Escape
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  // Priority fields order for accounts
  const PRIORITY_FIELDS = [
    'name', 'ehr_system', 'agents_stage', 'agents_owner', 'specialty',
    'num_employees', 'num_locations', 'num_providers', 'annual_revenue',
    'est_monthly_call_volume', 'agents_icp', 'icp_rationale', 'db_status',
    'enrichment_notes', 'billing_city', 'billing_state', 'source_category',
    'date_entered_discovery', 'date_entered_sql', 'date_entered_negotiations',
    'date_entered_closed_won', 'next_step', 'last_touch_date',
  ];

  const renderFields = () => {
    if (!acc) return null;
    const rendered = new Set();
    const sections = [];

    // Priority fields first
    for (const key of PRIORITY_FIELDS) {
      if (acc[key] != null && acc[key] !== '' && acc[key] !== false) {
        const display = formatValue(key, acc[key]);
        if (display) {
          sections.push({ key, display });
          rendered.add(key);
        }
      }
    }

    // Remaining populated fields
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
        <span style={{ color: C.textSec, fontSize: 13, wordBreak: 'break-word' }}>
          {display}
        </span>
      </div>
    ));
  };

  return (
    <Overlay onClose={onClose}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 16 }}>
        <div>
          <div style={{ color: C.textMuted, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.4px', marginBottom: 4 }}>Account Detail</div>
          <h2 style={{ margin: 0, color: C.textPri, fontSize: 18, fontWeight: 700 }}>
            {isLoading ? '…' : (acc?.name || 'Account')}
          </h2>
        </div>
        <CloseBtn onClose={onClose} />
      </div>

      {isLoading && <LoadingSpinner />}

      {!isLoading && acc && (
        <>
          {/* SFDC link */}
          {acc.sfdc_link && (
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

          <div style={{ maxHeight: '60vh', overflowY: 'auto', paddingRight: 4 }}>
            {renderFields()}
          </div>
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
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 14 }}>
                <div>
                  <div style={labelStyle}>Name</div>
                  <input style={inputStyle} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
                </div>
                <div>
                  <div style={labelStyle}>Stage</div>
                  <select style={inputStyle} value={form.stage_normalized} onChange={e => setForm(f => ({ ...f, stage_normalized: e.target.value }))}>
                    <option value="">— Select —</option>
                    {OPP_STAGE_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                <div>
                  <div style={labelStyle}>Amount ($)</div>
                  <input style={inputStyle} type="number" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} placeholder="e.g. 50000" />
                </div>
                <div>
                  <div style={labelStyle}>Close Date</div>
                  <input style={inputStyle} type="date" value={form.close_date} onChange={e => setForm(f => ({ ...f, close_date: e.target.value }))} />
                </div>
                <div>
                  <div style={labelStyle}>Owner</div>
                  <input style={inputStyle} value={form.owner} onChange={e => setForm(f => ({ ...f, owner: e.target.value }))} />
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
