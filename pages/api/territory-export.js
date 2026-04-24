import { query } from '../../lib/db';
import * as XLSX from 'xlsx';

const AGENTS_TEAM_REPS = ['Gray Hoffman', 'Andrew Sapien', 'Neha Bhongir', 'Manish Allamsetti', 'Adam Kelleher', 'Arya Davey', 'Zareen Tabibzadegan'];

export default async function handler(req, res) {
  const { territory } = req.query;
  if (!territory) return res.status(400).json({ error: 'territory required' });

  const isAll = territory === 'all';
  const terrParam = isAll ? null : territory;

  try {
    // Sheet 1: Accounts
    const accountsResult = await query(
      `SELECT
        a.name AS "Account Name",
        a.territory AS "Territory",
        a.ehr_system AS "EHR",
        a.num_employees AS "Employees",
        a.num_providers AS "Providers",
        a.agents_stage AS "Stage",
        a.source_sub_category AS "Campaign",
        a.billing_city AS "City",
        a.billing_state AS "State",
        a.sfdc_id AS "SFDC ID"
      FROM accounts a
      WHERE a.territory IS NOT NULL
        ${terrParam ? 'AND a.territory = $1' : ''}
      ORDER BY a.territory, a.name`,
      terrParam ? [terrParam] : []
    );

    // Sheet 2: Contacts
    const contactsResult = await query(
      `SELECT
        c.first_name AS "First Name",
        c.last_name AS "Last Name",
        c.title AS "Title",
        c.email AS "Email",
        c.phone AS "Phone",
        a.name AS "Account Name",
        a.territory AS "Territory",
        a.ehr_system AS "EHR",
        c.sfdc_id AS "Contact SFDC ID"
      FROM contacts c
      JOIN accounts a ON c.account_id = a.id
      WHERE a.territory IS NOT NULL
        ${terrParam ? 'AND a.territory = $1' : ''}
      ORDER BY a.territory, a.name, c.last_name`,
      terrParam ? [terrParam] : []
    );

    // Sheet 3: Activity (last 90d, agents team, outreach only)
    const activityResult = await query(
      `SELECT
        act.activity_date::date AS "Date",
        act.type AS "Type",
        act.rep AS "Rep",
        COALESCE(c.first_name || ' ' || c.last_name, act.contact_sfdc_id) AS "Contact",
        a.name AS "Account",
        a.territory AS "Territory",
        act.outcome AS "Outcome"
      FROM activities act
      JOIN accounts a ON act.account_sfdc_id = a.sfdc_id
      LEFT JOIN contacts c ON act.contact_sfdc_id = c.sfdc_id
      WHERE a.territory IS NOT NULL
        AND act.source_system = 'outreach'
        AND act.rep = ANY($1)
        AND act.activity_date >= NOW() - INTERVAL '90 days'
        ${terrParam ? 'AND a.territory = $2' : ''}
      ORDER BY act.activity_date DESC, a.territory`,
      terrParam ? [AGENTS_TEAM_REPS, terrParam] : [AGENTS_TEAM_REPS]
    );

    // Build workbook
    const wb = XLSX.utils.book_new();

    const ws1 = XLSX.utils.json_to_sheet(accountsResult.rows);
    XLSX.utils.book_append_sheet(wb, ws1, 'Accounts');

    const ws2 = XLSX.utils.json_to_sheet(contactsResult.rows);
    XLSX.utils.book_append_sheet(wb, ws2, 'Contacts');

    const ws3 = XLSX.utils.json_to_sheet(activityResult.rows);
    XLSX.utils.book_append_sheet(wb, ws3, 'Activity');

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const filename = isAll ? 'territory-all.xlsx' : `territory-${territory}.xlsx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buf);
  } catch (err) {
    console.error('territory-export error:', err);
    res.status(500).json({ error: err.message });
  }
}
