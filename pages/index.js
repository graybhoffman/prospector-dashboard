/**
 * 🗼 Watchtower — Pipeline Dashboard
 * Commure Call Center Agents team
 *
 * Two-tab dashboard: Pipeline | Contacts
 * Fully schema-driven: fields, filter options, and column lists
 * are all read from /api/schema — new Notion fields appear automatically.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import Head from 'next/head';
import useSWR from 'swr';
import {
  PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer,
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
} from 'recharts';

// ─── Theme ────────────────────────────────────────────────────────────────────
const C = {
  bg:        '#0f0f14',
  card:      '#1e1e2a',
  cardHover: '#252534',
  border:    '#2d2d3d',
  textPri:   '#f1f5f9',
  textSec:   '#94a3b8',
  textMuted: '#475569',
  accent:    '#6366f1',
  green:     '#10b981',
  amber:     '#f59e0b',
  red:       '#ef4444',
  chartColors: [
    '#6366f1','#10b981','#f59e0b','#ef4444','#3b82f6','#8b5cf6',
    '#ec4899','#14b8a6','#f97316','#84cc16','#06b6d4','#a78bfa',
  ],
};

// Notion select option colors → CSS colors
const NOTION_COLOR = {
  default: '#94a3b8',
  gray:    '#64748b',
  brown:   '#b45309',
  orange:  '#f97316',
  yellow:  '#f59e0b',
  green:   '#10b981',
  blue:    '#3b82f6',
  purple:  '#8b5cf6',
  pink:    '#ec4899',
  red:     '#ef4444',
};

// Known stage colors for the funnel chart
const STAGE_COLOR = {
  'Prospecting':          '#6366f1',
  'Qualification':        '#8b5cf6',
  'Needs Analysis':       '#3b82f6',
  'Value Proposition':    '#06b6d4',
  'Id. Decision Makers':  '#10b981',
  'Perception Analysis':  '#84cc16',
  'Proposal/Price Quote': '#f59e0b',
  'Negotiation/Review':   '#f97316',
  'Closed Won':           '#10b981',
  'Closed Lost':          '#ef4444',
};

// ─── Column defaults ──────────────────────────────────────────────────────────
const PIPELINE_DEFAULT_COLS = new Set([
  'Account Name', 'EHR', 'Stage', 'Specialty',
  'Potential ROE Issue', 'Not in RCM ICP', 'Providers #', 'Annual Revenue ($)',
]);

const CONTACTS_DEFAULT_COLS = new Set([
  'Full Name', 'Title/Headline', 'Company Name',
  'Email', 'Source', 'In SFDC', 'In Pipeline',
]);

// Quick filter fields shown in the Pipeline filter bar
const PIPELINE_QUICK_FILTERS = [
  'EHR', 'Stage', 'Specialty', 'Source Category', 'Priority', 'MM / Ent', 'Outreach Tactic',
];

// Quick filter fields for Contacts
const CONTACTS_QUICK_FILTERS = [
  'Source', 'Connection Degree',
];

const DEPLOYED_ARR = 650_000;

// ─── Utilities ────────────────────────────────────────────────────────────────
const fetcher = (url) => fetch(url).then((r) => r.json());

function fmt(n, style = 'decimal') {
  if (n == null || isNaN(n)) return '—';
  return new Intl.NumberFormat('en-US', {
    style,
    currency: 'USD',
    maximumFractionDigits: style === 'currency' ? 0 : 0,
    notation: n >= 1_000_000 ? 'compact' : 'standard',
  }).format(n);
}

function buildPipelineUrl(filters, page, pageSize = 50) {
  const p = new URLSearchParams({ page, pageSize });
  const map = {
    ehr: 'ehr', stage: 'stage', specialty: 'specialty',
    source: 'source', priority: 'priority', market: 'market',
  };
  for (const [k, v] of Object.entries(map)) {
    if (filters[k]) p.set(v, filters[k]);
  }
  if (filters.nonRcm) p.set('nonRcm', 'true');
  if (filters.roe)    p.set('roe',    'true');
  if (filters.search) p.set('search',  filters.search);
  return `/api/pipeline?${p}`;
}

function buildContactsUrl(filters, page, pageSize = 50) {
  const p = new URLSearchParams({ page, pageSize });
  if (filters.source)     p.set('source',     filters.source);
  if (filters.connDegree) p.set('connDegree',  filters.connDegree);
  if (filters.inSfdc)     p.set('inSfdc',      'true');
  if (filters.inPipeline) p.set('inPipeline',  'true');
  if (filters.search)     p.set('search',      filters.search);
  return `/api/contacts?${p}`;
}

// Get color for a select option from schema
function getSelectColor(schemaProps, fieldName, value) {
  if (!schemaProps || !fieldName || !value) return NOTION_COLOR.default;
  const opts = schemaProps[fieldName]?.options || [];
  const opt  = opts.find((o) => o.name === value);
  return NOTION_COLOR[opt?.color] || NOTION_COLOR.default;
}

// ─── Primitive components ─────────────────────────────────────────────────────
function Muted({ children = '—' }) {
  return <span style={{ color: C.textMuted }}>{children}</span>;
}

function SelectBadge({ value, color = NOTION_COLOR.default }) {
  if (!value) return <Muted />;
  return (
    <span style={{
      background:   color + '22',
      color,
      border:       `1px solid ${color}55`,
      borderRadius: 4,
      padding:      '2px 7px',
      fontSize:     11,
      fontWeight:   600,
      whiteSpace:   'nowrap',
      display:      'inline-block',
    }}>
      {value}
    </span>
  );
}

/** Renders any Notion field value based on its type */
function FieldValue({ value, type, fieldName, schemaProps }) {
  if (value === null || value === undefined) return <Muted />;

  switch (type) {
    case 'title':
      return value
        ? <span style={{ color: C.textPri, fontWeight: 500 }}>{value}</span>
        : <Muted />;

    case 'rich_text':
    case 'formula': {
      if (!value) return <Muted />;
      const s = String(value);
      const truncated = s.length > 60 ? s.slice(0, 60) + '…' : s;
      return (
        <span style={{ color: C.textSec, fontSize: 12 }} title={s.length > 60 ? s : undefined}>
          {truncated}
        </span>
      );
    }

    case 'select':
    case 'status': {
      if (!value) return <Muted />;
      const color = getSelectColor(schemaProps, fieldName, value);
      return <SelectBadge value={value} color={color} />;
    }

    case 'multi_select': {
      const arr = Array.isArray(value) ? value : [];
      if (!arr.length) return <Muted />;
      return (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
          {arr.map((v) => {
            const color = getSelectColor(schemaProps, fieldName, v);
            return <SelectBadge key={v} value={v} color={color} />;
          })}
        </div>
      );
    }

    case 'checkbox':
      return value
        ? <span style={{ color: C.green, fontSize: 14 }}>✓</span>
        : <Muted />;

    case 'number':
      return <span style={{ color: C.textSec }}>{value?.toLocaleString()}</span>;

    case 'date':
      return value
        ? <span style={{ color: C.textSec, fontSize: 12 }}>{value}</span>
        : <Muted />;

    case 'url':
      return value
        ? <a href={value} target="_blank" rel="noreferrer"
             style={{ color: C.accent, fontSize: 12, textDecoration: 'none' }}>↗ Link</a>
        : <Muted />;

    case 'email':
      return value
        ? <a href={`mailto:${value}`}
             style={{ color: C.accent, fontSize: 12, textDecoration: 'none' }}>{value}</a>
        : <Muted />;

    case 'phone_number':
      return value
        ? <span style={{ color: C.textSec, fontSize: 12 }}>{value}</span>
        : <Muted />;

    case 'relation': {
      const arr = Array.isArray(value) ? value : [];
      return arr.length
        ? <span style={{ color: C.textMuted, fontSize: 11 }}>{arr.length} linked</span>
        : <Muted />;
    }

    case 'people':
      return value
        ? <span style={{ color: C.textSec, fontSize: 12 }}>{value}</span>
        : <Muted />;

    default:
      return value
        ? <span style={{ color: C.textSec, fontSize: 12 }}>{String(value)}</span>
        : <Muted />;
  }
}

