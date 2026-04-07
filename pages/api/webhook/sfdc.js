/**
 * /api/webhook/sfdc — POST
 * Receives an SFDC outbound message (XML or JSON),
 * finds the matching Notion pipeline record by account name,
 * and updates Stage + Last interaction from SFDC.
 */

const NOTION_TOKEN   = process.env.NOTION_TOKEN;
const PIPELINE_DB    = process.env.NOTION_PIPELINE_DB;

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

/** Parse SFDC outbound message — supports simple JSON or XML envelope */
function parseSfdcPayload(body) {
  if (typeof body === 'object' && body !== null) {
    // JSON payload
    return {
      accountName:   body.accountName || body.Account_Name__c || body.Name || null,
      stage:         body.stage       || body.StageName       || null,
      lastActivity:  body.lastActivity|| body.LastActivityDate|| new Date().toISOString().slice(0, 10),
    };
  }
  // XML payload — simple regex extraction
  const name  = (/<Account_Name__c>(.*?)<\/Account_Name__c>/i.exec(body) ||
                 /<Name>(.*?)<\/Name>/i.exec(body))?.[1] || null;
  const stage = (/<StageName>(.*?)<\/StageName>/i.exec(body))?.[1] || null;
  const date  = (/<LastActivityDate>(.*?)<\/LastActivityDate>/i.exec(body))?.[1]
              || new Date().toISOString().slice(0, 10);
  return { accountName: name, stage, lastActivity: date };
}

/** Find a Notion page by account name (case-insensitive exact match) */
async function findNotionPageByName(name) {
  const resp = await fetch(
    `https://api.notion.com/v1/databases/${PIPELINE_DB}/query`,
    {
      method: 'POST',
      headers: {
        Authorization:    `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
        'Content-Type':   'application/json',
      },
      body: JSON.stringify({
        filter: {
          or: [
            { property: 'Account Name', title: { equals: name } },
            { property: 'Name',         title: { equals: name } },
          ],
        },
        page_size: 1,
      }),
    }
  );
  if (!resp.ok) return null;
  const data = await resp.json();
  return data.results?.[0] || null;
}

/** Update a Notion page's Stage and last-SFDC-interaction date */
async function updateNotionPage(pageId, stage, lastActivity) {
  const properties = {
    'Last interaction from SFDC': { date: { start: lastActivity } },
  };
  if (stage) {
    properties['Stage'] = { select: { name: stage } };
  }

  const resp = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: 'PATCH',
    headers: {
      Authorization:    `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
      'Content-Type':   'application/json',
    },
    body: JSON.stringify({ properties }),
  });
  return resp.ok;
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { accountName, stage, lastActivity } = parseSfdcPayload(req.body);
    console.log(`[sfdc webhook] Account: ${accountName} | Stage: ${stage} | Date: ${lastActivity}`);

    if (!accountName) {
      return res.status(200).json({ ok: true, message: 'No account name found — skipped' });
    }

    const page = await findNotionPageByName(accountName);
    if (!page) {
      console.log(`[sfdc webhook] No Notion record found for: ${accountName}`);
      return res.status(200).json({ ok: true, message: 'Account not found in Notion' });
    }

    const updated = await updateNotionPage(page.id, stage, lastActivity);
    console.log(`[sfdc webhook] Updated Notion page ${page.id}: ${updated}`);

    return res.status(200).json({ ok: true, pageId: page.id, updated });
  } catch (err) {
    console.error('[sfdc webhook] Error:', err);
    return res.status(200).json({ ok: true, error: err.message }); // Always 200 for webhooks
  }
}
