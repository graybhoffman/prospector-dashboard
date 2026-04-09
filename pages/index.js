/**
 * 🗼 Watchtower v2 — Pipeline Dashboard
 * Commure Call Center Agents
 * Full redesign: Goals, Market Summary, Pipeline Tracking, Activity, Market Overview
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useSession, signOut } from 'next-auth/react';
import Head from 'next/head';
import useSWR from 'swr';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  Cell, LabelList,
} from 'recharts';
import DataGrid, { STAGE_COLORS, STAGE_TEXT_COLORS } from '../components/DataGrid';

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

  // Collapsible per-goal account lists
  const [expandedGoal, setExpandedGoal] = useState(null);
  const GOAL_STAGES = {
    goal1: ['Discovery','SQL','Negotiations','Closed-Won','Pilot Deployment','Full Deployment'],
    goal2: ['Closed-Won','Pilot Deployment','Full Deployment'],
    goal3: ['Closed-Won','Pilot Deployment','Full Deployment'],
  };

  const goalAccountUrl = (key) => {
    const stages = GOAL_STAGES[key] || [];
    return `/api/pipeline?stage=${encodeURIComponent(stages.join(','))}&pageSize=100&page=1`;
  };

  const { data: goal1Accounts } = useSWR(
    expandedGoal === 'goal1' ? goalAccountUrl('goal1') : null, fetcher,
    { revalidateOnFocus: false }
  );
  const { data: goal2Accounts } = useSWR(
    expandedGoal === 'goal2' ? goalAccountUrl('goal2') : null, fetcher,
    { revalidateOnFocus: false }
  );
  const { data: goal3Accounts } = useSWR(
    expandedGoal === 'goal3' ? goalAccountUrl('goal3') : null, fetcher,
    { revalidateOnFocus: false }
  );

  const goalDataMap = { goal1: goal1Accounts, goal2: goal2Accounts, goal3: goal3Accounts };

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

  function CollapsibleAccountTable({ goalKey }) {
    const isExpanded = expandedGoal === goalKey;
    const accountData = goalDataMap[goalKey];
    const records = accountData?.records || [];
    const loading = isExpanded && !accountData;

    const thS = {
      padding: '6px 10px', textAlign: 'left', color: C.textMuted,
      fontSize: 10, fontWeight: 600, borderBottom: `1px solid ${C.border}`,
      textTransform: 'uppercase', letterSpacing: '0.3px', whiteSpace: 'nowrap',
      background: C.surface,
    };
    const tdS = { padding: '6px 10px', fontSize: 12, borderBottom: `1px solid ${C.border}1a`, color: C.textSec };

    if (!isExpanded) return null;
    return (
      <div style={{ marginTop: 10, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: '16px 18px', color: C.textMuted, fontSize: 12 }}>⟳ Loading accounts…</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={thS}>Account Name</th>
                  <th style={thS}>Stage</th>
                  <th style={{ ...thS, textAlign: 'right' }}>ACV</th>
                  <th style={thS}>Owner</th>
                  <th style={{ ...thS, textAlign: 'center' }}>SFDC</th>
                </tr>
              </thead>
              <tbody>
                {records.length === 0 ? (
                  <tr><td colSpan={5} style={{ ...tdS, textAlign: 'center', padding: '16px 10px', color: C.textMuted }}>No accounts found</td></tr>
                ) : records.map((rec, i) => {
                  const f = rec.fields || rec;
                  const name = f['Account Name'] || f.account_name || '—';
                  const stage = f['Stage'] || f.stage || '—';
                  const acv = f['Annual Revenue ($)'] || f['ACV'] || null;
                  const owner = f['Owner'] || f['Account Owner'] || f.owner || '—';
                  const sfdcId = f['SFDC Account ID'] || f['sfdc_id'] || null;
                  const sfdcUrl = sfdcId ? `https://athelas.lightning.force.com/lightning/r/Account/${sfdcId}/view` : null;
                  return (
                    <tr key={i} style={{ background: i % 2 === 0 ? 'transparent' : C.card + '44' }}>
                      <td style={{ ...tdS, color: C.textPri, fontWeight: 500 }}>{name}</td>
                      <td style={tdS}>
                        <span style={{ background: (STAGE_COLORS[stage] || '#334155') + '33', color: STAGE_TEXT_COLORS[stage] || C.textSec, border: `1px solid ${(STAGE_COLORS[stage] || '#334155')}66`, borderRadius: 4, padding: '1px 6px', fontSize: 10, fontWeight: 600 }}>{stage}</span>
                      </td>
                      <td style={{ ...tdS, textAlign: 'right' }}>{acv ? fmt(acv, 'currency') : '—'}</td>
                      <td style={tdS}>{owner}</td>
                      <td style={{ ...tdS, textAlign: 'center' }}>
                        {sfdcUrl
                          ? <a href={sfdcUrl} target="_blank" rel="noopener noreferrer" style={{ color: C.blue, fontSize: 14, textDecoration: 'none' }} title="Open in Salesforce">🔗</a>
                          : <span style={{ color: C.textMuted }}>—</span>
                        }
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  }

  function GoalRow({ goalKey, label, current, target, color, format = 'number' }) {
    const pct = target > 0 ? Math.min(100, Math.round((current / target) * 100)) : 0;
    const toGo = Math.max(0, target - current);
    const displayValue  = format === 'currency' ? fmt(current, 'currency') : current;
    const displayTarget = format === 'currency' ? fmt(target, 'currency') : target;
    const toGoDisplay   = format === 'currency' ? fmt(toGo, 'currency') : toGo;
    const isExpanded = expandedGoal === goalKey;
    return (
      <div style={{ marginBottom: 18 }}>
        <div
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, cursor: 'pointer' }}
          onClick={() => setExpandedGoal(isExpanded ? null : goalKey)}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ color: C.textPri, fontSize: 13, fontWeight: 600 }}>{label}</span>
            <span style={{ color: C.textMuted, fontSize: 11, transition: 'transform 0.2s', display: 'inline-block', transform: isExpanded ? 'rotate(180deg)' : 'none' }}>▾</span>
          </div>
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
        <CollapsibleAccountTable goalKey={goalKey} />
      </div>
    );
  }

  return (
    <Section id="goals" title="🎯 Goals & Progress" accent={SECTION_ACCENT.goals}
      subtitle="Target: July 31, 2026 · Cumulative from inception">
      <GoalRow
        goalKey="goal1"
        label="Accounts moved to Discovery stage or beyond (cumulative)"
        current={g1} target={t1} color={C.purple}
      />
      <GoalRow
        goalKey="goal2"
        label="Closed-Won accounts (incl. Pilot &amp; Full Deployment)"
        current={g2} target={t2} color={C.green}
      />
      <GoalRow
        goalKey="goal3"
        label="Deployed ARR"
        current={g3} target={t3} color={C.amber} format="currency"
      />
    </Section>
  );
}

// ─── Section 2: Market Summary ────────────────────────────────────────────────
function MarketSummarySection({ globals, statsLoading, title = '📊 Market Summary', hiddenLabels = [] }) {
  const [tooltipOpen, setTooltipOpen] = useState(false);
  if (statsLoading || !globals?.stats) {
    return (
      <Section id="market" title={title} accent={SECTION_ACCENT.market} defaultOpen={true}>
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

  const allStatCards = [
    { label: 'Total in Pipeline',    value: fmt(stats.total),                       color: C.blue    },
    { label: 'Est. TAM Value',       value: fmt(stats.total * 150_000, 'currency'), color: C.green,  sub: '@ $150K avg ACV' },
    { label: 'Non-RCM ICP',          value: fmt(stats.notRcmCount),                 color: C.amber   },
    { label: 'Confirmed ICP Tier',   value: fmt(stats.confirmedIcpCount),            color: C.purple  },
    { label: 'Deployed ARR',         value: '$650K',                                 color: C.green,  sub: 'Nathan Littauer $575K + Medvanta $75K' },
  ];
  const statCards = allStatCards.filter(({ label }) => !hiddenLabels.includes(label));

  return (
    <Section id="market" title={title} accent={SECTION_ACCENT.market} defaultOpen={true}>
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
                <li>Target EHR: eCW, Athena/Athenahealth, ModMed, AdvancedMD, MEDITECH, or Epic</li>
                <li>Size: $10M+ revenue OR 25+ providers OR 50+ employees OR 10+ locations</li>
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
          <div style={{ fontSize: 14, marginBottom: 8 }}>⟳ Loading pipeline…</div>
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

// ─── Section 4: Account and Contact Changes ───────────────────────────────────
// Change 10: replaced WoW/MoM stage transitions with 4-metric × 4-period tables
function ActivitySection() {
  const { data, error, isLoading } = useSWR('/api/activity', fetcher, {
    revalidateOnFocus: false,
    refreshInterval: 5 * 60 * 1000,
  });

  const { data: contactsData } = useSWR('/api/contacts-activity', fetcher, {
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
    const rows = ACTIVITY_METRICS.map((metric) => {
      const counts = periods.map(({ start, end }) => countInPeriod(items, metric.stages, start, end));
      const delta = counts[3] - counts[2];
      return { ...metric, counts, delta };
    });
    // Add Contacts Added row from contacts-activity API
    const contactsCounts = contactsData
      ? periods.map((p, i) => {
          const src = p === weeks[0] || p === weeks[1] || p === weeks[2] || p === weeks[3]
            ? contactsData.weeks
            : contactsData.months;
          return null; // resolved below
        })
      : null;
    return rows;
  };

  const buildRowsWithContacts = (periods, isWeek) => {
    const items = data?.activity || [];
    const rows = ACTIVITY_METRICS.map((metric) => {
      const counts = periods.map(({ start, end }) => countInPeriod(items, metric.stages, start, end));
      const delta = counts[3] - counts[2];
      return { ...metric, counts, delta };
    });
    // Add Contacts Added row
    const contactPeriods = isWeek ? contactsData?.weeks : contactsData?.months;
    const contactCounts = contactPeriods
      ? periods.map((_, i) => contactPeriods[i]?.count ?? null)
      : periods.map(() => null);
    const contactDelta = contactCounts[3] != null && contactCounts[2] != null
      ? contactCounts[3] - contactCounts[2]
      : 0;
    rows.push({
      label: 'Contacts Added',
      desc: 'New contacts created',
      stages: [],
      counts: contactCounts.map((c) => c ?? 0),
      delta: contactDelta,
      nullCounts: contactPeriods == null,
    });
    return rows;
  };

  const wowRows = data ? buildRowsWithContacts(weeks, true)  : null;
  const momRows = data ? buildRowsWithContacts(months, false) : null;

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

  return (
    <Section id="activity" title="🔄 Account and Contact Changes" accent={SECTION_ACCENT.activity}>
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

function MarketOverviewSection({ globals, title = '🌍 Addressable Market Overview' }) {
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
    <Section id="overview" title={title} accent={SECTION_ACCENT.overview}>
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

// ─── DataSection ──────────────────────────────────────────────────────────────
function fmt$(n) {
  if (n == null || n === '') return '—';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n}`;
}

function InlineEdit({ value, fieldKey, accountId, onSave }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft]     = useState('');
  const inputRef = useRef(null);

  function startEdit() {
    setDraft(value ?? '');
    setEditing(true);
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  function commit() {
    setEditing(false);
    if (String(draft) !== String(value ?? '')) onSave(accountId, fieldKey, draft);
  }

  if (editing) return (
    <input
      ref={inputRef}
      value={draft}
      onChange={e => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false); }}
      style={{
        background: '#0f1117', color: '#fff', border: '1px solid #22c55e',
        borderRadius: 4, padding: '2px 6px', width: '100%', fontSize: 12,
        outline: 'none',
      }}
    />
  );

  return (
    <div
      onClick={startEdit}
      style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, minWidth: 40 }}
      title="Click to edit"
    >
      <span style={{ color: '#cbd5e1' }}>{value || '—'}</span>
      <span style={{ color: '#475569', fontSize: 10, opacity: 0, transition: 'opacity 0.1s' }} className="pencil">✏</span>
    </div>
  );
}

function DataSection() {
  const [subTab, setSubTab] = useState('accounts');

  // ─ Accounts state ─
  const [accSearch, setAccSearch]   = useState('');
  const [accEhr,    setAccEhr]      = useState('');
  const [accStage,  setAccStage]    = useState('');
  const [accIcp,    setAccIcp]      = useState(false);
  const [accPage,   setAccPage]     = useState(1);
  const [accShowExcluded, setAccShowExcluded] = useState(false);

  // ─ Contacts state ─
  const [conSearch, setConSearch]   = useState('');
  const [conAccId,  setConAccId]    = useState('');
  const [conTarget, setConTarget]   = useState(false);
  const [conPage,   setConPage]     = useState(1);

  // ─ Opps state ─
  const [oppSearch, setOppSearch]   = useState('');
  const [oppStage,  setOppStage]    = useState('');
  const [oppEhr,    setOppEhr]      = useState('');
  const [oppOwner,  setOppOwner]    = useState('');
  const [oppPage,   setOppPage]     = useState(1);

  // ─ Build URLs ─
  function buildAccUrl() {
    const p = new URLSearchParams({ page: accPage, pageSize: 50 });
    if (accSearch) p.set('search', accSearch);
    if (accEhr)    p.set('ehr', accEhr);
    if (accStage)  p.set('stage', accStage);
    if (accIcp)    p.set('icp', 'true');
    if (accShowExcluded) p.set('includeExcluded', 'true');
    return `/api/accounts?${p}`;
  }
  function buildConUrl() {
    const p = new URLSearchParams({ page: conPage, pageSize: 50 });
    if (conSearch) p.set('search', conSearch);
    if (conAccId)  p.set('accountId', conAccId);
    if (conTarget) p.set('targetPersona', 'true');
    return `/api/contacts?${p}`;
  }
  function buildOppUrl() {
    const p = new URLSearchParams({ page: oppPage, pageSize: 50 });
    if (oppSearch) p.set('search', oppSearch);
    if (oppStage)  p.set('stage', oppStage);
    if (oppEhr)    p.set('ehr', oppEhr);
    if (oppOwner)  p.set('owner', oppOwner);
    return `/api/opportunities?${p}`;
  }

  const { data: accData,  isLoading: accLoading  } = useSWR(subTab === 'accounts'     ? buildAccUrl() : null, fetcher, { revalidateOnFocus: false });
  const { data: conData,  isLoading: conLoading  } = useSWR(subTab === 'contacts'     ? buildConUrl() : null, fetcher, { revalidateOnFocus: false });
  const { data: oppData,  isLoading: oppLoading  } = useSWR(subTab === 'opportunities'? buildOppUrl() : null, fetcher, { revalidateOnFocus: false });

  const [searchDraft, setSearchDraft] = useState('');
  const searchRef = useRef(null);

  useEffect(() => {
    setSearchDraft('');
    setAccPage(1); setConPage(1); setOppPage(1);
  }, [subTab]);

  function handleSearch(val) {
    setSearchDraft(val);
    clearTimeout(searchRef.current);
    searchRef.current = setTimeout(() => {
      if (subTab === 'accounts')      { setAccSearch(val);  setAccPage(1); }
      if (subTab === 'contacts')      { setConSearch(val);  setConPage(1); }
      if (subTab === 'opportunities') { setOppSearch(val);  setOppPage(1); }
    }, 350);
  }

  async function handleInlineEdit(accountId, field, value) {
    try {
      await fetch('/api/accounts', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId, field, value }),
      });
      // Re-fetch will happen automatically via SWR
    } catch (e) {
      console.error('Inline edit failed:', e);
    }
  }

  // Styles
  const S = {
    container: { background: '#1a1d2e', borderRadius: 12, padding: '18px 20px', marginTop: 20, border: '1px solid #252535' },
    subTabBar: { display: 'flex', gap: 4, marginBottom: 14 },
    subTab: (active) => ({
      background: active ? '#6366f122' : 'transparent',
      color: active ? '#6366f1' : '#94a3b8',
      border: `1px solid ${active ? '#6366f166' : 'transparent'}`,
      borderRadius: 8, padding: '5px 14px', cursor: 'pointer',
      fontSize: 12, fontWeight: active ? 600 : 400,
    }),
    filterRow: { display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' },
    searchBox: {
      background: '#0f1117', border: '1px solid #252535', borderRadius: 8,
      color: '#fff', padding: '6px 10px', fontSize: 12, width: 220, outline: 'none',
    },
    select: {
      background: '#0f1117', border: '1px solid #252535', borderRadius: 8,
      color: '#94a3b8', padding: '6px 10px', fontSize: 12, outline: 'none', cursor: 'pointer',
    },
    toggleBtn: (active) => ({
      background: active ? '#22c55e22' : '#0f1117',
      color: active ? '#22c55e' : '#94a3b8',
      border: `1px solid ${active ? '#22c55e66' : '#252535'}`,
      borderRadius: 8, padding: '6px 12px', fontSize: 12, cursor: 'pointer',
    }),
    table: { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
    th: { padding: '7px 8px', color: '#64748b', borderBottom: '1px solid #252535', textAlign: 'left', whiteSpace: 'nowrap', fontWeight: 500 },
    td: (i) => ({ padding: '6px 8px', borderBottom: '1px solid #1e2235', background: i % 2 === 0 ? '#1a1d2e' : '#1e2240', whiteSpace: 'nowrap' }),
    icpBadge: { background: '#22c55e22', color: '#22c55e', border: '1px solid #22c55e44', borderRadius: 4, padding: '1px 6px', fontSize: 10, fontWeight: 600 },
    pagination: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 12, color: '#64748b', fontSize: 12 },
    pageBtn: (disabled) => ({
      background: disabled ? '#0f1117' : '#252535', color: disabled ? '#475569' : '#cbd5e1',
      border: '1px solid #252535', borderRadius: 6, padding: '4px 10px', cursor: disabled ? 'default' : 'pointer', fontSize: 12,
    }),
    link: { color: '#6366f1', textDecoration: 'none' },
    muted: { color: '#64748b' },
    loading: { textAlign: 'center', padding: '40px 0', color: '#64748b', fontSize: 13 },
  };

  function Pagination({ page, setPage, total, pageSize }) {
    const totalPages = Math.ceil(total / pageSize);
    return (
      <div style={S.pagination}>
        <button style={S.pageBtn(page <= 1)} onClick={() => page > 1 && setPage(page - 1)} disabled={page <= 1}>← Prev</button>
        <span>Page {page} of {totalPages} · {total.toLocaleString()} records</span>
        <button style={S.pageBtn(page >= totalPages)} onClick={() => page < totalPages && setPage(page + 1)} disabled={page >= totalPages}>Next →</button>
      </div>
    );
  }

  // ─ Accounts Table ─
  function AccountsTable() {
    const accounts = accData?.accounts || [];
    const total    = accData?.total || 0;
    const EHR_OPTIONS = ['eCW','Athena','ModMed','AdvancedMD','MEDITECH','Epic','Cerner','Other'];
    const STAGE_OPTIONS = [
      'Prospect','Outreach','Discovery','SQL','Negotiations',
      'Pilot Deployment','Full Deployment','Closed-Won',
    ];

    function RoeBadge({ issues }) {
      if (!issues || issues.length === 0) return <span style={S.muted}>—</span>;
      const hasRed = issues.some(i => i.toLowerCase().includes('closed-won') || i.toLowerCase().includes('closed won'));
      return (
        <span title={issues.join(', ')} style={{
          background: hasRed ? '#ef444422' : '#f59e0b22',
          color:      hasRed ? '#ef4444'   : '#f59e0b',
          border:     `1px solid ${hasRed ? '#ef444444' : '#f59e0b44'}`,
          borderRadius: 4, padding: '1px 6px', fontSize: 10, fontWeight: 700,
          cursor: 'help', whiteSpace: 'nowrap',
        }}>
          {hasRed ? '🔴' : '🟡'} ROE
        </span>
      );
    }

    return (
      <>
        <div style={S.filterRow}>
          <input placeholder="🔍 Search accounts…" value={searchDraft} onChange={e => handleSearch(e.target.value)} style={S.searchBox} />
          <select value={accEhr} onChange={e => { setAccEhr(e.target.value); setAccPage(1); }} style={S.select}>
            <option value="">All EHRs</option>
            {EHR_OPTIONS.map(v => <option key={v} value={v}>{v}</option>)}
          </select>
          <select value={accStage} onChange={e => { setAccStage(e.target.value); setAccPage(1); }} style={S.select}>
            <option value="">All Stages</option>
            {STAGE_OPTIONS.map(v => <option key={v} value={v}>{v}</option>)}
          </select>
          <button style={S.toggleBtn(accIcp)} onClick={() => { setAccIcp(!accIcp); setAccPage(1); }}>
            {accIcp ? '✅ ICP Only' : 'ICP Only'}
          </button>
          <button style={S.toggleBtn(accShowExcluded)} onClick={() => { setAccShowExcluded(!accShowExcluded); setAccPage(1); }}>
            {accShowExcluded ? '👁 Showing Excluded' : 'Show Excluded'}
          </button>
          {accData?.total != null && (
            <span style={{ color: '#64748b', fontSize: 12, marginLeft: 8 }}>
              {accData.total.toLocaleString()} accounts
            </span>
          )}
        </div>
        {accLoading && <div style={S.loading}>⟳ Loading accounts…</div>}
        {!accLoading && (
          <>
            <div style={{ overflowX: 'auto' }}>
              <table style={S.table}>
                <thead>
                  <tr>
                    {['Account Name','Stage','EHR','ICP','Revenue','Providers','Employees','Locations','Est. Call Vol','Specialty','Source Category','Owner','ROE'].map(h =>
                      <th key={h} style={S.th}>{h}</th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {accounts.length === 0 && (
                    <tr><td colSpan={13} style={{ ...S.td(0), textAlign: 'center', color: '#64748b', padding: '30px 0' }}>No accounts found</td></tr>
                  )}
                  {accounts.map((a, i) => {
                    // Support both Postgres snake_case fields and legacy camelCase
                    const accountId = a.sfdc_id || a.sfdcAccountId || a.accountId || String(a.id);
                    const accountName = a.name || a.accountName || '—';
                    const sfdcLink = a.sfdc_link || a.sfdcAccountLink;
                    const excluded = a.exclude_from_reporting || a.excludeFromReporting;
                    const stage = a.agents_stage || a.stage;
                    const ehr = a.ehr;
                    const isICP = a.agents_icp || a.isICP;
                    const revenue = a.annual_revenue != null ? a.annual_revenue : a.annualRevenue;
                    const providers = a.num_providers != null ? a.num_providers : a.providers;
                    const employees = a.num_employees != null ? a.num_employees : a.employees;
                    const locations = a.num_locations != null ? a.num_locations : a.locations;
                    const callVol = a.est_monthly_call_volume != null ? a.est_monthly_call_volume : a.estMonthlyCallVolume;
                    const specialty = a.specialty;
                    const sourceCategory = a.source_category || a.sourceCategory;
                    const owner = a.agents_owner || a.agentsTeamOwner;
                    const roeIssues = Array.isArray(a.potential_roe_issue) ? a.potential_roe_issue : (Array.isArray(a.potentialRoeIssue) ? a.potentialRoeIssue : (a.potentialRoeIssue ? [a.potentialRoeIssue] : []));
                    return (
                    <tr key={accountId} style={{ transition: 'background 0.1s' }}
                      onMouseEnter={e => e.currentTarget.style.background = '#252540'}
                      onMouseLeave={e => e.currentTarget.style.background = ''}>
                      <td style={{ ...S.td(i), maxWidth: 220 }}>
                        {sfdcLink
                          ? <a href={sfdcLink} target="_blank" rel="noreferrer" style={{ ...S.link, fontWeight: 500, ...(excluded ? { textDecoration: 'line-through', opacity: 0.6 } : {}) }}>{accountName}</a>
                          : <span style={{ color: '#cbd5e1', fontWeight: 500, ...(excluded ? { textDecoration: 'line-through', opacity: 0.6 } : {}) }}>{accountName}</span>}
                        {excluded && (
                          <span style={{background:'#374151', color:'#9ca3af', fontSize:10, padding:'1px 5px', borderRadius:3, marginLeft:6}}>excluded</span>
                        )}
                      </td>
                      <td style={S.td(i)}>
                        <span style={{
                          background: '#6366f122', color: '#818cf8',
                          border: '1px solid #6366f144', borderRadius: 4,
                          padding: '1px 6px', fontSize: 10, fontWeight: 600, whiteSpace: 'nowrap',
                        }}>{stage || '—'}</span>
                      </td>
                      <td style={S.td(i)}><span style={{ color: '#a78bfa' }}>{ehr || '—'}</span></td>
                      <td style={S.td(i)}>{isICP ? <span style={S.icpBadge}>ICP</span> : <span style={S.muted}>—</span>}</td>
                      <td style={S.td(i)}>
                        <InlineEdit value={revenue != null ? revenue : ''} fieldKey="annual_revenue" accountId={accountId} onSave={handleInlineEdit} />
                      </td>
                      <td style={S.td(i)}>
                        <InlineEdit value={providers != null ? providers : ''} fieldKey="num_providers" accountId={accountId} onSave={handleInlineEdit} />
                      </td>
                      <td style={S.td(i)}>
                        <InlineEdit value={employees != null ? employees : ''} fieldKey="num_employees" accountId={accountId} onSave={handleInlineEdit} />
                      </td>
                      <td style={S.td(i)}>
                        <InlineEdit value={locations != null ? locations : ''} fieldKey="num_locations" accountId={accountId} onSave={handleInlineEdit} />
                      </td>
                      <td style={S.td(i)}>
                        <InlineEdit value={callVol != null ? callVol : ''} fieldKey="est_monthly_call_volume" accountId={accountId} onSave={handleInlineEdit} />
                      </td>
                      <td style={{ ...S.td(i), maxWidth: 140 }}>
                        <InlineEdit value={specialty || ''} fieldKey="specialty" accountId={accountId} onSave={handleInlineEdit} />
                      </td>
                      <td style={S.td(i)}><span style={S.muted}>{sourceCategory || '—'}</span></td>
                      <td style={S.td(i)}><span style={S.muted}>{owner || '—'}</span></td>
                      <td style={S.td(i)}>
                        <RoeBadge issues={roeIssues} />
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {total > 0 && <Pagination page={accPage} setPage={setAccPage} total={total} pageSize={50} />}
          </>
        )}
      </>
    );
  }

  // ─ Contacts Table ─
  function ContactsTable() {
    const contacts = conData?.contacts || [];
    const total    = conData?.total    || 0;
    return (
      <>
        <div style={S.filterRow}>
          <input placeholder="🔍 Search contacts…" value={searchDraft} onChange={e => handleSearch(e.target.value)} style={S.searchBox} />
          <button style={S.toggleBtn(conTarget)} onClick={() => { setConTarget(!conTarget); setConPage(1); }}>
            {conTarget ? '✅ Target Persona' : 'Target Persona'}
          </button>
        </div>
        {conLoading && <div style={S.loading}>⟳ Loading contacts…</div>}
        {!conLoading && (
          <>
            <div style={{ overflowX: 'auto' }}>
              <table style={S.table}>
                <thead>
                  <tr>
                    {['Name','Title','Email','Phone','Account','Target Persona'].map(h =>
                      <th key={h} style={S.th}>{h}</th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {contacts.length === 0 && (
                    <tr><td colSpan={6} style={{ ...S.td(0), textAlign: 'center', color: '#64748b', padding: '30px 0' }}>No contacts found</td></tr>
                  )}
                  {contacts.map((c, i) => (
                    <tr key={c.sfdc_id || c.contactId || i}
                      onMouseEnter={e => e.currentTarget.style.background = '#252540'}
                      onMouseLeave={e => e.currentTarget.style.background = ''}>
                      <td style={S.td(i)}><span style={{ color: '#cbd5e1', fontWeight: 500 }}>{c.full_name || `${c.first_name || c.firstName || ''} ${c.last_name || c.lastName || ''}`.trim() || '—'}</span></td>
                      <td style={S.td(i)}><span style={S.muted}>{c.title || '—'}</span></td>
                      <td style={S.td(i)}>{(c.email) ? <a href={`mailto:${c.email}`} style={S.link}>{c.email}</a> : <span style={S.muted}>—</span>}</td>
                      <td style={S.td(i)}><span style={S.muted}>{c.phone || '—'}</span></td>
                      <td style={S.td(i)}><span style={{ color: '#a78bfa' }}>{c.account_sfdc_id || c.accountName || '—'}</span></td>
                      <td style={S.td(i)}>{(c.target_persona || c.targetPersona) ? <span style={S.icpBadge}>✓</span> : <span style={S.muted}>—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {total > 0 && <Pagination page={conPage} setPage={setConPage} total={total} pageSize={50} />}
          </>
        )}
      </>
    );
  }

  // ─ Opportunities Table ─
  function OpportunitiesTable() {
    const opps  = oppData?.opportunities || [];
    const total = oppData?.total          || 0;
    const STAGE_OPTS = ['Early / Mid Pipeline','Late Pipeline','Closed Won','Closed Lost'];
    const EHR_OPTS   = ['eCW','Athena','ModMed','AdvancedMD','MEDITECH','Epic','Cerner'];
    const owners = [...new Set((oppData?.opportunities || []).map(o => o.owner).filter(Boolean))].sort();

    return (
      <>
        <div style={S.filterRow}>
          <input placeholder="🔍 Search opportunities…" value={searchDraft} onChange={e => handleSearch(e.target.value)} style={S.searchBox} />
          <select value={oppStage} onChange={e => { setOppStage(e.target.value); setOppPage(1); }} style={S.select}>
            <option value="">All Stages</option>
            {STAGE_OPTS.map(v => <option key={v} value={v}>{v}</option>)}
          </select>
          <select value={oppEhr} onChange={e => { setOppEhr(e.target.value); setOppPage(1); }} style={S.select}>
            <option value="">All EHRs</option>
            {EHR_OPTS.map(v => <option key={v} value={v}>{v}</option>)}
          </select>
          <select value={oppOwner} onChange={e => { setOppOwner(e.target.value); setOppPage(1); }} style={S.select}>
            <option value="">All Owners</option>
            {owners.map(v => <option key={v} value={v}>{v}</option>)}
          </select>
        </div>
        {oppLoading && <div style={S.loading}>⟳ Loading opportunities…</div>}
        {!oppLoading && (
          <>
            <div style={{ overflowX: 'auto' }}>
              <table style={S.table}>
                <thead>
                  <tr>
                    {['Opp Name','Account','Stage','EHR','ACV','Close Date','Owner'].map(h =>
                      <th key={h} style={S.th}>{h}</th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {opps.length === 0 && (
                    <tr><td colSpan={7} style={{ ...S.td(0), textAlign: 'center', color: '#64748b', padding: '30px 0' }}>No opportunities found</td></tr>
                  )}
                  {opps.map((o, i) => {
                    // Support both Postgres snake_case and legacy camelCase
                    const oppName = o.name || o.oppName;
                    const sfdcUrl = o.sfdc_link || o.sfdcUrl;
                    const accountName = o.account_name || o.accountName;
                    const stage = o.stage_normalized || o.stageBucket || o.stage;
                    const ehr = o.ehr;
                    const acv = o.acv;
                    const closeDate = o.close_date || o.closeDate;
                    const owner = o.owner;
                    return (
                    <tr key={o.sfdc_id || o.opportunityId || i}
                      onMouseEnter={e => e.currentTarget.style.background = '#252540'}
                      onMouseLeave={e => e.currentTarget.style.background = ''}>
                      <td style={S.td(i)}>
                        {sfdcUrl
                          ? <a href={sfdcUrl} target="_blank" rel="noreferrer" style={S.link}>{oppName}</a>
                          : <span style={{ color: '#cbd5e1' }}>{oppName || '—'}</span>}
                      </td>
                      <td style={S.td(i)}><span style={{ color: '#a78bfa' }}>{accountName || '—'}</span></td>
                      <td style={S.td(i)}><span style={S.muted}>{stage || '—'}</span></td>
                      <td style={S.td(i)}><span style={{ color: '#60a5fa' }}>{ehr || '—'}</span></td>
                      <td style={S.td(i)}><span style={{ color: '#22c55e' }}>{acv ? fmt$(acv) : '—'}</span></td>
                      <td style={S.td(i)}><span style={S.muted}>{closeDate || '—'}</span></td>
                      <td style={S.td(i)}><span style={S.muted}>{owner || '—'}</span></td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {total > 0 && <Pagination page={oppPage} setPage={setOppPage} total={total} pageSize={50} />}
          </>
        )}
      </>
    );
  }

  // Preload counts for header badges
  const { data: accCountData } = useSWR('/api/accounts?page=1&pageSize=1', fetcher, { revalidateOnFocus: false });
  const { data: conCountData } = useSWR('/api/contacts?page=1&pageSize=1', fetcher, { revalidateOnFocus: false });
  const { data: oppCountData } = useSWR('/api/opportunities?page=1&pageSize=1', fetcher, { revalidateOnFocus: false });

  function CountBadge({ n }) {
    if (n == null) return null;
    return <span style={{
      background: '#6366f122', color: '#818cf8',
      border: '1px solid #6366f144', borderRadius: 10,
      padding: '1px 7px', fontSize: 10, fontWeight: 700, marginLeft: 5,
    }}>{n.toLocaleString()}</span>;
  }

  return (
    <div style={S.container}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#e2e8f0' }}>🗂 Data Explorer</h2>
        <span style={{ color: '#64748b', fontSize: 12 }}>
          Full Notion pipeline · SFDC contacts · Opportunities
        </span>
      </div>

      <div style={S.subTabBar}>
        <button style={S.subTab(subTab === 'accounts')} onClick={() => setSubTab('accounts')}>
          📋 Accounts<CountBadge n={accCountData?.total} />
        </button>
        <button style={S.subTab(subTab === 'contacts')} onClick={() => setSubTab('contacts')}>
          👤 Contacts<CountBadge n={conCountData?.total} />
        </button>
        <button style={S.subTab(subTab === 'opportunities')} onClick={() => setSubTab('opportunities')}>
          💼 Opportunities<CountBadge n={oppCountData?.total} />
        </button>
      </div>

      {subTab === 'accounts'      && <AccountsTable />}
      {subTab === 'contacts'      && <ContactsTable />}
      {subTab === 'opportunities' && <OpportunitiesTable />}
    </div>
  );
}

// ─── Manage Tab ───────────────────────────────────────────────────────────────
function ManageTab() {
  const [subTab, setSubTab] = useState('accounts');
  const [search, setSearch] = useState('');
  const [searchDraft, setSearchDraft] = useState('');
  const [stageFilter, setStageFilter] = useState('');
  const [showExcluded, setShowExcluded] = useState(false);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState(new Set());
  const [bulkStage, setBulkStage] = useState('');
  const [bulkOwner, setBulkOwner] = useState('');
  const [bulkMsg, setBulkMsg] = useState('');
  const searchTimerRef = useRef(null);

  const STAGE_OPTIONS = [
    'Prospect','Outreach','Discovery','SQL','Negotiations',
    'Pilot Deployment','Full Deployment','Closed-Won',
  ];

  function buildAccUrl() {
    const p = new URLSearchParams({ page, pageSize: 50 });
    if (search) p.set('search', search);
    if (stageFilter) p.set('stage', stageFilter);
    if (showExcluded) p.set('includeExcluded', 'true');
    return `/api/accounts?${p}`;
  }

  const { data: accData, isLoading: accLoading, mutate: accMutate } = useSWR(
    subTab === 'accounts' ? buildAccUrl() : null, fetcher, { revalidateOnFocus: false }
  );
  const { data: syncData } = useSWR(subTab === 'synclog' ? '/api/sync-log' : null, fetcher, { revalidateOnFocus: false });
  const { data: dedupData, mutate: dedupMutate } = useSWR(subTab === 'dedup' ? '/api/dedup' : null, fetcher, { revalidateOnFocus: false });

  function handleSearchInput(val) {
    setSearchDraft(val);
    clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => { setSearch(val); setPage(1); }, 350);
  }

  async function handleInlineEdit(accountId, field, value) {
    try {
      const r = await fetch('/api/accounts', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId, field, value }),
      });
      if (!r.ok) { const e = await r.json(); alert('Edit failed: ' + e.error); return; }
      accMutate();
    } catch (e) { console.error('Inline edit failed:', e); }
  }

  async function handleBulkAction(action) {
    if (!selected.size) return;
    const ids = [...selected];
    let payload = {};
    if (action === 'exclude') payload = { exclude_from_reporting: true };
    else if (action === 'include') payload = { exclude_from_reporting: false };
    else if (action === 'set_stage') { if (!bulkStage) { setBulkMsg('Pick a stage first'); return; } payload = { agents_stage: bulkStage }; }
    else if (action === 'set_owner') { if (!bulkOwner) { setBulkMsg('Enter an owner first'); return; } payload = { agents_owner: bulkOwner }; }

    try {
      const r = await fetch('/api/manage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'bulk_update_accounts', ids, payload }),
      });
      const data = await r.json();
      setBulkMsg(`✅ Updated ${data.rowsAffected || ids.length} records`);
      setSelected(new Set());
      accMutate();
      setTimeout(() => setBulkMsg(''), 3000);
    } catch (e) { setBulkMsg('Error: ' + e.message); }
  }

  async function handleDedupAction(id, action) {
    try {
      await fetch('/api/manage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: action === 'approve' ? 'approve_dedup' : 'reject_dedup', payload: { id } }),
      });
      dedupMutate();
    } catch (e) { console.error('Dedup action failed:', e); }
  }

  const S = {
    container: { background: '#1a1d2e', borderRadius: 12, padding: '18px 20px', marginTop: 20, border: '1px solid #252535' },
    subTabBar: { display: 'flex', gap: 4, marginBottom: 16 },
    subTab: (active) => ({
      background: active ? '#6366f122' : 'transparent',
      color: active ? '#6366f1' : '#94a3b8',
      border: `1px solid ${active ? '#6366f166' : 'transparent'}`,
      borderRadius: 8, padding: '5px 14px', cursor: 'pointer',
      fontSize: 12, fontWeight: active ? 600 : 400,
    }),
    filterRow: { display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' },
    input: { background: '#0f1117', border: '1px solid #252535', borderRadius: 8, color: '#fff', padding: '6px 10px', fontSize: 12, outline: 'none' },
    select: { background: '#0f1117', border: '1px solid #252535', borderRadius: 8, color: '#94a3b8', padding: '6px 10px', fontSize: 12, outline: 'none', cursor: 'pointer' },
    btn: (color = '#6366f1') => ({ background: color + '22', color, border: `1px solid ${color}44`, borderRadius: 8, padding: '5px 12px', fontSize: 12, cursor: 'pointer', fontWeight: 600 }),
    table: { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
    th: { padding: '7px 8px', color: '#64748b', borderBottom: '1px solid #252535', textAlign: 'left', whiteSpace: 'nowrap', fontWeight: 500 },
    td: (i) => ({ padding: '6px 8px', borderBottom: '1px solid #1e2235', background: i % 2 === 0 ? '#1a1d2e' : '#1e2240', whiteSpace: 'nowrap' }),
    muted: { color: '#64748b' },
    loading: { textAlign: 'center', padding: '40px 0', color: '#64748b', fontSize: 13 },
    pagination: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 12, color: '#64748b', fontSize: 12 },
  };

  function Pagination({ page, setPage, total, ps = 50 }) {
    const tp = Math.ceil(total / ps);
    return (
      <div style={S.pagination}>
        <button style={{ ...S.btn('#6366f1'), opacity: page <= 1 ? 0.4 : 1 }} onClick={() => page > 1 && setPage(p => p - 1)} disabled={page <= 1}>← Prev</button>
        <span>Page {page} of {tp} · {total.toLocaleString()} records</span>
        <button style={{ ...S.btn('#6366f1'), opacity: page >= tp ? 0.4 : 1 }} onClick={() => page < tp && setPage(p => p + 1)} disabled={page >= tp}>Next →</button>
      </div>
    );
  }

  function InlineEditCell({ value, field, accountId }) {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(String(value ?? ''));
    if (!editing) return (
      <span onClick={() => { setDraft(String(value ?? '')); setEditing(true); }}
        title="Click to edit" style={{ cursor: 'text', minWidth: 30, display: 'inline-block', color: value ? '#cbd5e1' : '#475569' }}>
        {value != null && value !== '' ? String(value) : '—'}
      </span>
    );
    return (
      <input
        autoFocus value={draft} onChange={e => setDraft(e.target.value)}
        onBlur={() => { handleInlineEdit(accountId, field, draft); setEditing(false); }}
        onKeyDown={e => { if (e.key === 'Enter') { handleInlineEdit(accountId, field, draft); setEditing(false); } if (e.key === 'Escape') setEditing(false); }}
        style={{ ...S.input, padding: '2px 6px', width: 120, fontSize: 11 }}
      />
    );
  }

  function AccountsManageTable() {
    const accounts = accData?.accounts || [];
    const total = accData?.total || 0;
    const allSelected = accounts.length > 0 && accounts.every(a => selected.has(a.sfdc_id || String(a.id)));

    function toggleAll() {
      if (allSelected) setSelected(new Set());
      else setSelected(new Set(accounts.map(a => a.sfdc_id || String(a.id))));
    }

    return (
      <>
        {/* Filters */}
        <div style={S.filterRow}>
          <input placeholder="🔍 Search accounts…" value={searchDraft} onChange={e => handleSearchInput(e.target.value)} style={{ ...S.input, width: 220 }} />
          <select value={stageFilter} onChange={e => { setStageFilter(e.target.value); setPage(1); }} style={S.select}>
            <option value="">All Stages</option>
            {STAGE_OPTIONS.map(v => <option key={v} value={v}>{v}</option>)}
          </select>
          <button style={{ ...S.btn('#22c55e'), opacity: showExcluded ? 1 : 0.6 }} onClick={() => { setShowExcluded(v => !v); setPage(1); }}>
            {showExcluded ? '👁 Showing Excluded' : 'Show Excluded'}
          </button>
          {total > 0 && <span style={S.muted}>{total.toLocaleString()} accounts</span>}
        </div>

        {/* Bulk Actions */}
        {selected.size > 0 && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10, padding: '8px 12px', background: '#252540', borderRadius: 8, flexWrap: 'wrap' }}>
            <span style={{ color: '#a78bfa', fontWeight: 700, fontSize: 12 }}>{selected.size} selected</span>
            <button style={S.btn('#ef4444')} onClick={() => handleBulkAction('exclude')}>🚫 Exclude from Reporting</button>
            <button style={S.btn('#22c55e')} onClick={() => handleBulkAction('include')}>✅ Include in Reporting</button>
            <select value={bulkStage} onChange={e => setBulkStage(e.target.value)} style={{ ...S.select, fontSize: 11 }}>
              <option value="">Set Stage…</option>
              {STAGE_OPTIONS.map(v => <option key={v} value={v}>{v}</option>)}
            </select>
            {bulkStage && <button style={S.btn('#6366f1')} onClick={() => handleBulkAction('set_stage')}>Apply Stage</button>}
            <input placeholder="Set Owner…" value={bulkOwner} onChange={e => setBulkOwner(e.target.value)} style={{ ...S.input, width: 140, fontSize: 11 }} />
            {bulkOwner && <button style={S.btn('#f59e0b')} onClick={() => handleBulkAction('set_owner')}>Apply Owner</button>}
            <button style={S.btn('#64748b')} onClick={() => setSelected(new Set())}>Clear</button>
            {bulkMsg && <span style={{ color: '#22c55e', fontSize: 12 }}>{bulkMsg}</span>}
          </div>
        )}

        {accLoading && <div style={S.loading}>⟳ Loading…</div>}
        {!accLoading && (
          <>
            <div style={{ overflowX: 'auto' }}>
              <table style={S.table}>
                <thead>
                  <tr>
                    <th style={S.th}><input type="checkbox" checked={allSelected} onChange={toggleAll} /></th>
                    {['Name','Stage','EHR','ICP','Revenue','Providers','Employees','Locs','Call Vol','Specialty','Owner','Source','ROE','SFDC'].map(h =>
                      <th key={h} style={S.th}>{h}</th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {accounts.length === 0 && (
                    <tr><td colSpan={15} style={{ ...S.td(0), textAlign: 'center', color: '#64748b', padding: '30px 0' }}>No accounts found</td></tr>
                  )}
                  {accounts.map((a, i) => {
                    const aid = a.sfdc_id || String(a.id);
                    const isSelected = selected.has(aid);
                    return (
                      <tr key={aid}
                        style={{ background: isSelected ? '#312e5133' : '', transition: 'background 0.1s' }}
                        onMouseEnter={e => !isSelected && (e.currentTarget.style.background = '#252540')}
                        onMouseLeave={e => !isSelected && (e.currentTarget.style.background = '')}>
                        <td style={S.td(i)}>
                          <input type="checkbox" checked={isSelected}
                            onChange={() => setSelected(prev => { const s = new Set(prev); s.has(aid) ? s.delete(aid) : s.add(aid); return s; })} />
                        </td>
                        <td style={{ ...S.td(i), maxWidth: 200 }}>
                          {a.sfdc_link
                            ? <a href={a.sfdc_link} target="_blank" rel="noreferrer" style={{ color: '#6366f1', textDecoration: 'none', fontWeight: 500, ...(a.exclude_from_reporting ? { opacity: 0.5, textDecoration: 'line-through' } : {}) }}>{a.name}</a>
                            : <span style={{ color: '#cbd5e1', fontWeight: 500, ...(a.exclude_from_reporting ? { opacity: 0.5, textDecoration: 'line-through' } : {}) }}>{a.name}</span>}
                          {a.exclude_from_reporting && <span style={{ background: '#374151', color: '#9ca3af', fontSize: 10, padding: '1px 5px', borderRadius: 3, marginLeft: 5 }}>excl</span>}
                        </td>
                        <td style={S.td(i)}>
                          <InlineEditCell value={a.agents_stage} field="agents_stage" accountId={aid} />
                        </td>
                        <td style={S.td(i)}>
                          <InlineEditCell value={a.ehr} field="ehr" accountId={aid} />
                        </td>
                        <td style={S.td(i)}>
                          {a.agents_icp
                            ? <span style={{ background: '#22c55e22', color: '#22c55e', border: '1px solid #22c55e44', borderRadius: 4, padding: '1px 6px', fontSize: 10, fontWeight: 600 }}>ICP</span>
                            : <span style={S.muted}>—</span>}
                        </td>
                        <td style={S.td(i)}>
                          <InlineEditCell value={a.annual_revenue != null ? a.annual_revenue : ''} field="annual_revenue" accountId={aid} />
                        </td>
                        <td style={S.td(i)}>
                          <InlineEditCell value={a.num_providers != null ? a.num_providers : ''} field="num_providers" accountId={aid} />
                        </td>
                        <td style={S.td(i)}>
                          <InlineEditCell value={a.num_employees != null ? a.num_employees : ''} field="num_employees" accountId={aid} />
                        </td>
                        <td style={S.td(i)}>
                          <InlineEditCell value={a.num_locations != null ? a.num_locations : ''} field="num_locations" accountId={aid} />
                        </td>
                        <td style={S.td(i)}>
                          <InlineEditCell value={a.est_monthly_call_volume != null ? a.est_monthly_call_volume : ''} field="est_monthly_call_volume" accountId={aid} />
                        </td>
                        <td style={S.td(i)}>
                          <InlineEditCell value={a.specialty || ''} field="specialty" accountId={aid} />
                        </td>
                        <td style={S.td(i)}>
                          <InlineEditCell value={a.agents_owner || ''} field="agents_owner" accountId={aid} />
                        </td>
                        <td style={S.td(i)}><span style={S.muted}>{a.source_category || '—'}</span></td>
                        <td style={S.td(i)}>
                          {a.potential_roe_issue?.length
                            ? <span style={{ background: '#f59e0b22', color: '#f59e0b', border: '1px solid #f59e0b44', borderRadius: 4, padding: '1px 5px', fontSize: 10, fontWeight: 700 }}>🟡 ROE</span>
                            : <span style={S.muted}>—</span>}
                        </td>
                        <td style={S.td(i)}>
                          {a.sfdc_link ? <a href={a.sfdc_link} target="_blank" rel="noreferrer" style={{ color: '#3b82f6', fontSize: 11 }}>↗</a> : <span style={S.muted}>—</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {total > 0 && <Pagination page={page} setPage={setPage} total={total} />}
          </>
        )}
      </>
    );
  }

  function DedupQueueTab() {
    const items = dedupData?.items || [];
    if (!dedupData) return <div style={S.loading}>⟳ Loading dedup queue…</div>;
    return (
      <div>
        <div style={{ color: '#64748b', fontSize: 12, marginBottom: 12 }}>
          {items.length === 0 ? '✅ No pending dedup items' : `${items.length} pending items`}
        </div>
        {items.map((item, i) => (
          <div key={item.id} style={{ background: '#111119', border: '1px solid #252535', borderRadius: 8, padding: '12px 16px', marginBottom: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <span style={{ color: '#a78bfa', fontWeight: 600, fontSize: 13 }}>{item.entity_type}</span>
                <span style={{ color: '#64748b', fontSize: 11, marginLeft: 8 }}>{new Date(item.created_at).toLocaleDateString()}</span>
                {item.confidence_score && <span style={{ background: '#22c55e22', color: '#22c55e', fontSize: 11, padding: '1px 6px', borderRadius: 4, marginLeft: 8 }}>Score: {item.confidence_score}</span>}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button style={S.btn('#22c55e')} onClick={() => handleDedupAction(item.id, 'approve')}>✓ Approve</button>
                <button style={S.btn('#ef4444')} onClick={() => handleDedupAction(item.id, 'reject')}>✗ Reject</button>
              </div>
            </div>
            {item.proposed_data && (
              <pre style={{ color: '#94a3b8', fontSize: 11, marginTop: 8, overflowX: 'auto', maxHeight: 120, background: '#0a0a10', padding: 8, borderRadius: 4 }}>
                {JSON.stringify(item.proposed_data, null, 2)}
              </pre>
            )}
          </div>
        ))}
      </div>
    );
  }

  function SyncLogTab() {
    if (!syncData) return <div style={S.loading}>⟳ Loading sync log…</div>;
    const { lastSyncByTable = [], recentEntries = [] } = syncData;
    return (
      <div>
        <h3 style={{ color: '#e2e8f0', fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Last Sync by Table</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12, marginBottom: 24 }}>
          {lastSyncByTable.map(row => (
            <div key={row.table_name} style={{ background: '#111119', border: '1px solid #252535', borderRadius: 8, padding: '12px 16px' }}>
              <div style={{ color: '#a78bfa', fontWeight: 700, fontSize: 13, marginBottom: 4 }}>{row.table_name}</div>
              <div style={{ color: '#64748b', fontSize: 11 }}>
                <div>Synced: <span style={{ color: '#94a3b8' }}>{row.records_synced?.toLocaleString() || '—'}</span></div>
                <div>Type: <span style={{ color: '#94a3b8' }}>{row.sync_type || '—'}</span></div>
                <div>Last: <span style={{ color: '#94a3b8' }}>{row.completed_at ? new Date(row.completed_at).toLocaleString() : '—'}</span></div>
                {row.errors > 0 && <div style={{ color: '#ef4444' }}>Errors: {row.errors}</div>}
              </div>
            </div>
          ))}
        </div>

        <h3 style={{ color: '#e2e8f0', fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Recent Sync History</h3>
        <div style={{ overflowX: 'auto' }}>
          <table style={S.table}>
            <thead>
              <tr>{['Table','Type','Synced','Created','Updated','Errors','Completed','Notes'].map(h =>
                <th key={h} style={S.th}>{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {recentEntries.map((r, i) => (
                <tr key={r.id}>
                  <td style={S.td(i)}><span style={{ color: '#a78bfa' }}>{r.table_name}</span></td>
                  <td style={S.td(i)}><span style={S.muted}>{r.sync_type}</span></td>
                  <td style={S.td(i)}>{r.records_synced?.toLocaleString() || '—'}</td>
                  <td style={S.td(i)}>{r.records_created?.toLocaleString() || '—'}</td>
                  <td style={S.td(i)}>{r.records_updated?.toLocaleString() || '—'}</td>
                  <td style={S.td(i)}>{r.errors > 0 ? <span style={{ color: '#ef4444' }}>{r.errors}</span> : '0'}</td>
                  <td style={S.td(i)}><span style={S.muted}>{r.completed_at ? new Date(r.completed_at).toLocaleString() : '—'}</span></td>
                  <td style={{ ...S.td(i), maxWidth: 200, whiteSpace: 'normal' }}><span style={S.muted}>{r.notes || '—'}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  return (
    <div style={S.container}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#e2e8f0' }}>⚙️ Data Management</h2>
        <span style={{ color: '#64748b', fontSize: 12 }}>Neon Postgres · Inline edits are persistent</span>
      </div>

      <div style={S.subTabBar}>
        <button style={S.subTab(subTab === 'accounts')} onClick={() => setSubTab('accounts')}>📋 Accounts</button>
        <button style={S.subTab(subTab === 'dedup')} onClick={() => setSubTab('dedup')}>🔁 Dedup Queue</button>
        <button style={S.subTab(subTab === 'synclog')} onClick={() => setSubTab('synclog')}>🕐 Sync Log</button>
        <button style={S.subTab(subTab === 'teams')} onClick={() => setSubTab('teams')}>👥 Teams &amp; Users</button>
      </div>

      {subTab === 'accounts' && <AccountsManageTable />}
      {subTab === 'dedup'    && <DedupQueueTab />}
      {subTab === 'synclog'  && <SyncLogTab />}
      {subTab === 'teams'    && <TeamsSettings />}
    </div>
  );
}

// ─── Data Quality Banner ─────────────────────────────────────────────────────
function DataQualityBanner() {
  const { data, error } = useSWR('/api/data-quality', fetcher, {
    revalidateOnFocus: false,
    refreshInterval: 60_000,
  });

  if (!data || error) return null;

  const { agents_icp_pct, target_persona_pct, outcomes_pct } = data;
  const allGood = agents_icp_pct >= 95 && target_persona_pct >= 95 && outcomes_pct >= 95;
  const anyBad  = agents_icp_pct < 80 || target_persona_pct < 80 || outcomes_pct < 80;

  if (allGood) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 14px', background: C.green + '11', border: `1px solid ${C.green}33`, borderRadius: 8, fontSize: 11, color: C.green, marginBottom: 12 }}>
        ✅ Data quality: good
      </div>
    );
  }

  const metrics = [
    { label: 'ICP field', value: agents_icp_pct },
    { label: 'Contact personas', value: target_persona_pct },
    { label: 'Call outcomes', value: outcomes_pct },
  ].filter(m => m.value < 95);

  const chips = metrics.map(m => {
    const color = m.value >= 80 ? C.amber : C.red;
    return (
      <span key={m.label} style={{
        background: color + '22', color, border: `1px solid ${color}44`,
        borderRadius: 4, padding: '1px 6px', fontSize: 10, fontWeight: 600,
      }}>
        {m.label}: {m.value}% populated
      </span>
    );
  });

  return (
    <div style={{
      display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8,
      padding: '8px 14px', background: C.amber + '11',
      border: `1px solid ${C.amber}44`, borderRadius: 8, fontSize: 12,
      color: C.amber, marginBottom: 12,
    }}>
      <span>⚠️ Data quality:</span>
      {chips}
      <span style={{ color: C.textMuted, fontSize: 11 }}>— some filters may not work correctly</span>
    </div>
  );
}

// ─── Pipeline Pulse Section ───────────────────────────────────────────────────
function PipelinePulseSection() {
  const { data, error, isLoading, mutate } = useSWR('/api/pipeline-pulse', fetcher, {
    revalidateOnFocus: false,
    refreshInterval: 5 * 60_000,
  });

  const [nextStepDraft, setNextStepDraft] = useState({});
  const [editingId, setEditingId] = useState(null);

  async function saveNextStep(accountId, value) {
    try {
      await fetch('/api/accounts', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId, field: 'next_step', value }),
      });
      mutate();
    } catch (e) {
      console.error('saveNextStep failed:', e);
    }
  }

  const accounts = data?.accounts || [];

  const STAGE_BADGE_COLORS = {
    'Discovery':         C.amber,
    'SQL':               C.purple,
    'Disco Scheduled':   C.blue,
    'Negotiations':      C.teal,
    'Pilot Deployment':  C.green,
    'Full Deployment':   C.green,
  };

  function alertIcon(days) {
    if (days == null) return '❓';
    if (days > 7)  return '🔴';
    if (days >= 4) return '⚠️';
    return '✅';
  }

  function daysBadgeColor(days) {
    if (days == null) return C.textMuted;
    if (days > 7)  return C.red;
    if (days >= 4) return C.amber;
    return C.green;
  }

  function relDate(dateStr) {
    if (!dateStr) return '—';
    const d = new Date(dateStr);
    const diff = Math.floor((Date.now() - d.getTime()) / 86400000);
    if (diff === 0) return 'today';
    if (diff === 1) return '1d ago';
    return `${diff}d ago`;
  }

  const thS = {
    padding: '7px 10px', textAlign: 'left', color: C.textMuted,
    fontSize: 10, fontWeight: 600, borderBottom: `1px solid ${C.border}`,
    textTransform: 'uppercase', letterSpacing: '0.3px', background: C.surface,
    whiteSpace: 'nowrap',
  };
  const tdS = { padding: '6px 10px', fontSize: 12, borderBottom: `1px solid ${C.border}1a`, color: C.textSec, verticalAlign: 'middle' };

  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div style={{ color: C.textPri, fontWeight: 700, fontSize: 15 }}>
          📡 Pipeline Pulse — Discovery &amp; Beyond
          {accounts.length > 0 && <span style={{ color: C.textMuted, fontWeight: 400, fontSize: 12, marginLeft: 8 }}>({accounts.length} accounts)</span>}
        </div>
        <div style={{ color: C.textMuted, fontSize: 11, display: 'flex', gap: 12 }}>
          <span style={{ color: C.green }}>✅ ≤3d</span>
          <span style={{ color: C.amber }}>⚠️ 4–7d</span>
          <span style={{ color: C.red }}>🔴 &gt;7d</span>
        </div>
      </div>

      {isLoading && (
        <div style={{ textAlign: 'center', padding: '40px 0', color: C.textMuted, fontSize: 13 }}>⟳ Loading Pipeline Pulse…</div>
      )}
      {error && (
        <div style={{ color: C.red, fontSize: 13, padding: '10px 0' }}>⚠ Failed to load Pipeline Pulse.</div>
      )}

      {!isLoading && accounts.length === 0 && (
        <div style={{ color: C.textMuted, textAlign: 'center', padding: '40px 0', fontSize: 13 }}>
          No Discovery+ accounts found. Accounts in Discovery, SQL, Negotiations, Pilot or Full Deployment will appear here.
        </div>
      )}

      {accounts.length > 0 && (
        <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 800 }}>
              <thead>
                <tr>
                  <th style={thS}>Alert</th>
                  <th style={thS}>Account</th>
                  <th style={thS}>Stage</th>
                  <th style={{ ...thS, textAlign: 'right' }}>ACV</th>
                  <th style={thS}>Owner</th>
                  <th style={thS}>Last Touch</th>
                  <th style={{ ...thS, textAlign: 'center' }}>Days</th>
                  <th style={{ ...thS, minWidth: 200 }}>Next Step</th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((a) => {
                  const days  = a.days_since_touch != null ? parseInt(a.days_since_touch, 10) : null;
                  const color = daysBadgeColor(days);
                  const isEditing = editingId === a.id;
                  const draftVal  = nextStepDraft[a.id] ?? (a.next_step || '');
                  return (
                    <tr key={a.id} style={{ transition: 'background 0.1s' }}
                      onMouseEnter={e => e.currentTarget.style.background = C.cardHover}
                      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                      <td style={{ ...tdS, fontSize: 16, textAlign: 'center' }}>{alertIcon(days)}</td>
                      <td style={tdS}>
                        {a.sfdc_link
                          ? <a href={a.sfdc_link} target="_blank" rel="noreferrer" style={{ color: C.accent, fontWeight: 500, textDecoration: 'none' }}>{a.name}</a>
                          : <span style={{ color: C.textPri, fontWeight: 500 }}>{a.name}</span>}
                      </td>
                      <td style={tdS}>
                        <span style={{
                          background: (STAGE_BADGE_COLORS[a.agents_stage] || C.blue) + '22',
                          color:      STAGE_BADGE_COLORS[a.agents_stage] || C.blue,
                          border:     `1px solid ${(STAGE_BADGE_COLORS[a.agents_stage] || C.blue)}44`,
                          borderRadius: 4, padding: '1px 6px', fontSize: 10, fontWeight: 600, whiteSpace: 'nowrap',
                        }}>{a.agents_stage || '—'}</span>
                      </td>
                      <td style={{ ...tdS, textAlign: 'right', color: C.green }}>
                        {a.acv ? fmt(a.acv, 'currency') : '—'}
                      </td>
                      <td style={tdS}>{a.agents_owner || '—'}</td>
                      <td style={{ ...tdS, whiteSpace: 'nowrap' }}>
                        <span style={{ color: color }}>{relDate(a.last_touch_date)}</span>
                      </td>
                      <td style={{ ...tdS, textAlign: 'center' }}>
                        {days != null
                          ? <span style={{ color, fontWeight: 700, fontSize: 14 }}>{days}</span>
                          : <span style={{ color: C.textMuted }}>—</span>}
                      </td>
                      <td style={tdS}>
                        {isEditing
                          ? (
                            <input
                              autoFocus
                              value={draftVal}
                              onChange={e => setNextStepDraft(prev => ({ ...prev, [a.id]: e.target.value }))}
                              onBlur={() => { saveNextStep(a.sfdc_id || String(a.id), draftVal); setEditingId(null); }}
                              onKeyDown={e => {
                                if (e.key === 'Enter') { saveNextStep(a.sfdc_id || String(a.id), draftVal); setEditingId(null); }
                                if (e.key === 'Escape') setEditingId(null);
                              }}
                              style={{ background: C.surface, color: C.textPri, border: `1px solid ${C.accent}`, borderRadius: 4, padding: '3px 8px', width: '100%', fontSize: 12, outline: 'none' }}
                            />
                          )
                          : (
                            <span
                              onClick={() => { setNextStepDraft(prev => ({ ...prev, [a.id]: a.next_step || '' })); setEditingId(a.id); }}
                              style={{ cursor: 'pointer', color: a.next_step ? C.textSec : C.textMuted, display: 'block', minWidth: 40 }}
                              title="Click to edit"
                            >
                              {a.next_step || <span style={{ color: C.textMuted, fontStyle: 'italic' }}>click to add…</span>}
                            </span>
                          )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Teams & Users Settings ───────────────────────────────────────────────────
function TeamsSettings() {
  const { data, mutate } = useSWR('/api/teams', fetcher, { revalidateOnFocus: false });
  const teams = data?.teams || [];
  const repOptions = data?.reps || [];

  const [showModal, setShowModal] = useState(false);
  const [editTeam, setEditTeam]   = useState(null); // null = create, object = edit
  const [form, setForm]           = useState({ name: '', color: '#3b82f6', user_names: [] });
  const [userInput, setUserInput] = useState('');
  const [msg, setMsg]             = useState('');

  function openCreate() { setForm({ name: '', color: '#3b82f6', user_names: [] }); setEditTeam(null); setUserInput(''); setShowModal(true); }
  function openEdit(t)  { setForm({ name: t.name, color: t.color, user_names: [...(t.user_names || [])] }); setEditTeam(t); setUserInput(''); setShowModal(true); }
  function closeModal() { setShowModal(false); setEditTeam(null); setMsg(''); }

  function addUser(name) {
    const n = name.trim();
    if (n && !form.user_names.includes(n)) {
      setForm(f => ({ ...f, user_names: [...f.user_names, n] }));
    }
    setUserInput('');
  }

  function removeUser(name) {
    setForm(f => ({ ...f, user_names: f.user_names.filter(u => u !== name) }));
  }

  async function saveTeam() {
    if (!form.name.trim()) { setMsg('Name is required'); return; }
    try {
      if (editTeam) {
        await fetch(`/api/teams/${editTeam.id}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(form),
        });
      } else {
        await fetch('/api/teams', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(form),
        });
      }
      mutate();
      closeModal();
    } catch (e) { setMsg('Error: ' + e.message); }
  }

  async function deleteTeam(id) {
    if (!confirm('Delete this team?')) return;
    await fetch(`/api/teams/${id}`, { method: 'DELETE' });
    mutate();
  }

  const S = {
    card: { background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: '14px 16px', marginBottom: 10 },
    btn: (color = C.accent) => ({ background: color + '22', color, border: `1px solid ${color}44`, borderRadius: 6, padding: '5px 12px', fontSize: 12, cursor: 'pointer', fontWeight: 600 }),
    input: { background: C.card, border: `1px solid ${C.border}`, borderRadius: 6, color: C.textPri, padding: '6px 10px', fontSize: 12, outline: 'none', width: '100%' },
  };

  const suggestedReps = repOptions.filter(r => r.toLowerCase().includes(userInput.toLowerCase()) && !form.user_names.includes(r)).slice(0, 8);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div>
          <div style={{ color: C.textPri, fontWeight: 700, fontSize: 15, marginBottom: 4 }}>👥 Teams &amp; Users</div>
          <div style={{ color: C.textMuted, fontSize: 12 }}>Define teams to filter activity dashboards by your team vs. other sales motions.</div>
        </div>
        <button onClick={openCreate} style={S.btn(C.accent)}>+ Add Team</button>
      </div>

      {teams.length === 0 && (
        <div style={{ color: C.textMuted, textAlign: 'center', padding: '30px 0', fontSize: 13 }}>No teams yet. Click "Add Team" to get started.</div>
      )}

      {teams.map(t => (
        <div key={t.id} style={S.card}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ width: 14, height: 14, borderRadius: '50%', background: t.color || C.accent, flexShrink: 0 }} />
              <span style={{ color: C.textPri, fontWeight: 600, fontSize: 13 }}>{t.name}</span>
              <span style={{ color: C.textMuted, fontSize: 11 }}>{(t.user_names || []).length} member{(t.user_names || []).length !== 1 ? 's' : ''}</span>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => openEdit(t)} style={S.btn(C.blue)}>Edit</button>
              <button onClick={() => deleteTeam(t.id)} style={S.btn(C.red)}>Delete</button>
            </div>
          </div>
          {(t.user_names || []).length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
              {t.user_names.map(u => (
                <span key={u} style={{ background: (t.color || C.accent) + '22', color: t.color || C.accent, border: `1px solid ${(t.color || C.accent)}44`, borderRadius: 20, padding: '2px 10px', fontSize: 11 }}>{u}</span>
              ))}
            </div>
          )}
        </div>
      ))}

      {/* Modal */}
      {showModal && (
        <>
          <div onClick={closeModal} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 9998 }} />
          <div style={{
            position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
            background: C.card, border: `1px solid ${C.border}`, borderRadius: 12,
            padding: '22px 26px', width: 460, maxWidth: '92vw',
            zIndex: 9999, boxShadow: '0 16px 48px rgba(0,0,0,0.7)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
              <span style={{ color: C.textPri, fontWeight: 700, fontSize: 15 }}>{editTeam ? 'Edit Team' : 'New Team'}</span>
              <button onClick={closeModal} style={{ background: 'none', border: 'none', color: C.textMuted, cursor: 'pointer', fontSize: 18 }}>✕</button>
            </div>

            <div style={{ marginBottom: 14 }}>
              <label style={{ color: C.textMuted, fontSize: 11, display: 'block', marginBottom: 4 }}>TEAM NAME</label>
              <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Agents Team" style={S.input} />
            </div>

            <div style={{ marginBottom: 14 }}>
              <label style={{ color: C.textMuted, fontSize: 11, display: 'block', marginBottom: 4 }}>COLOR</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <input type="color" value={form.color} onChange={e => setForm(f => ({ ...f, color: e.target.value }))}
                  style={{ width: 40, height: 30, border: 'none', cursor: 'pointer', background: 'none' }} />
                <span style={{ color: C.textMuted, fontSize: 12 }}>{form.color}</span>
              </div>
            </div>

            <div style={{ marginBottom: 18 }}>
              <label style={{ color: C.textMuted, fontSize: 11, display: 'block', marginBottom: 4 }}>ADD MEMBERS</label>
              <div style={{ position: 'relative' }}>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    value={userInput}
                    onChange={e => setUserInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addUser(userInput); } }}
                    placeholder="Type rep name…"
                    style={{ ...S.input, flex: 1 }}
                  />
                  <button onClick={() => addUser(userInput)} style={S.btn(C.accent)}>Add</button>
                </div>
                {userInput.length > 0 && suggestedReps.length > 0 && (
                  <div style={{
                    position: 'absolute', top: '100%', left: 0, right: 0,
                    background: C.surface, border: `1px solid ${C.border}`,
                    borderRadius: 8, marginTop: 4, zIndex: 100, maxHeight: 200, overflowY: 'auto',
                    boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
                  }}>
                    {suggestedReps.map(r => (
                      <div key={r} onClick={() => addUser(r)}
                        style={{ padding: '7px 12px', cursor: 'pointer', color: C.textSec, fontSize: 12 }}
                        onMouseEnter={e => e.currentTarget.style.background = C.cardHover}
                        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                        {r}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              {form.user_names.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
                  {form.user_names.map(u => (
                    <span key={u} style={{
                      background: (form.color || C.accent) + '22', color: form.color || C.accent,
                      border: `1px solid ${(form.color || C.accent)}44`,
                      borderRadius: 20, padding: '2px 10px 2px 10px', fontSize: 11,
                      display: 'flex', alignItems: 'center', gap: 5,
                    }}>
                      {u}
                      <button onClick={() => removeUser(u)}
                        style={{ background: 'none', border: 'none', color: form.color || C.accent, cursor: 'pointer', fontSize: 13, lineHeight: 1, padding: 0 }}>✕</button>
                    </span>
                  ))}
                </div>
              )}
            </div>

            {msg && <div style={{ color: C.red, fontSize: 12, marginBottom: 10 }}>{msg}</div>}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button onClick={closeModal} style={S.btn(C.textMuted)}>Cancel</button>
              <button onClick={saveTeam} style={S.btn(C.accent)}>💾 Save Team</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Collapsible Dashboard Section ───────────────────────────────────────────
function DashSection({ title, defaultOpen = true, accent = '#6366f1', storageKey = null, children }) {
  const [open, setOpen] = useState(() => {
    if (storageKey && typeof window !== 'undefined') {
      const saved = localStorage.getItem(storageKey);
      if (saved !== null) return saved === 'true';
    }
    return defaultOpen;
  });

  function toggle() {
    setOpen(o => {
      const next = !o;
      if (storageKey && typeof window !== 'undefined') localStorage.setItem(storageKey, String(next));
      return next;
    });
  }

  return (
    <div style={{ marginBottom: 16, border: `1px solid ${C.border}`, borderLeftColor: accent, borderLeftWidth: 3, borderRadius: '0 10px 10px 0', background: C.card, overflow: 'hidden' }}>
      <button onClick={toggle} style={{
        width: '100%', background: 'transparent', border: 'none',
        padding: '12px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        cursor: 'pointer', borderBottom: open ? `1px solid ${C.border}` : 'none',
      }}>
        <span style={{ color: C.textPri, fontWeight: 700, fontSize: 14 }}>{title}</span>
        <span style={{ color: C.textMuted, fontSize: 12, transform: open ? 'rotate(180deg)' : 'none', transition: '0.2s', display: 'inline-block' }}>▼</span>
      </button>
      {open && <div style={{ padding: '14px 16px' }}>{children}</div>}
    </div>
  );
}

// ─── Activity Metric Card ─────────────────────────────────────────────────────
function ActivityMetricCard({ emoji, label, value, target, loading, note }) {
  const pct = target > 0 ? Math.min(100, Math.round((value / target) * 100)) : null;
  const status = pct === null ? null : pct >= 100 ? '✅' : pct >= 70 ? '⚠️' : '🔴';
  const statusColor = pct === null ? C.textMuted : pct >= 100 ? C.green : pct >= 70 ? C.amber : C.red;

  return (
    <div style={{
      background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10,
      padding: '14px 16px', flex: '1 1 140px', minWidth: 130,
    }}>
      <div style={{ color: C.textMuted, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 4 }}>
        {emoji} {label}
      </div>
      {loading
        ? <div style={{ background: C.card, borderRadius: 4, height: 24, width: '60%', opacity: 0.5 }} />
        : (
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
            <span style={{ color: C.textPri, fontSize: 22, fontWeight: 700, letterSpacing: '-0.5px' }}>
              {value.toLocaleString()}
            </span>
            {target != null && (
              <span style={{ color: C.textMuted, fontSize: 12 }}>
                / {target}
              </span>
            )}
            {status && <span style={{ fontSize: 14 }}>{status}</span>}
          </div>
        )
      }
      {target != null && pct !== null && !loading && (
        <div style={{ marginTop: 6, background: C.card, borderRadius: 99, height: 4, overflow: 'hidden' }}>
          <div style={{ width: `${pct}%`, height: '100%', background: statusColor, borderRadius: 99, transition: 'width 0.5s' }} />
        </div>
      )}
      {note && <div style={{ color: C.textMuted, fontSize: 10, marginTop: 4 }}>{note}</div>}
    </div>
  );
}

// ─── Activity Detail Tables (live data) ──────────────────────────────────────

function fmtTime(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  if (isNaN(d)) return '—';
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function fmtDuration(secs) {
  if (!secs) return '—';
  const s = parseInt(secs, 10);
  if (isNaN(s) || s <= 0) return '—';
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}m ${r}s` : `${r}s`;
}

function OutcomeBadge({ outcome }) {
  if (!outcome) return <span style={{ color: C.textMuted }}>—</span>;
  const o = outcome.toLowerCase();
  const isConn = o.includes('connect') || o.includes('answer') || o.includes('spoke');
  const color = isConn ? C.green : C.textMuted;
  return (
    <span style={{ background: color + '22', color, borderRadius: 4, padding: '2px 6px', fontSize: 10, fontWeight: 600, whiteSpace: 'nowrap' }}>
      {outcome}
    </span>
  );
}

function StageBadge({ stage }) {
  if (!stage) return <span style={{ color: C.textMuted }}>—</span>;
  const colorMap = {
    'Prospect': C.textMuted, 'Outreach': C.blue, 'Discovery': C.amber,
    'SQL': C.purple, 'Negotiations': C.teal, 'Closed-Won': C.green,
  };
  const color = colorMap[stage] || C.blue;
  return (
    <span style={{ background: color + '22', color, borderRadius: 4, padding: '2px 6px', fontSize: 10, fontWeight: 600, whiteSpace: 'nowrap' }}>
      {stage}
    </span>
  );
}

function SfdcLink({ sfdc_id }) {
  if (!sfdc_id) return <span style={{ color: C.textMuted }}>—</span>;
  return (
    <a href={`https://athelas.lightning.force.com/lightning/r/Task/${sfdc_id}/view`}
       target="_blank" rel="noopener noreferrer"
       style={{ color: C.blue, fontSize: 10 }}>↗</a>
  );
}

function DetailTableShell({ label, columns, children, count }) {
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, overflow: 'hidden', marginTop: 8 }}>
      <div style={{ padding: '8px 14px', borderBottom: `1px solid ${C.border}`, color: C.textSec, fontSize: 12, fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span>{label}</span>
        {count != null && <span style={{ color: C.textMuted, fontWeight: 400, fontSize: 11 }}>{count} row{count !== 1 ? 's' : ''}</span>}
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr>
              {columns.map(col => (
                <th key={col} style={{ padding: '7px 12px', textAlign: 'left', color: C.textMuted, fontSize: 10, fontWeight: 600, borderBottom: `1px solid ${C.border}`, textTransform: 'uppercase', letterSpacing: '0.4px', whiteSpace: 'nowrap', background: C.card }}>{col}</th>
              ))}
            </tr>
          </thead>
          <tbody>{children}</tbody>
        </table>
      </div>
    </div>
  );
}

function SkeletonRows({ cols, n = 3 }) {
  return Array.from({ length: n }, (_, i) => (
    <tr key={i}>
      {Array.from({ length: cols }, (__, j) => (
        <td key={j} style={{ padding: '8px 12px', borderBottom: `1px solid ${C.border}1a` }}>
          <div style={{ height: 10, borderRadius: 4, background: C.border + '88', width: `${50 + Math.random() * 40}%` }} />
        </td>
      ))}
    </tr>
  ));
}

function EmptyRow({ cols, msg = 'No activity today yet' }) {
  return (
    <tr>
      <td colSpan={cols} style={{ textAlign: 'center', padding: '20px 16px', color: C.textMuted, fontSize: 11 }}>
        {msg}
      </td>
    </tr>
  );
}

// Outbound Calls table
function OutboundCallsTable() {
  const { data, isLoading } = useSWR('/api/activities?window=today&type=call', fetcher, { revalidateOnFocus: false, refreshInterval: 60000 });
  const rows = data?.activities || [];
  const cols = ['Time', 'Rep', 'Account', 'Contact', 'Duration', 'Outcome', 'Link'];
  return (
    <DetailTableShell label="📞 Outbound Calls" columns={cols} count={isLoading ? null : rows.length}>
      {isLoading ? <SkeletonRows cols={7} /> : rows.length === 0 ? <EmptyRow cols={7} /> : rows.map(r => (
        <tr key={r.id} style={{ borderBottom: `1px solid ${C.border}1a` }}>
          <td style={{ padding: '6px 12px', color: C.textSec, whiteSpace: 'nowrap' }}>{fmtTime(r.activity_date)}</td>
          <td style={{ padding: '6px 12px', color: C.text }}>{r.rep || '—'}</td>
          <td style={{ padding: '6px 12px' }}>
            {r.account_sfdc_id
              ? <a href={`https://athelas.lightning.force.com/lightning/r/Account/${r.account_sfdc_id}/view`} target="_blank" rel="noopener noreferrer" style={{ color: C.blue }}>{r.account_name || r.account_sfdc_id}</a>
              : <span style={{ color: C.textMuted }}>{r.account_name || '—'}</span>}
          </td>
          <td style={{ padding: '6px 12px', color: C.textSec }}>{r.contact_name?.trim() || '—'}</td>
          <td style={{ padding: '6px 12px', color: C.textSec, whiteSpace: 'nowrap' }}>{fmtDuration(r.duration_seconds)}</td>
          <td style={{ padding: '6px 12px' }}><OutcomeBadge outcome={r.outcome} /></td>
          <td style={{ padding: '6px 12px' }}><SfdcLink sfdc_id={r.sfdc_id} /></td>
        </tr>
      ))}
    </DetailTableShell>
  );
}

// Live Connects table
function LiveConnectsTable() {
  const { data, isLoading } = useSWR('/api/activities?window=today&type=connects', fetcher, { revalidateOnFocus: false, refreshInterval: 60000 });
  const rows = data?.activities || [];
  const cols = ['Time', 'Rep', 'Account', 'Contact', 'Duration', 'Outcome', 'Link'];
  return (
    <DetailTableShell label="🔗 Live Connects" columns={cols} count={isLoading ? null : rows.length}>
      {isLoading ? <SkeletonRows cols={7} /> : rows.length === 0 ? <EmptyRow cols={7} /> : rows.map(r => (
        <tr key={r.id} style={{ borderBottom: `1px solid ${C.border}1a` }}>
          <td style={{ padding: '6px 12px', color: C.textSec, whiteSpace: 'nowrap' }}>{fmtTime(r.activity_date)}</td>
          <td style={{ padding: '6px 12px', color: C.text }}>{r.rep || '—'}</td>
          <td style={{ padding: '6px 12px' }}>
            {r.account_sfdc_id
              ? <a href={`https://athelas.lightning.force.com/lightning/r/Account/${r.account_sfdc_id}/view`} target="_blank" rel="noopener noreferrer" style={{ color: C.blue }}>{r.account_name || r.account_sfdc_id}</a>
              : <span style={{ color: C.textMuted }}>{r.account_name || '—'}</span>}
          </td>
          <td style={{ padding: '6px 12px', color: C.textSec }}>{r.contact_name?.trim() || '—'}</td>
          <td style={{ padding: '6px 12px', color: C.textSec, whiteSpace: 'nowrap' }}>{fmtDuration(r.duration_seconds)}</td>
          <td style={{ padding: '6px 12px' }}><OutcomeBadge outcome={r.outcome} /></td>
          <td style={{ padding: '6px 12px' }}><SfdcLink sfdc_id={r.sfdc_id} /></td>
        </tr>
      ))}
    </DetailTableShell>
  );
}

// Contacts Contacted table
function ContactsContactedTable() {
  const { data, isLoading } = useSWR('/api/activities?window=today', fetcher, { revalidateOnFocus: false, refreshInterval: 60000 });
  const rows = data?.activities || [];

  // Group by contact_sfdc_id (or contact_name if no sfdc_id)
  const grouped = useMemo(() => {
    const map = new Map();
    for (const r of rows) {
      const key = r.contact_sfdc_id || r.contact_name || 'unknown';
      if (!map.has(key)) {
        map.set(key, { contact_name: r.contact_name?.trim() || '—', account_name: r.account_name || '—', account_sfdc_id: r.account_sfdc_id, rep: r.rep || '—', types: new Set(), lastTouch: r.activity_date });
      }
      const g = map.get(key);
      if (r.type) g.types.add(r.type);
      if (r.activity_date > g.lastTouch) g.lastTouch = r.activity_date;
    }
    return Array.from(map.values()).sort((a, b) => b.lastTouch > a.lastTouch ? 1 : -1);
  }, [rows]);

  const typeEmoji = (t) => t === 'call' ? '📞' : t === 'email' ? '📧' : t === 'meeting' ? '📅' : t === 'task' ? '✅' : t;
  const cols = ['Contact Name', 'Account', 'Rep', 'Activity Types Today', 'Last Touch'];
  return (
    <DetailTableShell label="👤 Contacts Contacted" columns={cols} count={isLoading ? null : grouped.length}>
      {isLoading ? <SkeletonRows cols={5} /> : grouped.length === 0 ? <EmptyRow cols={5} /> : grouped.map((g, i) => (
        <tr key={i} style={{ borderBottom: `1px solid ${C.border}1a` }}>
          <td style={{ padding: '6px 12px', color: C.text }}>{g.contact_name}</td>
          <td style={{ padding: '6px 12px' }}>
            {g.account_sfdc_id
              ? <a href={`https://athelas.lightning.force.com/lightning/r/Account/${g.account_sfdc_id}/view`} target="_blank" rel="noopener noreferrer" style={{ color: C.blue }}>{g.account_name}</a>
              : <span style={{ color: C.textSec }}>{g.account_name}</span>}
          </td>
          <td style={{ padding: '6px 12px', color: C.textSec }}>{g.rep}</td>
          <td style={{ padding: '6px 12px', color: C.textSec }}>{[...g.types].map(typeEmoji).join(', ')}</td>
          <td style={{ padding: '6px 12px', color: C.textSec, whiteSpace: 'nowrap' }}>{fmtTime(g.lastTouch)}</td>
        </tr>
      ))}
    </DetailTableShell>
  );
}

// Accounts Contacted table
function AccountsContactedTable() {
  const { data, isLoading } = useSWR('/api/activities?window=today', fetcher, { revalidateOnFocus: false, refreshInterval: 60000 });
  const rows = data?.activities || [];

  const grouped = useMemo(() => {
    const map = new Map();
    for (const r of rows) {
      const key = r.account_sfdc_id || r.account_name || 'unknown';
      if (!map.has(key)) {
        map.set(key, { account_name: r.account_name || '—', account_sfdc_id: r.account_sfdc_id, account_stage: r.account_stage, rep: r.rep || '—', touches: 0, types: new Set() });
      }
      const g = map.get(key);
      g.touches++;
      if (r.type) g.types.add(r.type);
    }
    return Array.from(map.values()).sort((a, b) => b.touches - a.touches);
  }, [rows]);

  const typeEmoji = (t) => t === 'call' ? '📞' : t === 'email' ? '📧' : t === 'meeting' ? '📅' : t === 'task' ? '✅' : t;
  const cols = ['Account Name', 'Rep', '# Touches Today', 'Activity Types', 'Stage'];
  return (
    <DetailTableShell label="🏢 Accounts Contacted" columns={cols} count={isLoading ? null : grouped.length}>
      {isLoading ? <SkeletonRows cols={5} /> : grouped.length === 0 ? <EmptyRow cols={5} /> : grouped.map((g, i) => (
        <tr key={i} style={{ borderBottom: `1px solid ${C.border}1a` }}>
          <td style={{ padding: '6px 12px' }}>
            {g.account_sfdc_id
              ? <a href={`https://athelas.lightning.force.com/lightning/r/Account/${g.account_sfdc_id}/view`} target="_blank" rel="noopener noreferrer" style={{ color: C.blue }}>{g.account_name}</a>
              : <span style={{ color: C.text }}>{g.account_name}</span>}
          </td>
          <td style={{ padding: '6px 12px', color: C.textSec }}>{g.rep}</td>
          <td style={{ padding: '6px 12px', textAlign: 'center', color: C.text, fontWeight: 600 }}>{g.touches}</td>
          <td style={{ padding: '6px 12px', color: C.textSec }}>{[...g.types].map(typeEmoji).join(', ')}</td>
          <td style={{ padding: '6px 12px' }}><StageBadge stage={g.account_stage} /></td>
        </tr>
      ))}
    </DetailTableShell>
  );
}

// Sets table
function SetsTable() {
  const { data, isLoading } = useSWR('/api/activities?window=today&type=sets', fetcher, { revalidateOnFocus: false, refreshInterval: 60000 });
  const rows = data?.activities || [];
  const cols = ['Time', 'Account', 'Contact', 'Rep', 'Subject', 'SFDC'];
  return (
    <DetailTableShell label="📅 Sets (Disco Scheduled)" columns={cols} count={isLoading ? null : rows.length}>
      {isLoading ? <SkeletonRows cols={6} /> : rows.length === 0 ? <EmptyRow cols={6} /> : rows.map(r => (
        <tr key={r.id} style={{ borderBottom: `1px solid ${C.border}1a` }}>
          <td style={{ padding: '6px 12px', color: C.textSec, whiteSpace: 'nowrap' }}>{fmtTime(r.activity_date)}</td>
          <td style={{ padding: '6px 12px' }}>
            {r.account_sfdc_id
              ? <a href={`https://athelas.lightning.force.com/lightning/r/Account/${r.account_sfdc_id}/view`} target="_blank" rel="noopener noreferrer" style={{ color: C.blue }}>{r.account_name || r.account_sfdc_id}</a>
              : <span style={{ color: C.textSec }}>{r.account_name || '—'}</span>}
          </td>
          <td style={{ padding: '6px 12px', color: C.textSec }}>{r.contact_name?.trim() || '—'}</td>
          <td style={{ padding: '6px 12px', color: C.textSec }}>{r.rep || '—'}</td>
          <td style={{ padding: '6px 12px', color: C.textSec, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.subject || '—'}</td>
          <td style={{ padding: '6px 12px' }}><SfdcLink sfdc_id={r.sfdc_id} /></td>
        </tr>
      ))}
    </DetailTableShell>
  );
}

// Sync Banner
function ActivitySyncBanner({ onRefresh }) {
  const { data: syncData } = useSWR('/api/sync-log', fetcher, { revalidateOnFocus: false, refreshInterval: 60000 });
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 10000);
    return () => clearInterval(t);
  }, []);

  const activitiesSync = syncData?.lastSyncByTable?.find(s => s.table_name === 'activities');
  const lastSyncedAt = activitiesSync?.completed_at ? new Date(activitiesSync.completed_at) : null;

  function relTime(ts) {
    if (!ts) return 'never';
    const diffMs = now - ts.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    return ts.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 12px', background: C.card, border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 11, color: C.textMuted, marginBottom: 10 }}>
      <span>🔄</span>
      <span>Last synced: <strong style={{ color: C.textSec }}>{relTime(lastSyncedAt)}</strong></span>
      <span style={{ color: C.border }}>·</span>
      <span>Auto-refresh every 60s</span>
      <span style={{ color: C.border }}>·</span>
      <button
        onClick={onRefresh}
        style={{ background: 'none', border: 'none', color: C.blue, cursor: 'pointer', fontSize: 11, padding: 0, textDecoration: 'underline' }}>
        Refresh now
      </button>
    </div>
  );
}

// ─── Week date range label ────────────────────────────────────────────────────
function getWeekRange() {
  const now = new Date();
  const day = now.getDay(); // 0=Sun
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((day + 6) % 7));
  const friday = new Date(monday);
  friday.setDate(monday.getDate() + 4);
  const fmt = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `Week of ${fmt(monday)}–${fmt(friday)}`;
}

// ─── Activity Trend Charts ────────────────────────────────────────────────────
function ActivityTrendCharts() {
  const [callsWindow, setCallsWindow] = useState('daily');
  const [coverageWindow, setCoverageWindow] = useState('daily');
  const [setsWindow, setSetsWindow] = useState('daily');

  // Build placeholder trend data
  const buildPlaceholder = (n, base, variance) =>
    Array.from({ length: n }, (_, i) => ({
      label: `P${i + 1}`,
      calls: 0, connects: 0, contacts: 0, accounts: 0, sets: 0,
    }));

  const dailyData  = buildPlaceholder(14, 0, 0).map((d, i) => {
    const date = new Date(); date.setDate(date.getDate() - (13 - i));
    return { ...d, label: date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) };
  });
  const weeklyData = buildPlaceholder(4, 0, 0).map((d, i) => {
    const date = new Date(); date.setDate(date.getDate() - (3 - i) * 7);
    const mon = new Date(date); mon.setDate(date.getDate() - ((date.getDay() + 6) % 7));
    return { ...d, label: `Wk ${mon.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` };
  });
  const monthlyData = buildPlaceholder(4, 0, 0).map((d, i) => {
    const date = new Date(); date.setMonth(date.getMonth() - (3 - i));
    return { ...d, label: date.toLocaleDateString('en-US', { month: 'short' }) };
  });

  const getWindowData = (w) => w === 'daily' ? dailyData : w === 'weekly' ? weeklyData : monthlyData;
  const callsTarget = callsWindow === 'daily' ? 40 : callsWindow === 'weekly' ? 200 : 880;
  const connectsTarget = callsWindow === 'daily' ? 4 : callsWindow === 'weekly' ? 20 : 88;
  const setsTarget = setsWindow === 'daily' ? 1 : setsWindow === 'weekly' ? 5 : 22;

  const windowBtns = (current, setCurrent) => ['daily', 'weekly', 'monthly'].map(w => (
    <button key={w} onClick={() => setCurrent(w)} style={{
      background: current === w ? C.accent + '33' : 'transparent',
      color: current === w ? C.accent : C.textMuted,
      border: `1px solid ${current === w ? C.accent + '55' : 'transparent'}`,
      borderRadius: 6, padding: '3px 10px', cursor: 'pointer', fontSize: 11,
      fontWeight: current === w ? 600 : 400, textTransform: 'capitalize',
    }}>{w.charAt(0).toUpperCase() + w.slice(1)}</button>
  ));

  const CHART_H = 180;
  const chartStyle = {
    background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: '14px 16px',
    flex: '1 1 300px', minWidth: 280,
  };

  const emptyNote = (
    <div style={{ color: C.textMuted, fontSize: 11, textAlign: 'center', marginTop: 8 }}>
      📊 Charts will populate once SFDC Task sync is active
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Chart 1 — Calls & Connects */}
      <div style={chartStyle}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <span style={{ color: C.textSec, fontSize: 12, fontWeight: 600 }}>📞 Calls &amp; Connects</span>
          <div style={{ display: 'flex', gap: 4 }}>{windowBtns(callsWindow, setCallsWindow)}</div>
        </div>
        <div style={{ display: 'flex', gap: 12, fontSize: 11, color: C.textMuted, marginBottom: 8 }}>
          <span style={{ color: C.blue }}>■ Outbound Calls</span>
          <span style={{ color: C.amber }}>— Live Connects</span>
          <span style={{ color: C.textMuted, borderTop: '1px dashed', paddingTop: 1 }}>- - - Target ({callsTarget}/pd)</span>
        </div>
        <ResponsiveContainer width="100%" height={CHART_H}>
          <BarChart data={getWindowData(callsWindow)} margin={{ top: 4, right: 8, bottom: 0, left: -20 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={C.border} vertical={false} />
            <XAxis dataKey="label" tick={{ fill: C.textMuted, fontSize: 10 }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fill: C.textMuted, fontSize: 10 }} axisLine={false} tickLine={false} />
            <Tooltip
              contentStyle={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12 }}
              labelStyle={{ color: C.textSec }}
              itemStyle={{ color: C.textPri }}
            />
            <Bar dataKey="calls" fill={C.blue} radius={[3, 3, 0, 0]} name="Calls" />
            <Bar dataKey="connects" fill={C.amber} radius={[3, 3, 0, 0]} name="Connects" />
          </BarChart>
        </ResponsiveContainer>
        {emptyNote}
      </div>

      {/* Chart 2 — Outreach Coverage */}
      <div style={chartStyle}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <span style={{ color: C.textSec, fontSize: 12, fontWeight: 600 }}>🎯 Outreach Coverage</span>
          <div style={{ display: 'flex', gap: 4 }}>{windowBtns(coverageWindow, setCoverageWindow)}</div>
        </div>
        <div style={{ display: 'flex', gap: 12, fontSize: 11, color: C.textMuted, marginBottom: 8 }}>
          <span style={{ color: C.teal }}>■ Contacts Reached</span>
          <span style={{ color: C.purple }}>■ Accounts Contacted</span>
        </div>
        <ResponsiveContainer width="100%" height={CHART_H}>
          <BarChart data={getWindowData(coverageWindow)} margin={{ top: 4, right: 8, bottom: 0, left: -20 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={C.border} vertical={false} />
            <XAxis dataKey="label" tick={{ fill: C.textMuted, fontSize: 10 }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fill: C.textMuted, fontSize: 10 }} axisLine={false} tickLine={false} />
            <Tooltip contentStyle={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12 }} labelStyle={{ color: C.textSec }} itemStyle={{ color: C.textPri }} />
            <Bar dataKey="contacts" fill={C.teal} radius={[3, 3, 0, 0]} name="Contacts" />
            <Bar dataKey="accounts" fill={C.purple} radius={[3, 3, 0, 0]} name="Accounts" />
          </BarChart>
        </ResponsiveContainer>
        {emptyNote}
      </div>

      {/* Chart 3 — Sets */}
      <div style={chartStyle}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <span style={{ color: C.textSec, fontSize: 12, fontWeight: 600 }}>📅 Discovery Sets</span>
          <div style={{ display: 'flex', gap: 4 }}>{windowBtns(setsWindow, setSetsWindow)}</div>
        </div>
        <div style={{ display: 'flex', gap: 12, fontSize: 11, color: C.textMuted, marginBottom: 8 }}>
          <span style={{ color: C.green }}>■ Sets (Disco Scheduled)</span>
          <span style={{ color: C.textMuted }}>- - - Target ({setsTarget}/pd)</span>
        </div>
        <ResponsiveContainer width="100%" height={CHART_H}>
          <BarChart data={getWindowData(setsWindow)} margin={{ top: 4, right: 8, bottom: 0, left: -20 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={C.border} vertical={false} />
            <XAxis dataKey="label" tick={{ fill: C.textMuted, fontSize: 10 }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fill: C.textMuted, fontSize: 10 }} axisLine={false} tickLine={false} />
            <Tooltip contentStyle={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12 }} labelStyle={{ color: C.textSec }} itemStyle={{ color: C.textPri }} />
            <Bar dataKey="sets" fill={C.green} radius={[3, 3, 0, 0]} name="Sets" />
          </BarChart>
        </ResponsiveContainer>
        {emptyNote}
      </div>
    </div>
  );
}

// ─── Activity Dashboard ───────────────────────────────────────────────────────
function ActivityDashboard() {
  const { data: todayData,   isLoading: todayLoading  } = useSWR('/api/activity-stats?window=today',  fetcher, { revalidateOnFocus: false, refreshInterval: 60000 });
  const { data: weekData,    isLoading: weekLoading   } = useSWR('/api/activity-stats?window=week',   fetcher, { revalidateOnFocus: false, refreshInterval: 60000 });

  const today = todayData?.stats || { calls: 0, connects: 0, contactsContacted: 0, accountsContacted: 0, sets: 0 };
  const week  = weekData?.stats  || { calls: 0, connects: 0, contactsContacted: 0, accountsContacted: 0, sets: 0 };
  const isLive = todayData?.isLive ?? false;

  const liveNote = !isLive ? 'Live once SFDC sync active' : null;

  return (
    <div>
      {/* Live status banner */}
      {!isLive && (
        <div style={{ background: C.amber + '11', border: `1px solid ${C.amber}33`, borderRadius: 8, padding: '8px 14px', marginBottom: 14, color: C.amber, fontSize: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span>⏳</span>
          <span>Activity sync not yet active — stats below are placeholders. Once SFDC Task sync runs, this dashboard will populate automatically.</span>
        </div>
      )}

      {/* ── Section 1 — Today's Stats ── */}
      <DashSection title="📊 Today's Stats" accent={C.blue}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 14 }}>
          <ActivityMetricCard emoji="📞" label="Outbound Calls"      value={today.calls}              target={40} loading={todayLoading} note={liveNote} />
          <ActivityMetricCard emoji="🔗" label="Live Connects"       value={today.connects}           target={4}  loading={todayLoading} note={liveNote} />
          <ActivityMetricCard emoji="👤" label="Contacts Contacted"  value={today.contactsContacted}  target={null} loading={todayLoading} note={liveNote} />
          <ActivityMetricCard emoji="🏢" label="Accounts Contacted"  value={today.accountsContacted}  target={null} loading={todayLoading} note={liveNote} />
          <ActivityMetricCard emoji="📅" label="Sets"                value={today.sets}               target={1}  loading={todayLoading} note={liveNote} />
        </div>
      </DashSection>

      {/* ── Section 2 — Daily Activity Detail ── */}
      <DashSection title="📋 Daily Activity Detail" accent={C.purple} defaultOpen={false}>
        <ActivitySyncBanner onRefresh={() => {
          // Trigger SWR revalidation by mutating cache keys
          if (typeof window !== 'undefined' && window.__SWR_MUTATE__) window.__SWR_MUTATE__();
        }} />
        <OutboundCallsTable />
        <LiveConnectsTable />
        <ContactsContactedTable />
        <AccountsContactedTable />
        <SetsTable />
      </DashSection>

      {/* ── Section 3 — This Week's Stats ── */}
      <DashSection title={`📅 This Week's Stats — ${getWeekRange()}`} accent={C.teal}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 16 }}>
          <ActivityMetricCard emoji="📞" label="Outbound Calls"      value={week.calls}              target={200} loading={weekLoading} note={liveNote} />
          <ActivityMetricCard emoji="🔗" label="Live Connects"       value={week.connects}           target={20}  loading={weekLoading} note={liveNote} />
          <ActivityMetricCard emoji="👤" label="Contacts Contacted"  value={week.contactsContacted}  target={null} loading={weekLoading} note={liveNote} />
          <ActivityMetricCard emoji="🏢" label="Accounts Contacted"  value={week.accountsContacted}  target={null} loading={weekLoading} note={liveNote} />
          <ActivityMetricCard emoji="📅" label="Sets"                value={week.sets}               target={5}   loading={weekLoading} note={liveNote} />
        </div>
        {/* Daily breakdown table */}
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr>
                <th style={{ padding: '7px 12px', textAlign: 'left', color: C.textMuted, fontSize: 10, fontWeight: 600, borderBottom: `1px solid ${C.border}`, background: C.card, textTransform: 'uppercase', letterSpacing: '0.4px' }}>Metric</th>
                {['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].map(d => (
                  <th key={d} style={{ padding: '7px 12px', textAlign: 'center', color: C.textMuted, fontSize: 10, fontWeight: 600, borderBottom: `1px solid ${C.border}`, background: C.card, textTransform: 'uppercase', letterSpacing: '0.4px' }}>{d}</th>
                ))}
                <th style={{ padding: '7px 12px', textAlign: 'center', color: C.teal, fontSize: 10, fontWeight: 700, borderBottom: `1px solid ${C.border}`, background: C.card, textTransform: 'uppercase', letterSpacing: '0.4px' }}>Total</th>
              </tr>
            </thead>
            <tbody>
              {[
                { label: '📞 Calls', target: 40, key: 'calls' },
                { label: '🔗 Connects', target: 4, key: 'connects' },
                { label: '👤 Contacts', target: null, key: 'contactsContacted' },
                { label: '🏢 Accounts', target: null, key: 'accountsContacted' },
                { label: '📅 Sets', target: 1, key: 'sets' },
              ].map(metric => (
                <tr key={metric.key}>
                  <td style={{ padding: '6px 12px', borderBottom: `1px solid ${C.border}1a`, color: C.textSec, fontSize: 12 }}>
                    {metric.label}
                    {metric.target && <span style={{ color: C.textMuted, fontSize: 10 }}> (tgt: {metric.target}/day)</span>}
                  </td>
                  {['mon', 'tue', 'wed', 'thu', 'fri'].map(day => (
                    <td key={day} style={{ padding: '6px 12px', borderBottom: `1px solid ${C.border}1a`, textAlign: 'center', color: C.textMuted, fontSize: 12 }}>
                      {weekData?.daily?.[day]?.[metric.key] ?? '—'}
                    </td>
                  ))}
                  <td style={{ padding: '6px 12px', borderBottom: `1px solid ${C.border}1a`, textAlign: 'center', color: C.teal, fontWeight: 700, fontSize: 12 }}>
                    {week[metric.key] || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </DashSection>

      {/* ── Section 4 — Activity Trends ── */}
      <DashSection title="📈 Trends" accent={C.green} defaultOpen={true} storageKey="wt_show_trends">
        <ActivityTrendCharts />
      </DashSection>
    </div>
  );
}

// ─── New Data Tabs (DataGrid-powered) ─────────────────────────────────────────

function AccountsDataTab() {
  const fmtCurrency = (n) => {
    if (n == null || n === '') return '—';
    if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `$${Math.round(n / 1_000)}K`;
    return `$${n}`;
  };

  const columns = [
    {
      key: 'name', label: 'Account Name', width: 220,
      render: (row) => (
        row.sfdc_link
          ? <a href={row.sfdc_link} target="_blank" rel="noreferrer" style={{ color: C.accent, fontWeight: 500, textDecoration: 'none', fontSize: 12 }}>{row.name || '—'}</a>
          : <span style={{ color: C.textPri, fontWeight: 500, fontSize: 12 }}>{row.name || '—'}</span>
      ),
      getValue: (row) => row.name,
    },
    {
      key: 'agents_stage', label: 'Stage', width: 140,
      render: (row) => {
        const s = row.agents_stage;
        if (!s) return <span style={{ color: C.textMuted }}>—</span>;
        const bg = STAGE_COLORS[s] || '#374151';
        const fg = STAGE_TEXT_COLORS[s] || '#9ca3af';
        return (
          <span style={{ background: bg, color: fg, border: `1px solid ${fg}44`, borderRadius: 4, padding: '2px 7px', fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap' }}>
            {s}
          </span>
        );
      },
      getValue: (row) => row.agents_stage,
    },
    {
      key: 'agents_icp', label: 'ICP', width: 60, filterable: false,
      render: (row) => row.agents_icp ? <span style={{ color: C.green }}>✅</span> : <span style={{ color: C.textMuted }}>—</span>,
      getValue: (row) => row.agents_icp ? 'Yes' : 'No',
    },
    {
      key: 'domain', label: 'Domain', width: 160,
      render: (row) => <span style={{ color: C.textSec, fontSize: 12 }}>{row.domain || '—'}</span>,
    },
    {
      key: 'billing_state', label: 'State', width: 70,
      render: (row) => <span style={{ color: C.textSec, fontSize: 12 }}>{row.billing_state || '—'}</span>,
    },
    {
      key: 'industry', label: 'Industry', width: 150,
      render: (row) => <span style={{ color: C.textSec, fontSize: 12 }}>{row.industry || '—'}</span>,
    },
    {
      key: 'num_providers', label: '# Providers', width: 90, filterable: false,
      render: (row) => <span style={{ color: C.textSec, fontSize: 12 }}>{row.num_providers ?? '—'}</span>,
      getValue: (row) => row.num_providers,
    },
    {
      key: 'agents_owner', label: 'Owner', width: 130,
      render: (row) => <span style={{ color: C.textSec, fontSize: 12 }}>{row.agents_owner || '—'}</span>,
    },
    {
      key: 'potential_roe_issue', label: 'ROE', width: 90, filterable: false, sortable: false,
      render: (row) => {
        const issues = row.potential_roe_issue;
        const hasIssue = Array.isArray(issues) ? issues.length > 0 : (issues && issues !== '[]' && issues !== 'null');
        return hasIssue
          ? <span style={{ background: C.amber + '22', color: C.amber, border: `1px solid ${C.amber}44`, borderRadius: 4, padding: '1px 6px', fontSize: 10, fontWeight: 700 }}>🟡 ROE</span>
          : <span style={{ color: C.textMuted }}>—</span>;
      },
      getValue: (row) => row.potential_roe_issue ? 'Yes' : '',
    },
    {
      key: 'exclude_from_reporting', label: 'Excluded', width: 80, filterable: false,
      render: (row) => row.exclude_from_reporting
        ? <span style={{ background: '#37415122', color: '#9ca3af', border: '1px solid #37415166', borderRadius: 4, padding: '1px 6px', fontSize: 10 }}>excl</span>
        : <span style={{ color: C.textMuted }}>—</span>,
      getValue: (row) => row.exclude_from_reporting ? 'Yes' : '',
    },
    {
      key: 'sfdc_id', label: 'SFDC', width: 50, filterable: false, sortable: false,
      render: (row) => row.sfdc_link
        ? <a href={row.sfdc_link} target="_blank" rel="noreferrer" style={{ color: C.blue, textDecoration: 'none', fontSize: 14 }}>↗</a>
        : <span style={{ color: C.textMuted }}>—</span>,
      getValue: () => '',
    },
    {
      key: 'ehr_system', label: 'EHR', width: 130,
      render: (row) => {
        const ehr = row.ehr_system;
        if (!ehr) return <span style={{ color: C.textMuted }}>—</span>;
        const EHR_COLORS = {
          'Athenahealth': '#1e4d7b', 'Athena': '#1e4d7b',
          'eClinicalWorks': '#1a3d2e', 'eClincalWorks': '#1a3d2e',
          'EPIC': '#3b2800', 'Epic': '#3b2800',
          'MEDITECH': '#2d1b5e',
          'Modernizing Medicine': '#3b2000',
          'AdvancedMD': '#1e3050',
        };
        const bg = EHR_COLORS[ehr] || '#2a2d3e';
        return <span style={{ background: bg, color: '#e2e8f0', borderRadius: 4, padding: '2px 6px', fontSize: 10, fontWeight: 600, whiteSpace: 'nowrap' }}>{ehr}</span>;
      },
      getValue: (row) => row.ehr_system,
    },
    {
      key: 'specialty', label: 'Specialty', width: 160,
      render: (row) => <span style={{ color: C.textSec, fontSize: 11 }}>{row.specialty || '—'}</span>,
      getValue: (row) => row.specialty,
    },
    {
      key: 'dhc_num_physicians', label: 'Providers', width: 80,
      render: (row) => {
        const n = row.dhc_num_physicians;
        if (!n) return <span style={{ color: C.textMuted }}>—</span>;
        const color = n >= 25 ? C.green : n >= 10 ? '#f59e0b' : C.textMuted;
        return <span style={{ color, fontWeight: n >= 25 ? 700 : 400, fontSize: 12 }}>{n}</span>;
      },
      getValue: (row) => row.dhc_num_physicians,
    },
    {
      key: 'num_locations', label: 'Locs', width: 60,
      render: (row) => <span style={{ color: C.textSec, fontSize: 12 }}>{row.num_locations || row.dhc_num_locations || '—'}</span>,
      getValue: (row) => row.num_locations || row.dhc_num_locations,
    },
    {
      key: 'source_category', label: 'Source', width: 150,
      render: (row) => {
        const s = row.source_category;
        if (!s) return <span style={{ color: C.textMuted }}>—</span>;
        const SC_COLORS = {
          'Direct': '#374151',
          'MM Customers (x-sell)': '#1e4d3a',
          'MM New Biz Co-sell': '#1e3a5f',
          'MM Lead-Gen': '#3b3500',
          'Meditech': '#2d1b5e',
          'Enterprise Customers (x-sell)': '#3b0066',
          'Enterprise New Biz Co-sell': '#003366',
          'Enterprise Sales Motion': '#1a2a40',
          'Partnerships': '#3b1a00',
        };
        return <span style={{ background: SC_COLORS[s] || '#2a2d3e', color: '#e2e8f0', borderRadius: 4, padding: '2px 6px', fontSize: 10, fontWeight: 600, whiteSpace: 'nowrap', maxWidth: 140, display: 'inline-block', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s}</span>;
      },
      getValue: (row) => row.source_category,
    },
  ];

  const [showQueue, setShowQueue] = React.useState(false);
  const [queueCount, setQueueCount] = React.useState(null);

  React.useEffect(() => {
    fetch('/api/accounts?queue=enrichment&limit=1&page=1')
      .then(r => r.json())
      .then(data => setQueueCount(data.total || 0))
      .catch(() => setQueueCount(0));
  }, []);

  const handlePromote = React.useCallback(async (accountId) => {
    try {
      await fetch('/api/accounts', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId, field: 'db_status', value: 'main' }),
      });
    } catch (e) { console.error(e); }
  }, []);

  const queueColumns = React.useMemo(() => [
    ...columns,
    {
      key: 'promote', label: '', width: 100, filterable: false, sortable: false,
      render: (row) => (
        <button
          onClick={() => handlePromote(row.sfdc_id || row.id)}
          style={{ padding: '3px 10px', borderRadius: 4, background: '#6d28d9', color: '#e9d5ff', border: 'none', cursor: 'pointer', fontSize: 11, fontWeight: 600 }}
        >
          Promote →
        </button>
      ),
      getValue: () => '',
    },
  ], [columns, handlePromote]);

  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12, gap: 10 }}>
        <button
          onClick={() => setShowQueue(!showQueue)}
          style={{
            padding: '5px 12px', borderRadius: 12, cursor: 'pointer', fontSize: 12, fontWeight: 600,
            background: showQueue ? '#6d28d9' : '#2a2d3e',
            color: showQueue ? '#e9d5ff' : '#a78bfa',
            border: `1px solid ${showQueue ? '#7c3aed' : '#4c1d95'}`,
          }}
        >
          {showQueue ? '← Main Pipeline' : `🔬 Enrichment Queue (${queueCount === null ? '...' : queueCount.toLocaleString()})`}
        </button>
      </div>
      {showQueue && (
        <div style={{ background: '#1e1040', border: '1px solid #6d28d9', borderRadius: 8, padding: '10px 14px', marginBottom: 12, fontSize: 12, color: '#c4b5fd' }}>
          <strong>Enrichment Queue</strong> — accounts with matching EHR but unverified size data. Review and promote to main pipeline when size is confirmed (50+ employees, $10M+ revenue, 25+ providers, or 10+ locations).
        </div>
      )}
      <DataGrid
        columns={showQueue ? queueColumns : columns}
        fetchUrl={showQueue ? '/api/accounts?queue=enrichment' : '/api/accounts'}
        defaultSort={{ key: 'name', dir: 'asc' }}
        savedViewsKey={showQueue ? 'wt_accounts_queue' : 'wt_accounts_v2'}
        dataKey="accounts"
        quickFilters={showQueue ? [] : [
          { label: 'ICP Only',    params: { agents_icp: 'true' } },
          { label: 'Has Stage',   params: { has_stage: 'true' } },
          { label: 'ROE Flagged', params: { has_roe: 'true' } },
          { label: 'Excluded',    params: { exclude_from_reporting: 'true', includeExcluded: 'true' } },
          { label: 'MEDITECH',    params: { ehr: 'MEDITECH' } },
          { label: 'MM X-Sell',   params: { source_category: 'MM Customers (x-sell)' } },
          { label: 'Partners',    params: { source_category: 'Partnerships' } },
        ]}
      />
    </div>
  );
}

function ContactsDataTab() {
  const columns = [
    {
      key: 'full_name', label: 'Name', width: 180,
      render: (row) => {
        const name = row.full_name || `${row.first_name || ''} ${row.last_name || ''}`.trim();
        return <span style={{ color: C.textPri, fontWeight: 500, fontSize: 12 }}>{name || '—'}</span>;
      },
      getValue: (row) => row.full_name || `${row.first_name || ''} ${row.last_name || ''}`.trim(),
    },
    {
      key: 'title', label: 'Title', width: 180,
      render: (row) => <span style={{ color: C.textSec, fontSize: 12 }}>{row.title || '—'}</span>,
    },
    {
      key: 'account_name', label: 'Account', width: 200,
      render: (row) => <span style={{ color: C.purple, fontSize: 12 }}>{row.account_name || '—'}</span>,
    },
    {
      key: 'email', label: 'Email', width: 200,
      render: (row) => row.email
        ? <a href={`mailto:${row.email}`} style={{ color: C.accent, fontSize: 12, textDecoration: 'none' }}>{row.email}</a>
        : <span style={{ color: C.textMuted }}>—</span>,
    },
    {
      key: 'phone', label: 'Phone', width: 140,
      render: (row) => <span style={{ color: C.textSec, fontSize: 12 }}>{row.phone || '—'}</span>,
    },
    {
      key: 'target_persona', label: 'Target Persona', width: 100, filterable: false,
      render: (row) => row.target_persona ? <span style={{ color: C.green }}>✅</span> : <span style={{ color: C.textMuted }}>—</span>,
      getValue: (row) => row.target_persona ? 'Yes' : '',
    },
    {
      key: 'agents_icp', label: 'ICP', width: 60, filterable: false,
      render: (row) => row.agents_icp ? <span style={{ color: C.green }}>✅</span> : <span style={{ color: C.textMuted }}>—</span>,
      getValue: (row) => row.agents_icp ? 'Yes' : '',
    },
    {
      key: 'sfdc_id', label: 'SFDC', width: 50, filterable: false, sortable: false,
      render: (row) => row.sfdc_link
        ? <a href={row.sfdc_link} target="_blank" rel="noreferrer" style={{ color: C.blue, textDecoration: 'none', fontSize: 14 }}>↗</a>
        : <span style={{ color: C.textMuted }}>—</span>,
      getValue: () => '',
    },
  ];

  return (
    <div style={{ marginTop: 16 }}>
      <DataGrid
        columns={columns}
        fetchUrl="/api/contacts"
        defaultSort={{ key: 'full_name', dir: 'asc' }}
        savedViewsKey="wt_contacts_v2"
        dataKey="contacts"
        quickFilters={[
          { label: 'Target Persona', params: { target_persona: 'true' } },
          { label: 'ICP Only',       params: { agents_icp: 'true' } },
          { label: 'Has Email',      params: { has_email: 'true' } },
          { label: 'Has Phone',      params: { has_phone: 'true' } },
        ]}
      />
    </div>
  );
}

function OpportunitiesDataTab() {
  const fmtAcv = (n) => {
    if (n == null || n === '') return '—';
    if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `$${n.toLocaleString()}`;
    return `$${n}`;
  };

  const columns = [
    {
      key: 'account_name', label: 'Account', width: 220,
      render: (row) => (
        row.sfdc_link
          ? <a href={row.sfdc_link} target="_blank" rel="noreferrer" style={{ color: C.accent, fontWeight: 500, textDecoration: 'none', fontSize: 12 }}>{row.account_name || row.name || '—'}</a>
          : <span style={{ color: C.textPri, fontWeight: 500, fontSize: 12 }}>{row.account_name || row.name || '—'}</span>
      ),
      getValue: (row) => row.account_name,
    },
    {
      key: 'stage_normalized', label: 'Stage', width: 160,
      render: (row) => {
        const s = row.stage_normalized || row.stage;
        if (!s) return <span style={{ color: C.textMuted }}>—</span>;
        const bg = STAGE_COLORS[s] || '#374151';
        const fg = STAGE_TEXT_COLORS[s] || '#9ca3af';
        return (
          <span style={{ background: bg, color: fg, border: `1px solid ${fg}44`, borderRadius: 4, padding: '2px 7px', fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap' }}>
            {s}
          </span>
        );
      },
      getValue: (row) => row.stage_normalized || row.stage,
    },
    {
      key: 'acv', label: 'ACV', width: 100, filterable: false,
      render: (row) => <span style={{ color: C.green, fontWeight: 600, fontSize: 12 }}>{fmtAcv(row.acv)}</span>,
      getValue: (row) => row.acv,
    },
    {
      key: 'owner', label: 'Owner', width: 140,
      render: (row) => <span style={{ color: C.textSec, fontSize: 12 }}>{row.owner || '—'}</span>,
    },
    {
      key: 'close_date', label: 'Close Date', width: 110,
      render: (row) => {
        if (!row.close_date) return <span style={{ color: C.textMuted }}>—</span>;
        try {
          const d = new Date(row.close_date);
          return <span style={{ color: C.textSec, fontSize: 12 }}>{d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })}</span>;
        } catch { return <span style={{ color: C.textSec, fontSize: 12 }}>{row.close_date}</span>; }
      },
      getValue: (row) => row.close_date,
    },
    {
      key: 'source_category', label: 'Source', width: 140,
      render: (row) => <span style={{ color: C.textSec, fontSize: 12 }}>{row.source_category || '—'}</span>,
    },
    {
      key: 'agents_icp', label: 'ICP', width: 60, filterable: false,
      render: (row) => row.agents_icp ? <span style={{ color: C.green }}>✅</span> : <span style={{ color: C.textMuted }}>—</span>,
      getValue: (row) => row.agents_icp ? 'Yes' : '',
    },
    {
      key: 'discovery_scheduled', label: 'Disco Sched', width: 90, filterable: false,
      render: (row) => row.discovery_scheduled ? <span style={{ color: C.green }}>✅</span> : <span style={{ color: C.textMuted }}>—</span>,
      getValue: (row) => row.discovery_scheduled ? 'Yes' : '',
    },
    {
      key: 'sfdc_id', label: 'SFDC', width: 50, filterable: false, sortable: false,
      render: (row) => row.sfdc_link
        ? <a href={row.sfdc_link} target="_blank" rel="noreferrer" style={{ color: C.blue, textDecoration: 'none', fontSize: 14 }}>↗</a>
        : <span style={{ color: C.textMuted }}>—</span>,
      getValue: () => '',
    },
  ];

  return (
    <div style={{ marginTop: 16 }}>
      <DataGrid
        columns={columns}
        fetchUrl="/api/opportunities"
        defaultSort={{ key: 'account_name', dir: 'asc' }}
        savedViewsKey="wt_opps_v2"
        dataKey="opportunities"
        quickFilters={[
          { label: 'Active Only',  params: { active_only: 'true' } },
          { label: 'Closed-Won',   params: { closed_won: 'true' } },
          { label: 'Closed-Lost',  params: { closed_lost: 'true' } },
          { label: 'ICP Only',     params: { agents_icp: 'true' } },
          { label: 'Missing ACV',  params: { missing_acv: 'true' } },
        ]}
      />
    </div>
  );
}

function ActivitiesDataTab() {
  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ background: C.card, border: `1px solid ${C.amber}33`, borderRadius: 12, padding: '32px 24px', textAlign: 'center' }}>
        <div style={{ fontSize: 32, marginBottom: 12 }}>📭</div>
        <div style={{ color: C.textPri, fontWeight: 700, fontSize: 16, marginBottom: 8 }}>Activity Log — Coming Soon</div>
        <p style={{ color: C.textSec, fontSize: 13, margin: '0 0 16px 0', maxWidth: 500, marginLeft: 'auto', marginRight: 'auto', lineHeight: 1.6 }}>
          This tab will show a full log of calls, emails, meetings, and tasks once the SFDC Task sync is active.
          Records will include date, type, subject, account, contact, rep, outcome, and source.
        </p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
          <span style={{ background: C.green + '22', color: C.green, border: `1px solid ${C.green}44`, borderRadius: 4, padding: '3px 10px', fontSize: 12 }}>
            ✅ Webhook endpoint ready: /api/webhook/sfdc
          </span>
          <span style={{ background: C.green + '22', color: C.green, border: `1px solid ${C.green}44`, borderRadius: 4, padding: '3px 10px', fontSize: 12 }}>
            ✅ Webhook endpoint ready: /api/webhook/outreach
          </span>
          <span style={{ background: C.amber + '22', color: C.amber, border: `1px solid ${C.amber}44`, borderRadius: 4, padding: '3px 10px', fontSize: 12 }}>
            ⏳ SFDC Task sync: pending
          </span>
        </div>
      </div>
    </div>
  );
}

function SyncLogDataTab() {
  const { data: syncData, isLoading } = useSWR('/api/sync-log', fetcher, {
    revalidateOnFocus: false,
    refreshInterval: 60_000,
  });

  // Calculate next scheduled run times
  function getNextRun(hour, minute) {
    const now = new Date();
    const next = new Date();
    next.setUTCHours(hour, minute, 0, 0);
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    const diff = next - now;
    const h = Math.floor(diff / 3_600_000);
    const m = Math.floor((diff % 3_600_000) / 60_000);
    return { time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} UTC`, in: h > 0 ? `in ${h}h ${m}m` : `in ${m}m` };
  }

  const schedule = [
    { name: 'SFDC Account sync',      ...getNextRun(2, 0)  },
    { name: 'SFDC Contact sync',      ...getNextRun(2, 15) },
    { name: 'SFDC Opportunity sync',  ...getNextRun(2, 30) },
    { name: 'SFDC Activity (Tasks) sync', ...getNextRun(3, 0) },
  ];

  const thS = { padding: '8px 12px', textAlign: 'left', color: C.textMuted, fontSize: 10, fontWeight: 600, borderBottom: `1px solid ${C.border}`, textTransform: 'uppercase', letterSpacing: '0.4px', background: C.card, whiteSpace: 'nowrap' };
  const tdS = { padding: '7px 12px', borderBottom: `1px solid ${C.border}1a`, fontSize: 12, color: C.textSec, whiteSpace: 'nowrap' };

  function StatusBadge({ errors }) {
    if (errors == null) return null;
    if (errors === 0) return <span style={{ background: C.green + '22', color: C.green, border: `1px solid ${C.green}44`, borderRadius: 4, padding: '1px 7px', fontSize: 11 }}>✅ ok</span>;
    if (errors < 5)   return <span style={{ background: C.amber + '22', color: C.amber, border: `1px solid ${C.amber}44`, borderRadius: 4, padding: '1px 7px', fontSize: 11 }}>⚠️ partial</span>;
    return <span style={{ background: C.red + '22', color: C.red, border: `1px solid ${C.red}44`, borderRadius: 4, padding: '1px 7px', fontSize: 11 }}>❌ errors</span>;
  }

  return (
    <div style={{ marginTop: 16 }}>
      {/* Section 1 — Last 48h syncs */}
      <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, overflow: 'hidden', marginBottom: 16 }}>
        <div style={{ padding: '12px 16px', borderBottom: `1px solid ${C.border}` }}>
          <span style={{ color: C.textPri, fontWeight: 700, fontSize: 14 }}>🕐 Recent Syncs (Last 48h)</span>
        </div>
        {isLoading && (
          <div style={{ textAlign: 'center', padding: '32px 0', color: C.textMuted }}>⟳ Loading…</div>
        )}
        {!isLoading && (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  {['Time', 'Table', 'Type', 'Records Synced', 'Created', 'Updated', 'Errors', 'Status', 'Notes'].map(h => (
                    <th key={h} style={thS}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(!syncData?.recentEntries || syncData.recentEntries.length === 0) && (
                  <tr>
                    <td colSpan={9} style={{ textAlign: 'center', padding: '32px 0', color: C.textMuted, fontSize: 12 }}>
                      No sync history yet — runs will appear here after the first scheduled sync.
                    </td>
                  </tr>
                )}
                {(syncData?.recentEntries || []).map((r, i) => (
                  <tr key={r.id || i} onMouseEnter={(e) => e.currentTarget.style.background = C.cardHover} onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'} style={{ transition: 'background 0.1s' }}>
                    <td style={tdS}>{r.completed_at ? new Date(r.completed_at).toLocaleString() : '—'}</td>
                    <td style={{ ...tdS, color: C.purple, fontWeight: 600 }}>{r.table_name}</td>
                    <td style={tdS}><span style={{ background: C.blue + '22', color: C.blue, borderRadius: 4, padding: '1px 6px', fontSize: 11 }}>{r.sync_type || '—'}</span></td>
                    <td style={{ ...tdS, textAlign: 'right' }}>{r.records_synced?.toLocaleString() ?? '—'}</td>
                    <td style={{ ...tdS, textAlign: 'right', color: C.green }}>{r.records_created?.toLocaleString() ?? '—'}</td>
                    <td style={{ ...tdS, textAlign: 'right', color: C.amber }}>{r.records_updated?.toLocaleString() ?? '—'}</td>
                    <td style={{ ...tdS, textAlign: 'right' }}>{r.errors > 0 ? <span style={{ color: C.red, fontWeight: 600 }}>{r.errors}</span> : '0'}</td>
                    <td style={tdS}><StatusBadge errors={r.errors} /></td>
                    <td style={{ ...tdS, maxWidth: 200, whiteSpace: 'normal', color: C.textMuted }}>{r.notes || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Section 2 — Upcoming scheduled syncs */}
      <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: '16px 20px' }}>
        <div style={{ color: C.textPri, fontWeight: 700, fontSize: 14, marginBottom: 12 }}>📅 Upcoming Scheduled Syncs</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {schedule.map((s, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, padding: '10px 14px' }}>
              <span style={{ color: C.blue, fontSize: 18 }}>🔄</span>
              <div style={{ flex: 1 }}>
                <div style={{ color: C.textPri, fontSize: 13, fontWeight: 500 }}>{s.name}</div>
                <div style={{ color: C.textMuted, fontSize: 11, marginTop: 2 }}>Daily at {s.time}</div>
              </div>
              <span style={{ color: C.teal, fontSize: 12, fontWeight: 600, background: C.teal + '11', border: `1px solid ${C.teal}33`, borderRadius: 6, padding: '3px 10px' }}>
                {s.in}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function Home() {
  const { data: session } = useSession();
  const userRole = session?.user?.role || 'viewer';

  const [activeTab, setActiveTab] = useState('pipeline');
  const [dashSection, setDashSection] = useState('pipeline'); // 'pipeline' | 'activity' | 'icpaccounts' | 'pipelinepulse'
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
              {tabBtn('pipeline', '📊 Dashboard')}
              {tabBtn('accounts', '🏢 Accounts')}
              {tabBtn('contacts', '👥 Contacts')}
              {tabBtn('opportunities', '💼 Opportunities')}
              {tabBtn('activities', '📞 Activities')}
              {tabBtn('synclog', '🔄 Sync Log')}
              {tabBtn('manage', '⚙️ Manage')}
            </div>

            {/* ── User pill ── */}
            {session && (
              <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                {session.user.image && (
                  <img src={session.user.image} alt="" style={{ width:24, height:24, borderRadius:'50%' }} />
                )}
                <span style={{ color:'#aaa', fontSize:12 }}>{session.user.name}</span>
                <span style={{
                  background: userRole==='admin'?'#7c3aed':'#1d4ed8',
                  color:'#fff', fontSize:10, padding:'2px 6px',
                  borderRadius:4, textTransform:'uppercase', fontWeight:700,
                }}>{userRole}</span>
                <button
                  onClick={() => signOut()}
                  style={{ color:'#666', fontSize:11, background:'none', border:'none', cursor:'pointer' }}
                >Sign out</button>
              </div>
            )}
          </div>
        </div>

        {/* ── Dashboard Tab ── */}
        {activeTab === 'pipeline' && (
          <>
            {/* Data Quality Banner */}
            <DataQualityBanner />

            {/* Dashboard section selector */}
            <div style={{ display: 'flex', gap: 4, marginBottom: 18, background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: 4, width: 'fit-content' }}>
              {(['activity', 'pipeline', 'icpaccounts', 'pipelinepulse']).map((sec) => {
                const labels = { pipeline: '🔭 Pipeline', activity: '📞 Activity', icpaccounts: '📋 ICP Accounts', pipelinepulse: '📡 Pipeline Pulse' };
                const active = dashSection === sec;
                return (
                  <button key={sec} onClick={() => setDashSection(sec)} style={{
                    background:   active ? C.accent + '22' : 'transparent',
                    color:        active ? C.accent : C.textSec,
                    border:       `1px solid ${active ? C.accent + '66' : 'transparent'}`,
                    borderRadius: 7, padding: '5px 20px', cursor: 'pointer',
                    fontSize: 13, fontWeight: active ? 600 : 400, transition: 'all 0.15s',
                  }}>
                    {labels[sec]}
                  </button>
                );
              })}
            </div>

            {dashSection === 'activity' && <ActivityDashboard />}

            {dashSection === 'pipeline' && (
              <>
                <GoalsSection globals={globals} currentMonth={currentMonth} statsLoading={statsLoading} />
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
              </>
            )}
            {dashSection === 'icpaccounts' && (
              <>
                <MarketSummarySection
                  globals={globals}
                  statsLoading={statsLoading}
                  title="📊 Total ICP Accounts"
                  hiddenLabels={['Non-RCM ICP', 'Confirmed ICP Tier']}
                />
                <MarketOverviewSection globals={globals} title="🌍 ICP Account List - Detailed View" />
              </>
            )}
            {dashSection === 'pipelinepulse' && <PipelinePulseSection />}
          </>
        )}

        {/* ── Accounts Tab ── */}
        {activeTab === 'accounts' && <AccountsDataTab />}

        {/* ── Contacts Tab ── */}
        {activeTab === 'contacts' && <ContactsDataTab />}

        {/* ── Opportunities Tab ── */}
        {activeTab === 'opportunities' && <OpportunitiesDataTab />}

        {/* ── Activities Tab ── */}
        {activeTab === 'activities' && <ActivitiesDataTab />}

        {/* ── Sync Log Tab ── */}
        {activeTab === 'synclog' && <SyncLogDataTab />}

        {/* ── Manage Tab ── */}
        {activeTab === 'manage' && <ManageTab />}

      </div>
    </div>
  );
}
