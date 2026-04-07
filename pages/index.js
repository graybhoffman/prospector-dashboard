/**
 * Watchtower — Pipeline Dashboard
 * Dark-themed React dashboard for Commure's Call Center Agents team.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import Head from 'next/head';
import useSWR from 'swr';
import {
  PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer,
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
} from 'recharts';

// ─── Constants ────────────────────────────────────────────────────────────────
const C = {
  bg:        '#0f0f14',
  card:      '#1e1e2a',
  border:    '#2d2d3d',
  textPri:   '#f1f5f9',
  textSec:   '#94a3b8',
  textMuted: '#475569',
  accent:    '#6366f1',
  green:     '#10b981',
  amber:     '#f59e0b',
  red:       '#ef4444',
  chartColors: ['#6366f1','#10b981','#f59e0b','#ef4444','#3b82f6','#8b5cf6',
                '#ec4899','#14b8a6','#f97316','#84cc16'],
};

const DEPLOYED_ARR = 650000;

const STAGE_COLORS = {
  'Prospecting':        '#6366f1',
  'Qualification':      '#8b5cf6',
  'Needs Analysis':     '#3b82f6',
  'Value Proposition':  '#06b6d4',
  'Id. Decision Makers':'#10b981',
  'Perception Analysis':'#84cc16',
  'Proposal/Price Quote':'#f59e0b',
  'Negotiation/Review': '#f97316',
  'Closed Won':         '#10b981',
  'Closed Lost':        '#ef4444',
};

const fetcher = (url) => fetch(url).then((r) => r.json());

function fmt(n, style = 'decimal', decimals = 0) {
  if (n == null) return '—';
  return new Intl.NumberFormat('en-US', {
    style,
    currency: 'USD',
    maximumFractionDigits: decimals,
    minimumFractionDigits: decimals,
    notation: n >= 1_000_000 ? 'compact' : 'standard',
  }).format(n);
}

// ─── Build API URL from filters ────────────────────────────────────────────────
function buildUrl(filters, page, pageSize = 50) {
  const params = new URLSearchParams({ page, pageSize });
  if (filters.ehr)       params.set('ehr',       filters.ehr);
  if (filters.stage)     params.set('stage',     filters.stage);
  if (filters.specialty) params.set('specialty', filters.specialty);
  if (filters.source)    params.set('source',    filters.source);
  if (filters.nonRcm)    params.set('nonRcm',    'true');
  if (filters.roe)       params.set('roe',       'true');
  if (filters.search)    params.set('search',    filters.search);
  return `/api/pipeline?${params.toString()}`;
}

// ─── KPI Card ─────────────────────────────────────────────────────────────────
function KpiCard({ label, value, sub, color = C.accent }) {
  return (
    <div style={{
      background: C.card,
      border:     `1px solid ${C.border}`,
      borderRadius: 12,
      padding:    '18px 22px',
      flex:       '1 1 160px',
      minWidth:   150,
    }}>
      <div style={{ color: C.textMuted, fontSize: 12, marginBottom: 6 }}>{label}</div>
      <div style={{ color, fontSize: 26, fontWeight: 700, letterSpacing: '-0.5px' }}>{value}</div>
      {sub && <div style={{ color: C.textMuted, fontSize: 11, marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

// ─── Stage badge ──────────────────────────────────────────────────────────────
function StageBadge({ stage }) {
  const color = STAGE_COLORS[stage] || C.textMuted;
  return (
    <span style={{
      background: color + '22',
      color,
      border:     `1px solid ${color}44`,
      borderRadius: 4,
      padding:    '2px 7px',
      fontSize:   11,
      fontWeight: 600,
      whiteSpace: 'nowrap',
    }}>
      {stage || '—'}
    </span>
  );
}

// ─── ROE badge ────────────────────────────────────────────────────────────────
function RoeBadge({ value }) {
  if (!value) return <span style={{ color: C.textMuted }}>—</span>;
  return <span title="ROE flag">🔴</span>;
}

// ─── ICP badge ────────────────────────────────────────────────────────────────
function IcpBadge({ value }) {
  if (!value) return <span style={{ color: C.green, fontSize: 12 }}>✓ ICP</span>;
  return <span style={{ color: C.amber, fontSize: 12 }}>⚠ Non-RCM</span>;
}

// ─── Chart section ────────────────────────────────────────────────────────────
function Charts({ agg }) {
  if (!agg) return null;

  const ehrData = Object.entries(agg.byEhr || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, value]) => ({ name, value }));

  const stageData = Object.entries(agg.byStage || {})
    .sort((a, b) => b[1] - a[1])
    .map(([name, value]) => ({ name, value }));

  const specialtyData = (agg.topSpecialties || []).slice(0, 10);

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
      gap: 16,
      marginBottom: 24,
    }}>
      {/* EHR Donut */}
      <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 16 }}>
        <div style={{ color: C.textSec, fontSize: 13, fontWeight: 600, marginBottom: 12 }}>EHR Distribution</div>
        <ResponsiveContainer width="100%" height={220}>
          <PieChart>
            <Pie data={ehrData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={80} innerRadius={40}>
              {ehrData.map((_, i) => (
                <Cell key={i} fill={C.chartColors[i % C.chartColors.length]} />
              ))}
            </Pie>
            <Tooltip
              contentStyle={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8 }}
              labelStyle={{ color: C.textPri }}
            />
            <Legend
              iconType="circle"
              iconSize={8}
              formatter={(v) => <span style={{ color: C.textSec, fontSize: 11 }}>{v}</span>}
            />
          </PieChart>
        </ResponsiveContainer>
      </div>

      {/* Stage Funnel */}
      <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 16 }}>
        <div style={{ color: C.textSec, fontSize: 13, fontWeight: 600, marginBottom: 12 }}>Stage Funnel</div>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={stageData} layout="vertical" margin={{ left: 8, right: 16 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
            <XAxis type="number" tick={{ fill: C.textMuted, fontSize: 10 }} />
            <YAxis type="category" dataKey="name" tick={{ fill: C.textSec, fontSize: 10 }} width={120} />
            <Tooltip
              contentStyle={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8 }}
              labelStyle={{ color: C.textPri }}
            />
            <Bar dataKey="value" fill={C.accent} radius={[0, 4, 4, 0]}>
              {stageData.map((entry, i) => (
                <Cell key={i} fill={STAGE_COLORS[entry.name] || C.accent} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Top Specialties */}
      <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 16 }}>
        <div style={{ color: C.textSec, fontSize: 13, fontWeight: 600, marginBottom: 12 }}>Top Specialties</div>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={specialtyData} layout="vertical" margin={{ left: 8, right: 16 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
            <XAxis type="number" tick={{ fill: C.textMuted, fontSize: 10 }} />
            <YAxis type="category" dataKey="name" tick={{ fill: C.textSec, fontSize: 10 }} width={120} />
            <Tooltip
              contentStyle={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8 }}
              labelStyle={{ color: C.textPri }}
            />
            <Bar dataKey="count" fill={C.green} radius={[0, 4, 4, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ─── Account Table ────────────────────────────────────────────────────────────
function AccountTable({ records, meta, page, setPage }) {
  const [hovered, setHovered] = useState(null);

  if (!records?.length) {
    return (
      <div style={{ color: C.textMuted, textAlign: 'center', padding: '40px 0' }}>
        No accounts match the current filters.
      </div>
    );
  }

  const th = (label) => (
    <th style={{
      padding:    '10px 14px',
      textAlign:  'left',
      color:      C.textMuted,
      fontSize:   11,
      fontWeight: 600,
      borderBottom: `1px solid ${C.border}`,
      whiteSpace: 'nowrap',
    }}>
      {label}
    </th>
  );

  return (
    <>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              {th('Account Name')}{th('EHR')}{th('Stage')}{th('Specialty')}
              {th('ROE')}{th('ICP')}{th('Providers')}{th('Revenue')}
            </tr>
          </thead>
          <tbody>
            {records.map((r, i) => (
              <tr
                key={r.id || i}
                onMouseEnter={() => setHovered(i)}
                onMouseLeave={() => setHovered(null)}
                style={{
                  background: hovered === i ? '#ffffff08' : 'transparent',
                  transition: 'background 0.1s',
                }}
              >
                <td style={{ padding: '8px 14px', color: C.textPri, fontSize: 13, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {r.accountName}
                </td>
                <td style={{ padding: '8px 14px', color: C.textSec, fontSize: 12 }}>
                  {r.ehr || '—'}
                </td>
                <td style={{ padding: '8px 14px' }}>
                  <StageBadge stage={r.stage} />
                </td>
                <td style={{ padding: '8px 14px', color: C.textSec, fontSize: 12, maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {r.specialty || '—'}
                </td>
                <td style={{ padding: '8px 14px', textAlign: 'center' }}>
                  <RoeBadge value={r.potentialRoe} />
                </td>
                <td style={{ padding: '8px 14px' }}>
                  <IcpBadge value={r.notInRcmIcp} />
                </td>
                <td style={{ padding: '8px 14px', color: C.textSec, fontSize: 12, textAlign: 'right' }}>
                  {r.providers != null ? r.providers : '—'}
                </td>
                <td style={{ padding: '8px 14px', color: C.textSec, fontSize: 12, textAlign: 'right' }}>
                  {r.annualRevenue ? fmt(r.annualRevenue, 'currency') : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {meta && meta.totalPages > 1 && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          gap: 8, marginTop: 20,
        }}>
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
            style={paginationBtn(page <= 1)}
          >
            ← Prev
          </button>
          <span style={{ color: C.textSec, fontSize: 12 }}>
            Page {meta.page} of {meta.totalPages} ({fmt(meta.total)} accounts)
          </span>
          <button
            onClick={() => setPage((p) => Math.min(meta.totalPages, p + 1))}
            disabled={page >= meta.totalPages}
            style={paginationBtn(page >= meta.totalPages)}
          >
            Next →
          </button>
        </div>
      )}
    </>
  );
}

function paginationBtn(disabled) {
  return {
    background:   disabled ? C.border : C.card,
    color:        disabled ? C.textMuted : C.textPri,
    border:       `1px solid ${C.border}`,
    borderRadius: 6,
    padding:      '6px 14px',
    cursor:       disabled ? 'not-allowed' : 'pointer',
    fontSize:     13,
  };
}

// ─── Filter bar ───────────────────────────────────────────────────────────────
function FilterBar({ filters, setFilters, agg, onClear }) {
  const [searchInput, setSearchInput] = useState(filters.search || '');
  const debounceRef = useRef(null);

  const handleSearch = (val) => {
    setSearchInput(val);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setFilters((f) => ({ ...f, search: val }));
    }, 300);
  };

  const ehrOptions    = Object.keys(agg?.byEhr    || {}).sort();
  const stageOptions  = Object.keys(agg?.byStage  || {}).sort();
  const sourceOptions = Object.keys(agg?.bySource || {}).sort();
  const specialtyOptions = (agg?.topSpecialties || []).map((s) => s.name);

  const sel = (label, key, options) => (
    <select
      value={filters[key] || ''}
      onChange={(e) => setFilters((f) => ({ ...f, [key]: e.target.value || undefined }))}
      style={selectStyle}
    >
      <option value="">{label}</option>
      {options.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  );

  return (
    <div style={{
      background: C.card,
      border:     `1px solid ${C.border}`,
      borderRadius: 12,
      padding:    '14px 18px',
      marginBottom: 20,
      display:    'flex',
      flexWrap:   'wrap',
      gap:        10,
      alignItems: 'center',
    }}>
      {sel('All EHRs',       'ehr',       ehrOptions)}
      {sel('All Stages',     'stage',     stageOptions)}
      {sel('All Specialties','specialty', specialtyOptions)}
      {sel('All Sources',    'source',    sourceOptions)}

      <label style={{ color: C.textSec, fontSize: 12, display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={filters.nonRcm || false}
          onChange={(e) => setFilters((f) => ({ ...f, nonRcm: e.target.checked || undefined }))}
          style={{ accentColor: C.amber }}
        />
        Non-RCM ICP
      </label>

      <label style={{ color: C.textSec, fontSize: 12, display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={filters.roe || false}
          onChange={(e) => setFilters((f) => ({ ...f, roe: e.target.checked || undefined }))}
          style={{ accentColor: C.red }}
        />
        ROE Flagged
      </label>

      <input
        type="text"
        placeholder="🔍 Search accounts…"
        value={searchInput}
        onChange={(e) => handleSearch(e.target.value)}
        style={{
          ...selectStyle,
          flex: '1 1 180px',
          minWidth: 160,
        }}
      />

      <button onClick={onClear} style={{
        background: 'transparent',
        color:      C.textMuted,
        border:     `1px solid ${C.border}`,
        borderRadius: 6,
        padding:    '5px 12px',
        cursor:     'pointer',
        fontSize:   12,
      }}>
        Clear
      </button>
    </div>
  );
}

const selectStyle = {
  background:   '#13131a',
  color:        '#94a3b8',
  border:       '1px solid #2d2d3d',
  borderRadius: 6,
  padding:      '5px 10px',
  fontSize:     12,
  cursor:       'pointer',
  outline:      'none',
};

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function Home() {
  const [filters, setFilters] = useState({});
  const [page, setPage]       = useState(1);
  const [tick, setTick]       = useState(0); // manual refresh trigger

  // Auto-refresh every 60 seconds
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  // Reset to page 1 when filters change
  useEffect(() => { setPage(1); }, [filters]);

  const url = buildUrl(filters, page) + `&_t=${tick}`;
  const { data, error, isLoading } = useSWR(url, fetcher, {
    revalidateOnFocus: false,
    dedupingInterval:  5000,
  });

  const agg     = data?.aggregations;
  const records = data?.records;
  const meta    = data?.meta;

  const clearFilters = useCallback(() => {
    setFilters({});
    setPage(1);
  }, []);

  const lastUpdated = meta?.cachedAt
    ? new Date(meta.cachedAt).toLocaleTimeString()
    : 'loading…';

  return (
    <div style={{ minHeight: '100vh', background: C.bg, color: C.textPri, fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' }}>
      <Head>
        <title>🗼 Watchtower — Pipeline Dashboard</title>
        <meta name="description" content="Commure Call Center Agents — Pipeline KPI Dashboard" />
      </Head>
      <div style={{ maxWidth: 1400, margin: '0 auto', padding: '24px 20px' }}>

        {/* ── Header ── */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, marginBottom: 24 }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: C.textPri }}>
              🗼 Watchtower — Pipeline Dashboard
            </h1>
            <div style={{ color: C.textMuted, fontSize: 12, marginTop: 4 }}>
              Commure Call Center Agents · Last updated: {lastUpdated}
              {meta?.cacheAge != null && <span> ({meta.cacheAge}s ago)</span>}
            </div>
          </div>
          <button
            onClick={() => setTick((t) => t + 1)}
            style={{
              background:   C.card,
              color:        C.textSec,
              border:       `1px solid ${C.border}`,
              borderRadius: 8,
              padding:      '8px 16px',
              cursor:       'pointer',
              fontSize:     13,
            }}
          >
            {isLoading ? '⟳ Loading…' : '⟳ Refresh'}
          </button>
        </div>

        {/* ── Error state ── */}
        {error && (
          <div style={{ background: '#ef444422', border: '1px solid #ef4444', borderRadius: 8, padding: '12px 16px', marginBottom: 20, color: C.red }}>
            ⚠ Failed to load data. Retrying…
          </div>
        )}

        {/* ── Loading state (first load) ── */}
        {isLoading && !data && (
          <div style={{ textAlign: 'center', padding: '60px 0' }}>
            <div style={{ color: C.textMuted, fontSize: 14 }}>
              ⟳ Loading pipeline data from Notion…<br />
              <span style={{ fontSize: 12, marginTop: 8, display: 'block' }}>
                This may take a few minutes for large datasets (13k+ records).
              </span>
            </div>
          </div>
        )}

        {data && (
          <>
            {/* ── KPI Cards ── */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 24 }}>
              <KpiCard
                label="Total Accounts"
                value={fmt(agg?.total ?? meta?.total)}
                color={C.accent}
              />
              <KpiCard
                label="Est. Pipeline ACV"
                value={fmt((agg?.total ?? 0) * 150_000, 'currency')}
                sub="@ $150K avg ACV"
                color={C.green}
              />
              <KpiCard
                label="Non-RCM ICP"
                value={fmt(agg?.notRcmCount)}
                sub="accounts outside RCM ICP"
                color={C.amber}
              />
              <KpiCard
                label="ROE Flagged"
                value={fmt(agg?.roeCount)}
                sub="potential ROE issues"
                color={C.red}
              />
              <KpiCard
                label="Specialties Tagged"
                value={`${agg?.specialtiesTaggedPct ?? 0}%`}
                sub="of accounts have specialty"
                color={C.accent}
              />
              <KpiCard
                label="Deployed ARR"
                value={fmt(DEPLOYED_ARR, 'currency')}
                sub="Nathan Littauer $575K · Medvanta $75K"
                color={C.green}
              />
            </div>

            {/* ── Filter Bar ── */}
            <FilterBar filters={filters} setFilters={setFilters} agg={agg} onClear={clearFilters} />

            {/* ── Charts ── */}
            <Charts agg={agg} />

            {/* ── Account Table ── */}
            <div style={{
              background:   C.card,
              border:       `1px solid ${C.border}`,
              borderRadius: 12,
              overflow:     'hidden',
            }}>
              <div style={{ padding: '14px 18px', borderBottom: `1px solid ${C.border}`, color: C.textSec, fontSize: 13, fontWeight: 600 }}>
                Accounts
                {meta && <span style={{ color: C.textMuted, fontWeight: 400, marginLeft: 8 }}>
                  (showing {records?.length} of {fmt(meta.total)})
                </span>}
              </div>
              <AccountTable records={records} meta={meta} page={page} setPage={setPage} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
