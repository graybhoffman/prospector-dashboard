/**
 * lib/outreach.js
 * Outreach API helper with automatic token refresh.
 *
 * Required env vars (set in Vercel):
 *   OUTREACH_CLIENT_ID      = UIRYF~S0gyzA7OtwGwwM~pI.z4hVVuUv5rdJzOAlbNC_
 *   OUTREACH_CLIENT_SECRET  = (secret)
 *   OUTREACH_REFRESH_TOKEN  = (from initial OAuth flow — update after each refresh)
 *
 * ⚠️  SCOPE NOTE:
 *   The Outreach OAuth app needs 'calls.read' and 'mailings.read' scopes.
 *   If those scopes are missing, API calls will return 403 errors.
 *   To re-authorize: visit /api/outreach-auth (or the re-auth URL in the README).
 */

import { query } from './db.js';

const OUTREACH_TOKEN_URL = 'https://api.outreach.io/oauth/token';
const OUTREACH_API_BASE  = 'https://api.outreach.io/api/v2';

// ── Token storage in DB (outreach_tokens table, single row) ──────────────────
async function getStoredToken() {
  try {
    const r = await query(`
      SELECT access_token, refresh_token, expires_at
      FROM outreach_tokens
      ORDER BY id DESC LIMIT 1
    `);
    return r.rows[0] || null;
  } catch {
    // Table may not exist — fall back to env vars
    return null;
  }
}

async function storeToken(accessToken, refreshToken, expiresIn) {
  const expiresAt = new Date(Date.now() + expiresIn * 1000 - 60000); // 1-min buffer
  try {
    // Always upsert id=1 — single canonical token row
    await query(`
      INSERT INTO outreach_tokens (id, access_token, refresh_token, expires_at, updated_at)
      VALUES (1, $1, $2, $3, NOW())
      ON CONFLICT (id) DO UPDATE
        SET access_token = EXCLUDED.access_token,
            refresh_token = EXCLUDED.refresh_token,
            expires_at = EXCLUDED.expires_at,
            updated_at = NOW()
    `, [accessToken, refreshToken, expiresAt]);
  } catch (e) {
    console.warn('[outreach] storeToken failed (non-fatal):', e.message);
  }
}

// In-memory token cache (per cold-start)
let _tokenCache = null;

export async function getAccessToken() {
  // 1. Try in-memory cache first
  if (_tokenCache && _tokenCache.expiresAt > Date.now() + 30000) {
    return _tokenCache.accessToken;
  }

  // 2. Try DB-stored token
  const stored = await getStoredToken();
  if (stored && new Date(stored.expires_at) > new Date(Date.now() + 30000)) {
    _tokenCache = { accessToken: stored.access_token, expiresAt: new Date(stored.expires_at).getTime() };
    return stored.access_token;
  }

  // 3. Refresh using DB refresh_token or env var
  const refreshToken = stored?.refresh_token || process.env.OUTREACH_REFRESH_TOKEN;
  if (!refreshToken) {
    throw new Error('No Outreach refresh token available. Re-authorize at /api/outreach-auth.');
  }

  const resp = await fetch(OUTREACH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id:     process.env.OUTREACH_CLIENT_ID,
      client_secret: process.env.OUTREACH_CLIENT_SECRET,
      grant_type:    'refresh_token',
      refresh_token: refreshToken,
      redirect_uri:  process.env.OUTREACH_REDIRECT_URI || 'https://www.localhost:8888/oauth/redirect',
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Outreach token refresh failed: ${err}`);
  }

  const data = await resp.json();
  _tokenCache = {
    accessToken: data.access_token,
    expiresAt: Date.now() + (data.expires_in - 60) * 1000,
  };

  await storeToken(data.access_token, data.refresh_token, data.expires_in);
  return data.access_token;
}

/**
 * Paginate through all pages of an Outreach API endpoint.
 * Returns all records combined.
 */
export async function fetchAllPages(path, params = {}) {
  const token = await getAccessToken();
  const results = [];
  let nextUrl = null;

  // Build initial URL
  const url = new URL(`${OUTREACH_API_BASE}${path}`);
  url.searchParams.set('page[limit]', '100');
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  let currentUrl = url.toString();
  let pageCount = 0;
  const MAX_PAGES = 50; // safety cap

  while (currentUrl && pageCount < MAX_PAGES) {
    const resp = await fetch(currentUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      const errId = body?.errors?.[0]?.id || 'unknown';
      throw new Error(`Outreach API ${path} failed (${resp.status}): ${errId} — ${body?.errors?.[0]?.detail || ''}`);
    }

    const data = await resp.json();
    if (data.data) results.push(...data.data);

    nextUrl = data.links?.next || null;
    currentUrl = nextUrl;
    pageCount++;
  }

  return results;
}

/**
 * Fetch Outreach calls for given user IDs and date range.
 * @param {number[]} userIds
 * @param {string} startDate ISO date string (YYYY-MM-DD)
 * @param {string} endDate   ISO date string (YYYY-MM-DD)
 */
export async function fetchCalls(userIds, startDate, endDate) {
  const startISO = `${startDate}T00:00:00.000Z`;
  const endISO   = `${endDate}T23:59:59.999Z`;

  const allCalls = [];
  for (const uid of userIds) {
    const records = await fetchAllPages('/calls', {
      'filter[user][id]':        uid,
      'filter[createdAt][gte]':  startISO,
      'filter[createdAt][lte]':  endISO,
    });
    allCalls.push(...records);
  }
  return allCalls;
}

/**
 * Fetch Outreach mailings (delivered emails) for given user IDs and date range.
 */
export async function fetchMailings(userIds, startDate, endDate) {
  const startISO = `${startDate}T00:00:00.000Z`;
  const endISO   = `${endDate}T23:59:59.999Z`;

  const allMailings = [];
  for (const uid of userIds) {
    const records = await fetchAllPages('/mailings', {
      'filter[user][id]':        uid,
      'filter[createdAt][gte]':  startISO,
      'filter[createdAt][lte]':  endISO,
      'filter[state]':           'delivered',
    });
    allMailings.push(...records);
  }
  return allMailings;
}
