#!/usr/bin/env python3
"""
sync_activities.py - Sync SFDC Tasks to Postgres activities table
Pulls last 30 days of Tasks (Call, Email, LinkedInMessage, Task subtypes)
and upserts into the activities table.
"""

import os
import sys
import time
from datetime import datetime, timezone

import psycopg2
import psycopg2.extras
from simple_salesforce import Salesforce, SalesforceAuthenticationFailed

# ── Config ──────────────────────────────────────────────────────────────────
DB_URL  = os.environ.get(
    "DATABASE_URL",
    "postgresql://neondb_owner:npg_zr6DfhL0gelj@ep-bold-leaf-an92homd.c-6.us-east-1.aws.neon.tech/neondb?sslmode=require"
)
SFDC_USER     = "gray.hoffman@getathelas.com"
SFDC_PASSWORD = "ctk0WZK*rzw@tyh!pnp"
SFDC_TOKEN    = "zK9vAeYocFwweG6zBmKDvO2F"
SFDC_INSTANCE = "https://athelas.my.salesforce.com"

SOQL = """
SELECT Id, Subject, ActivityDate, TaskSubtype, CallType,
       CallDurationInSeconds, CallDisposition, Description,
       Status, WhoId, WhatId, Who.Name, What.Name,
       OwnerId, Owner.Name, CreatedDate, LastModifiedDate
FROM Task
WHERE ActivityDate >= LAST_N_DAYS:30
AND TaskSubtype IN ('Call', 'Email', 'LinkedInMessage', 'Task')
ORDER BY ActivityDate DESC
LIMIT 5000
"""

# ── Helpers ──────────────────────────────────────────────────────────────────

def map_subtype(subtype, subject):
    """Map SFDC TaskSubtype to our type values."""
    if subtype in ("Call",):
        return "call"
    if subtype in ("Email",):
        return "email"
    if subtype in ("LinkedInMessage",):
        return "linkedin"
    if subtype in ("Task",):
        return "task"
    # Fallback: infer from subject
    if subject:
        sl = subject.lower()
        if "call" in sl:
            return "call"
        if "email" in sl:
            return "email"
        if "linkedin" in sl or "li" in sl:
            return "linkedin"
    return "task"


def build_account_index(cur):
    """Return {sfdc_id: sfdc_id} mapping for accounts (sfdc_id → sfdc_id, just for lookup)."""
    cur.execute("SELECT sfdc_id FROM accounts WHERE sfdc_id IS NOT NULL")
    return {row[0] for row in cur.fetchall()}


def build_contact_index(cur):
    """Return set of known contact sfdc_ids."""
    cur.execute("SELECT sfdc_id FROM contacts WHERE sfdc_id IS NOT NULL")
    return {row[0] for row in cur.fetchall()}


# ── Main ─────────────────────────────────────────────────────────────────────

