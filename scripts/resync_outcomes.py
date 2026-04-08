#!/usr/bin/env python3
"""
Re-sync SFDC CallDisposition → activities.outcome / call_disposition / is_set
"""

import os
import sys
import requests
import psycopg2
from xml.etree import ElementTree as ET

# ── Config ──────────────────────────────────────────────────────────────────
SFDC_USERNAME    = "gray.hoffman@getathelas.com"
SFDC_PASSWORD    = "ctk0WZK*rzw@tyh!pnp"
SFDC_SECURITY_TOKEN = "zK9vAeYocFwweG6zBmKDvO2F"
SFDC_PASSWORD_FULL  = SFDC_PASSWORD + SFDC_SECURITY_TOKEN

NEON_DSN = "postgresql://neondb_owner:npg_zr6DfhL0gelj@ep-bold-leaf-an92homd.c-6.us-east-1.aws.neon.tech/neondb?sslmode=require"

# ── Disposition → outcome mapping ───────────────────────────────────────────
CONNECTED_DISPOSITIONS = {
    'Answered', 'Answered - NOT interested', 'Answered - Meeting Set',
    'Answered - Correct Contact Follow up (end sequence)',
    'Correct Contact- Follow Up Needed', 'Correct Contact Follow Up needed',
    'Correct Contact Updated', 'Demo Confirmation', 'CLM',
}
VOICEMAIL_DISPOSITIONS = {'Left Voicemail', 'LVM', 'VM', 'Left VM', 'Voicemail'}
NO_ANSWER_DISPOSITIONS = {'NO answer', 'Call - No Answer', 'Gatekeeper', 'Bad Number'}
SET_DISPOSITIONS       = {'Answered - Meeting Set', 'Demo Confirmation'}

def map_outcome(disp):
    if not disp:
        return None
    if disp in CONNECTED_DISPOSITIONS:
        return 'connected'
    if disp in VOICEMAIL_DISPOSITIONS:
        return 'voicemail'
    if disp in NO_ANSWER_DISPOSITIONS:
        return 'no_answer'
    return None

def is_set(disp):
    return disp in SET_DISPOSITIONS if disp else False

# ── SFDC SOAP login ──────────────────────────────────────────────────────────
SOAP_URL = "https://login.salesforce.com/services/Soap/u/57.0"
LOGIN_ENVELOPE = """<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                  xmlns:urn="urn:partner.soap.sforce.com">
  <soapenv:Body>
    <urn:login>
      <urn:username>{username}</urn:username>
      <urn:password>{password}</urn:password>
    </urn:login>
  </soapenv:Body>
</soapenv:Envelope>"""

def sfdc_login():
    print("Logging in to Salesforce...")
    body = LOGIN_ENVELOPE.format(username=SFDC_USERNAME, password=SFDC_PASSWORD_FULL)
    r = requests.post(SOAP_URL, data=body.encode('utf-8'),
                      headers={'Content-Type': 'text/xml; charset=utf-8',
                               'SOAPAction': 'login'}, timeout=30)
    r.raise_for_status()
    root = ET.fromstring(r.content)
    ns = {'s': 'http://schemas.xmlsoap.org/soap/envelope/',
          'p': 'urn:partner.soap.sforce.com'}
    session_id  = root.findtext('.//p:sessionId',  namespaces=ns)
    server_url  = root.findtext('.//p:serverUrl',  namespaces=ns)
    if not session_id:
        raise RuntimeError(f"Login failed: {r.text[:500]}")
    # Extract base URL
    base_url = server_url.rsplit('/services/', 1)[0]
    print(f"  Logged in. Instance: {base_url}")
    return session_id, base_url

# ── SFDC REST query ──────────────────────────────────────────────────────────
def sfdc_query(session_id, base_url, soql):
    url = f"{base_url}/services/data/v57.0/query"
    headers = {'Authorization': f'Bearer {session_id}', 'Content-Type': 'application/json'}
    records = []
    params = {'q': soql}
    while True:
        r = requests.get(url, headers=headers, params=params, timeout=60)
        if r.status_code == 400:
            print(f"  SOQL error: {r.text[:300]}")
            return []
        r.raise_for_status()
        data = r.json()
        records.extend(data.get('records', []))
        if data.get('done', True):
            break
        next_url = data.get('nextRecordsUrl')
        if not next_url:
            break
        url = base_url + next_url
        params = {}
    return records

