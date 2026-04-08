/**
 * Export full Notion pipeline to data/pipeline_accounts.json
 * Usage: node scripts/export-notion-pipeline.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT = path.join(__dirname, '..', 'data', 'pipeline_accounts.json');

// Set NOTION_TOKEN env var before running:
//   NOTION_TOKEN=ntn_... node scripts/export-notion-pipeline.mjs
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const PIPELINE_DB  = process.env.NOTION_PIPELINE_DB || '33af92a633f281cc8fa2e7a2b8b05e16';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function extractPropValue(prop) {
  if (!prop) return null;
  switch (prop.type) {
    case 'title':       return prop.title?.map(t => t.plain_text).join('') || null;
    case 'rich_text':   return prop.rich_text?.map(t => t.plain_text).join('') || null;
    case 'select':      return prop.select?.name || null;
    case 'multi_select':return prop.multi_select?.map(s => s.name) || [];
    case 'number':      return prop.number ?? null;
    case 'checkbox':    return prop.checkbox ?? false;
    case 'date':        return prop.date?.start || null;
    case 'url':         return prop.url || null;
    default:            return null;
  }
}

function extractSfdcAccountId(url) {
  if (!url) return null;
  // Extract from URLs like: .../r/Account/001Vo000004iZUPIA2/view
  const m = url.match(/\/Account\/([A-Za-z0-9]+)/);
  return m ? m[1] : null;
}

function mapRecord(item) {
  const f = {};
  for (const [name, prop] of Object.entries(item.properties || {})) {
    f[name] = extractPropValue(prop);
  }

  const sfdcUrl = f['SFDC Account Link'] || null;
  const sfdcAccountId = extractSfdcAccountId(sfdcUrl);

  return {
    notionPageId:         item.id,
    accountName:          f['Account Name'] || '',
    stage:                f['Stage'] || '',
    ehr:                  f['EHR'] || '',
    sfdcAccountLink:      sfdcUrl,
    sfdcAccountId:        sfdcAccountId,
    sourceCategory:       f['Source Category'] || '',
    sourceSubCategory:    f['Source Sub-category'] || '',
    agentsTeamOwner:      f['Agents Team Owner'] || '',
    annualRevenue:        f['Annual Revenue ($)'] ?? null,
    providers:            f['Providers #'] ?? null,
    employees:            f['Employees #'] ?? null,
    locations:            f['# of locations'] ?? null,
    estMonthlyCallVolume: f['Est. Monthly Call Volume'] ?? null,
    specialty:            f['Specialty'] || '',
    aiRationale:          f['AI Rationale'] || '',
    potentialRoeIssue:    f['Potential ROE Issue']
                            ? (Array.isArray(f['Potential ROE Issue']) ? f['Potential ROE Issue'] : [f['Potential ROE Issue']])
                            : [],
    roeFlagNotes:         f['ROE Flag Notes'] || '',
    netNewAccount:        f['Net New Account'] || false,
    notInRcmIcp:          f['Not in RCM ICP'] || false,
    contactsInSfdc:       f['# of contacts in SFDC'] ?? null,
    dateProspect:         f['Date → Prospect'] || null,
    dateOutreach:         f['Date → Outreach'] || null,
    dateDiscovery:        f['Date → Discovery'] || null,
    dateSql:              f['Date → SQL'] || null,
    dateNegotiations:     f['Date → Negotiations'] || null,
    datePilotDeployment:  f['Date → Pilot Deployment'] || null,
    dateFullDeployment:   f['Date → Full Deployment'] || null,
    dateClosedWon:        f['Date → Closed-Won'] || null,
    enrichmentNotes:      f['Enrichment Notes'] || '',
    mmEnt:                f['MM / Ent'] || '',
    priority:             f['Priority'] || '',
    division:             f['Division'] || '',
  };
}

async function main() {
  console.log('Starting Notion pipeline export…');
  const records = [];
  let cursor = undefined;
  let hasMore = true;
  let page = 0;

  while (hasMore) {
    page++;
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;

    const resp = await fetch(
      `https://api.notion.com/v1/databases/${PIPELINE_DB}/query`,
      {
        method: 'POST',
        headers: {
          Authorization:    `Bearer ${NOTION_TOKEN}`,
          'Notion-Version': '2022-06-28',
          'Content-Type':   'application/json',
        },
        body: JSON.stringify(body),
      }
    );

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Notion error ${resp.status}: ${err}`);
    }

    const data = await resp.json();
    for (const item of data.results) {
      records.push(mapRecord(item));
    }

    console.log(`  Page ${page}: fetched ${data.results.length} → total ${records.length}`);

    hasMore = data.has_more;
    cursor  = data.next_cursor;
    if (hasMore) await sleep(350);
  }

  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, JSON.stringify(records, null, 2), 'utf8');
  console.log(`\n✅ Exported ${records.length} accounts to ${OUTPUT}`);
}

main().catch(err => { console.error('FAILED:', err); process.exit(1); });
