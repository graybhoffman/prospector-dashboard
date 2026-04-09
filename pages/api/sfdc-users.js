/**
 * /api/sfdc-users — GET
 * SOAP-logs into Salesforce, queries active users, returns JSON list.
 *
 * Response: { users: [{ Id, Name, FirstName, LastName, Title, Department, IsActive, Username }] }
 */

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const SF_USERNAME = 'gray.hoffman@getathelas.com';
  const SF_PASSWORD = 'ctk0WZK*rzw@tyh!pnp';
  const SF_TOKEN    = 'zK9vAeYocFwweG6zBmKDvO2F';
  const LOGIN_URL   = 'https://login.salesforce.com/services/Soap/u/57.0';

  // ── Step 1: SOAP Login ────────────────────────────────────────────────────
  const loginEnvelope = `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                  xmlns:urn="urn:partner.soap.sforce.com">
  <soapenv:Body>
    <urn:login>
      <urn:username>${SF_USERNAME}</urn:username>
      <urn:password>${SF_PASSWORD}${SF_TOKEN}</urn:password>
    </urn:login>
  </soapenv:Body>
</soapenv:Envelope>`;

  let sessionId, serverUrl;

  try {
    const loginResp = await fetch(LOGIN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': 'login',
      },
      body: loginEnvelope,
    });

    const loginXml = await loginResp.text();

    if (!loginResp.ok || loginXml.includes('<faultcode>')) {
      const faultMatch = loginXml.match(/<faultstring>(.*?)<\/faultstring>/s);
      return res.status(502).json({ error: 'SFDC login failed', detail: faultMatch?.[1] || loginXml.slice(0, 500) });
    }

    const sessionMatch   = loginXml.match(/<sessionId>(.*?)<\/sessionId>/s);
    const serverUrlMatch = loginXml.match(/<serverUrl>(.*?)<\/serverUrl>/s);

    if (!sessionMatch || !serverUrlMatch) {
      return res.status(502).json({ error: 'Could not parse SFDC login response', raw: loginXml.slice(0, 1000) });
    }

    sessionId = sessionMatch[1].trim();
    serverUrl = serverUrlMatch[1].trim();
  } catch (err) {
    return res.status(502).json({ error: 'SFDC login request failed', detail: err.message });
  }

  // ── Step 2: SOQL Query ────────────────────────────────────────────────────
  const soql = 'SELECT Id, Name, FirstName, LastName, Title, Department, IsActive, Username FROM User WHERE IsActive = true ORDER BY Name';

  const queryEnvelope = `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                  xmlns:urn="urn:partner.soap.sforce.com">
  <soapenv:Header>
    <urn:CallOptions><urn:client>Watchtower</urn:client></urn:CallOptions>
    <urn:SessionHeader>
      <urn:sessionId>${sessionId}</urn:sessionId>
    </urn:SessionHeader>
  </soapenv:Header>
  <soapenv:Body>
    <urn:query>
      <urn:queryString>${soql}</urn:queryString>
    </urn:query>
  </soapenv:Body>
</soapenv:Envelope>`;

  try {
    const queryResp = await fetch(serverUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': 'query',
      },
      body: queryEnvelope,
    });

    const queryXml = await queryResp.text();

    if (!queryResp.ok || queryXml.includes('<faultcode>')) {
      const faultMatch = queryXml.match(/<faultstring>(.*?)<\/faultstring>/s);
      return res.status(502).json({ error: 'SFDC query failed', detail: faultMatch?.[1] || queryXml.slice(0, 500) });
    }

    // Parse records from SOAP XML
    const users = [];
    const recordRegex = /<records[^>]*>([\s\S]*?)<\/records>/g;
    let match;

    function extractField(xml, fieldName) {
      const regex = new RegExp(`<(?:sf:)?${fieldName}[^>]*>([\\s\\S]*?)<\\/(?:sf:)?${fieldName}>`, 'i');
      const m = xml.match(regex);
      return m ? m[1].trim() : null;
    }

    while ((match = recordRegex.exec(queryXml)) !== null) {
      const rec = match[1];
      users.push({
        Id:         extractField(rec, 'Id') || extractField(rec, 'sf:Id'),
        Name:       extractField(rec, 'Name') || extractField(rec, 'sf:Name'),
        FirstName:  extractField(rec, 'FirstName') || extractField(rec, 'sf:FirstName'),
        LastName:   extractField(rec, 'LastName') || extractField(rec, 'sf:LastName'),
        Title:      extractField(rec, 'Title') || extractField(rec, 'sf:Title'),
        Department: extractField(rec, 'Department') || extractField(rec, 'sf:Department'),
        Username:   extractField(rec, 'Username') || extractField(rec, 'sf:Username'),
      });
    }

    // If regex approach got 0, try a different namespace approach
    if (users.length === 0 && queryXml.includes('<Id>')) {
      // Try simpler field extraction
      const allRecordBlocks = queryXml.split('<records ');
      for (let i = 1; i < allRecordBlocks.length; i++) {
        const block = allRecordBlocks[i];
        function extractSimple(xml, fieldName) {
          const m = xml.match(new RegExp(`<${fieldName}>(.*?)<\/${fieldName}>`, 'i'));
          return m ? m[1].trim() : null;
        }
        users.push({
          Id:         extractSimple(block, 'Id'),
          Name:       extractSimple(block, 'Name'),
          FirstName:  extractSimple(block, 'FirstName'),
          LastName:   extractSimple(block, 'LastName'),
          Title:      extractSimple(block, 'Title'),
          Department: extractSimple(block, 'Department'),
          Username:   extractSimple(block, 'Username'),
        });
      }
    }

    return res.status(200).json({ users, count: users.length });
  } catch (err) {
    return res.status(502).json({ error: 'SFDC query request failed', detail: err.message });
  }
}
