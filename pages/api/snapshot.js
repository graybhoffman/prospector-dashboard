/**
 * /api/snapshot — POST (cron)
 * Captures current pipeline aggregations and appends them to a
 * rolling snapshots array stored in /tmp/snapshots.json.
 * Used for Week-over-Week delta calculations.
 */

import { createReadStream, writeFileSync, existsSync, readFileSync } from 'fs';

const SNAPSHOT_FILE = '/tmp/pipeline_snapshots.json';
const MAX_SNAPSHOTS = 52; // keep up to one year of weekly snapshots

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function loadSnapshots() {
  try {
    if (existsSync(SNAPSHOT_FILE)) {
      return JSON.parse(readFileSync(SNAPSHOT_FILE, 'utf8'));
    }
  } catch {}
  return [];
}

function saveSnapshots(snapshots) {
  writeFileSync(SNAPSHOT_FILE, JSON.stringify(snapshots, null, 2));
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    // Return existing snapshots for WoW display
    const snapshots = loadSnapshots();
    return res.status(200).json({ snapshots });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // Fetch current aggregations from the pipeline API
    const protocol = req.headers['x-forwarded-proto'] || 'http';
    const host     = req.headers.host || 'localhost:3000';
    const apiUrl   = `${protocol}://${host}/api/pipeline?pageSize=1`;

    const pipelineResp = await fetch(apiUrl);
    if (!pipelineResp.ok) {
      throw new Error(`Pipeline API returned ${pipelineResp.status}`);
    }
    const data = await pipelineResp.json();
    const { aggregations, meta } = data;

    const snapshot = {
      takenAt:   new Date().toISOString(),
      total:     aggregations.total,
      byStage:   aggregations.byStage,
      byEhr:     aggregations.byEhr,
      notRcm:    aggregations.notRcmCount,
      roe:       aggregations.roeCount,
    };

    const snapshots = loadSnapshots();
    snapshots.push(snapshot);

    // Keep only the most recent MAX_SNAPSHOTS entries
    if (snapshots.length > MAX_SNAPSHOTS) {
      snapshots.splice(0, snapshots.length - MAX_SNAPSHOTS);
    }

    saveSnapshots(snapshots);
    console.log(`[snapshot] Saved snapshot: ${snapshot.total} accounts at ${snapshot.takenAt}`);

    return res.status(200).json({ ok: true, snapshot });
  } catch (err) {
    console.error('[snapshot] Error:', err);
    return res.status(500).json({ error: err.message });
  }
}