def sfdc_query_by_ids(session_id, base_url, task_ids):
    """Query SFDC tasks in batches of 200."""
    all_records = []
    batch_size = 200
    fields = "Id,CallDisposition,CallDurationInSeconds,TaskSubtype"
    for i in range(0, len(task_ids), batch_size):
        batch = task_ids[i:i+batch_size]
        id_list = "'" + "','".join(batch) + "'"
        soql = f"SELECT {fields} FROM Task WHERE Id IN ({id_list})"
        records = sfdc_query(session_id, base_url, soql)
        all_records.extend(records)
        print(f"  Fetched batch {i//batch_size + 1}: {len(records)} tasks")
    return all_records

# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    print("=== SFDC CallDisposition re-sync ===\n")

    conn = psycopg2.connect(NEON_DSN)
    cur  = conn.cursor()

    # Ensure columns exist
    print("Adding columns if needed...")
    for ddl in [
        "ALTER TABLE activities ADD COLUMN IF NOT EXISTS call_disposition TEXT",
        "ALTER TABLE activities ADD COLUMN IF NOT EXISTS is_set BOOLEAN DEFAULT FALSE",
        "ALTER TABLE activities ADD COLUMN IF NOT EXISTS call_duration_seconds INTEGER",
        "ALTER TABLE activities ADD COLUMN IF NOT EXISTS outreach_sequence_name TEXT",
    ]:
        cur.execute(ddl)
    conn.commit()
    print("  Done.\n")

    # Load activities with SFDC task IDs
    print("Loading activities from Postgres...")
    cur.execute("""
        SELECT sfdc_id FROM activities
        WHERE sfdc_id IS NOT NULL AND source_system != 'event'
    """)
    task_ids = [r[0] for r in cur.fetchall()]
    print(f"  Found {len(task_ids)} activities with SFDC task IDs\n")

    if not task_ids:
        print("No task IDs found — nothing to sync.")
        conn.close()
        return

    # Login to SFDC
    session_id, base_url = sfdc_login()
    print()

    # Fetch from SFDC
    print(f"Fetching {len(task_ids)} tasks from SFDC in batches of 200...")
    records = sfdc_query_by_ids(session_id, base_url, task_ids)
    print(f"\n  Total fetched: {len(records)} SFDC task records\n")

    # Update Postgres
    print("Updating activities in Postgres...")
    updated = 0
    outcomes_populated = 0
    sets_count = 0

    for rec in records:
        sfdc_id  = rec.get('Id')
        disp     = rec.get('CallDisposition')
        duration = rec.get('CallDurationInSeconds')
        outcome  = map_outcome(disp)
        set_flag = is_set(disp)

        cur.execute("""
            UPDATE activities
            SET call_disposition = %s,
                outcome          = %s,
                is_set           = %s,
                call_duration_seconds = %s
            WHERE sfdc_id = %s
        """, (disp, outcome, set_flag, duration, sfdc_id))

        updated += 1
        if outcome:
            outcomes_populated += 1
        if set_flag:
            sets_count += 1

    conn.commit()
    print(f"\n  Updated: {updated} records")
    print(f"  Outcomes populated: {outcomes_populated}")
    print(f"  is_set = TRUE: {sets_count}")

    # Get breakdown by outcome
    cur.execute("""
        SELECT outcome, COUNT(*) FROM activities
        WHERE outcome IS NOT NULL
        GROUP BY outcome ORDER BY COUNT(*) DESC
    """)
    rows = cur.fetchall()
    print(f"\nOutcome breakdown:")
    outcome_stats = {}
    for outcome, cnt in rows:
        print(f"  {outcome}: {cnt}")
        outcome_stats[outcome] = cnt

    cur.close()
    conn.close()

    print("\n=== Done ===")
    return {
        'updated': updated,
        'outcomes_populated': outcomes_populated,
        'sets_count': sets_count,
        'outcome_stats': outcome_stats,
    }

if __name__ == '__main__':
    main()
