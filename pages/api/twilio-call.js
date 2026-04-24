/**
 * /api/twilio-call.js
 * Interactive AI caller — simulates a real patient using an LLM to respond
 * dynamically to whatever the Commure call center agent says.
 *
 * Flow:
 *   1. Twilio calls this endpoint with CallSid + (after first turn) SpeechResult
 *   2. We load conversation history from DB, append agent's speech
 *   3. Call OpenAI to generate a natural patient response
 *   4. Return TwiML that speaks the response and gathers the next agent turn
 */

import { Pool } from "pg";
import OpenAI from "openai";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SYSTEM_PROMPT = `You are roleplaying as a patient calling a urology practice (Arizona Urology) to become a new patient and schedule an appointment.

PATIENT DETAILS — reveal these naturally as the agent asks, do not dump all at once:
- Name: Michael Torres
- Date of birth: June 12, 1981
- Gender: Male
- Phone: 602-555-0184
- Email: michael.torres@gmail.com
- Insurance: Blue Cross Blue Shield, Group: BCB-447821, Member ID: XYZ998123401
- Insurance card address: PO Box 14500, Chicago, IL 60601
- Reason for visit: Right-sided flank pain for about a week, primary care doctor suspects kidney stones and referred me to a urologist
- Preferred provider: Dr. Pankaj Jain
- Preferred location: Goodyear
- Schedule preference: Mornings, any day next week (Mon-Fri)

BEHAVIOR RULES:
- Speak naturally like a real patient calling a doctor's office
- Only answer what was actually asked — don't volunteer all info at once
- If asked to confirm info, confirm it
- If the agent says something confusing, ask for clarification politely
- Keep responses SHORT — 1-3 sentences max per turn
- If the agent says they're connecting you to someone or putting you on hold, say "Of course, thank you"
- If the agent says goodbye, say a warm goodbye and hang up
- If the agent asks something you don't know (like a specific medical question), say you're not sure
- Sound like a normal person, not a robot reading from a form

Your first message when the agent answers: "Hi, I'd like to schedule an appointment as a new patient please."`;

export default async function handler(req, res) {
  const callSid = req.body?.CallSid || req.query?.CallSid;
  const speechResult = req.body?.SpeechResult || req.query?.SpeechResult || "";
  const callStatus = req.body?.CallStatus || "";

  // Handle call completion
  if (callStatus === "completed" || callStatus === "failed") {
    await updateSessionStatus(callSid, "completed");
    res.setHeader("Content-Type", "text/xml");
    return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`);
  }

  try {
    // Load or create session
    let session = await getSession(callSid);

    if (!session) {
      // First turn — initialize
      session = { call_sid: callSid, history: [], status: "active" };
      await createSession(callSid);
    }

    let history = session.history || [];

    // Add agent's speech to history (if any)
    if (speechResult && speechResult.trim()) {
      history.push({ role: "user", content: speechResult.trim() });
    }

    // Generate patient response via LLM
    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...history,
    ];

    // If no history yet (first turn), seed with the opening line
    if (history.length === 0) {
      history.push({ role: "assistant", content: "Hi, I'd like to schedule an appointment as a new patient please." });
      await saveHistory(callSid, history);
      return respondWithTwiml(res, "Hi, I'd like to schedule an appointment as a new patient please.", callSid);
    }

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      max_tokens: 150,
      temperature: 0.7,
    });

    const reply = completion.choices[0].message.content.trim();

    // Save to history
    history.push({ role: "assistant", content: reply });
    await saveHistory(callSid, history);

    // Check if we should hang up
    const hangupPhrases = ["goodbye", "have a good", "take care", "thank you, bye", "thanks, bye", "have a great"];
    const shouldHangup = hangupPhrases.some(p => reply.toLowerCase().includes(p)) && history.length > 6;

    return respondWithTwiml(res, reply, callSid, shouldHangup);

  } catch (err) {
    console.error("twilio-call error:", err);
    // Fallback — say something neutral and keep gathering
    return respondWithTwiml(res, "I'm sorry, could you repeat that?", callSid);
  }
}

function respondWithTwiml(res, text, callSid, hangup = false) {
  const webhookUrl = `https://prospector-dashboard-tau.vercel.app/api/twilio-call`;
  const safeText = escapeXml(text);

  let twiml;
  if (hangup) {
    twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Pause length="1"/>
  <Say voice="Polly.Matthew" language="en-US">${safeText}</Say>
  <Pause length="2"/>
  <Hangup/>
</Response>`;
  } else {
    twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Pause length="1"/>
  <Say voice="Polly.Matthew" language="en-US">${safeText}</Say>
  <Gather input="speech" timeout="10" speechTimeout="2" action="${webhookUrl}" method="POST">
    <Pause length="1"/>
  </Gather>
  <Redirect method="POST">${webhookUrl}</Redirect>
</Response>`;
  }

  res.setHeader("Content-Type", "text/xml");
  return res.status(200).send(twiml);
}

// ── DB helpers ────────────────────────────────────────────────────────────────

async function getSession(callSid) {
  if (!callSid) return null;
  const r = await pool.query("SELECT * FROM call_sessions WHERE call_sid = $1", [callSid]);
  return r.rows[0] || null;
}

async function createSession(callSid) {
  await pool.query(
    "INSERT INTO call_sessions (call_sid, persona, history, status) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING",
    [callSid, "michael_torres_new_patient", JSON.stringify([]), "active"]
  );
}

async function saveHistory(callSid, history) {
  await pool.query(
    "UPDATE call_sessions SET history = $1, updated_at = NOW() WHERE call_sid = $2",
    [JSON.stringify(history), callSid]
  );
}

async function updateSessionStatus(callSid, status) {
  if (!callSid) return;
  await pool.query(
    "UPDATE call_sessions SET status = $1, updated_at = NOW() WHERE call_sid = $2",
    [status, callSid]
  );
}

function escapeXml(str) {
  return (str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
