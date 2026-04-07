/**
 * lib/notion.js — Shared Notion API utilities
 * Used by all /api/* routes that talk to Notion.
 */

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Extract a plain JS value from any Notion property object.
 * Handles all property types cleanly.
 */
export function extractPropValue(prop) {
  if (!prop) return null;
  switch (prop.type) {
    case 'title':
      return prop.title?.map((t) => t.plain_text).join('') || null;
    case 'rich_text':
      return prop.rich_text?.map((t) => t.plain_text).join('') || null;
    case 'select':
      return prop.select?.name || null;
    case 'multi_select':
      return prop.multi_select?.map((s) => s.name) || [];
    case 'status':
      return prop.status?.name || null;
    case 'number':
      return prop.number ?? null;
    case 'checkbox':
      return prop.checkbox ?? false;
    case 'date':
      return prop.date?.start || null;
    case 'url':
      return prop.url || null;
    case 'email':
      return prop.email || null;
    case 'phone_number':
      return prop.phone_number || null;
    case 'formula':
      return prop.formula?.string ?? prop.formula?.number ?? prop.formula?.boolean ?? null;
    case 'relation':
      // Returns array of related page IDs; resolve separately if needed
      return prop.relation?.map((r) => r.id) || [];
    case 'rollup':
      return prop.rollup?.number ?? (prop.rollup?.array?.length ?? null);
    case 'people':
      return prop.people?.map((p) => p.name || p.id).join(', ') || null;
    case 'created_time':
      return prop.created_time || null;
    case 'last_edited_time':
      return prop.last_edited_time || null;
    case 'created_by':
      return prop.created_by?.name || null;
    case 'last_edited_by':
      return prop.last_edited_by?.name || null;
    default:
      return null;
  }
}

/**
 * Extract ALL properties from a Notion page into a flat key→value map.
 * New fields appear automatically — no code changes needed.
 */
export function extractAllProps(properties) {
  const result = {};
  for (const [name, prop] of Object.entries(properties || {})) {
    result[name] = extractPropValue(prop);
  }
  return result;
}

/**
 * Paginate through all records in a Notion database.
 * Rate-limited to 0.35s between requests per Notion guidelines.
 *
 * @param {string} dbId     - Notion DB UUID
 * @param {string} token    - Notion integration token
 * @param {function} onPage - Optional progress callback(pageNum, totalSoFar)
 * @returns {Array<{ id: string, fields: Object }>}
 */
export async function fetchAllPages(dbId, token, onPage) {
  if (!token)  throw new Error('Missing NOTION_TOKEN');
  if (!dbId)   throw new Error('Missing Notion DB ID');

  const records = [];
  let cursor    = undefined;
  let hasMore   = true;
  let pageNum   = 0;

  while (hasMore) {
    pageNum++;
    const body = {
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    };

    const resp = await fetch(
      `https://api.notion.com/v1/databases/${dbId}/query`,
      {
        method: 'POST',
        headers: {
          Authorization:    `Bearer ${token}`,
          'Notion-Version': '2022-06-28',
          'Content-Type':   'application/json',
        },
        body: JSON.stringify(body),
      }
    );

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Notion query error (DB ${dbId}) ${resp.status}: ${err}`);
    }

    const data = await resp.json();

    for (const item of data.results) {
      records.push({
        id:     item.id,
        fields: extractAllProps(item.properties),
      });
    }

    if (onPage) onPage(pageNum, records.length);

    hasMore = data.has_more;
    cursor  = data.next_cursor;
    if (hasMore) await sleep(350);
  }

  return records;
}

/**
 * Fetch the schema (property definitions) for a Notion database.
 * Returns property names, types, and select/multi_select options with colors.
 */
export async function fetchDbSchema(dbId, token) {
  if (!token) throw new Error('Missing NOTION_TOKEN');
  if (!dbId)  throw new Error('Missing DB ID');

  const resp = await fetch(`https://api.notion.com/v1/databases/${dbId}`, {
    headers: {
      Authorization:    `Bearer ${token}`,
      'Notion-Version': '2022-06-28',
    },
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Schema fetch failed (DB ${dbId}) ${resp.status}: ${err}`);
  }

  const data = await resp.json();
  const properties = {};

  for (const [name, prop] of Object.entries(data.properties || {})) {
    const entry = {
      type:    prop.type,
      options: [],
    };
    if (['select', 'multi_select', 'status'].includes(prop.type)) {
      entry.options = (prop[prop.type]?.options || []).map((o) => ({
        name:  o.name,
        color: o.color,
      }));
    }
    properties[name] = entry;
  }

  return {
    id:         dbId,
    title:      data.title?.[0]?.plain_text || dbId,
    properties,
    // Ordered list of property names as Notion returns them
    propOrder:  Object.keys(data.properties || {}),
  };
}

/**
 * Simple non-cryptographic hash for change detection.
 */
export function hashObject(obj) {
  const str = JSON.stringify(obj);
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(31, h) + str.charCodeAt(i) | 0;
  }
  return Math.abs(h).toString(36);
}
