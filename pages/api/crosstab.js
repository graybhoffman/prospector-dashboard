/**
 * /api/crosstab — GET
 *
 * On-demand crosstab: row × col dimension count matrix.
 * Uses the shared pipeline cache.
 *
 * Query params:
 *   row   dimension: EHR | Specialty | Source | EmployeeBucket | Stage
 *   col   dimension: same options
 *
 * Response:
 *   { rows, cols, matrix: { [rowVal]: { [colVal]: count } } }
 */

import { ensurePipelineCache } from '../../lib/pipelineCache';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function empBucket(emp) {
  if (!emp || emp === 0) return 'Unknown';
  if (emp <= 25)  return '1-25';
  if (emp <= 100) return '26-100';
  if (emp <= 500) return '101-500';
  return '500+';
}

function getDimensionValue(fields, dim) {
  switch (dim) {
    case 'EHR':           return fields['EHR'] || 'Unknown';
    case 'Specialty': {
      const s = fields['Specialty'];
      if (!s) return ['Unknown'];
      return Array.isArray(s) ? (s.length ? s : ['Unknown']) : [s];
    }
    case 'Source':        return fields['Source Category'] || 'Unknown';
    case 'EmployeeBucket': return empBucket(fields['Employees #']);
    case 'Stage':         return fields['Stage'] || 'Unknown';
    default:              return 'Unknown';
  }
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { row, col } = req.query;
  if (!row || !col) return res.status(400).json({ error: 'row and col params required' });

  const allRecords = await ensurePipelineCache();
  if (!allRecords) {
    return res.status(503).json({ error: 'Pipeline data still loading.' });
  }

  // Filter excluded accounts from crosstab
  const activeRecords = allRecords.filter(r => !r.fields['Exclude from Reporting']);

  const matrix = {};
  const rowSet = new Set();
  const colSet = new Set();

  for (const { fields } of activeRecords) {
    let rowVals = getDimensionValue(fields, row);
    let colVals = getDimensionValue(fields, col);
    if (!Array.isArray(rowVals)) rowVals = [rowVals];
    if (!Array.isArray(colVals)) colVals = [colVals];

    for (const rv of rowVals) {
      for (const cv of colVals) {
        rowSet.add(rv);
        colSet.add(cv);
        if (!matrix[rv]) matrix[rv] = {};
        matrix[rv][cv] = (matrix[rv][cv] || 0) + 1;
      }
    }
  }

  // Sort rows/cols by total desc
  const rows = [...rowSet].sort((a, b) => {
    const aTotal = Object.values(matrix[a] || {}).reduce((s, n) => s + n, 0);
    const bTotal = Object.values(matrix[b] || {}).reduce((s, n) => s + n, 0);
    return bTotal - aTotal;
  }).slice(0, 30);

  const cols = [...colSet].sort((a, b) => {
    let aTotal = 0, bTotal = 0;
    for (const r of rows) {
      aTotal += matrix[r]?.[a] || 0;
      bTotal += matrix[r]?.[b] || 0;
    }
    return bTotal - aTotal;
  }).slice(0, 20);

  return res.status(200).json({ rows, cols, matrix });
}
