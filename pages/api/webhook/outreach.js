/**
 * /api/webhook/outreach — POST
 * Receives an Outreach.io webhook event, parses the prospect name
 * + event type, and updates the Last interaction from SFDC date
 * in the matching Notion pipeline record.
 *
 * Supported event types:
 *   mailbox.email.sent, mailbox.email.opened, mailbox.email.replied,
 *   call.completed, meeting.booked
 */

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const PIPELINE_DB  = process.env.NOTION_PIPELINE_DB;

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

/** Extract prospect/account name from Outreach webhook payload */
function parseOutreachPayload(body) {
  // Outreach.io webhook schema: { meta: { eventName }, data: { attributes, relationships } }
  const eventName    = body?.meta?.eventName || body?.event || 'unknown';
  const attrs        = body?.data?.attributes || body?.attributes || {};
  const prospectName = attrs?.name
                    || attrs?.companyName
                    || body?.prospect?.name
                    || body?.account?.name
                    || null;

  const activityDate = attrs?.updatedAt
                    || attrs?.createdAt
                    || body?.occurredAt
                    || new Date().toISOString().slice(0, 10);

  return { eventName, prospectName, activityDate: activityDate.slice(0, 10) };
}

/** Find a Notion page by account name */
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

/** Update Last interaction from SFDC date on a Notion page */
async function updateLastInteraction(pageId, date) {
  const resp = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: 'PATCH',
    headers: {
      Authorization:    `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
      'Content-Type':   'application/json',
    },
    body: JSON.stringify({
      properties: {
        'Last interaction from SFDC': { date: { start: date } },
      },
    }),
  });
  return resp.ok;
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { eventName, prospectName, activityDate } = parseOutreachPayload(req.body);
    console.log(`[outreach webhook] Event: ${eventName} | Prospect: ${prospectName} | Date: ${activityDate}`);

    if (!prospectName) {
      return res.status(200).json({ ok: true, message: 'No prospect name found — skipped' });
    }

    const page = await findNotionPageByName(prospectName);
    if (!page) {
      console.log(`[outreach webhook] No Notion record for: ${prospectName}`);
      return res.status(200).json({ ok: true, message: 'Prospect not found in Notion' });
    }

    const updated = await updateLastInteraction(page.id, activityDate);
    console.log(`[outreach webhook] Updated page ${page.id}: ${updated}`);

    return res.status(200).json({ ok: true, pageId: page.id, eventName, updated });
  } catch (err) {
    console.error('[outreach webhook] Error:', err);
    return res.status(200).json({ ok: true, error: err.message });
  }
}
