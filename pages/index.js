/**
 * 🗼 Watchtower v2 — Pipeline Dashboard
 * Commure Call Center Agents
 * Full redesign: Goals, Market Summary, Pipeline Tracking, Activity, Market Overview
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import Head from 'next/head';
import useSWR from 'swr';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  Cell, LabelList,
} from 'recharts';

// ─── Theme ────────────────────────────────────────────────────────────────────
const C = {
  bg:        '#0a0a10',
  surface:   '#111119',
  card:      '#16161f',
  cardHover: '#1c1c28',
  border:    '#252535',
  borderSub: '#1e1e2c',
  textPri:   '#f0f4ff',
  textSec:   '#9ca3c8',
  textMuted: '#4b5280',
  accent:    '#6366f1',
  purple:    '#8b5cf6',
  green:     '#10b981',
  amber:     '#f59e0b',
  red:       '#ef4444',
  blue:      '#3b82f6',
  teal:      '#14b8a6',
  pink:      '#ec4899',
  chartColors: [
    '#6366f1','#10b981','#f59e0b','#3b82f6','#8b5cf6',
    '#ec4899','#14b8a6','#f97316','#84cc16','#06b6d4',
    '#a78bfa','#34d399','#fbbf24','#60a5fa','#f472b6',
  ],
};

const SECTION_ACCENT = {
  goals:    C.purple,
  market:   C.green,
  pipeline: C.blue,
  activity: C.amber,
  overview: C.teal,
};

const NOTION_COLOR = {
  default: '#9ca3c8', gray: '#64748b', brown: '#b45309',
  orange: '#f97316', yellow: '#f59e0b', green: '#10b981',
  blue: '#3b82f6', purple: '#8b5cf6', pink: '#ec4899', red: '#ef4444',
};

const PIPELINE_STAGES = [
  'Prospect','Outreach','Discovery','SQL','Negotiations',
  'Closed-Won','Pilot Deployment','Full Deployment',
];

// Default filter excludes Prospects
const NON_PROSPECT_STAGES = PIPELINE_STAGES.filter((s) => s !== 'Prospect');
const DEFAULT_PIPELINE_FILTERS = { stage: NON_PROSPECT_STAGES };

const ACTIVE_STAGES = new Set(['SQL','Negotiations','Closed-Won','Pilot Deployment','Full Deployment']);

const PIPELINE_DEFAULT_COLS = new Set([
  'Account Name','EHR','Stage','Specialty',
  'Potential ROE Issue','Not in RCM ICP','Providers #','Annual Revenue ($)',
]);

const CONTACTS_DEFAULT_COLS = new Set([
  'Full Name','Title/Headline','Company Name','LinkedIn URL',
  'Source','In SFDC','Date Added',
]);

const CROSSTAB_DIMS = ['EHR','Specialty','Source','EmployeeBucket','Stage'];

// ─── Utilities ────────────────────────────────────────────────────────────────
const fetcher = (url) => fetch(url).then((r) => r.json());

function fmt(n, style = 'decimal') {
  if (n == null || isNaN(n)) return '—';
  if (style === 'currency') {
    if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `$${Math.round(n / 1_000)}K`;
    return `$${n.toLocaleString()}`;
  }
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return n.toLocaleString();
}

function buildPipelineUrl(filters, page, pageSize = 50, tick = 0) {
  const p = new URLSearchParams({ page, pageSize });
  if (filters.ehr?.length)      p.set('ehr',      filters.ehr.join(','));
  if (filters.stage?.length)    p.set('stage',    filters.stage.join(','));
  if (filters.specialty?.length) p.set('specialty', filters.specialty.join(','));
  if (filters.source?.length)   p.set('source',   filters.source.join(','));
  if (filters.nonRcm)           p.set('nonRcm',   'true');
  if (filters.roe)              p.set('roe',       'true');
  if (filters.search)           p.set('search',    filters.search);
  if (tick) p.set('_t', tick);
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

function getSelectColor(schemaProps, fieldName, value) {
  if (!schemaProps || !fieldName || !value) return NOTION_COLOR.default;
  const opts = schemaProps[fieldName]?.options || [];
  const opt  = opts.find((o) => o.name === value);
  return NOTION_COLOR[opt?.color] || NOTION_COLOR.default;
}

function formatDate(dateStr) {
  if (!dateStr) return null;
  try {
    return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch { return dateStr; }
}

// ─── Week / Month helpers ─────────────────────────────────────────────────────
function getMondayOfWeek(date, weekOffset = 0) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day; // shift to Monday (ISO week start)
  d.setDate(d.getDate() + diff + weekOffset * 7);
  d.setHours(0, 0, 0, 0);
  return d;
}

function getSundayOfWeek(mondayDate) {
  const d = new Date(mondayDate);
  d.setDate(d.getDate() + 6);
  d.setHours(23, 59, 59, 999);
  return d;
}

function getMonthStart(date, monthOffset = 0) {
  const d = new Date(date.getFullYear(), date.getMonth() + monthOffset, 1);
  d.setHours(0, 0, 0, 0);
  return d;
}

function getMonthEnd(monthStart) {
  const d = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0);
  d.setHours(23, 59, 59, 999);
  return d;
}

function fmtWeekLabel(mondayDate, offset) {
  if (offset === 0) return 'This Week';
  if (offset === 1) return 'Last Week';
  return mondayDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function fmtMonthLabel(monthStart, offset) {
  if (offset === 0) return 'This Month';
  if (offset === 1) return 'Last Month';
  return monthStart.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
}

function getTrailingWeeks(n = 4) {
  const now = new Date();
  return Array.from({ length: n }, (_, i) => {
    const offset = n - 1 - i;
    const start = getMondayOfWeek(now, -offset);
    const end   = getSundayOfWeek(start);
    return { label: fmtWeekLabel(start, offset), start, end, offset };
  });
}

function getTrailingMonths(n = 4) {
  const now = new Date();
  return Array.from({ length: n }, (_, i) => {
    const offset = n - 1 - i;
    const start = getMonthStart(now, -offset);
    const end   = getMonthEnd(start);
    return { label: fmtMonthLabel(start, offset), start, end, offset };
  });
}

function countInPeriod(activityItems, stages, start, end) {
  const stageSet = new Set(stages);
  const seen = new Set();
  for (const item of activityItems) {
    if (!stageSet.has(item.to_stage)) continue;
    const d = new Date(item.transition_date);
    if (d >= start && d <= end) seen.add(item.account_name + '|' + item.to_stage);
  }
  return seen.size;
}

// ─── Primitive components ─────────────────────────────────────────────────────
function Muted({ children = '—' }) {
  return <span style={{ color: C.textMuted }}>{children}</span>;
}

function SelectBadge({ value, color = NOTION_COLOR.default, small }) {
  if (!value) return <Muted />;
  return (
    <span style={{
      background:   color + '1f',
      color,
      border:       `1px solid ${color}44`,
      borderRadius: 4,
      padding:      small ? '1px 5px' : '2px 7px',
      fontSize:     small ? 10 : 11,
      fontWeight:   600,
      whiteSpace:   'nowrap',
      display:      'inline-block',
    }}>
      {value}
    </span>
  );
}

function FieldValue({ value, type, fieldName, schemaProps }) {
  if (value === null || value === undefined) return <Muted />;
  switch (type) {
    case 'title':
      return <span style={{ color: C.textPri, fontWeight: 500 }}>{value || <Muted />}</span>;
    case 'rich_text':
    case 'formula': {
      if (!value) return <Muted />;
      const s = String(value);
      return <span style={{ color: C.textSec, fontSize: 12 }} title={s.length > 60 ? s : undefined}>{s.length > 60 ? s.slice(0,60)+'…' : s}</span>;
    }
    case 'select':
    case 'status': {
      if (!value) return <Muted />;
      return <SelectBadge value={value} color={getSelectColor(schemaProps, fieldName, value)} />;
    }
    case 'multi_select': {
      const arr = Array.isArray(value) ? value : [];
      if (!arr.length) return <Muted />;
      return <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
        {arr.map((v) => <SelectBadge key={v} value={v} color={getSelectColor(schemaProps, fieldName, v)} />)}
      </div>;
    }
    case 'checkbox':
      return value ? <span style={{ color: C.green }}>✓</span> : <Muted />;
    case 'number':
      return <span style={{ color: C.textSec }}>{value?.toLocaleString()}</span>;
    case 'date':
      return value ? <span style={{ color: C.textSec, fontSize: 12 }}>{value}</span> : <Muted />;
    case 'url':
      return value ? <a href={value} target="_blank" rel="noreferrer" style={{ color: C.accent, fontSize: 12, textDecoration: 'none' }}>↗</a> : <Muted />;
    case 'email':
      return value ? <a href={`mailto:${value}`} style={{ color: C.accent, fontSize: 12, textDecoration: 'none' }}>{value}</a> : <Muted />;
    default:
      return value ? <span style={{ color: C.textSec, fontSize: 12 }}>{String(value)}</span> : <Muted />;
  }
}

// ─── Collapsible Section ──────────────────────────────────────────────────────
function Section({ id, title, subtitle, accent, children, defaultOpen = true, style: extraStyle }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{
      marginBottom: 20,
      borderLeft:   `3px solid ${accent}`,
      borderRadius: '0 12px 12px 0',
      overflow:     'hidden',
      background:   C.card,
      border:       `1px solid ${C.border}`,
      borderLeftColor: accent,
      ...extraStyle,
    }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          width:          '100%',
          background:     'transparent',
          border:         'none',
          padding:        '14px 18px',
          display:        'flex',
          alignItems:     'center',
          justifyContent: 'space-between',
          cursor:         'pointer',
          borderBottom:   open ? `1px solid ${C.border}` : 'none',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ color: C.textPri, fontWeight: 700, fontSize: 14 }}>{title}</span>
          {subtitle && <span style={{ color: C.textMuted, fontSize: 12 }}>{subtitle}</span>}
        </div>
        <span style={{ color: C.textMuted, fontSize: 12, transform: open ? 'rotate(180deg)' : 'none', transition: '0.2s', display:'inline-block' }}>▼</span>
      </button>
      {open && <div style={{ padding: '16px 18px' }}>{children}</div>}
    </div>
  );
}

// ─── Progress Bar ─────────────────────────────────────────────────────────────
function ProgressBar({ value, max, color = C.accent, height = 8 }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div style={{ background: C.surface, borderRadius: 99, height, overflow: 'hidden', flex: 1 }}>
      <div style={{
        width:      `${pct}%`,
        height:     '100%',
        background: `linear-gradient(90deg, ${color}cc, ${color})`,
        borderRadius: 99,
        transition: 'width 0.6s ease',
        minWidth:   pct > 0 ? 4 : 0,
      }} />
    </div>
  );
}

// ─── Section 1: Goals ─────────────────────────────────────────────────────────
function SkeletonBar({ width = '100%', height = 12, mb = 8 }) {
  return <div style={{ width, height, background: C.surface, borderRadius: 6, marginBottom: mb, opacity: 0.6 }} />;
}

function GoalsSection({ globals, currentMonth, statsLoading }) {
  const isLoading = statsLoading || !globals?.goals;
  const goals = globals?.goals;

  if (isLoading) {
    return (
      <Section id="goals" title="🎯 Goals & Progress" accent={SECTION_ACCENT.goals} subtitle="Loading…">
        <SkeletonBar height={14} mb={12} />
        <SkeletonBar width="70%" height={10} mb={20} />
        <SkeletonBar height={14} mb={12} />
        <SkeletonBar width="55%" height={10} />
      </Section>
    );
  }

  const g1 = goals.discoveryPlus ?? goals.discoveryPlusThisMonth ?? 0;
  const g2 = goals.closedWon ?? goals.closedWonThisMonth ?? 0;
  const g3 = goals.deployedRevenue ?? 0;
  const t1 = goals.goal1Target || 35;
  const t2 = goals.goal2Target || 7;
  const t3 = goals.goal3Target || 300_000;

  function GoalRow({ label, current, target, color, format = 'number' }) {
    const pct = target > 0 ? Math.min(100, Math.round((current / target) * 100)) : 0;
    const toGo = Math.max(0, target - current);
    const displayValue  = format === 'currency' ? fmt(current, 'currency') : current;
    const displayTarget = format === 'currency' ? fmt(target, 'currency') : target;
    const toGoDisplay   = format === 'currency' ? fmt(toGo, 'currency') : toGo;
    return (
      <div style={{ marginBottom: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <span style={{ color: C.textPri, fontSize: 13, fontWeight: 600 }}>{label}</span>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <span style={{ color, fontWeight: 700, fontSize: 15 }}>{displayValue}<span style={{ color: C.textMuted, fontWeight: 400, fontSize: 12 }}>/{displayTarget}</span></span>
            <SelectBadge value={`${pct}%`} color={color} />
            {toGo > 0
              ? <span style={{ color: C.textMuted, fontSize: 12 }}>{toGoDisplay} to go</span>
              : <span style={{ color: C.green, fontSize: 12, fontWeight: 600 }}>✓ Goal met!</span>
            }
          </div>
        </div>
        <ProgressBar value={current} max={target} color={color} height={10} />
      </div>
    );
  }

  return (
    <Section id="goals" title="🎯 Goals & Progress" accent={SECTION_ACCENT.goals}
      subtitle="Target: July 31, 2026 · Cumulative from inception">
      <GoalRow
        label="Accounts moved to Discovery stage or beyond (cumulative)"
        current={g1} target={t1} color={C.purple}
      />
      <GoalRow
        label="Closed-Won accounts (incl. Pilot &amp; Full Deployment)"
        current={g2} target={t2} color={C.green}
      />
      <GoalRow
        label="Deployed ARR"
        current={g3} target={t3} color={C.amber} format="currency"
      />
    </Section>
  );
}

// ─── Section 2: Market Summary ────────────────────────────────────────────────
function MarketSummarySection({ globals, statsLoading }) {
  const [tooltipOpen, setTooltipOpen] = useState(false);
  if (statsLoading || !globals?.stats) {
    return (
      <Section id="market" title="📊 Market Summary" accent={SECTION_ACCENT.market} defaultOpen={true}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          {[1,2,3,4,5].map(i => (
            <div key={i} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: '12px 16px', flex: '1 1 140px', minWidth: 120 }}>
              <SkeletonBar width="60%" height={9} mb={8} />
              <SkeletonBar width="80%" height={22} mb={4} />
            </div>
          ))}
        </div>
      </Section>
    );
  }
  const { stats } = globals;

  const statCards = [
    { label: 'Total in Pipeline',    value: fmt(stats.total),                       color: C.blue    },
    { label: 'Est. TAM Value',       value: fmt(stats.total * 150_000, 'currency'), color: C.green,  sub: '@ $150K avg ACV' },
    { label: 'Non-RCM ICP',          value: fmt(stats.notRcmCount),                 color: C.amber   },
    { label: 'Confirmed ICP Tier',   value: fmt(stats.confirmedIcpCount),            color: C.purple  },
    { label: 'Deployed ARR',         value: '$650K',                                 color: C.green,  sub: 'Nathan Littauer $575K + Medvanta $75K' },
  ];

  return (
    <Section id="market" title="📊 Market Summary" accent={SECTION_ACCENT.market} defaultOpen={true}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 12 }}>
        {statCards.map(({ label, value, color, sub }) => (
          <div key={label} style={{
            background:   C.surface,
            border:       `1px solid ${C.border}`,
            borderRadius: 10,
            padding:      '12px 16px',
            flex:         '1 1 140px',
            minWidth:     120,
          }}>
            <div style={{ color: C.textMuted, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 4 }}>{label}</div>
            <div style={{ color, fontSize: 20, fontWeight: 700, letterSpacing: '-0.5px' }}>{value}</div>
            {sub && <div style={{ color: C.textMuted, fontSize: 10, marginTop: 2 }}>{sub}</div>}
          </div>
        ))}
      </div>
      <div style={{ position: 'relative', display: 'inline-block' }}>
        <button
          onClick={() => setTooltipOpen((o) => !o)}
          style={{ background: 'none', border: 'none', color: C.textMuted, cursor: 'pointer', fontSize: 12 }}
        >
          ℹ️ What&apos;s included
        </button>
        {tooltipOpen && (
          <>
            {/* Backdrop */}
            <div
              onClick={() => setTooltipOpen(false)}
              style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 9998 }}
            />
            {/* Modal */}
            <div style={{
              position: 'fixed',
              top: '50%', left: '50%',
              transform: 'translate(-50%, -50%)',
              background: C.card, border: `1px solid ${C.border}`,
              borderRadius: 12, padding: '20px 24px',
              fontSize: 13, color: C.textSec,
              width: 420, maxWidth: '90vw',
              zIndex: 9999, boxShadow: '0 16px 48px rgba(0,0,0,0.7)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
                <span style={{ color: C.textPri, fontWeight: 700, fontSize: 14 }}>What&apos;s included</span>
                <button onClick={() => setTooltipOpen(false)} style={{ background: 'none', border: 'none', color: C.textMuted, cursor: 'pointer', fontSize: 16, lineHeight: 1 }}>✕</button>
              </div>
              <p style={{ margin: '0 0 10px 0', lineHeight: 1.6 }}>
                All accounts in the <strong style={{ color: C.textPri }}>Voice Agents Pipeline</strong> Notion DB.
              </p>
              <p style={{ margin: '0 0 6px 0', color: C.textPri, fontWeight: 600 }}>ICP criteria:</p>
              <ul style={{ margin: '0 0 12px 0', paddingLeft: 18, lineHeight: 1.8 }}>
                <li>Healthcare practice (not a vendor/tech company)</li>
                <li>Target EHR: eCW, Athena, ModMed, AdvancedMD, or MEDITECH</li>
                <li>$1M+ revenue OR 5+ locations OR 25+ employees</li>
              </ul>
              <p style={{ margin: '0 0 6px 0', color: C.textPri, fontWeight: 600 }}>Deployed ARR:</p>
              <p style={{ margin: 0, lineHeight: 1.6 }}>
                Nathan Littauer Hospital (<span style={{ color: C.green }}>$575K</span>) + Medvanta (<span style={{ color: C.green }}>$75K</span>) = <strong style={{ color: C.green }}>$650K</strong> actual
              </p>
            </div>
          </>
        )}
      </div>
    </Section>
  );
}

