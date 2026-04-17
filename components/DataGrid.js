/**
 * DataGrid — Full-featured data grid component
 * Sortable columns, column filters, global search, pagination,
 * saved views, column visibility toggle, CSV export, loading skeleton.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import useSWR from 'swr';

const fetcher = (url) => fetch(url).then((r) => r.json());

// ─── Stage color maps (export for use in column defs) ─────────────────────────
export const STAGE_COLORS = {
  Prospect:            '#374151',
  Outreach:            '#1e3a5f',
  Discovery:           '#1e4d3a',
  SQL:                 '#3b3500',
  'Disco Scheduled':   '#4a2d00',
  Negotiations:        '#4a1d00',
  'Pilot Deployment':  '#3b0066',
  'Full Deployment':   '#003366',
  'Closed-Won':        '#003300',
  'Closed-Lost':       '#3b0000',
};

export const STAGE_TEXT_COLORS = {
  Prospect:            '#9ca3af',
  Outreach:            '#60a5fa',
  Discovery:           '#34d399',
  SQL:                 '#fcd34d',
  'Disco Scheduled':   '#fb923c',
  Negotiations:        '#f87171',
  'Pilot Deployment':  '#c084fc',
  'Full Deployment':   '#38bdf8',
  'Closed-Won':        '#4ade80',
  'Closed-Lost':       '#6b7280',
};

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
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function pageBtnStyle(disabled) {
  return {
    background:   disabled ? 'transparent' : C.card,
    color:        disabled ? C.textMuted   : C.textSec,
    border:       `1px solid ${disabled ? C.border + '44' : C.border}`,
    borderRadius: 6,
    padding:      '4px 12px',
    cursor:       disabled ? 'not-allowed' : 'pointer',
    fontSize:     12,
  };
}

// Skeleton rows while loading
const SKELETON_WIDTHS = [60, 80, 45, 70, 55, 85, 50, 65, 75, 40];

// ─── DataGrid ─────────────────────────────────────────────────────────────────
/**
 * @param {Object} props
 * @param {Array}  props.columns    [{key, label, width?, render?, filterable?, sortable?, getValue?}]
 * @param {string} props.fetchUrl   Base API endpoint
 * @param {Object} props.defaultSort  {key, dir} — initial sort
 * @param {string} props.savedViewsKey  localStorage namespace for saved views
 * @param {Array}  props.quickFilters   [{label, params: {k:v,...}}] — quick filter chips
 * @param {string} props.dataKey    Key in API response that holds the rows array
 * @param {string} props.totalKey   Key in API response that holds total count (default 'total')
 * @param {string} props.emptyState  Custom empty state message
 * @param {boolean} props.selectable  Enable row checkboxes + selection tracking
 * @param {Function} props.bulkActions  Render prop: ({selectedIds, selectedRows, clearSelection}) => JSX
 */