// ─── KPI Card ─────────────────────────────────────────────────────────────────
function KpiCard({ label, value, sub, color = C.accent }) {
  return (
    <div style={{
      background:   C.card,
      border:       `1px solid ${C.border}`,
      borderRadius: 12,
      padding:      '16px 20px',
      flex:         '1 1 150px',
      minWidth:     140,
    }}>
      <div style={{ color: C.textMuted, fontSize: 11, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
        {label}
      </div>
      <div style={{ color, fontSize: 24, fontWeight: 700, letterSpacing: '-0.5px' }}>
        {value}
      </div>
      {sub && (
        <div style={{ color: C.textMuted, fontSize: 10, marginTop: 4 }}>{sub}</div>
      )}
    </div>
  );
}

// ─── Column Picker ────────────────────────────────────────────────────────────
function ColumnPicker({ allCols, visibleCols, onToggle, onReset, label = 'Columns' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    function handle(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [open]);

  const visCount = allCols.filter((c) => visibleCols.has(c)).length;

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        onClick={() => setOpen((o) => !o)}
        title="Toggle column visibility"
        style={{
          background:   open ? C.border : 'transparent',
          color:        open ? C.textPri : C.textMuted,
          border:       `1px solid ${open ? C.accent : C.border}`,
          borderRadius: 6,
          padding:      '5px 10px',
          cursor:       'pointer',
          fontSize:     13,
          display:      'flex',
          alignItems:   'center',
          gap:          5,
        }}
      >
        ⚙ <span style={{ fontSize: 11 }}>{visCount}/{allCols.length}</span>
      </button>

      {open && (
        <div style={{
          position:  'absolute',
          right:     0,
          top:       'calc(100% + 6px)',
          background: C.card,
          border:    `1px solid ${C.border}`,
          borderRadius: 8,
          padding:   12,
          width:     220,
          maxHeight: 380,
          overflowY: 'auto',
          zIndex:    200,
          boxShadow: '0 12px 40px rgba(0,0,0,0.5)',
        }}>
          <div style={{
            display:      'flex',
            alignItems:   'center',
            justifyContent: 'space-between',
            marginBottom: 10,
            paddingBottom: 8,
            borderBottom: `1px solid ${C.border}`,
          }}>
            <span style={{ color: C.textSec, fontSize: 12, fontWeight: 600 }}>{label}</span>
            <button
              onClick={onReset}
              style={{ background: 'none', border: 'none', color: C.accent, fontSize: 11, cursor: 'pointer' }}
            >
              Reset defaults
            </button>
          </div>

          {allCols.map((col) => (
            <label key={col} style={{
              display:    'flex',
              alignItems: 'center',
              gap:        8,
              padding:    '4px 0',
              cursor:     'pointer',
            }}>
              <input
                type="checkbox"
                checked={visibleCols.has(col)}
                onChange={() => onToggle(col)}
                style={{ accentColor: C.accent, width: 13, height: 13 }}
              />
              <span style={{ color: C.textSec, fontSize: 12, userSelect: 'none' }}>{col}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Schema-driven Filter Bar ─────────────────────────────────────────────────
function FilterBar({ quickFilters, filters, setFilters, schemaProps, checkboxFilters = [], onClear }) {
  const [searchInput, setSearchInput] = useState(filters.search || '');
  const debounceRef = useRef(null);

  const handleSearch = (val) => {
    setSearchInput(val);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setFilters((f) => ({ ...f, search: val || undefined }));
    }, 300);
  };

  const selStyle = {
    background:   '#13131c',
    color:        C.textSec,
    border:       `1px solid ${C.border}`,
    borderRadius: 6,
    padding:      '5px 10px',
    fontSize:     12,
    cursor:       'pointer',
    outline:      'none',
  };

  return (
    <div style={{
      background:   C.card,
      border:       `1px solid ${C.border}`,
      borderRadius: 10,
      padding:      '12px 16px',
      marginBottom: 18,
      display:      'flex',
      flexWrap:     'wrap',
      gap:          10,
      alignItems:   'center',
    }}>
      {/* Schema-driven select dropdowns */}
      {quickFilters.map((fieldName) => {
        const schemaProp = schemaProps?.[fieldName];
        if (!schemaProp) return null;
        const options = schemaProp.options || [];
        const filterKey = fieldName.replace(/[^a-zA-Z]/g, '').toLowerCase();

        return (
          <select
            key={fieldName}
            value={filters[filterKey] || ''}
            onChange={(e) =>
              setFilters((f) => ({ ...f, [filterKey]: e.target.value || undefined }))
            }
            style={selStyle}
          >
            <option value="">All {fieldName}</option>
            {options.map((o) => (
              <option key={o.name} value={o.name}>{o.name}</option>
            ))}
          </select>
        );
      })}

      {/* Checkbox filters */}
      {checkboxFilters.map(({ key, label, color = C.textSec }) => (
        <label key={key} style={{
          color,
          fontSize: 12,
          display:  'flex',
          alignItems: 'center',
          gap:      5,
          cursor:   'pointer',
        }}>
          <input
            type="checkbox"
            checked={filters[key] || false}
            onChange={(e) =>
              setFilters((f) => ({ ...f, [key]: e.target.checked || undefined }))
            }
            style={{ accentColor: color, width: 13, height: 13 }}
          />
          {label}
        </label>
      ))}

      {/* Search */}
      <input
        type="text"
        placeholder="🔍 Search…"
        value={searchInput}
        onChange={(e) => handleSearch(e.target.value)}
        style={{ ...selStyle, flex: '1 1 160px', minWidth: 140 }}
      />

      {/* Clear */}
      <button
        onClick={() => { onClear(); setSearchInput(''); }}
        style={{
          background:   'transparent',
          color:        C.textMuted,
          border:       `1px solid ${C.border}`,
          borderRadius: 6,
          padding:      '5px 12px',
          cursor:       'pointer',
          fontSize:     12,
        }}
      >
        ✕ Clear
      </button>
    </div>
  );
}

// ─── Charts ───────────────────────────────────────────────────────────────────
function Charts({ agg }) {
  if (!agg) return null;

  const ehrData = Object.entries(agg.byEhr || {})
    .sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([name, value]) => ({ name, value }));

  const stageData = Object.entries(agg.byStage || {})
    .sort((a, b) => b[1] - a[1])
    .map(([name, value]) => ({ name, value }));

  const specData = (agg.topSpecialties || []).slice(0, 10);

  const chartCard = { background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 16 };
  const chartTitle = { color: C.textSec, fontSize: 12, fontWeight: 600, marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.4px' };
  const ttStyle   = { contentStyle: { background: C.card, border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 12 } };

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
      gap: 14,
      marginBottom: 20,
    }}>
      {/* EHR Donut */}
      <div style={chartCard}>
        <div style={chartTitle}>EHR Distribution</div>
        <ResponsiveContainer width="100%" height={210}>
          <PieChart>
            <Pie data={ehrData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={75} innerRadius={38}>
              {ehrData.map((_, i) => (
                <Cell key={i} fill={C.chartColors[i % C.chartColors.length]} />
              ))}
            </Pie>
            <Tooltip {...ttStyle} />
            <Legend iconType="circle" iconSize={7}
              formatter={(v) => <span style={{ color: C.textSec, fontSize: 10 }}>{v}</span>} />
          </PieChart>
        </ResponsiveContainer>
      </div>

      {/* Stage Funnel */}
      <div style={chartCard}>
        <div style={chartTitle}>Stage Funnel</div>
        <ResponsiveContainer width="100%" height={210}>
          <BarChart data={stageData} layout="vertical" margin={{ left: 4, right: 12 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
            <XAxis type="number" tick={{ fill: C.textMuted, fontSize: 9 }} />
            <YAxis type="category" dataKey="name" tick={{ fill: C.textSec, fontSize: 9 }} width={110} />
            <Tooltip {...ttStyle} />
            <Bar dataKey="value" radius={[0, 3, 3, 0]}>
              {stageData.map((entry, i) => (
                <Cell key={i} fill={STAGE_COLOR[entry.name] || C.accent} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Top Specialties */}
      <div style={chartCard}>
        <div style={chartTitle}>Top Specialties</div>
        <ResponsiveContainer width="100%" height={210}>
          <BarChart data={specData} layout="vertical" margin={{ left: 4, right: 12 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
            <XAxis type="number" tick={{ fill: C.textMuted, fontSize: 9 }} />
            <YAxis type="category" dataKey="name" tick={{ fill: C.textSec, fontSize: 9 }} width={110} />
            <Tooltip {...ttStyle} />
            <Bar dataKey="count" fill={C.green} radius={[0, 3, 3, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ─── Data Table (generic — works for both Pipeline and Contacts) ──────────────
function DataTable({ records, meta, page, setPage, visibleCols, allCols, onToggleCol, onResetCols, schema, dbKey, title }) {
  const [hovered, setHovered] = useState(null);
  const schemaProps = schema?.[dbKey]?.properties || {};

  // Ordered visible columns
  const cols = allCols.filter((c) => visibleCols.has(c));

  const thStyle = {
    padding:       '9px 12px',
    textAlign:     'left',
    color:         C.textMuted,
    fontSize:      10,
    fontWeight:    600,
    borderBottom:  `1px solid ${C.border}`,
    whiteSpace:    'nowrap',
    textTransform: 'uppercase',
    letterSpacing: '0.4px',
    background:    C.card,
  };

  return (
    <div style={{
      background:   C.card,
      border:       `1px solid ${C.border}`,
      borderRadius: 12,
      overflow:     'hidden',
    }}>
      {/* Table header */}
      <div style={{
        display:        'flex',
        alignItems:     'center',
        justifyContent: 'space-between',
        padding:        '12px 16px',
        borderBottom:   `1px solid ${C.border}`,
      }}>
        <span style={{ color: C.textSec, fontSize: 13, fontWeight: 600 }}>
          {title}
          {meta && (
            <span style={{ color: C.textMuted, fontWeight: 400, marginLeft: 8, fontSize: 12 }}>
              ({records?.length ?? 0} shown · {(meta.total ?? 0).toLocaleString()} total)
            </span>
          )}
        </span>
        <ColumnPicker
          allCols={allCols}
          visibleCols={visibleCols}
          onToggle={onToggleCol}
          onReset={onResetCols}
          label={`${title} columns`}
        />
      </div>

      {/* Empty state */}
      {(!records || records.length === 0) && (
        <div style={{ color: C.textMuted, textAlign: 'center', padding: '40px 0', fontSize: 13 }}>
          No records match the current filters.
        </div>
      )}

      {/* Table */}
      {records && records.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 500 }}>
            <thead>
              <tr>
                {cols.map((col) => (
                  <th key={col} style={thStyle}>{col}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {records.map((r, i) => (
                <tr
                  key={r.id || i}
                  onMouseEnter={() => setHovered(i)}
                  onMouseLeave={() => setHovered(null)}
                  style={{
                    background:  hovered === i ? C.cardHover : 'transparent',
                    transition:  'background 0.1s',
                  }}
                >
                  {cols.map((col) => {
                    const val  = r.fields?.[col];
                    const type = schemaProps[col]?.type || 'rich_text';
                    const isTitleCol = type === 'title';

                    return (
                      <td key={col} style={{
                        padding:       '7px 12px',
                        borderBottom:  `1px solid ${C.border}1a`,
                        maxWidth:      isTitleCol ? 240 : 180,
                        overflow:      'hidden',
                        textOverflow:  'ellipsis',
                        whiteSpace:    isTitleCol ? 'nowrap' : undefined,
                        verticalAlign: 'middle',
                      }}>
                        <FieldValue
                          value={val}
                          type={type}
                          fieldName={col}
                          schemaProps={schemaProps}
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {meta && meta.totalPages > 1 && (
        <div style={{
          display:        'flex',
          alignItems:     'center',
          justifyContent: 'center',
          gap:            10,
          padding:        '14px 0',
          borderTop:      `1px solid ${C.border}`,
        }}>
          <PaginationBtn disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>← Prev</PaginationBtn>
          <span style={{ color: C.textSec, fontSize: 12 }}>
            Page {meta.page} of {meta.totalPages}
          </span>
          <PaginationBtn disabled={page >= meta.totalPages} onClick={() => setPage((p) => p + 1)}>Next →</PaginationBtn>
        </div>
      )}
    </div>
  );
}

function PaginationBtn({ disabled, onClick, children }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        background:   disabled ? 'transparent' : C.card,
        color:        disabled ? C.textMuted : C.textSec,
        border:       `1px solid ${disabled ? C.border + '44' : C.border}`,
        borderRadius: 6,
        padding:      '5px 14px',
        cursor:       disabled ? 'not-allowed' : 'pointer',
        fontSize:     12,
      }}
    >
      {children}
    </button>
  );
}

// ─── Column state hook (localStorage-backed) ──────────────────────────────────
function useColumnState(storageKey, defaults) {
  const [cols, setCols] = useState(defaults);

  // Hydrate from localStorage after mount (avoid SSR mismatch)
  useEffect(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) setCols(new Set(JSON.parse(saved)));
    } catch {}
  }, [storageKey]);

  const toggle = useCallback((col) => {
    setCols((prev) => {
      const next = new Set(prev);
      next.has(col) ? next.delete(col) : next.add(col);
      try { localStorage.setItem(storageKey, JSON.stringify([...next])); } catch {}
      return next;
    });
  }, [storageKey]);

  const reset = useCallback(() => {
    setCols(defaults);
    try { localStorage.removeItem(storageKey); } catch {}
  }, [storageKey, defaults]);

  return [cols, toggle, reset];
}

// ─── Pipeline Tab ─────────────────────────────────────────────────────────────
function PipelineTab({ schema }) {
  const [filters, setFilters] = useState({});
  const [page, setPage]       = useState(1);
  const [tick, setTick]       = useState(0);
  const [pipelineCols, togglePipelineCol, resetPipelineCols] =
    useColumnState('wt_pipeline_cols', PIPELINE_DEFAULT_COLS);

  // Reset page when filters change
  useEffect(() => { setPage(1); }, [filters]);

  // Auto-refresh every 60s
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  const url = buildPipelineUrl(filters, page) + `&_t=${tick}`;
  const { data, error, isLoading } = useSWR(url, fetcher, {
    revalidateOnFocus:  false,
    dedupingInterval:   5000,
  });

  const schemaProps = schema?.pipeline?.properties || {};
  const propOrder   = schema?.pipeline?.propOrder  || [];
  const agg         = data?.aggregations;
  const records     = data?.records;
  const meta        = data?.meta;

  const clearFilters = () => setFilters({});

  return (
    <>
      {/* KPI Cards */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 18 }}>
        <KpiCard label="Total Accounts"   value={fmt(agg?.total)}               color={C.accent} />
        <KpiCard label="Est. Pipeline ACV" value={fmt((agg?.total ?? 0) * 150_000, 'currency')}
          sub="@ $150K avg ACV" color={C.green} />
        <KpiCard label="Non-RCM ICP"      value={fmt(agg?.notRcmCount)}          color={C.amber}
          sub="outside RCM ICP" />
        <KpiCard label="ROE Flagged"       value={fmt(agg?.roeCount)}             color={C.red}
          sub="potential ROE issues" />
        <KpiCard label="Specialties Tagged" value={`${agg?.specialtiesTaggedPct ?? 0}%`} color={C.accent} />
        <KpiCard label="Deployed ARR"      value={fmt(DEPLOYED_ARR, 'currency')} color={C.green}
          sub="Nathan Littauer $575K · Medvanta $75K" />
      </div>

      {/* Filter Bar */}
      <FilterBar
        quickFilters={PIPELINE_QUICK_FILTERS}
        filters={filters}
        setFilters={setFilters}
        schemaProps={schemaProps}
        checkboxFilters={[
          { key: 'nonRcm', label: 'Non-RCM ICP only', color: C.amber },
          { key: 'roe',    label: 'ROE Flagged only',  color: C.red  },
        ]}
        onClear={clearFilters}
      />

      {/* Loading / Error */}
      {error && (
        <div style={{ background: '#ef444422', border: `1px solid ${C.red}`, borderRadius: 8,
          padding: '10px 14px', marginBottom: 14, color: C.red, fontSize: 13 }}>
          ⚠ Failed to load pipeline data.
        </div>
      )}
      {isLoading && !data && (
        <div style={{ textAlign: 'center', padding: '50px 0', color: C.textMuted }}>
          <div style={{ fontSize: 14, marginBottom: 8 }}>⟳ Loading pipeline from Notion…</div>
          <div style={{ fontSize: 12 }}>Large databases may take a few minutes on first load.</div>
        </div>
      )}

      {/* Charts */}
      {data && <Charts agg={agg} />}

      {/* Table */}
      {data && (
        <DataTable
          records={records}
          meta={meta}
          page={page}
          setPage={setPage}
          visibleCols={pipelineCols}
          allCols={propOrder.length ? propOrder : [...PIPELINE_DEFAULT_COLS]}
          onToggleCol={togglePipelineCol}
          onResetCols={resetPipelineCols}
          schema={schema}
          dbKey="pipeline"
          title="Accounts"
        />
      )}

      {/* Cache info */}
      {meta && (
        <div style={{ color: C.textMuted, fontSize: 11, textAlign: 'right', marginTop: 8 }}>
          Data cached {meta.cacheAge}s ago · {new Date(meta.cachedAt).toLocaleTimeString()}
        </div>
      )}
    </>
  );
}

// ─── Contacts Tab ─────────────────────────────────────────────────────────────
function ContactsTab({ schema }) {
  const [filters, setFilters] = useState({});
  const [page, setPage]       = useState(1);
  const [contactsCols, toggleContactsCol, resetContactsCols] =
    useColumnState('wt_contacts_cols', CONTACTS_DEFAULT_COLS);

  useEffect(() => { setPage(1); }, [filters]);

  const url = buildContactsUrl(filters, page);
  const { data, error, isLoading } = useSWR(url, fetcher, {
    revalidateOnFocus: false,
    dedupingInterval:  5000,
  });

  const schemaProps = schema?.contacts?.properties || {};
  const propOrder   = schema?.contacts?.propOrder  || [];
  const records     = data?.records;
  const meta        = data?.meta;

  const clearFilters = () => setFilters({});

  return (
    <>
      {/* Filter Bar */}
      <FilterBar
        quickFilters={CONTACTS_QUICK_FILTERS}
        filters={filters}
        setFilters={setFilters}
        schemaProps={schemaProps}
        checkboxFilters={[
          { key: 'inSfdc',     label: 'In SFDC',       color: C.green },
          { key: 'inPipeline', label: 'In Pipeline',   color: C.accent },
        ]}
        onClear={clearFilters}
      />

      {/* Loading / Error */}
      {error && (
        <div style={{ background: '#ef444422', border: `1px solid ${C.red}`, borderRadius: 8,
          padding: '10px 14px', marginBottom: 14, color: C.red, fontSize: 13 }}>
          ⚠ Failed to load contacts data.
        </div>
      )}
      {isLoading && !data && (
        <div style={{ textAlign: 'center', padding: '50px 0', color: C.textMuted, fontSize: 13 }}>
          ⟳ Loading contacts from Notion…
        </div>
      )}

      {/* Table */}
      {data && (
        <DataTable
          records={records}
          meta={meta}
          page={page}
          setPage={setPage}
          visibleCols={contactsCols}
          allCols={propOrder.length ? propOrder : [...CONTACTS_DEFAULT_COLS]}
          onToggleCol={toggleContactsCol}
          onResetCols={resetContactsCols}
          schema={schema}
          dbKey="contacts"
          title="Contacts"
        />
      )}

      {meta && (
        <div style={{ color: C.textMuted, fontSize: 11, textAlign: 'right', marginTop: 8 }}>
          Data cached {meta.cacheAge}s ago · {new Date(meta.cachedAt).toLocaleTimeString()}
        </div>
      )}
    </>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function Home() {
  const [activeTab, setActiveTab] = useState('pipeline');

  // Schema — refresh every 10 minutes, detect changes via hash
  const { data: schema } = useSWR('/api/schema', fetcher, {
    revalidateOnFocus: false,
    refreshInterval:   10 * 60 * 1000,
  });

  // Schema change detection
  const schemaHashRef = useRef(null);
  useEffect(() => {
    if (!schema?.hash) return;
    if (schemaHashRef.current && schemaHashRef.current !== schema.hash) {
      console.log('[Watchtower] Schema changed — filter options & columns updated automatically');
    }
    schemaHashRef.current = schema.hash;
  }, [schema?.hash]);

  const tabBtn = (id, label) => (
    <button
      onClick={() => setActiveTab(id)}
      style={{
        background:   activeTab === id ? C.accent + '22' : 'transparent',
        color:        activeTab === id ? C.accent : C.textSec,
        border:       `1px solid ${activeTab === id ? C.accent + '66' : 'transparent'}`,
        borderRadius: 8,
        padding:      '6px 18px',
        cursor:       'pointer',
        fontSize:     13,
        fontWeight:   activeTab === id ? 600 : 400,
        transition:   'all 0.15s',
      }}
    >
      {label}
    </button>
  );

  return (
    <div style={{ minHeight: '100vh', background: C.bg, color: C.textPri }}>
      <Head>
        <title>🗼 Watchtower — Pipeline Dashboard</title>
        <meta name="description" content="Commure Call Center Agents — Pipeline KPI Dashboard" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>

      <div style={{ maxWidth: 1440, margin: '0 auto', padding: '20px 18px' }}>

        {/* ── Header ── */}
        <div style={{
          display:        'flex',
          alignItems:     'center',
          justifyContent: 'space-between',
          flexWrap:       'wrap',
          gap:            10,
          marginBottom:   20,
          paddingBottom:  16,
          borderBottom:   `1px solid ${C.border}`,
        }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, letterSpacing: '-0.3px' }}>
              🗼 Watchtower
            </h1>
            <div style={{ color: C.textMuted, fontSize: 12, marginTop: 3 }}>
              Commure Call Center Agents · Pipeline Dashboard
              {schema?.stale && <span style={{ color: C.amber }}> · schema stale</span>}
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {/* Tab bar */}
            <div style={{
              display:      'flex',
              gap:          4,
              background:   C.card,
              border:       `1px solid ${C.border}`,
              borderRadius: 10,
              padding:      4,
            }}>
              {tabBtn('pipeline', '📊 Pipeline')}
              {tabBtn('contacts', '👥 Contacts')}
            </div>
          </div>
        </div>

        {/* ── Tab content ── */}
        {activeTab === 'pipeline' && <PipelineTab schema={schema} />}
        {activeTab === 'contacts' && <ContactsTab schema={schema} />}

      </div>
    </div>
  );
}