def run_sync():
    started = datetime.now(timezone.utc)
    print(f"[{started.isoformat()}] Starting SFDC → Postgres activities sync…")

    # 1. Connect to SFDC
    print("  Connecting to Salesforce…")
    try:
        sf = Salesforce(
            username=SFDC_USER,
            password=SFDC_PASSWORD,
            security_token=SFDC_TOKEN,
            instance_url=SFDC_INSTANCE,
        )
        print("  ✓ Salesforce connected")
    except SalesforceAuthenticationFailed as e:
        print(f"  ✗ SFDC auth failed: {e}")
        sys.exit(1)

    # 2. Query SFDC
    print("  Querying Tasks (last 30 days)…")
    result = sf.query_all(SOQL)
    records = result["records"]
    print(f"  ✓ Got {len(records)} records from SFDC")

    if not records:
        print("  No records to sync. Done.")
        return

    # 3. Connect to Postgres
    print("  Connecting to Postgres…")
    conn = psycopg2.connect(DB_URL)
    cur  = conn.cursor()
    print("  ✓ Postgres connected")

    # 4. Build lookup indexes
    account_sfdc_ids = build_account_index(cur)
    contact_sfdc_ids = build_contact_index(cur)
    print(f"  Account index: {len(account_sfdc_ids)} entries")
    print(f"  Contact index: {len(contact_sfdc_ids)} entries")

    # 5. Upsert
    UPSERT_SQL = """
        INSERT INTO activities (
            sfdc_id, account_sfdc_id, contact_sfdc_id,
            type, subject, activity_date,
            outcome, notes, rep,
            source_system, call_duration_seconds,
            call_disposition, created_at
        ) VALUES (
            %(sfdc_id)s, %(account_sfdc_id)s, %(contact_sfdc_id)s,
            %(type)s, %(subject)s, %(activity_date)s,
            %(outcome)s, %(notes)s, %(rep)s,
            'sfdc', %(call_duration_seconds)s,
            %(call_disposition)s, NOW()
        )
        ON CONFLICT (sfdc_id) DO UPDATE SET
            account_sfdc_id     = EXCLUDED.account_sfdc_id,
            contact_sfdc_id     = EXCLUDED.contact_sfdc_id,
            type                = EXCLUDED.type,
            subject             = EXCLUDED.subject,
            activity_date       = EXCLUDED.activity_date,
            outcome             = EXCLUDED.outcome,
            notes               = EXCLUDED.notes,
            rep                 = EXCLUDED.rep,
            call_duration_seconds = EXCLUDED.call_duration_seconds,
            call_disposition    = EXCLUDED.call_disposition,
            source_system       = 'sfdc'
    """

    synced = 0
    errors = 0
    batch  = []

    for rec in records:
        try:
            what_id = rec.get("WhatId")
            who_id  = rec.get("WhoId")

            # Only link if we have the account/contact in our DB
            account_sfdc_id = what_id if what_id and what_id in account_sfdc_ids else None
            contact_sfdc_id = who_id  if who_id  and who_id  in contact_sfdc_ids else None

            # Parse ActivityDate (can be date string or None)
            act_date = rec.get("ActivityDate")
            if act_date and isinstance(act_date, str):
                try:
                    act_date = datetime.strptime(act_date, "%Y-%m-%d")
                except ValueError:
                    act_date = None

            # Owner.Name via relationship
            owner_name = None
            owner_rel  = rec.get("Owner")
            if owner_rel and isinstance(owner_rel, dict):
                owner_name = owner_rel.get("Name")

            row = {
                "sfdc_id":               rec["Id"],
                "account_sfdc_id":       account_sfdc_id,
                "contact_sfdc_id":       contact_sfdc_id,
                "type":                  map_subtype(rec.get("TaskSubtype"), rec.get("Subject")),
                "subject":               (rec.get("Subject") or "")[:500],
                "activity_date":         act_date,
                "outcome":               rec.get("CallDisposition"),
                "notes":                 (rec.get("Description") or "")[:2000] if rec.get("Description") else None,
                "rep":                   owner_name,
                "call_duration_seconds": rec.get("CallDurationInSeconds"),
                "call_disposition":      rec.get("CallDisposition"),
            }
            batch.append(row)

        except Exception as e:
            print(f"  ✗ Row error for {rec.get('Id', '?')}: {e}")
            errors += 1
            continue

        # Flush every 500
        if len(batch) >= 500:
            try:
                psycopg2.extras.execute_batch(cur, UPSERT_SQL, batch, page_size=500)
                conn.commit()
                synced += len(batch)
                print(f"  … {synced} upserted so far…")
                batch = []
            except Exception as e:
                print(f"  ✗ Batch error: {e}")
                conn.rollback()
                errors += len(batch)
                batch = []

    # Final flush
    if batch:
        try:
            psycopg2.extras.execute_batch(cur, UPSERT_SQL, batch, page_size=500)
            conn.commit()
            synced += len(batch)
        except Exception as e:
            print(f"  ✗ Final batch error: {e}")
            conn.rollback()
            errors += len(batch)

    # 6. Write sync_log
    completed = datetime.now(timezone.utc)
    try:
        cur.execute(
            """
            INSERT INTO sync_log (table_name, sync_type, completed_at, records_synced, errors, started_at)
            VALUES ('activities', 'incremental_30d', %s, %s, %s, %s)
            """,
            (completed, synced, errors, started)
        )
        conn.commit()
        print(f"  ✓ sync_log written")
    except Exception as e:
        print(f"  ✗ sync_log error: {e}")
        conn.rollback()

    cur.close()
    conn.close()

    elapsed = (completed - started).total_seconds()
    print(f"\n✅ Sync complete: {synced} upserted, {errors} errors ({elapsed:.1f}s)")
    return synced, errors


if __name__ == "__main__":
    run_sync()
