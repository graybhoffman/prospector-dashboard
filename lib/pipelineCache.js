/**
 * lib/pipelineCache.js — Shared pipeline data cache
 * Used by /api/pipeline, /api/activity, and /api/crosstab
 */

import { fetchAllPages } from './notion';

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const PIPELINE_DB  = process.env.NOTION_PIPELINE_DB;
export const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export const pipelineCache = {
  records:    null,
  fetchedAt:  0,
  isFetching: false,
};

export function startPipelineRefresh() {
  if (pipelineCache.isFetching) return;
  pipelineCache.isFetching = true;
  console.log('[pipeline-cache] Refresh started…');

  fetchAllPages(PIPELINE_DB, NOTION_TOKEN, (page, total) => {
    if (page % 10 === 0) console.log(`[pipeline-cache] Page ${page} (${total} records so far)`);
  })
    .then((records) => {
      pipelineCache.records   = records;
      pipelineCache.fetchedAt = Date.now();
      console.log(`[pipeline-cache] Updated: ${records.length} records`);
    })
    .catch((err) => console.error('[pipeline-cache] Refresh failed:', err.message))
    .finally(() => { pipelineCache.isFetching = false; });
}

/**
 * Ensure cache is warm; triggers refresh if stale.
 * On cold start waits up to 5 minutes for the initial load.
 */
export async function ensurePipelineCache() {
  const age = Date.now() - pipelineCache.fetchedAt;
  if (!pipelineCache.records || age > CACHE_TTL) {
    startPipelineRefresh();
  }

  if (!pipelineCache.records) {
    console.log('[pipeline-cache] Cold start — waiting for first load…');
    const deadline = Date.now() + 300_000;
    while (!pipelineCache.records && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  return pipelineCache.records;
}