export default function DataGrid({
  columns,
  fetchUrl,
  defaultSort = { key: null, dir: 'asc' },
  savedViewsKey,
  quickFilters = [],
  dataKey,
  totalKey = 'total',
  emptyState,
  selectable = false,
  bulkActions = null,
  onRowClick = null,
}) {
  const [sort, setSort]                         = useState(defaultSort || { key: null, dir: 'asc' });
  const [colFilters, setColFilters]             = useState({});   // display state (immediate)
  const [debouncedFilters, setDebouncedFilters] = useState({});   // used in URL (debounced)
  const [searchVal, setSearchVal]               = useState('');   // display
  const [debouncedSearch, setDebouncedSearch]   = useState('');   // used in URL
  const [activeQF, setActiveQF]                 = useState({});   // quick filter label → bool
  const [page, setPage]                         = useState(1);
  const [visibleCols, setVisibleCols]           = useState(null); // null = all
  const [savedViews, setSavedViews]             = useState([]);
  const [showColPicker, setShowColPicker]       = useState(false);
  const [showViews, setShowViews]               = useState(false);
  const [selectedIds, setSelectedIds]           = useState(new Set());

  const debTimers = useRef({});
  const colPickerRef = useRef(null);
  const viewsRef     = useRef(null);

  // ── Load saved state from localStorage ──────────────────────────────────
  useEffect(() => {
    if (!savedViewsKey) return;
    try {
      const v = JSON.parse(localStorage.getItem(savedViewsKey + '_views') || '[]');
      setSavedViews(v);
    } catch {}
    try {
      const c = JSON.parse(localStorage.getItem(savedViewsKey + '_cols') || 'null');
      if (c) setVisibleCols(new Set(c));
    } catch {}
  }, [savedViewsKey]);

  // ── Close dropdowns on outside click ────────────────────────────────────
  useEffect(() => {
    function handler(e) {
      if (colPickerRef.current && !colPickerRef.current.contains(e.target)) setShowColPicker(false);
      if (viewsRef.current && !viewsRef.current.contains(e.target)) setShowViews(false);
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // ── Build fetch URL ──────────────────────────────────────────────────────
  const url = (() => {
    const p = new URLSearchParams();
    p.set('page', page);
    p.set('limit', 50);
    if (debouncedSearch) p.set('search', debouncedSearch);
    if (sort.key) { p.set('sort', sort.key); p.set('dir', sort.dir); }

    // Column filters
    Object.entries(debouncedFilters).forEach(([k, v]) => {
      if (v && String(v).trim()) p.set(k, String(v).trim());
    });

    // Quick filters — merge their params
    Object.entries(activeQF).forEach(([label, active]) => {
      if (!active) return;
      const qf = quickFilters.find((q) => q.label === label);
      if (qf?.params) {
        Object.entries(qf.params).forEach(([k, v]) => p.set(k, v));
      }
    });

    return `${fetchUrl}?${p.toString()}`;
  })();

  const { data, isLoading } = useSWR(url, fetcher, {
    revalidateOnFocus: false,
    dedupingInterval: 3000,
  });

  const rows      = data?.[dataKey] || [];
  const total     = data?.[totalKey] || 0;
  const pageSize  = 50;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const from      = total > 0 ? (page - 1) * pageSize + 1 : 0;
  const to        = Math.min(page * pageSize, total);

  // ── Derived columns ──────────────────────────────────────────────────────
  const allKeys         = columns.map((c) => c.key);
  const effectiveVis    = visibleCols || new Set(allKeys);
  const visibleColumns  = columns.filter((c) => effectiveVis.has(c.key));

  // ── Handlers ─────────────────────────────────────────────────────────────
  function handleColFilter(key, val) {
    setColFilters((prev) => ({ ...prev, [key]: val }));
    clearTimeout(debTimers.current[key]);
    debTimers.current[key] = setTimeout(() => {
      setDebouncedFilters((prev) => ({ ...prev, [key]: val }));
      setPage(1);
    }, 300);
  }

  function handleSearch(val) {
    setSearchVal(val);
    clearTimeout(debTimers.current['__search__']);
    debTimers.current['__search__'] = setTimeout(() => {
      setDebouncedSearch(val);
      setPage(1);
    }, 300);
  }

  function handleSort(key) {
    setSort((prev) => ({
      key,
      dir: prev.key === key && prev.dir === 'asc' ? 'desc' : 'asc',
    }));
    setPage(1);
  }

  function toggleQF(label) {
    setActiveQF((prev) => ({ ...prev, [label]: !prev[label] }));
    setPage(1);
  }

  function toggleCol(key) {
    setVisibleCols((prev) => {
      const cur = prev || new Set(allKeys);
      const next = new Set(cur);
      next.has(key) ? next.delete(key) : next.add(key);
      if (savedViewsKey) {
        try { localStorage.setItem(savedViewsKey + '_cols', JSON.stringify([...next])); } catch {}
      }
      return next;
    });
  }

  function resetCols() {
    setVisibleCols(null);
    if (savedViewsKey) {
      try { localStorage.removeItem(savedViewsKey + '_cols'); } catch {}
    }
  }

  // ── Saved views ───────────────────────────────────────────────────────────
  function saveView() {
    const name = window.prompt('Name this view:');
    if (!name?.trim()) return;
    const view = {
      name: name.trim(),
      search:      debouncedSearch,
      colFilters:  debouncedFilters,
      sort,
      visibleCols: [...effectiveVis],
      quickFilters: activeQF,
      savedAt: Date.now(),
    };
    const updated = [...savedViews, view];
    setSavedViews(updated);
    if (savedViewsKey) {
      try { localStorage.setItem(savedViewsKey + '_views', JSON.stringify(updated)); } catch {}
    }
    setShowViews(false);
  }

  function loadView(view) {
    setDebouncedSearch(view.search || '');
    setSearchVal(view.search || '');
    const cf = view.colFilters || {};
    setColFilters(cf);
    setDebouncedFilters(cf);
    if (view.sort) setSort(view.sort);
    if (view.visibleCols) setVisibleCols(new Set(view.visibleCols));
    if (view.quickFilters) setActiveQF(view.quickFilters);
    setPage(1);
    setShowViews(false);
  }

  function deleteView(idx) {
    const updated = savedViews.filter((_, i) => i !== idx);
    setSavedViews(updated);
    if (savedViewsKey) {
      try { localStorage.setItem(savedViewsKey + '_views', JSON.stringify(updated)); } catch {}
    }
  }

  // ── Export CSV ────────────────────────────────────────────────────────────
  function exportCsv() {
    if (!rows.length) return;
    const headers = visibleColumns.map((c) => `"${c.label}"`);
    const csvRows = rows.map((row) =>
      visibleColumns.map((c) => {
        const val = c.getValue ? c.getValue(row) : row[c.key];
        const s = val != null ? String(val).replace(/"/g, '""') : '';
        return `"${s}"`;
      })
    );
    const csv = [headers.join(','), ...csvRows.map((r) => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const burl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = burl;
    a.download = `${savedViewsKey || 'export'}_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(burl);
  }

  const hasActiveFilters =
    debouncedSearch ||
    Object.values(debouncedFilters).some((v) => v) ||
    Object.values(activeQF).some(Boolean);

  function clearAll() {
    setSearchVal('');
    setDebouncedSearch('');
    setColFilters({});
    setDebouncedFilters({});
    setActiveQF({});
    setPage(1);
  }

  // ── Row selection ─────────────────────────────────────────────────────────
  function toggleRow(id) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (selectedIds.size === rows.length && rows.length > 0) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(rows.map((r) => r.id || r.sfdc_id)));
    }
  }

  function clearSelection() {
    setSelectedIds(new Set());
  }

  const selectedRows = rows.filter((r) => selectedIds.has(r.id || r.sfdc_id));

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div>
      {/* ── Toolbar ── */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 10 }}>
        {/* Global search */}
        <input
          value={searchVal}
          onChange={(e) => handleSearch(e.target.value)}
          placeholder="🔍 Search…"
          style={{
            background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8,
            color: C.textPri, padding: '6px 10px', fontSize: 12, outline: 'none', width: 200,
          }}
        />

        {/* Quick filters */}
        {quickFilters.map((qf) => {
          const active = !!activeQF[qf.label];
          return (
            <button key={qf.label} onClick={() => toggleQF(qf.label)} style={{
              background:   active ? C.accent + '33' : C.surface,
              color:        active ? C.accent         : C.textMuted,
              border:       `1px solid ${active ? C.accent + '66' : C.border}`,
              borderRadius: 20, padding: '4px 12px', cursor: 'pointer', fontSize: 12,
              fontWeight:   active ? 600 : 400,
            }}>
              {qf.label}
            </button>
          );
        })}

        {hasActiveFilters && (
          <button onClick={clearAll} style={{
            background: 'transparent', color: C.textMuted,
            border: `1px solid ${C.border}`, borderRadius: 6, padding: '5px 10px',
            cursor: 'pointer', fontSize: 12,
          }}>
            ✕ Clear
          </button>
        )}

        {/* Right side controls */}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
          {/* Save view */}
          <button onClick={saveView} style={{
            background: C.surface, color: C.textMuted, border: `1px solid ${C.border}`,
            borderRadius: 6, padding: '5px 10px', cursor: 'pointer', fontSize: 12,
          }}>
            💾 Save View
          </button>

          {/* Saved views dropdown */}
          {savedViews.length > 0 && (
            <div ref={viewsRef} style={{ position: 'relative' }}>
              <button onClick={() => setShowViews((v) => !v)} style={{
                background: showViews ? C.border : C.surface, color: C.textMuted,
                border: `1px solid ${C.border}`, borderRadius: 6, padding: '5px 10px',
                cursor: 'pointer', fontSize: 12,
              }}>
                📋 Views ({savedViews.length}) ▾
              </button>
              {showViews && (
                <div style={{
                  position: 'absolute', right: 0, top: 'calc(100% + 4px)',
                  background: C.card, border: `1px solid ${C.border}`, borderRadius: 8,
                  padding: 8, minWidth: 180, maxHeight: 280, overflowY: 'auto', zIndex: 200,
                  boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
                }}>
                  {savedViews.map((v, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <button onClick={() => loadView(v)} style={{
                        flex: 1, background: 'none', border: 'none', color: C.textSec,
                        cursor: 'pointer', padding: '6px 8px', textAlign: 'left', fontSize: 12,
                        borderRadius: 4,
                      }}>
                        {v.name}
                      </button>
                      <button onClick={() => deleteView(i)} style={{
                        background: 'none', border: 'none', color: C.textMuted,
                        cursor: 'pointer', fontSize: 13, padding: '0 4px', lineHeight: 1,
                      }}>✕</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Column visibility picker */}
          <div ref={colPickerRef} style={{ position: 'relative' }}>
            <button onClick={() => setShowColPicker((v) => !v)} style={{
              background: showColPicker ? C.border : C.surface, color: C.textMuted,
              border: `1px solid ${showColPicker ? C.accent : C.border}`, borderRadius: 6,
              padding: '5px 10px', cursor: 'pointer', fontSize: 12,
              display: 'flex', alignItems: 'center', gap: 4,
            }}>
              ⚙ <span style={{ fontSize: 11 }}>{[...effectiveVis].filter((k) => allKeys.includes(k)).length}/{columns.length}</span>
            </button>
            {showColPicker && (
              <div style={{
                position: 'absolute', right: 0, top: 'calc(100% + 4px)',
                background: C.card, border: `1px solid ${C.border}`, borderRadius: 8,
                padding: 12, minWidth: 180, maxHeight: 340, overflowY: 'auto', zIndex: 200,
                boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10, paddingBottom: 8, borderBottom: `1px solid ${C.border}` }}>
                  <span style={{ color: C.textSec, fontSize: 12, fontWeight: 600 }}>Columns</span>
                  <button onClick={resetCols} style={{ background: 'none', border: 'none', color: C.accent, fontSize: 11, cursor: 'pointer' }}>Reset</button>
                </div>
                {columns.map((col) => (
                  <label key={col.key} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0', cursor: 'pointer' }}>
                    <input type="checkbox" checked={effectiveVis.has(col.key)} onChange={() => toggleCol(col.key)} style={{ accentColor: C.accent }} />
                    <span style={{ color: C.textSec, fontSize: 12, userSelect: 'none' }}>{col.label}</span>
                  </label>
                ))}
              </div>
            )}
          </div>

          {/* Export CSV */}
          <button onClick={exportCsv} style={{
            background: C.surface, color: C.textMuted, border: `1px solid ${C.border}`,
            borderRadius: 6, padding: '5px 10px', cursor: 'pointer', fontSize: 12,
          }}>
            ⬇ CSV
          </button>
        </div>
      </div>

      {/* ── Row count ── */}
      <div style={{ color: C.textMuted, fontSize: 12, marginBottom: 8 }}>
        {isLoading && !data
          ? 'Loading…'
          : total > 0
            ? <span>Showing <strong style={{ color: C.textSec }}>{from.toLocaleString()}–{to.toLocaleString()}</strong> of <strong style={{ color: C.textPri }}>{total.toLocaleString()}</strong></span>
            : 'No records match the current filters.'
        }
      </div>

      {/* ── Bulk actions bar ── */}
      {selectable && bulkActions && selectedIds.size > 0 && (
        <div style={{ marginBottom: 8 }}>
          {bulkActions({ selectedIds, selectedRows, clearSelection })}
        </div>
      )}

      {/* ── Table ── */}
      <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 500 }}>
            <thead>
              {/* Sort headers */}
              <tr>
                {selectable && (
                  <th style={{ padding: '9px 8px', width: 36, background: C.card, borderBottom: `1px solid ${C.border}` }}>
                    <input
                      type="checkbox"
                      checked={rows.length > 0 && selectedIds.size === rows.length}
                      onChange={toggleAll}
                      style={{ accentColor: '#7c3aed', cursor: 'pointer' }}
                    />
                  </th>
                )}
                {visibleColumns.map((col) => {
                  const isSorted = sort.key === col.key;
                  const sortable = col.sortable !== false;
                  return (
                    <th
                      key={col.key}
                      onClick={() => sortable && handleSort(col.key)}
                      style={{
                        padding: '9px 12px', textAlign: 'left', background: C.card,
                        color: isSorted ? C.accent : C.textMuted,
                        fontSize: 10, fontWeight: 600, textTransform: 'uppercase',
                        letterSpacing: '0.4px', whiteSpace: 'nowrap',
                        cursor: sortable ? 'pointer' : 'default',
                        borderBottom: `1px solid ${C.border}`,
                        width: col.width,
                        userSelect: 'none',
                      }}
                    >
                      {col.label}
                      {sortable && isSorted && (
                        <span style={{ marginLeft: 3, opacity: 0.8 }}>
                          {sort.dir === 'asc' ? '↑' : '↓'}
                        </span>
                      )}
                      {sortable && !isSorted && (
                        <span style={{ marginLeft: 3, opacity: 0.2 }}>↕</span>
                      )}
                    </th>
                  );
                })}
              </tr>
              {/* Column filter inputs */}
              <tr>
                {selectable && (
                  <th style={{ padding: '3px 8px', background: C.surface, borderBottom: `1px solid ${C.border}` }} />
                )}
                {visibleColumns.map((col) => (
                  <th key={col.key} style={{ padding: '3px 8px', background: C.surface, borderBottom: `1px solid ${C.border}` }}>
                    {col.filterable !== false && (
                      <input
                        value={colFilters[col.key] || ''}
                        onChange={(e) => handleColFilter(col.key, e.target.value)}
                        placeholder={col.filterHint || 'filter…'}
                        style={{
                          background: C.card, border: `1px solid ${C.border}`, borderRadius: 4,
                          color: C.textPri, padding: '3px 6px', fontSize: 11, outline: 'none',
                          width: '100%', minWidth: 0,
                        }}
                      />
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {/* Loading skeleton */}
              {isLoading && !data && Array.from({ length: 12 }).map((_, i) => (
                <tr key={`skel-${i}`}>
                  {selectable && <td style={{ padding: '8px 8px', borderBottom: `1px solid ${C.border}1a` }} />}
                  {visibleColumns.map((col, j) => (
                    <td key={col.key} style={{ padding: '8px 12px', borderBottom: `1px solid ${C.border}1a` }}>
                      <div style={{
                        background: C.surface, borderRadius: 4, height: 11,
                        width: `${SKELETON_WIDTHS[(i + j) % SKELETON_WIDTHS.length]}%`,
                        opacity: 0.5,
                      }} />
                    </td>
                  ))}
                </tr>
              ))}

              {/* Empty state */}
              {!isLoading && rows.length === 0 && (
                <tr>
                  <td colSpan={visibleColumns.length + (selectable ? 1 : 0)} style={{ textAlign: 'center', padding: '48px 24px', color: C.textMuted, fontSize: 13 }}>
                    {emptyState || 'No records match the current filters.'}
                  </td>
                </tr>
              )}

              {/* Data rows */}
              {!isLoading && rows.map((row, i) => {
                const rowId = row.id || row.sfdc_id;
                const isSelected = selectedIds.has(rowId);
                return (
                <tr
                  key={rowId || i}
                  style={{
                    transition: 'background 0.1s',
                    background: isSelected ? '#7c3aed11' : undefined,
                    cursor: onRowClick ? 'pointer' : 'default',
                  }}
                  onClick={() => onRowClick && onRowClick(row)}
                  onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = C.cardHover; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = isSelected ? '#7c3aed11' : 'transparent'; }}
                >
                  {selectable && (
                    <td style={{ padding: '7px 8px', borderBottom: `1px solid ${C.border}1a`, verticalAlign: 'middle' }}>
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleRow(rowId)}
                        style={{ accentColor: '#7c3aed', cursor: 'pointer' }}
                      />
                    </td>
                  )}
                  {visibleColumns.map((col) => (
                    <td
                      key={col.key}
                      style={{
                        padding: '7px 12px',
                        borderBottom: `1px solid ${C.border}1a`,
                        maxWidth: col.width || 220,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        verticalAlign: 'middle',
                      }}
                    >
                      {col.render
                        ? col.render(row)
                        : <span style={{ color: C.textSec, fontSize: 12 }}>
                            {row[col.key] != null ? String(row[col.key]) : <span style={{ color: C.textMuted }}>—</span>}
                          </span>
                      }
                    </td>
                  ))}
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {(totalPages > 1 || total > 0) && (
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            gap: 10, padding: '12px 16px', borderTop: `1px solid ${C.border}`,
          }}>
            <button onClick={() => setPage(1)} disabled={page <= 1} style={pageBtnStyle(page <= 1)}>«</button>
            <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} style={pageBtnStyle(page <= 1)}>
              ← Prev
            </button>
            <span style={{ color: C.textSec, fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
              Page
              <input
                type="number"
                min={1}
                max={totalPages}
                value={page}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10);
                  if (!isNaN(v) && v >= 1 && v <= totalPages) setPage(v);
                }}
                style={{
                  background: C.surface, border: `1px solid ${C.border}`, borderRadius: 4,
                  color: C.textPri, padding: '2px 6px', width: 52, fontSize: 12, textAlign: 'center',
                  outline: 'none',
                }}
              />
              of {totalPages.toLocaleString()}
            </span>
            <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages} style={pageBtnStyle(page >= totalPages)}>
              Next →
            </button>
            <button onClick={() => setPage(totalPages)} disabled={page >= totalPages} style={pageBtnStyle(page >= totalPages)}>»</button>
          </div>
        )}
      </div>
    </div>
  );
}