// ─── Stage Funnel ─────────────────────────────────────────────────────────────
function StageFunnel({ byStage, onStageClick, selectedStage }) {
  if (!byStage) return null;

  const stages = PIPELINE_STAGES;
  const counts  = stages.map((s) => byStage[s] || 0);
  const maxCount = Math.max(...counts, 1);
  const isClickable = !!onStageClick;

  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ color: C.textMuted, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 10 }}>Stage Funnel{isClickable && <span style={{ marginLeft: 6, fontWeight: 400 }}>· click to filter</span>}</div>
      <div style={{ overflowX: 'auto' }}>
        <div style={{ display: 'flex', gap: 4, minWidth: 600, alignItems: 'flex-end' }}>
          {stages.map((stage, i) => {
            const count = counts[i];
            const prev  = i > 0 ? counts[i - 1] : null;
            const convRate = prev != null && prev > 0 ? Math.round((count / prev) * 100) : null;
            const height = maxCount > 0 ? Math.max(32, Math.round((count / maxCount) * 120)) : 32;
            const isActive = ACTIVE_STAGES.has(stage);
            const isSelected = selectedStage === stage;
            return (
              <div
                key={stage}
                onClick={() => isClickable && onStageClick(stage)}
                style={{
                  flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
                  cursor: isClickable ? 'pointer' : 'default',
                  borderRadius: 6,
                  outline: isSelected ? `2px solid ${isActive ? C.amber : C.blue}` : 'none',
                  padding: '4px 2px',
                  background: isSelected ? (isActive ? C.amber : C.blue) + '11' : 'transparent',
                  transition: 'background 0.15s',
                }}
              >
                <div style={{ color: isActive ? C.amber : C.textSec, fontWeight: 700, fontSize: 14 }}>{fmt(count)}</div>
                <div style={{
                  width: '100%',
                  height,
                  background: isActive
                    ? `linear-gradient(180deg, ${C.amber}44, ${C.amber}22)`
                    : `linear-gradient(180deg, ${C.blue}33, ${C.blue}11)`,
                  border: `1px solid ${isActive ? C.amber : C.blue}44`,
                  borderRadius: '4px 4px 0 0',
                  display: 'flex',
                  alignItems: 'flex-end',
                  justifyContent: 'center',
                  paddingBottom: 4,
                }}>
                  {convRate != null && (
                    <span style={{ color: C.textMuted, fontSize: 9, whiteSpace: 'nowrap' }}>
                      {convRate}% ←
                    </span>
                  )}
                </div>
                <div style={{
                  color: isActive ? C.amber : C.textSec,
                  fontSize: 9,
                  textAlign: 'center',
                  fontWeight: isActive ? 600 : 400,
                  lineHeight: 1.2,
                  whiteSpace: 'nowrap',
                }}>
                  {stage}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ─── Multi-Select Dropdown ────────────────────────────────────────────────────
function MultiSelect({ label, options, selected, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const count = selected.length;

  useEffect(() => {
    if (!open) return;
    const handle = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [open]);

  const toggle = (val) => {
    onChange(selected.includes(val) ? selected.filter((v) => v !== val) : [...selected, val]);
  };

  const selStyle = {
    background:   open ? C.border : '#111119',
    color:        count > 0 ? C.textPri : C.textSec,
    border:       `1px solid ${count > 0 ? C.accent + '66' : C.border}`,
    borderRadius: 6,
    padding:      '5px 10px',
    cursor:       'pointer',
    fontSize:     12,
    whiteSpace:   'nowrap',
    display:      'flex',
    alignItems:   'center',
    gap:          5,
    outline:      'none',
  };

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button onClick={() => setOpen((o) => !o)} style={selStyle}>
        {count > 0 ? `${label} (${count})` : `All ${label}`}
        <span style={{ color: C.textMuted, fontSize: 10 }}>▾</span>
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 6px)', left: 0,
          background: C.card, border: `1px solid ${C.border}`,
          borderRadius: 8, padding: 8, minWidth: 180, maxHeight: 300,
          overflowY: 'auto', zIndex: 100, boxShadow: '0 12px 40px rgba(0,0,0,0.6)',
        }}>
          {count > 0 && (
            <button
              onClick={() => { onChange([]); setOpen(false); }}
              style={{ background: 'none', border: 'none', color: C.accent, fontSize: 11, cursor: 'pointer', marginBottom: 6, padding: '2px 4px' }}
            >
              Clear all
            </button>
          )}
          {options.map((opt) => (
            <label key={opt} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 4px', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={selected.includes(opt)}
                onChange={() => toggle(opt)}
                style={{ accentColor: C.accent }}
              />
              <span style={{ color: C.textSec, fontSize: 12, userSelect: 'none' }}>{opt}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Filters Bar ──────────────────────────────────────────────────────────────
function FiltersBar({ filters, setFilters, schemaProps, showingCount, defaultFilters }) {
  const [searchInput, setSearchInput] = useState(filters.search || '');
  const debRef = useRef(null);

  const handleSearch = (val) => {
    setSearchInput(val);
    clearTimeout(debRef.current);
    debRef.current = setTimeout(() => setFilters((f) => ({ ...f, search: val || undefined })), 300);
  };

  const getOptions = (fieldName) => schemaProps?.[fieldName]?.options?.map((o) => o.name) || [];

  const selStyle = {
    background: '#111119', color: C.textSec,
    border: `1px solid ${C.border}`, borderRadius: 6,
    padding: '5px 10px', fontSize: 12, cursor: 'pointer', outline: 'none',
  };

  const resetTo = defaultFilters || {};
  const clear = () => { setFilters(resetTo); setSearchInput(''); };

  // hasFilters: differs from the default state
  const hasFilters = (() => {
    const df = resetTo;
    const keys = new Set([...Object.keys(filters), ...Object.keys(df)]);
    for (const k of keys) {
      const fv = filters[k];
      const dv = df[k];
      if (Array.isArray(fv) && Array.isArray(dv)) {
        if (fv.length !== dv.length || !fv.every((v) => dv.includes(v))) return true;
      } else if (fv !== dv) return true;
    }
    return false;
  })();

  // Is Prospect currently excluded?
  const prospectExcluded = filters.stage?.length > 0 && !filters.stage.includes('Prospect');

  return (
    <div style={{
      background: C.card, border: `1px solid ${C.border}`,
      borderRadius: 10, padding: '12px 16px', marginBottom: 14,
    }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <MultiSelect label="EHR" options={getOptions('EHR')} selected={filters.ehr || []}
          onChange={(v) => setFilters((f) => ({ ...f, ehr: v }))} />
        <MultiSelect label="Stage" options={PIPELINE_STAGES} selected={filters.stage || []}
          onChange={(v) => setFilters((f) => ({ ...f, stage: v }))} />
        <MultiSelect label="Specialty" options={getOptions('Specialty')} selected={filters.specialty || []}
          onChange={(v) => setFilters((f) => ({ ...f, specialty: v }))} />
        <MultiSelect label="Source" options={getOptions('Source Category')} selected={filters.source || []}
          onChange={(v) => setFilters((f) => ({ ...f, source: v }))} />

        <label style={{ color: C.textSec, fontSize: 12, display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
          <input type="checkbox" checked={filters.nonRcm || false}
            onChange={(e) => setFilters((f) => ({ ...f, nonRcm: e.target.checked || undefined }))}
            style={{ accentColor: C.amber }} />
          Non-RCM ICP only
        </label>
        <label style={{ color: C.red, fontSize: 12, display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
          <input type="checkbox" checked={filters.roe || false}
            onChange={(e) => setFilters((f) => ({ ...f, roe: e.target.checked || undefined }))}
            style={{ accentColor: C.red }} />
          ROE Flagged only
        </label>

        <input
          type="text" placeholder="🔍 Search accounts…"
          value={searchInput} onChange={(e) => handleSearch(e.target.value)}
          style={{ ...selStyle, flex: '1 1 160px', minWidth: 140, color: C.textPri }}
        />

        {hasFilters && (
          <button onClick={clear} style={{
            background: 'transparent', color: C.textMuted,
            border: `1px solid ${C.border}`, borderRadius: 6,
            padding: '5px 12px', cursor: 'pointer', fontSize: 12,
          }}>
            ✕ Clear
          </button>
        )}
      </div>

      <div style={{ color: C.textMuted, fontSize: 11, marginTop: 8, display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <span>
          Showing <span style={{ color: C.textPri, fontWeight: 600 }}>{(showingCount || 0).toLocaleString()}</span> accounts
          {hasFilters && <span style={{ color: C.amber }}> (filtered)</span>}
        </span>
        {prospectExcluded && (
          <span style={{ color: C.textMuted, fontSize: 11 }}>
            ·{' '}
            <span style={{ color: C.amber }}>Prospects hidden by default</span>
            {' '}—{' '}
            <button
              onClick={() => setFilters((f) => ({ ...f, stage: PIPELINE_STAGES }))}
              style={{ background: 'none', border: 'none', color: C.accent, cursor: 'pointer', fontSize: 11, padding: 0 }}
            >
              click to include
            </button>
          </span>
        )}
      </div>
    </div>
  );
}

// ─── Active Deals Callout ─────────────────────────────────────────────────────
function ActiveDealsCallout({ records }) {
  const [expanded, setExpanded] = useState(false);
  if (!records?.length) return null;

  const active = records.filter((r) => ACTIVE_STAGES.has(r.fields['Stage']));
  if (!active.length) return null;

  const visible = expanded ? active : active.slice(0, 8);

  const stageColor = {
    'SQL':               C.blue,
    'Negotiations':      C.amber,
    'Closed-Won':        C.green,
    'Pilot Deployment':  C.teal,
    'Full Deployment':   C.purple,
  };

  return (
    <div style={{
      background: C.card, border: `1px solid ${C.amber}33`,
      borderRadius: 10, padding: '12px 16px', marginBottom: 14,
    }}>
      <div style={{ color: C.amber, fontSize: 12, fontWeight: 600, marginBottom: 10 }}>
        ⚡ Active Deals — {active.length} accounts in SQL+
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {visible.map((r) => {
          const stage = r.fields['Stage'];
          const color = stageColor[stage] || C.textSec;
          const rev = r.fields['Annual Revenue ($)'];
          return (
            <div key={r.id} style={{
              background: C.surface, border: `1px solid ${color}33`,
              borderRadius: 8, padding: '8px 12px', minWidth: 160, maxWidth: 220,
              cursor: 'default',
            }}>
              <div style={{ color: C.textPri, fontSize: 12, fontWeight: 600, marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {r.fields['Account Name'] || 'Unknown'}
              </div>
              <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                <SelectBadge value={stage} color={color} small />
                {r.fields['EHR'] && <SelectBadge value={r.fields['EHR']} color={C.textMuted} small />}
              </div>
              {rev && <div style={{ color: C.textMuted, fontSize: 10, marginTop: 4 }}>{fmt(rev, 'currency')} est.</div>}
            </div>
          );
        })}
      </div>
      {active.length > 8 && (
        <button onClick={() => setExpanded((e) => !e)}
          style={{ background: 'none', border: 'none', color: C.amber, cursor: 'pointer', fontSize: 12, marginTop: 8, padding: 0 }}>
          {expanded ? '▲ Show less' : `▼ Show all ${active.length} active deals`}
        </button>
      )}
    </div>
  );
}

// ─── Column Picker ────────────────────────────────────────────────────────────
function ColumnPicker({ allCols, visibleCols, onToggle, onReset }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const handle = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [open]);

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen((o) => !o)}
        title="Toggle columns"
        style={{
          background: open ? C.border : 'transparent',
          color: open ? C.textPri : C.textMuted,
          border: `1px solid ${open ? C.accent : C.border}`,
          borderRadius: 6, padding: '5px 10px',
          cursor: 'pointer', fontSize: 13,
          display: 'flex', alignItems: 'center', gap: 5,
        }}
      >
        ⚙ <span style={{ fontSize: 11 }}>{[...visibleCols].filter(c => allCols.includes(c)).length}/{allCols.length}</span>
      </button>
      {open && (
        <div style={{
          position: 'absolute', right: 0, top: 'calc(100% + 6px)',
          background: C.card, border: `1px solid ${C.border}`,
          borderRadius: 8, padding: 12, width: 220, maxHeight: 380,
          overflowY: 'auto', zIndex: 200, boxShadow: '0 12px 40px rgba(0,0,0,0.5)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, paddingBottom: 8, borderBottom: `1px solid ${C.border}` }}>
            <span style={{ color: C.textSec, fontSize: 12, fontWeight: 600 }}>Columns</span>
            <button onClick={onReset} style={{ background: 'none', border: 'none', color: C.accent, fontSize: 11, cursor: 'pointer' }}>Reset</button>
          </div>
          {allCols.map((col) => (
            <label key={col} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0', cursor: 'pointer' }}>
              <input type="checkbox" checked={visibleCols.has(col)} onChange={() => onToggle(col)}
                style={{ accentColor: C.accent }} />
              <span style={{ color: C.textSec, fontSize: 12, userSelect: 'none' }}>{col}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Column state hook ────────────────────────────────────────────────────────
function useColumnState(storageKey, defaults) {
  const [cols, setCols] = useState(defaults);
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

// ─── Account Table ────────────────────────────────────────────────────────────
function AccountTable({ records, meta, page, setPage, visibleCols, allCols, onToggleCol, onResetCols, schemaProps }) {
  const [expandedRow, setExpandedRow] = useState(null);
  const cols = allCols.filter((c) => visibleCols.has(c));

  const thStyle = {
    padding: '8px 12px', textAlign: 'left',
    color: C.textMuted, fontSize: 10, fontWeight: 600,
    borderBottom: `1px solid ${C.border}`, whiteSpace: 'nowrap',
    textTransform: 'uppercase', letterSpacing: '0.4px', background: C.card,
  };

  return (
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: `1px solid ${C.border}` }}>
        <span style={{ color: C.textSec, fontSize: 13, fontWeight: 600 }}>
          Accounts
          {meta && <span style={{ color: C.textMuted, fontWeight: 400, marginLeft: 8, fontSize: 12 }}>
            ({(records?.length ?? 0)} shown · {(meta.total ?? 0).toLocaleString()} total)
          </span>}
        </span>
        <ColumnPicker allCols={allCols} visibleCols={visibleCols} onToggle={onToggleCol} onReset={onResetCols} />
      </div>

      {(!records || records.length === 0) && (
        <div style={{ color: C.textMuted, textAlign: 'center', padding: '40px 0', fontSize: 13 }}>
          No records match the current filters.
        </div>
      )}

      {records?.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 500 }}>
            <thead>
              <tr>{cols.map((col) => <th key={col} style={thStyle}>{col}</th>)}</tr>
            </thead>
            <tbody>
              {records.map((r, i) => {
                const isExpanded = expandedRow === i;
                return [
                  <tr
                    key={r.id || i}
                    onClick={() => setExpandedRow(isExpanded ? null : i)}
                    style={{ background: isExpanded ? C.cardHover : 'transparent', cursor: 'pointer', transition: 'background 0.1s' }}
                  >
                    {cols.map((col) => (
                      <td key={col} style={{
                        padding: '7px 12px', borderBottom: `1px solid ${C.border}1a`,
                        maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'middle',
                      }}>
                        <FieldValue value={r.fields?.[col]} type={schemaProps?.[col]?.type || 'rich_text'} fieldName={col} schemaProps={schemaProps} />
                      </td>
                    ))}
                  </tr>,
                  isExpanded && (
                    <tr key={`${i}-expanded`} style={{ background: C.surface }}>
                      <td colSpan={cols.length} style={{ padding: '12px 16px', borderBottom: `1px solid ${C.border}` }}>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                          {Object.entries(r.fields || {})
                            .filter(([, v]) => v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0))
                            .map(([k, v]) => (
                              <div key={k} style={{
                                background: C.card, border: `1px solid ${C.border}`,
                                borderRadius: 6, padding: '5px 10px', minWidth: 120, maxWidth: 220,
                              }}>
                                <div style={{ color: C.textMuted, fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.4px', marginBottom: 3 }}>{k}</div>
                                <div style={{ fontSize: 12 }}>
                                  <FieldValue value={v} type={schemaProps?.[k]?.type || 'rich_text'} fieldName={k} schemaProps={schemaProps} />
                                </div>
                              </div>
                            ))}
                        </div>
                      </td>
                    </tr>
                  ),
                ];
              })}
            </tbody>
          </table>
        </div>
      )}

      {meta?.totalPages > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, padding: '14px 0', borderTop: `1px solid ${C.border}` }}>
          <PaginationBtn disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>← Prev</PaginationBtn>
          <span style={{ color: C.textSec, fontSize: 12 }}>Page {meta.page} of {meta.totalPages}</span>
          <PaginationBtn disabled={page >= meta.totalPages} onClick={() => setPage((p) => p + 1)}>Next →</PaginationBtn>
        </div>
      )}
    </div>
  );
}

function PaginationBtn({ disabled, onClick, children }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      background: disabled ? 'transparent' : C.card,
      color: disabled ? C.textMuted : C.textSec,
      border: `1px solid ${disabled ? C.border + '44' : C.border}`,
      borderRadius: 6, padding: '5px 14px',
      cursor: disabled ? 'not-allowed' : 'pointer', fontSize: 12,
    }}>{children}</button>
  );
}

// ─── Section 3: Pipeline ──────────────────────────────────────────────────────

// --- WoW/MoM Pipeline Stage Table (Change 9) ---
const WOW_MOM_STAGES = ['Outreach', 'Discovery', 'SQL', 'Negotiations', 'Closed-Won', 'Pilot Deployment', 'Full Deployment'];

function PipelineWowMom({ activityData }) {
  if (!activityData) {
    return <div style={{ color: C.textMuted, fontSize: 12, padding: '12px 0', textAlign: 'center' }}>⟳ Loading trend data…</div>;
  }

  const items = activityData.activity || [];
  const weeks  = getTrailingWeeks(4);
  const months = getTrailingMonths(4);

  const stageCountInPeriod = (stage, start, end) =>
    countInPeriod(items, [stage], start, end);

  const wowRows = WOW_MOM_STAGES.map((stage) => {
    const counts = weeks.map(({ start, end }) => stageCountInPeriod(stage, start, end));
    return { stage, counts, delta: counts[3] - counts[2] };
  });
  const wowTotals = weeks.map((_, wi) => wowRows.reduce((s, r) => s + r.counts[wi], 0));

  const momRows = WOW_MOM_STAGES.map((stage) => {
    const counts = months.map(({ start, end }) => stageCountInPeriod(stage, start, end));
    return { stage, counts, delta: counts[3] - counts[2] };
  });
  const momTotals = months.map((_, mi) => momRows.reduce((s, r) => s + r.counts[mi], 0));

  const thS = { padding: '5px 10px', textAlign: 'center', color: C.textMuted, fontSize: 10, fontWeight: 600, borderBottom: `1px solid ${C.border}`, textTransform: 'uppercase', letterSpacing: '0.3px', whiteSpace: 'nowrap', background: C.surface };
  const tdS = { padding: '5px 10px', textAlign: 'center', fontSize: 12, color: C.textSec, borderBottom: `1px solid ${C.border}1a` };

  const DeltaCell = ({ delta }) => (
    <td style={{ ...tdS }}>
      {delta === 0
        ? <span style={{ color: C.textMuted }}>—</span>
        : <span style={{ color: delta > 0 ? C.green : C.red, fontWeight: 600 }}>{delta > 0 ? '▲' : '▼'}{Math.abs(delta)}</span>
      }
    </td>
  );

  const TrendTable = ({ title, headers, rows, totals }) => (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden', flex: '1 1 300px', minWidth: 300 }}>
      <div style={{ padding: '8px 14px', borderBottom: `1px solid ${C.border}`, color: C.textSec, fontSize: 12, fontWeight: 600 }}>{title}</div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={{ ...thS, textAlign: 'left', width: 120 }}>Stage</th>
              {headers.map((h) => <th key={h.label} style={thS}>{h.label}</th>)}
              <th style={thS}>Δ</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.stage}>
                <td style={{ ...tdS, textAlign: 'left' }}>
                  <SelectBadge value={row.stage} color={C.blue} small />
                </td>
                {row.counts.map((c, i) => (
                  <td key={i} style={{ ...tdS, color: i === row.counts.length - 1 ? C.textPri : C.textSec, fontWeight: i === row.counts.length - 1 ? 600 : 400 }}>
                    {c > 0 ? c : <span style={{ color: C.textMuted }}>—</span>}
                  </td>
                ))}
                <DeltaCell delta={row.delta} />
              </tr>
            ))}
            <tr style={{ borderTop: `1px solid ${C.border}` }}>
              <td style={{ ...tdS, textAlign: 'left', color: C.textMuted, fontWeight: 700, fontSize: 11 }}>Total</td>
              {totals.map((t, i) => (
                <td key={i} style={{ ...tdS, color: C.teal, fontWeight: 700 }}>{t > 0 ? t : '—'}</td>
              ))}
              <td style={tdS}>
                {(() => {
                  const d = totals[3] - totals[2];
                  return d === 0
                    ? <span style={{ color: C.textMuted }}>—</span>
                    : <span style={{ color: d > 0 ? C.green : C.red, fontWeight: 600 }}>{d > 0 ? '▲' : '▼'}{Math.abs(d)}</span>;
                })()}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ color: C.textMuted, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 10 }}>Pipeline Trends</div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <TrendTable title="Week over Week" headers={weeks} rows={wowRows} totals={wowTotals} />
        <TrendTable title="Month over Month" headers={months} rows={momRows} totals={momTotals} />
      </div>
    </div>
  );
}

// --- Pipeline Mini Charts (EHR, Source, Specialty) — clickable (Change 7) ---
function PipelineCharts({ agg, filters, setFilters }) {
  if (!agg) return null;

  const toBarData = (obj) => Object.entries(obj || {})
    .filter(([, v]) => v > 0)
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value);

  const ehrData     = toBarData(agg.byEhr);
  const srcData     = toBarData(agg.bySource);
  const specData    = (agg.topSpecialties || []).map((s) => ({ name: s.name, value: s.count }));

  const handleEhrClick  = (name) => setFilters((f) => ({ ...f, ehr:      f.ehr?.[0] === name ? [] : [name] }));
  const handleSrcClick  = (name) => setFilters((f) => ({ ...f, source:   f.source?.[0] === name ? [] : [name] }));
  const handleSpecClick = (name) => setFilters((f) => ({ ...f, specialty: f.specialty?.[0] === name ? [] : [name] }));

  const selectedEhr  = filters.ehr?.length === 1 ? filters.ehr[0] : null;
  const selectedSrc  = filters.source?.length === 1 ? filters.source[0] : null;
  const selectedSpec = filters.specialty?.length === 1 ? filters.specialty[0] : null;

  const cardS = { background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: '12px 14px', flex: '1 1 220px', minWidth: 200 };
  const titleS = { color: C.textSec, fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.4px', marginBottom: 10 };

  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ color: C.textMuted, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 8 }}>Distribution · click to filter ↓</div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        {ehrData.length > 0 && (
          <div style={cardS}>
            <div style={titleS}>By EHR</div>
            <HBarChart data={ehrData} color={C.blue} maxItems={10} onBarClick={handleEhrClick} selectedName={selectedEhr} />
          </div>
        )}
        {srcData.length > 0 && (
          <div style={cardS}>
            <div style={titleS}>By Source</div>
            <HBarChart data={srcData} color={C.teal} maxItems={10} onBarClick={handleSrcClick} selectedName={selectedSrc} />
          </div>
        )}
        {specData.length > 0 && (
          <div style={cardS}>
            <div style={titleS}>By Specialty (Top 10)</div>
            <HBarChart data={specData} color={C.purple} maxItems={10} onBarClick={handleSpecClick} selectedName={selectedSpec} />
          </div>
        )}
      </div>
    </div>
  );
}
function PipelineSection({ schema, pipelineData, isLoading, error, filters, setFilters, page, setPage }) {
  const [pipelineCols, togglePipelineCol, resetPipelineCols] =
    useColumnState('wt_pipeline_cols_v2', PIPELINE_DEFAULT_COLS);
  const [tableExpanded, setTableExpanded] = useState(false);

  // Fetch activity data for WoW/MoM (Change 9)
  const { data: activityData } = useSWR('/api/activity', fetcher, {
    revalidateOnFocus: false,
    refreshInterval: 5 * 60 * 1000,
  });

  const schemaProps = schema?.pipeline?.properties || {};
  const propOrder   = schema?.pipeline?.propOrder  || [...PIPELINE_DEFAULT_COLS];
  const agg         = pipelineData?.aggregations;
  const records     = pipelineData?.records;
  const meta        = pipelineData?.meta;

  // StageFunnel click → toggle single-stage filter (Change 7)
  const handleStageClick = (stage) => {
    setFilters((f) => {
      const cur = f.stage || [];
      if (cur.length === 1 && cur[0] === stage) return { ...f, stage: NON_PROSPECT_STAGES };
      return { ...f, stage: [stage] };
    });
  };
  const selectedFunnelStage = (filters.stage?.length === 1) ? filters.stage[0] : null;

  return (
    <Section id="pipeline" title="🔭 Pipeline Tracking" accent={SECTION_ACCENT.pipeline}>
      {/* Stage Funnel — clickable (Change 7) */}
      {agg && (
        <StageFunnel
          byStage={agg.byStage}
          onStageClick={handleStageClick}
          selectedStage={selectedFunnelStage}
        />
      )}

      {/* Mini distribution charts — clickable (Change 7) */}
      {agg && <PipelineCharts agg={agg} filters={filters} setFilters={setFilters} />}

      {/* Filters */}
      <FiltersBar
        filters={filters} setFilters={setFilters}
        schemaProps={schemaProps}
        showingCount={meta?.total}
        defaultFilters={DEFAULT_PIPELINE_FILTERS}
      />

      {/* WoW / MoM stage trend tables (Change 9) */}
      <PipelineWowMom activityData={activityData} />

      {/* Error */}
      {error && (
        <div style={{ background: '#ef444422', border: `1px solid ${C.red}`, borderRadius: 8, padding: '10px 14px', marginBottom: 14, color: C.red, fontSize: 13 }}>
          ⚠ Failed to load pipeline data.
        </div>
      )}

      {/* Loading */}
      {isLoading && !pipelineData && (
        <div style={{ textAlign: 'center', padding: '50px 0', color: C.textMuted }}>
          <div style={{ fontSize: 14, marginBottom: 8 }}>⟳ Loading pipeline from Notion…</div>
          <div style={{ fontSize: 12 }}>Large databases may take a few minutes on first load.</div>
        </div>
      )}

      {/* Active Deals */}
      {records && <ActiveDealsCallout records={records} />}

      {/* Collapsible Account Table */}
      {pipelineData && (
        <div style={{ marginBottom: 14 }}>
          <button
            onClick={() => setTableExpanded((e) => !e)}
            style={{
              display: 'flex', alignItems: 'center', gap: 8, width: '100%',
              background: C.surface, border: `1px solid ${C.border}`, borderRadius: tableExpanded ? '10px 10px 0 0' : 10,
              padding: '10px 16px', cursor: 'pointer', color: C.textSec, fontSize: 13, fontWeight: 600,
            }}
          >
            <span style={{ color: C.textMuted, fontSize: 11, transform: tableExpanded ? 'rotate(90deg)' : 'none', transition: '0.2s', display: 'inline-block' }}>▶</span>
            Account List ({(meta?.total ?? 0).toLocaleString()} accounts)
            <span style={{ color: C.textMuted, fontSize: 11, fontWeight: 400, marginLeft: 4 }}>
              {tableExpanded ? '— click to collapse' : '— click to expand'}
            </span>
          </button>
          {tableExpanded && (
            <div style={{ border: `1px solid ${C.border}`, borderTop: 'none', borderRadius: '0 0 10px 10px', overflow: 'hidden' }}>
              <AccountTable
                records={records} meta={meta} page={page} setPage={setPage}
                visibleCols={pipelineCols} allCols={propOrder}
                onToggleCol={togglePipelineCol} onResetCols={resetPipelineCols}
                schemaProps={schemaProps}
              />
            </div>
          )}
        </div>
      )}

      {meta && (
        <div style={{ color: C.textMuted, fontSize: 11, textAlign: 'right', marginTop: 8 }}>
          Cached {meta.cacheAge}s ago · {new Date(meta.cachedAt).toLocaleTimeString()}
        </div>
      )}
    </Section>
  );
}

// ─── Section 4: Activity ──────────────────────────────────────────────────────
// Change 10: replaced WoW/MoM stage transitions with 4-metric × 4-period tables
function ActivitySection() {
  const [subTab, setSubTab] = useState('activity');

  const { data, error, isLoading } = useSWR('/api/activity', fetcher, {
    revalidateOnFocus: false,
    refreshInterval: 5 * 60 * 1000,
  });

  const now = new Date();
  const weeks  = getTrailingWeeks(4);
  const months = getTrailingMonths(4);

  const ACTIVITY_METRICS = [
    {
      label: 'Accounts Added',
      desc: 'Date → Prospect',
      stages: ['Prospect'],
    },
    {
      label: 'Discos',
      desc: 'Date → Discovery',
      stages: ['Discovery'],
    },
    {
      label: 'SQLs',
      desc: 'Date → SQL',
      stages: ['SQL'],
    },
    {
      label: 'Closed-Won',
      desc: 'Date → Closed-Won / Pilot / Full',
      stages: ['Closed-Won', 'Pilot Deployment', 'Full Deployment'],
    },
  ];

  const buildRows = (periods) => {
    const items = data?.activity || [];
    return ACTIVITY_METRICS.map((metric) => {
      const counts = periods.map(({ start, end }) => countInPeriod(items, metric.stages, start, end));
      const delta = counts[3] - counts[2];
      return { ...metric, counts, delta };
    });
  };

  const wowRows = data ? buildRows(weeks)  : null;
  const momRows = data ? buildRows(months) : null;

  const thS = {
    padding: '6px 10px', textAlign: 'center', color: C.textMuted,
    fontSize: 10, fontWeight: 600, borderBottom: `1px solid ${C.border}`,
    textTransform: 'uppercase', letterSpacing: '0.3px', whiteSpace: 'nowrap',
    background: C.surface,
  };
  const tdS = { padding: '6px 10px', textAlign: 'center', fontSize: 12, borderBottom: `1px solid ${C.border}1a` };

  const DeltaCell = ({ delta }) => (
    <td style={{ ...tdS }}>
      {delta === 0
        ? <span style={{ color: C.textMuted }}>—</span>
        : <span style={{ color: delta > 0 ? C.green : C.red, fontWeight: 700 }}>{delta > 0 ? '▲' : '▼'}{Math.abs(delta)}</span>
      }
    </td>
  );

  const MetricTable = ({ title, periods, rows }) => (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden', flex: '1 1 300px', minWidth: 280 }}>
      <div style={{ padding: '8px 14px', borderBottom: `1px solid ${C.border}`, color: C.textSec, fontSize: 12, fontWeight: 600 }}>{title}</div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={{ ...thS, textAlign: 'left', width: 130 }}>Metric</th>
              {periods.map((p) => <th key={p.label} style={thS}>{p.label}</th>)}
              <th style={thS}>Δ</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label}>
                <td style={{ ...tdS, textAlign: 'left' }}>
                  <span style={{ color: C.textPri, fontWeight: 500, fontSize: 12 }}>{row.label}</span>
                  <div style={{ color: C.textMuted, fontSize: 9 }}>{row.desc}</div>
                </td>
                {row.counts.map((c, i) => (
                  <td key={i} style={{
                    ...tdS,
                    color: i === row.counts.length - 1 ? C.textPri : C.textSec,
                    fontWeight: i === row.counts.length - 1 ? 700 : 400,
                  }}>
                    {c > 0 ? c : <span style={{ color: C.textMuted }}>—</span>}
                  </td>
                ))}
                <DeltaCell delta={row.delta} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );

  const subTabBtn = (id, label) => (
    <button key={id} onClick={() => setSubTab(id)} style={{
      background: subTab === id ? C.amber + '22' : 'transparent',
      color: subTab === id ? C.amber : C.textSec,
      border: `1px solid ${subTab === id ? C.amber + '55' : 'transparent'}`,
      borderRadius: 6, padding: '4px 14px', cursor: 'pointer', fontSize: 12,
      fontWeight: subTab === id ? 600 : 400,
    }}>{label}</button>
  );

  return (
    <Section id="activity" title="⚡ Activity" accent={SECTION_ACCENT.activity}>
      <div style={{ display: 'flex', gap: 4, marginBottom: 16 }}>
        {subTabBtn('activity', '📊 Activity Metrics')}
        {subTabBtn('outreach', '📬 Outreach & Contact Activity')}
      </div>

      {subTab === 'outreach' && (
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: '20px 18px' }}>
          <div style={{ color: C.textSec, fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Coming Soon</div>
          <p style={{ color: C.textMuted, fontSize: 12, margin: '0 0 12px 0' }}>
            Will show emails, calls, LinkedIn activity from Outreach.io + SFDC once webhooks are connected.
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <SelectBadge value="Webhook ready: /api/webhook/sfdc" color={C.green} />
            <SelectBadge value="Webhook ready: /api/webhook/outreach" color={C.green} />
          </div>
        </div>
      )}

      {subTab === 'activity' && (
        <>
          {isLoading && !data && (
            <div style={{ color: C.textMuted, textAlign: 'center', padding: '30px 0', fontSize: 13 }}>⟳ Loading activity…</div>
          )}
          {error && (
            <div style={{ color: C.red, fontSize: 13, marginBottom: 12 }}>⚠ Failed to load activity data.</div>
          )}
          {data && wowRows && momRows && (
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <MetricTable title="Week over Week (ISO weeks)" periods={weeks} rows={wowRows} />
              <MetricTable title="Month over Month" periods={months} rows={momRows} />
            </div>
          )}
        </>
      )}
    </Section>
  );
}


// ─── Market Account List (collapsible, used in Market Overview) ───────────────
// Change 7/8: accepts chartFilter prop to auto-filter from chart clicks
function MarketAccountList({ globals, chartFilter }) {
  const [expanded, setExpanded] = useState(false);
  const [page, setPage] = useState(1);
  const [localFilters, setLocalFilters] = useState({});

  const buildUrl = () => {
    const p = new URLSearchParams({ page, pageSize: 50 });
    // local manual filters
    if (localFilters.ehr?.length)       p.set('ehr',           localFilters.ehr.join(','));
    if (localFilters.specialty?.length) p.set('specialty',     localFilters.specialty.join(','));
    if (localFilters.source?.length)    p.set('source',        localFilters.source.join(','));
    if (localFilters.stage?.length)     p.set('stage',         localFilters.stage.join(','));
    if (localFilters.employeeBucket?.length) p.set('employeeBucket', localFilters.employeeBucket.join(','));
    // chart-driven filter overrides (if set)
    if (chartFilter?.dim && chartFilter?.value) {
      const { dim, value } = chartFilter;
      if (dim === 'ehr')            { if (!localFilters.ehr?.length)       p.set('ehr',            value); }
      else if (dim === 'source')    { if (!localFilters.source?.length)    p.set('source',         value); }
      else if (dim === 'specialty') { if (!localFilters.specialty?.length) p.set('specialty',      value); }
      else if (dim === 'stage')     { if (!localFilters.stage?.length)     p.set('stage',          value); }
      else if (dim === 'employee')  { if (!localFilters.employeeBucket?.length) p.set('employeeBucket', value); }
      else if (dim === 'revenue')   p.set('revenueBucket',  value);
      else if (dim === 'provider')  p.set('providerBucket', value);
    }
    return `/api/pipeline?${p}`;
  };

  // Reset page when filters or chartFilter change
  useEffect(() => { setPage(1); }, [localFilters, chartFilter]);

  const { data, isLoading } = useSWR(
    expanded ? buildUrl() : null,
    fetcher,
    { revalidateOnFocus: false, dedupingInterval: 10000 }
  );

  const total = data?.meta?.total ?? 0;
  const records = data?.records || [];
  const meta = data?.meta;

  const statsForOptions = globals?.stats;
  const ehrOptions  = statsForOptions ? Object.keys(statsForOptions.byEhr || {}).sort() : [];
  const empBuckets  = ['1-25','26-100','101-500','500+'];

  const mktCols = ['Account Name','EHR','Stage','Specialty','Source Category','Employees #','Annual Revenue ($)','Providers #'];

  const thStyle = {
    padding: '7px 12px', textAlign: 'left',
    color: C.textMuted, fontSize: 10, fontWeight: 600,
    borderBottom: `1px solid ${C.border}`, whiteSpace: 'nowrap',
    textTransform: 'uppercase', letterSpacing: '0.4px', background: C.surface,
  };

  const filterPill = (label, active, onClick) => (
    <button
      key={label}
      onClick={onClick}
      style={{
        background: active ? C.teal + '22' : C.surface,
        color: active ? C.teal : C.textMuted,
        border: `1px solid ${active ? C.teal + '66' : C.border}`,
        borderRadius: 20, padding: '3px 10px', cursor: 'pointer', fontSize: 11,
      }}
    >
      {label}
    </button>
  );

  return (
    <div style={{ marginTop: 16 }}>
      <button
        onClick={() => setExpanded((e) => !e)}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, width: '100%',
          background: C.surface, border: `1px solid ${C.border}`,
          borderRadius: expanded ? '10px 10px 0 0' : 10,
          padding: '10px 16px', cursor: 'pointer', color: C.textSec, fontSize: 13, fontWeight: 600,
        }}
      >
        <span style={{ color: C.textMuted, fontSize: 11, transform: expanded ? 'rotate(90deg)' : 'none', transition: '0.2s', display: 'inline-block' }}>▶</span>
        All ICP Accounts {expanded && total > 0 ? `(${total.toLocaleString()} accounts)` : ''}
        <span style={{ color: C.textMuted, fontSize: 11, fontWeight: 400, marginLeft: 4 }}>
          {expanded ? '— click to collapse' : '— click to expand'}
        </span>
      </button>

      {expanded && (
        <div style={{ border: `1px solid ${C.border}`, borderTop: 'none', borderRadius: '0 0 10px 10px', overflow: 'hidden', background: C.card }}>
          {/* Chart filter banner */}
          {chartFilter?.dim && chartFilter?.value && (
            <div style={{ padding: '6px 14px', background: C.teal + '15', borderBottom: `1px solid ${C.teal}33`, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ color: C.teal, fontSize: 11 }}>
                🔵 Chart filter active: <strong>{chartFilter.dim}</strong> = <strong>{chartFilter.value}</strong>
              </span>
              <span style={{ color: C.textMuted, fontSize: 11 }}>· click the chart bar again to clear</span>
            </div>
          )}

          {/* Mini filters */}
          <div style={{ padding: '10px 14px', borderBottom: `1px solid ${C.border}`, display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
            <span style={{ color: C.textMuted, fontSize: 11 }}>Filter:</span>
            {/* EHR */}
            {ehrOptions.slice(0, 8).map((ehr) => filterPill(
              ehr,
              localFilters.ehr?.includes(ehr),
              () => setLocalFilters((f) => ({
                ...f,
                ehr: f.ehr?.includes(ehr) ? f.ehr.filter((v) => v !== ehr) : [...(f.ehr || []), ehr],
              }))
            ))}
            <span style={{ color: C.border, fontSize: 11 }}>|</span>
            {/* Employee buckets */}
            {empBuckets.map((b) => filterPill(
              b + ' emp',
              localFilters.employeeBucket?.includes(b),
              () => setLocalFilters((f) => ({
                ...f,
                employeeBucket: f.employeeBucket?.includes(b)
                  ? f.employeeBucket.filter((v) => v !== b)
                  : [...(f.employeeBucket || []), b],
              }))
            ))}
            {(Object.values(localFilters).some((v) => Array.isArray(v) && v.length)) && (
              <button
                onClick={() => setLocalFilters({})}
                style={{ background: 'none', border: `1px solid ${C.border}`, borderRadius: 6, color: C.textMuted, fontSize: 11, cursor: 'pointer', padding: '3px 8px' }}
              >
                ✕ Clear
              </button>
            )}
          </div>

          {isLoading && (
            <div style={{ textAlign: 'center', padding: '30px 0', color: C.textMuted, fontSize: 13 }}>⟳ Loading…</div>
          )}

          {!isLoading && records.length > 0 && (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 700 }}>
                <thead>
                  <tr>{mktCols.map((col) => <th key={col} style={thStyle}>{col}</th>)}</tr>
                </thead>
                <tbody>
                  {records.map((r, i) => (
                    <tr key={r.id || i}
                      style={{ transition: 'background 0.1s', cursor: 'default' }}
                      onMouseEnter={(e) => e.currentTarget.style.background = C.cardHover}
                      onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}>
                      {mktCols.map((col) => (
                        <td key={col} style={{ padding: '6px 12px', borderBottom: `1px solid ${C.border}1a`, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'middle', fontSize: 12, color: C.textSec }}>
                          {col === 'Account Name'
                            ? <span style={{ color: C.textPri, fontWeight: 500 }}>{r.fields?.[col] || '—'}</span>
                            : col === 'Stage'
                              ? <SelectBadge value={r.fields?.[col]} color={C.blue} small />
                              : col === 'Annual Revenue ($)' || col === 'ACV ($)'
                                ? (r.fields?.[col] ? fmt(r.fields[col], 'currency') : '—')
                                : (r.fields?.[col] != null ? String(r.fields[col]) : '—')
                          }
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {!isLoading && records.length === 0 && (
            <div style={{ color: C.textMuted, textAlign: 'center', padding: '30px 0', fontSize: 13 }}>No records match the current filters.</div>
          )}

          {meta?.totalPages > 1 && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, padding: '12px 0', borderTop: `1px solid ${C.border}` }}>
              <PaginationBtn disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>← Prev</PaginationBtn>
              <span style={{ color: C.textSec, fontSize: 12 }}>Page {meta.page} of {meta.totalPages} · {total.toLocaleString()} total</span>
              <PaginationBtn disabled={page >= meta.totalPages} onClick={() => setPage((p) => p + 1)}>Next →</PaginationBtn>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Section 5: Market Overview ───────────────────────────────────────────────
function HBarChart({ data, color, maxItems = 15, onBarClick, selectedName }) {
  const items = data.slice(0, maxItems);
  const maxVal = Math.max(...items.map((d) => d.value), 1);
  const isClickable = !!onBarClick;

  return (
    <div>
      {items.map((item) => {
        const isSelected = selectedName === item.name;
        return (
          <div
            key={item.name}
            onClick={() => isClickable && onBarClick(item.name)}
            style={{
              display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6,
              cursor: isClickable ? 'pointer' : 'default',
              borderRadius: 4,
              background: isSelected ? color + '18' : 'transparent',
              outline: isSelected ? `1px solid ${color}55` : 'none',
              padding: isSelected ? '1px 3px' : '1px 3px',
              transition: 'background 0.15s',
            }}
          >
            <div style={{
              color: isSelected ? color : C.textSec,
              fontSize: 11, width: 130,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              flexShrink: 0, textAlign: 'right',
              fontWeight: isSelected ? 600 : 400,
            }} title={item.name}>
              {item.name}
            </div>
            <div style={{ flex: 1, height: 16, background: C.surface, borderRadius: 3, overflow: 'hidden', border: isSelected ? `1px solid ${color}66` : '1px solid transparent' }}>
              <div style={{
                height: '100%', borderRadius: 3,
                background: `linear-gradient(90deg, ${color}99, ${color})`,
                width: `${Math.max(2, (item.value / maxVal) * 100)}%`,
                transition: 'width 0.4s ease',
                opacity: isSelected ? 1 : 0.75,
              }} />
            </div>
            <div style={{ color: isSelected ? color : C.textMuted, fontSize: 11, width: 40, textAlign: 'right', fontWeight: isSelected ? 600 : 400 }}>{item.value.toLocaleString()}</div>
          </div>
        );
      })}
      {isClickable && selectedName && (
        <button
          onClick={() => onBarClick(selectedName)}
          style={{ background: 'none', border: 'none', color: C.textMuted, fontSize: 10, cursor: 'pointer', padding: '2px 0', marginTop: 2 }}
        >
          ✕ Clear filter
        </button>
      )}
    </div>
  );
}

function CrosstabMatrix({ rowDim, colDim }) {
  const { data, isLoading } = useSWR(
    rowDim && colDim ? `/api/crosstab?row=${rowDim}&col=${colDim}` : null,
    fetcher, { revalidateOnFocus: false }
  );

  if (isLoading) return <div style={{ color: C.textMuted, fontSize: 12, padding: '20px 0' }}>Computing matrix…</div>;
  if (!data || !data.rows?.length) return <div style={{ color: C.textMuted, fontSize: 12 }}>No data available.</div>;

  const { rows, cols, matrix } = data;

  return (
    <div style={{ overflowX: 'auto', marginTop: 12 }}>
      <table style={{ borderCollapse: 'collapse', fontSize: 11 }}>
        <thead>
          <tr>
            <th style={{ padding: '6px 10px', color: C.textMuted, borderBottom: `1px solid ${C.border}`, textAlign: 'left' }}>↓ {rowDim} \ {colDim} →</th>
            {cols.map((c) => <th key={c} style={{ padding: '6px 8px', color: C.textMuted, borderBottom: `1px solid ${C.border}`, whiteSpace: 'nowrap', fontWeight: 500 }}>{c}</th>)}
            <th style={{ padding: '6px 8px', color: C.textMuted, borderBottom: `1px solid ${C.border}`, fontWeight: 700 }}>Total</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const total = cols.reduce((s, c) => s + (matrix[r]?.[c] || 0), 0);
            return (
              <tr key={r}>
                <td style={{ padding: '5px 10px', color: C.textSec, borderBottom: `1px solid ${C.border}1a`, whiteSpace: 'nowrap', fontWeight: 500 }}>{r}</td>
                {cols.map((c) => {
                  const val = matrix[r]?.[c] || 0;
                  return (
                    <td key={c} style={{
                      padding: '5px 8px', textAlign: 'center', borderBottom: `1px solid ${C.border}1a`,
                      background: val > 0 ? `${C.teal}${Math.min(99, Math.round((val / total) * 66 + 5)).toString(16).padStart(2,'0')}` : 'transparent',
                      color: val > 0 ? C.textPri : C.textMuted,
                    }}>
                      {val || '—'}
                    </td>
                  );
                })}
                <td style={{ padding: '5px 8px', textAlign: 'center', borderBottom: `1px solid ${C.border}1a`, color: C.teal, fontWeight: 700 }}>{total}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function MarketOverviewSection({ globals }) {
  const [rowDim, setRowDim] = useState('EHR');
  const [colDim, setColDim] = useState('Stage');

  // Chart-driven filter for MarketAccountList (Change 7/8/11)
  const [chartFilter, setChartFilter] = useState({ dim: null, value: null });

  const handleChartClick = (dim, value) => {
    setChartFilter((prev) =>
      prev.dim === dim && prev.value === value
        ? { dim: null, value: null }  // toggle off
        : { dim, value }
    );
  };

  if (!globals?.stats) return null;
  const { stats } = globals;

  const total = stats.total || 0;
  const estimatedTAM = total * 150_000;

  const toBarData = (obj) => Object.entries(obj || {})
    .filter(([, v]) => v > 0)
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value);

  const empOrder = ['1-25','26-100','101-500','500+','Unknown'];
  const empData = empOrder.map((k) => ({ name: k, value: stats.byEmployeeBucket?.[k] || 0 })).filter((d) => d.value > 0);

  const revOrder = ['<$1M','$1M-$5M','$5M-$10M','$10M-$25M','$25M+','Unknown'];
  const revData  = revOrder.map((k) => ({ name: k, value: stats.byRevenueBucket?.[k] || 0 })).filter((d) => d.value > 0);

  const provOrder = ['1-5','6-15','16-30','31-50','50+','Unknown'];
  const provData  = provOrder.map((k) => ({ name: k, value: stats.byProviderBucket?.[k] || 0 })).filter((d) => d.value > 0);

  const dimSelect = (val, onChange) => (
    <select value={val} onChange={(e) => onChange(e.target.value)} style={{
      background: C.card, border: `1px solid ${C.border}`, borderRadius: 6,
      padding: '4px 10px', color: C.textSec, fontSize: 12,
    }}>
      {CROSSTAB_DIMS.map((d) => <option key={d} value={d}>{d}</option>)}
    </select>
  );

  const chartCard = { background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: '14px 16px' };
  const chartTitle = { color: C.textSec, fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.4px', marginBottom: 12 };
  const chartSubtitle = { ...chartTitle, color: C.textMuted, fontWeight: 400, fontSize: 10, marginBottom: 4 };

  const isChartSelected = (dim, name) => chartFilter.dim === dim && chartFilter.value === name;

  return (
    <Section id="overview" title="🌍 Addressable Market Overview" accent={SECTION_ACCENT.overview}>
      {/* Header stat */}
      <div style={{ marginBottom: 8 }}>
        <span style={{ color: C.teal, fontWeight: 700, fontSize: 18 }}>{total.toLocaleString()}</span>
        <span style={{ color: C.textSec, fontSize: 14 }}> accounts in ICP · </span>
        <span style={{ color: C.teal, fontWeight: 700, fontSize: 18 }}>Est. {fmt(estimatedTAM, 'currency')}</span>
        <span style={{ color: C.textSec, fontSize: 14 }}> TAM</span>
      </div>
      <div style={{ color: C.textMuted, fontSize: 11, marginBottom: 16 }}>
        Click any chart bar to filter the account list below. Click again to clear.
        {chartFilter.dim && (
          <span style={{ color: C.teal, marginLeft: 8 }}>
            Active: <strong>{chartFilter.dim}</strong> = <strong>{chartFilter.value}</strong>
            <button onClick={() => setChartFilter({ dim: null, value: null })}
              style={{ background: 'none', border: 'none', color: C.teal, cursor: 'pointer', fontSize: 11, marginLeft: 4 }}>✕</button>
          </span>
        )}
      </div>

      {/* Charts grid — 4 original charts (Change 7/8 clickable) */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12, marginBottom: 12 }}>
        <div style={chartCard}>
          <div style={chartTitle}>By Source Category</div>
          <HBarChart
            data={toBarData(stats.bySource)} color={C.teal}
            onBarClick={(name) => handleChartClick('source', name)}
            selectedName={chartFilter.dim === 'source' ? chartFilter.value : null}
          />
        </div>
        <div style={chartCard}>
          <div style={chartTitle}>By EHR</div>
          <HBarChart
            data={toBarData(stats.byEhr)} color={C.blue}
            onBarClick={(name) => handleChartClick('ehr', name)}
            selectedName={chartFilter.dim === 'ehr' ? chartFilter.value : null}
          />
        </div>
        <div style={chartCard}>
          <div style={chartTitle}>By Specialty (Top 15)</div>
          <HBarChart
            data={toBarData(stats.bySpecialty)} color={C.purple} maxItems={15}
            onBarClick={(name) => handleChartClick('specialty', name)}
            selectedName={chartFilter.dim === 'specialty' ? chartFilter.value : null}
          />
        </div>
        <div style={chartCard}>
          <div style={chartTitle}>By Employee Size</div>
          <HBarChart
            data={empData} color={C.green}
            onBarClick={(name) => handleChartClick('employee', name)}
            selectedName={chartFilter.dim === 'employee' ? chartFilter.value : null}
          />
        </div>
      </div>

      {/* Change 11: Revenue Bucket + Provider Bucket charts */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12, marginBottom: 16 }}>
        <div style={chartCard}>
          <div style={chartTitle}>Revenue Bucket Distribution</div>
          <div style={{ color: C.textMuted, fontSize: 10, marginBottom: 8 }}>Annual Revenue ($)</div>
          <HBarChart
            data={revData} color={C.amber}
            onBarClick={(name) => handleChartClick('revenue', name)}
            selectedName={chartFilter.dim === 'revenue' ? chartFilter.value : null}
          />
        </div>
        <div style={chartCard}>
          <div style={chartTitle}>Provider Bucket Distribution</div>
          <div style={{ color: C.textMuted, fontSize: 10, marginBottom: 8 }}>Providers #</div>
          <HBarChart
            data={provData} color={C.pink}
            onBarClick={(name) => handleChartClick('provider', name)}
            selectedName={chartFilter.dim === 'provider' ? chartFilter.value : null}
          />
        </div>
      </div>

      {/* Crosstab */}
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: '14px 16px', marginBottom: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 4 }}>
          <span style={{ color: C.textSec, fontSize: 12, fontWeight: 600 }}>Custom Crosstab</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ color: C.textMuted, fontSize: 12 }}>Rows:</span>
            {dimSelect(rowDim, setRowDim)}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ color: C.textMuted, fontSize: 12 }}>Cols:</span>
            {dimSelect(colDim, setColDim)}
          </div>
        </div>
        <CrosstabMatrix rowDim={rowDim} colDim={colDim} />
      </div>

      {/* Collapsible full account list — receives chart filter (Change 7/8/11) */}
      <MarketAccountList globals={globals} chartFilter={chartFilter} />
    </Section>
  );
}

// ─── Contacts Tab ─────────────────────────────────────────────────────────────
function ContactsTab({ schema }) {
  const [filters, setFilters] = useState({});
  const [page, setPage] = useState(1);
  const [contactsCols, toggleContactsCol, resetContactsCols] =
    useColumnState('wt_contacts_cols_v2', CONTACTS_DEFAULT_COLS);
  const [searchInput, setSearchInput] = useState('');
  const debRef = useRef(null);

  useEffect(() => { setPage(1); }, [filters]);

  const url = buildContactsUrl(filters, page);
  const { data, error, isLoading } = useSWR(url, fetcher, {
    revalidateOnFocus: false,
    dedupingInterval: 5000,
  });

  const schemaProps = schema?.contacts?.properties || {};
  const propOrder   = schema?.contacts?.propOrder  || [...CONTACTS_DEFAULT_COLS];

  const selStyle = { background: C.surface, color: C.textSec, border: `1px solid ${C.border}`, borderRadius: 6, padding: '5px 10px', fontSize: 12, outline: 'none' };

  const handleSearch = (val) => {
    setSearchInput(val);
    clearTimeout(debRef.current);
    debRef.current = setTimeout(() => setFilters((f) => ({ ...f, search: val || undefined })), 300);
  };

  const clear = () => { setFilters({}); setSearchInput(''); };

  return (
    <>
      {/* Filters */}
      <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: '12px 16px', marginBottom: 14, display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
        <select value={filters.source || ''} onChange={(e) => setFilters((f) => ({ ...f, source: e.target.value || undefined }))} style={selStyle}>
          <option value="">All Sources</option>
          {(schemaProps?.['Source']?.options || []).map((o) => <option key={o.name} value={o.name}>{o.name}</option>)}
        </select>
        <select value={filters.connDegree || ''} onChange={(e) => setFilters((f) => ({ ...f, connDegree: e.target.value || undefined }))} style={selStyle}>
          <option value="">All Connections</option>
          {(schemaProps?.['Connection Degree']?.options || []).map((o) => <option key={o.name} value={o.name}>{o.name}</option>)}
        </select>
        <label style={{ color: C.green, fontSize: 12, display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
          <input type="checkbox" checked={filters.inSfdc || false} onChange={(e) => setFilters((f) => ({ ...f, inSfdc: e.target.checked || undefined }))} style={{ accentColor: C.green }} />
          In SFDC
        </label>
        <label style={{ color: C.accent, fontSize: 12, display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
          <input type="checkbox" checked={filters.inPipeline || false} onChange={(e) => setFilters((f) => ({ ...f, inPipeline: e.target.checked || undefined }))} style={{ accentColor: C.accent }} />
          In Pipeline
        </label>
        <input type="text" placeholder="🔍 Search contacts…" value={searchInput} onChange={(e) => handleSearch(e.target.value)}
          style={{ ...selStyle, flex: '1 1 160px', minWidth: 140, color: C.textPri }} />
        <button onClick={clear} style={{ background: 'transparent', color: C.textMuted, border: `1px solid ${C.border}`, borderRadius: 6, padding: '5px 12px', cursor: 'pointer', fontSize: 12 }}>✕ Clear</button>
      </div>

      {error && <div style={{ background: '#ef444422', border: `1px solid ${C.red}`, borderRadius: 8, padding: '10px 14px', marginBottom: 14, color: C.red, fontSize: 13 }}>⚠ Failed to load contacts.</div>}
      {isLoading && !data && <div style={{ textAlign: 'center', padding: '50px 0', color: C.textMuted, fontSize: 13 }}>⟳ Loading contacts…</div>}

      {data && (
        <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: `1px solid ${C.border}` }}>
            <span style={{ color: C.textSec, fontSize: 13, fontWeight: 600 }}>
              Contacts
              {data.meta && <span style={{ color: C.textMuted, fontWeight: 400, marginLeft: 8, fontSize: 12 }}>
                ({(data.records?.length ?? 0)} shown · {(data.meta.total ?? 0).toLocaleString()} total)
              </span>}
            </span>
            <ColumnPicker allCols={propOrder} visibleCols={contactsCols} onToggle={toggleContactsCol} onReset={resetContactsCols} />
          </div>

          {data.records?.length === 0 && <div style={{ color: C.textMuted, textAlign: 'center', padding: '40px 0', fontSize: 13 }}>No contacts match the current filters.</div>}

          {data.records?.length > 0 && (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 500 }}>
                <thead>
                  <tr>{propOrder.filter((c) => contactsCols.has(c)).map((col) => (
                    <th key={col} style={{ padding: '8px 12px', textAlign: 'left', color: C.textMuted, fontSize: 10, fontWeight: 600, borderBottom: `1px solid ${C.border}`, whiteSpace: 'nowrap', textTransform: 'uppercase', letterSpacing: '0.4px', background: C.card }}>{col}</th>
                  ))}</tr>
                </thead>
                <tbody>
                  {data.records.map((r, i) => (
                    <tr key={r.id || i} style={{ transition: 'background 0.1s' }}
                      onMouseEnter={(e) => e.currentTarget.style.background = C.cardHover}
                      onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}>
                      {propOrder.filter((c) => contactsCols.has(c)).map((col) => (
                        <td key={col} style={{ padding: '7px 12px', borderBottom: `1px solid ${C.border}1a`, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'middle' }}>
                          <FieldValue value={r.fields?.[col]} type={schemaProps?.[col]?.type || 'rich_text'} fieldName={col} schemaProps={schemaProps} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {data.meta?.totalPages > 1 && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, padding: '14px 0', borderTop: `1px solid ${C.border}` }}>
              <PaginationBtn disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>← Prev</PaginationBtn>
              <span style={{ color: C.textSec, fontSize: 12 }}>Page {data.meta.page} of {data.meta.totalPages}</span>
              <PaginationBtn disabled={page >= data.meta.totalPages} onClick={() => setPage((p) => p + 1)}>Next →</PaginationBtn>
            </div>
          )}
        </div>
      )}

      {data?.meta && <div style={{ color: C.textMuted, fontSize: 11, textAlign: 'right', marginTop: 8 }}>Cached {data.meta.cacheAge}s ago</div>}
    </>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function Home() {
  const [activeTab, setActiveTab] = useState('pipeline');
  const [filters, setFilters]     = useState(DEFAULT_PIPELINE_FILTERS);
  const [page, setPage]           = useState(1);
  const [tick, setTick]           = useState(0);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  // Reset page on filter change
  useEffect(() => { setPage(1); }, [filters]);

  // Auto-refresh every 60s
  useEffect(() => {
    const id = setInterval(() => {
      setTick((t) => t + 1);
      setLastRefreshed(new Date());
    }, 60_000);
    setLastRefreshed(new Date());
    return () => clearInterval(id);
  }, []);

  const pipelineUrl = buildPipelineUrl(filters, page, 50, tick);
  const { data: pipelineData, error: pipelineError, isLoading: pipelineLoading } = useSWR(
    pipelineUrl, fetcher, { revalidateOnFocus: false, dedupingInterval: 5000 }
  );

  // Stats (fast endpoint — returns immediately even on cold start)
  // Note: refreshInterval cannot reference statsData (TDZ), so we use a ref-based approach
  const [statsRefreshMs, setStatsRefreshMs] = useState(5000); // start fast, slow down once warm
  const { data: statsData } = useSWR('/api/stats', fetcher, {
    revalidateOnFocus: false,
    refreshInterval: statsRefreshMs,
    onSuccess: (data) => {
      // Once data loads and isn't in loading state, switch to 60s refresh
      if (!data?.loading) setStatsRefreshMs(60_000);
    },
  });

  // Schema
  const { data: schema } = useSWR('/api/schema', fetcher, {
    revalidateOnFocus: false,
    refreshInterval: 10 * 60 * 1000,
  });

  // Prefer fresh globals from pipeline response; fall back to stats endpoint
  const globals      = pipelineData?.globals ?? (statsData?.loading === false ? statsData : null);
  const statsLoading = !statsData || statsData.loading;
  const currentMonth = pipelineData?.meta?.currentMonth ?? (() => {
    const d = new Date(); return d.toLocaleString('default', { month: 'long', year: 'numeric' });
  })();

  const tabBtn = (id, label) => (
    <button
      key={id}
      onClick={() => setActiveTab(id)}
      style={{
        background:   activeTab === id ? C.accent + '22' : 'transparent',
        color:        activeTab === id ? C.accent : C.textSec,
        border:       `1px solid ${activeTab === id ? C.accent + '66' : 'transparent'}`,
        borderRadius: 8, padding: '6px 18px', cursor: 'pointer',
        fontSize: 13, fontWeight: activeTab === id ? 600 : 400, transition: 'all 0.15s',
      }}
    >
      {label}
    </button>
  );

  return (
    <div style={{ minHeight: '100vh', background: C.bg, color: C.textPri }}>
      <Head>
        <title>🗼 Watchtower — Commure Call Center Agents</title>
        <meta name="description" content="Commure Call Center Agents — Watchtower Pipeline Dashboard" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>

      <div style={{ maxWidth: 1440, margin: '0 auto', padding: '20px 18px' }}>

        {/* ── Header ── */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          flexWrap: 'wrap', gap: 12, marginBottom: 20, paddingBottom: 16,
          borderBottom: `1px solid ${C.border}`,
        }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, letterSpacing: '-0.5px' }}>
              🗼 Watchtower
            </h1>
            <div style={{ color: C.textMuted, fontSize: 12, marginTop: 3 }}>
              Commure Call Center Agents
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
            {lastRefreshed && (
              <div style={{ color: C.textMuted, fontSize: 11, textAlign: 'right' }}>
                <div>Last refreshed: {lastRefreshed.toLocaleTimeString()}</div>
                <div style={{ color: C.textMuted + '99' }}>Auto-refresh every 60s</div>
              </div>
            )}
            <div style={{
              display: 'flex', gap: 4, background: C.card,
              border: `1px solid ${C.border}`, borderRadius: 10, padding: 4,
            }}>
              {tabBtn('pipeline', '📊 Pipeline')}
              {tabBtn('contacts', '👥 Contacts')}
            </div>
          </div>
        </div>

        {/* ── Pipeline Tab ── */}
        {activeTab === 'pipeline' && (
          <>
            <GoalsSection globals={globals} currentMonth={currentMonth} statsLoading={statsLoading} />
            <MarketSummarySection globals={globals} statsLoading={statsLoading} />
            <PipelineSection
              schema={schema}
              pipelineData={pipelineData}
              isLoading={pipelineLoading}
              error={pipelineError}
              filters={filters}
              setFilters={setFilters}
              page={page}
              setPage={setPage}
            />
            <ActivitySection />
            <MarketOverviewSection globals={globals} />
          </>
        )}

        {/* ── Contacts Tab ── */}
        {activeTab === 'contacts' && <ContactsTab schema={schema} />}

      </div>
    </div>
  );
}
