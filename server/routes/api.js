const express = require("express");
const { getDb } = require("../db/setup");

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function parseJsonColumn(value, fallback) {
  try {
    return JSON.parse(value);
  } catch (_error) {
    return fallback;
  }
}

function mapProblem(row) {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    category: row.category,
    summary: row.summary,
    keywords: row.keywords,
    routeId: row.route_id,
  };
}

function mapRoute(row, questions) {
  return {
    id: row.id,
    authorityName: row.authority_name,
    portalName: row.portal_name,
    portalUrl: row.portal_url,
    helpline: row.helpline,
    department: row.department,
    checklist: parseJsonColumn(row.checklist_json, []),
    steps: parseJsonColumn(row.steps_json, []),
    draftTemplate: row.draft_template,
    questions: (questions || []).map((question) => ({
      id: question.id,
      routeId: question.route_id,
      sortOrder: question.sort_order,
      prompt: question.prompt,
      questionKey: question.question_key,
      options: parseJsonColumn(question.options_json, []),
    })),
  };
}

function interpolate(template, values) {
  return String(template || "").replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key) => {
    const value = values[key];
    if (value === undefined || value === null || String(value).trim() === "") {
      return "[to be filled]";
    }
    return String(value).trim();
  });
}

function generateTrackingCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "NS-";
  for (let i = 0; i < 8; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

// ─────────────────────────────────────────────────────────────────────────────
// PROBLEMS — Citizen Decision Tree
// ─────────────────────────────────────────────────────────────────────────────

router.get("/problems", (req, res) => {
  const db = getDb();
  const query = String(req.query.q || req.query.query || "").trim();

  let rows;
  if (query) {
    const like = `%${query}%`;
    rows = db
      .prepare(
        `
        SELECT * FROM problems
        WHERE title LIKE @like
           OR category LIKE @like
           OR summary LIKE @like
           OR keywords LIKE @like
           OR id LIKE @like
        ORDER BY title ASC
      `
      )
      .all({ like });
  } else {
    rows = db.prepare("SELECT * FROM problems ORDER BY title ASC").all();
  }

  res.json({ ok: true, count: rows.length, data: rows.map(mapProblem) });
});

router.get("/routes/:id", (req, res) => {
  const db = getDb();
  const route = db.prepare("SELECT * FROM routes WHERE id = ?").get(req.params.id);

  if (!route) {
    res.status(404).json({ ok: false, error: "Route not found" });
    return;
  }

  const questions = db
    .prepare("SELECT * FROM questions WHERE route_id = ? ORDER BY sort_order ASC")
    .all(req.params.id);

  const relatedProblems = db
    .prepare("SELECT * FROM problems WHERE route_id = ?")
    .all(req.params.id)
    .map(mapProblem);

  res.json({
    ok: true,
    data: {
      ...mapRoute(route, questions),
      problems: relatedProblems,
    },
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// WIZARD — Citizen Decision Tree Step-Through  (POST /wizard/next)
// ─────────────────────────────────────────────────────────────────────────────

router.post("/wizard/next", (req, res) => {
  const db = getDb();
  const body = req.body || {};
  const sessionId = String(body.sessionId || "").trim();
  const answer = body.answer !== undefined ? body.answer : null;

  // Load or create session
  let session = sessionId
    ? db.prepare("SELECT * FROM wizard_sessions WHERE session_id = ?").get(sessionId)
    : null;

  if (!session) {
    // Fresh session — pick the first problem that matches a category hint, or default
    const newSessionId = `ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const categoryHint = String(body.category || "").trim();

    let routeRow = null;
    if (categoryHint) {
      routeRow = db
        .prepare("SELECT id FROM routes WHERE department LIKE ? OR authority_name LIKE ? LIMIT 1")
        .get(`%${categoryHint}%`, `%${categoryHint}%`);
    }
    if (!routeRow) {
      routeRow = db.prepare("SELECT id FROM routes LIMIT 1").get();
    }

    const routeId = routeRow ? routeRow.id : null;
    db.prepare(
      `INSERT INTO wizard_sessions (session_id, route_id, answers_json, current_step)
       VALUES (@session_id, @route_id, '{}', 0)`
    ).run({ session_id: newSessionId, route_id: routeId });

    session = db
      .prepare("SELECT * FROM wizard_sessions WHERE session_id = ?")
      .get(newSessionId);
  }

  // Save current answer
  if (answer !== null && session.route_id) {
    const questions = db
      .prepare(
        "SELECT * FROM questions WHERE route_id = ? ORDER BY sort_order ASC"
      )
      .all(session.route_id);

    const currentQ = questions[session.current_step];
    if (currentQ) {
      const answers = parseJsonColumn(session.answers_json, {});
      answers[currentQ.question_key] = answer;
      db.prepare(
        `UPDATE wizard_sessions
         SET answers_json = @answers_json,
             current_step = @current_step,
             updated_at   = datetime('now')
         WHERE session_id = @session_id`
      ).run({
        answers_json: JSON.stringify(answers),
        current_step: session.current_step + 1,
        session_id: session.session_id,
      });
      session = db
        .prepare("SELECT * FROM wizard_sessions WHERE session_id = ?")
        .get(session.session_id);
    }
  }

  // Fetch next question
  if (session.route_id) {
    const questions = db
      .prepare(
        "SELECT * FROM questions WHERE route_id = ? ORDER BY sort_order ASC"
      )
      .all(session.route_id);

    const nextQ = questions[session.current_step];
    if (nextQ) {
      return res.json({
        ok: true,
        done: false,
        sessionId: session.session_id,
        step: session.current_step,
        total: questions.length,
        question: {
          id: nextQ.id,
          prompt: nextQ.prompt,
          questionKey: nextQ.question_key,
          options: parseJsonColumn(nextQ.options_json, []),
        },
      });
    }

    // All questions answered — return route guidance
    const route = db
      .prepare("SELECT * FROM routes WHERE id = ?")
      .get(session.route_id);

    const answers = parseJsonColumn(session.answers_json, {});
    const draft = interpolate(route ? route.draft_template : "", answers);

    return res.json({
      ok: true,
      done: true,
      sessionId: session.session_id,
      answers,
      route: route ? mapRoute(route, []) : null,
      draft,
    });
  }

  // No route available
  res.json({
    ok: true,
    done: true,
    sessionId: session.session_id,
    message: "No matching guidance route found. Please contact support.",
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DRAFTS — Grievance Draft Generator
// ─────────────────────────────────────────────────────────────────────────────

const generateDraft = (req, res) => {
  const body = req.body || {};
  const answers = body.answers && typeof body.answers === "object" ? body.answers : body;
  const routeId = body.routeId || answers.routeId;
  const db = getDb();

  let template =
    "Subject: Citizen grievance — {{issueType}}\n\nTo,\nThe Concerned Authority\n\nRespected Sir/Madam,\n\nI am {{complainantName}} of {{location}}.\n\nIssue: {{issueType}}\nDetails: {{description}}\n\nRelief sought: {{reliefSought}}\n\nI will file this myself on the official government portal. NyayaSetu does not submit complaints on my behalf.\n\nThank you.\n{{complainantName}}";

  if (routeId) {
    const route = db.prepare("SELECT draft_template FROM routes WHERE id = ?").get(routeId);
    if (route && route.draft_template) {
      template = route.draft_template;
    }
  }

  const draft = interpolate(template, answers);
  res.json({
    ok: true,
    data: {
      draft,
      disclaimer:
        "NyayaSetu is an independent guidance layer. It does not file this text on any government portal.",
    },
  });
};

router.post("/drafts/generate", generateDraft);
router.post("/drafts", generateDraft);

// ─────────────────────────────────────────────────────────────────────────────
// TRACKER — Personal Grievance Tracker
// ─────────────────────────────────────────────────────────────────────────────

router.get("/tracker", (_req, res) => {
  const db = getDb();
  const rows = db
    .prepare(
      `
      SELECT id, title, category, reference_id AS referenceId, filing_date AS filingDate,
             status, notes, portal_url AS portalUrl, created_at AS createdAt
      FROM tracker_items
      ORDER BY datetime(created_at) DESC
    `
    )
    .all();

  res.json({ ok: true, count: rows.length, data: rows });
});

router.post("/tracker", (req, res) => {
  const body = req.body || {};
  const title = String(body.title || "").trim();

  if (!title) {
    res.status(400).json({ ok: false, error: "title is required" });
    return;
  }

  const db = getDb();
  const result = db
    .prepare(
      `
      INSERT INTO tracker_items (title, category, reference_id, filing_date, status, notes, portal_url)
      VALUES (@title, @category, @reference_id, @filing_date, @status, @notes, @portal_url)
    `
    )
    .run({
      title,
      category: String(body.category || "").trim(),
      reference_id: String(body.referenceId || body.reference_id || "").trim(),
      filing_date: String(body.filingDate || body.filing_date || "").trim(),
      status: String(body.status || "drafted").trim(),
      notes: String(body.notes || "").trim(),
      portal_url: String(body.portalUrl || body.portal_url || "").trim(),
    });

  const item = db
    .prepare(
      `
      SELECT id, title, category, reference_id AS referenceId, filing_date AS filingDate,
             status, notes, portal_url AS portalUrl, created_at AS createdAt
      FROM tracker_items
      WHERE id = ?
    `
    )
    .get(result.lastInsertRowid);

  res.status(201).json({ ok: true, data: item });
});

// ─────────────────────────────────────────────────────────────────────────────
// CONTACT — Citizen Inquiries
// ─────────────────────────────────────────────────────────────────────────────

router.post("/contact", (req, res) => {
  const body = req.body || {};
  const name = String(body.name || "").trim();
  const email = String(body.email || "").trim();
  const message = String(body.message || "").trim();

  if (!name || !email || !message) {
    return res.status(400).json({ ok: false, error: "name, email, and message are required" });
  }
  if (!/^\S+@\S+\.\S+$/.test(email)) {
    return res.status(400).json({ ok: false, error: "Invalid email address" });
  }

  const db = getDb();
  const result = db
    .prepare(
      `INSERT INTO contacts (name, email, field, message, agreed_terms, ip_address)
       VALUES (@name, @email, @field, @message, @agreed_terms, @ip_address)`
    )
    .run({
      name,
      email: email.toLowerCase(),
      field: String(body.field || "General Guidance Inquiry").trim(),
      message,
      agreed_terms: body.agreedTerms !== false ? 1 : 0,
      ip_address: req.ip || "",
    });

  const contact = db
    .prepare("SELECT * FROM contacts WHERE id = ?")
    .get(result.lastInsertRowid);

  res.status(201).json({ ok: true, data: contact });
});

router.get("/contact", (req, res) => {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM contacts ORDER BY datetime(created_at) DESC")
    .all();
  res.json({ ok: true, count: rows.length, data: rows });
});

router.patch("/contact/:id", (req, res) => {
  const db = getDb();
  const { status } = req.body || {};
  const allowed = ["New", "In Progress", "Responded", "Archived"];
  if (!status || !allowed.includes(status)) {
    return res.status(400).json({ ok: false, error: `status must be one of: ${allowed.join(", ")}` });
  }
  db.prepare("UPDATE contacts SET status = ? WHERE id = ?").run(status, req.params.id);
  const updated = db.prepare("SELECT * FROM contacts WHERE id = ?").get(req.params.id);
  if (!updated) return res.status(404).json({ ok: false, error: "Contact not found" });
  res.json({ ok: true, data: updated });
});

router.delete("/contact/:id", (req, res) => {
  const db = getDb();
  const result = db.prepare("DELETE FROM contacts WHERE id = ?").run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ ok: false, error: "Contact not found" });
  res.json({ ok: true, message: "Contact deleted" });
});

// ─────────────────────────────────────────────────────────────────────────────
// NEWSLETTER — Subscription Management
// ─────────────────────────────────────────────────────────────────────────────

router.post("/newsletter", (req, res) => {
  const body = req.body || {};
  const email = String(body.email || "").trim().toLowerCase();

  if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
    return res.status(400).json({ ok: false, error: "A valid email address is required" });
  }

  const db = getDb();

  // Upsert: if already subscribed, reactivate
  const existing = db.prepare("SELECT * FROM newsletters WHERE email = ?").get(email);
  if (existing) {
    db.prepare("UPDATE newsletters SET active = 1 WHERE email = ?").run(email);
    const updated = db.prepare("SELECT * FROM newsletters WHERE email = ?").get(email);
    return res.json({ ok: true, resubscribed: true, data: updated });
  }

  const result = db
    .prepare(
      `INSERT INTO newsletters (email, source_page) VALUES (@email, @source_page)`
    )
    .run({
      email,
      source_page: String(body.sourcePage || body.source_page || "Home").trim(),
    });

  const sub = db.prepare("SELECT * FROM newsletters WHERE id = ?").get(result.lastInsertRowid);
  res.status(201).json({ ok: true, data: sub });
});

router.get("/newsletter", (req, res) => {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM newsletters WHERE active = 1 ORDER BY datetime(created_at) DESC")
    .all();
  res.json({ ok: true, count: rows.length, data: rows });
});

router.delete("/newsletter/:id", (req, res) => {
  const db = getDb();
  const result = db
    .prepare("UPDATE newsletters SET active = 0 WHERE id = ?")
    .run(req.params.id);
  if (result.changes === 0)
    return res.status(404).json({ ok: false, error: "Subscriber not found" });
  res.json({ ok: true, message: "Unsubscribed successfully" });
});

// ─────────────────────────────────────────────────────────────────────────────
// FEEDBACK — Ratings & Reviews
// ─────────────────────────────────────────────────────────────────────────────

router.post("/feedback", (req, res) => {
  const body = req.body || {};
  const rating = Number(body.rating);

  if (!rating || rating < 1 || rating > 5) {
    return res.status(400).json({ ok: false, error: "rating must be a number between 1 and 5" });
  }

  const db = getDb();
  const result = db
    .prepare(
      `INSERT INTO feedback (rating, category, feedback_text, citizen_role, helpful)
       VALUES (@rating, @category, @feedback_text, @citizen_role, @helpful)`
    )
    .run({
      rating,
      category: String(body.category || "General Guidance").trim(),
      feedback_text: String(body.feedbackText || body.feedback_text || "").trim(),
      citizen_role: String(body.citizenRole || body.citizen_role || "Citizen User").trim(),
      helpful: body.helpful !== false ? 1 : 0,
    });

  const fb = db.prepare("SELECT * FROM feedback WHERE id = ?").get(result.lastInsertRowid);
  res.status(201).json({ ok: true, data: fb });
});

router.get("/feedback", (req, res) => {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM feedback ORDER BY datetime(created_at) DESC")
    .all();
  res.json({ ok: true, count: rows.length, data: rows });
});

router.delete("/feedback/:id", (req, res) => {
  const db = getDb();
  const result = db.prepare("DELETE FROM feedback WHERE id = ?").run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ ok: false, error: "Feedback not found" });
  res.json({ ok: true, message: "Feedback deleted" });
});

// ─────────────────────────────────────────────────────────────────────────────
// SUBMISSIONS — Citizen Grievance Submissions
// ─────────────────────────────────────────────────────────────────────────────

router.post("/submissions", (req, res) => {
  const body = req.body || {};
  const incidentTitle = String(body.incidentTitle || "").trim();
  const incidentDescription = String(body.incidentDescription || "").trim();

  if (!incidentTitle || !incidentDescription) {
    return res.status(400).json({
      ok: false,
      error: "incidentTitle and incidentDescription are required",
    });
  }

  const db = getDb();

  // Generate unique tracking code
  let trackingCode;
  for (let attempt = 0; attempt < 5; attempt++) {
    trackingCode = generateTrackingCode();
    const exists = db
      .prepare("SELECT id FROM submissions WHERE tracking_code = ?")
      .get(trackingCode);
    if (!exists) break;
  }

  const location = body.location || {};
  const result = db
    .prepare(
      `INSERT INTO submissions (
        tracking_code, category, citizen_name, citizen_email, citizen_phone,
        city, state, pincode,
        incident_title, incident_description, incident_date,
        opposing_party, reference_number, claimed_amount,
        official_portal_name, official_portal_url, official_portal_helpline,
        checklist_json, generated_draft, status
      ) VALUES (
        @tracking_code, @category, @citizen_name, @citizen_email, @citizen_phone,
        @city, @state, @pincode,
        @incident_title, @incident_description, @incident_date,
        @opposing_party, @reference_number, @claimed_amount,
        @official_portal_name, @official_portal_url, @official_portal_helpline,
        @checklist_json, @generated_draft, @status
      )`
    )
    .run({
      tracking_code: trackingCode,
      category: String(body.category || "Consumer Grievance & Refunds").trim(),
      citizen_name: String(body.citizenName || "Anonymous Citizen").trim(),
      citizen_email: String(body.citizenEmail || "").trim().toLowerCase(),
      citizen_phone: String(body.citizenPhone || "").trim(),
      city: String(location.city || body.city || "").trim(),
      state: String(location.state || body.state || "").trim(),
      pincode: String(location.pincode || body.pincode || "").trim(),
      incident_title: incidentTitle,
      incident_description: incidentDescription,
      incident_date: String(body.incidentDate || new Date().toISOString().slice(0, 10)).trim(),
      opposing_party: String(body.opposingPartyOrDept || "").trim(),
      reference_number: String(body.orderOrReferenceNumber || "").trim(),
      claimed_amount: Number(body.claimedAmount) || 0,
      official_portal_name: String((body.officialPortal || {}).name || "CPGRAMS / National Consumer Helpline").trim(),
      official_portal_url: String((body.officialPortal || {}).url || "https://pgportal.gov.in/").trim(),
      official_portal_helpline: String((body.officialPortal || {}).helpline || "1915 / 1800-11-4000").trim(),
      checklist_json: JSON.stringify(body.checklist || []),
      generated_draft: String(body.generatedDraftText || "").trim(),
      status: String(body.status || "Guidance Generated").trim(),
    });

  const sub = db
    .prepare("SELECT * FROM submissions WHERE id = ?")
    .get(result.lastInsertRowid);

  res.status(201).json({ ok: true, trackingCode, data: sub });
});

router.get("/submissions", (req, res) => {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM submissions ORDER BY datetime(created_at) DESC")
    .all();
  res.json({ ok: true, count: rows.length, data: rows });
});

router.get("/submissions/:trackingCode", (req, res) => {
  const db = getDb();
  const sub = db
    .prepare("SELECT * FROM submissions WHERE tracking_code = ? COLLATE NOCASE")
    .get(req.params.trackingCode.toUpperCase());
  if (!sub) return res.status(404).json({ ok: false, error: "Submission not found" });
  res.json({ ok: true, data: sub });
});

router.patch("/submissions/:trackingCode", (req, res) => {
  const db = getDb();
  const body = req.body || {};
  const allowed = ["Drafted", "Guidance Generated", "Action Pending", "Submitted to Portal", "Resolved"];
  const status = String(body.status || "").trim();
  if (status && !allowed.includes(status)) {
    return res.status(400).json({ ok: false, error: `status must be one of: ${allowed.join(", ")}` });
  }
  const sub = db
    .prepare("SELECT * FROM submissions WHERE tracking_code = ? COLLATE NOCASE")
    .get(req.params.trackingCode.toUpperCase());
  if (!sub) return res.status(404).json({ ok: false, error: "Submission not found" });

  if (status) {
    db.prepare("UPDATE submissions SET status = ? WHERE id = ?").run(status, sub.id);
  }
  if (body.notes) {
    const notes = parseJsonColumn(sub.notes_json, []);
    notes.push({ text: String(body.notes).trim(), createdAt: new Date().toISOString() });
    db.prepare("UPDATE submissions SET notes_json = ? WHERE id = ?").run(JSON.stringify(notes), sub.id);
  }
  const updated = db.prepare("SELECT * FROM submissions WHERE id = ?").get(sub.id);
  res.json({ ok: true, data: updated });
});

router.delete("/submissions/:trackingCode", (req, res) => {
  const db = getDb();
  const result = db
    .prepare("DELETE FROM submissions WHERE tracking_code = ? COLLATE NOCASE")
    .run(req.params.trackingCode.toUpperCase());
  if (result.changes === 0) return res.status(404).json({ ok: false, error: "Submission not found" });
  res.json({ ok: true, message: "Submission deleted" });
});

// ─────────────────────────────────────────────────────────────────────────────
// STATS — Admin Dashboard
// ─────────────────────────────────────────────────────────────────────────────

router.get("/stats", (req, res) => {
  const db = getDb();

  const totalContacts = db.prepare("SELECT COUNT(*) AS count FROM contacts").get().count;
  const newContacts = db.prepare("SELECT COUNT(*) AS count FROM contacts WHERE status = 'New'").get().count;
  const totalSubscribers = db.prepare("SELECT COUNT(*) AS count FROM newsletters WHERE active = 1").get().count;
  const totalFeedback = db.prepare("SELECT COUNT(*) AS count FROM feedback").get().count;
  const avgRating = db.prepare("SELECT ROUND(AVG(rating), 2) AS avg FROM feedback").get().avg || 0;
  const totalSubmissions = db.prepare("SELECT COUNT(*) AS count FROM submissions").get().count;
  const resolvedSubmissions = db
    .prepare("SELECT COUNT(*) AS count FROM submissions WHERE status = 'Resolved'")
    .get().count;
  const totalProblems = db.prepare("SELECT COUNT(*) AS count FROM problems").get().count;
  const totalRoutes = db.prepare("SELECT COUNT(*) AS count FROM routes").get().count;
  const totalTrackerItems = db.prepare("SELECT COUNT(*) AS count FROM tracker_items").get().count;

  // Category breakdown for submissions
  const categoryBreakdown = db
    .prepare(
      `SELECT category, COUNT(*) AS count FROM submissions GROUP BY category ORDER BY count DESC`
    )
    .all();

  // Recent contacts (last 5)
  const recentContacts = db
    .prepare(
      `SELECT id, name, email, field, status, created_at AS createdAt
       FROM contacts ORDER BY datetime(created_at) DESC LIMIT 5`
    )
    .all();

  res.json({
    ok: true,
    data: {
      contacts: { total: totalContacts, new: newContacts, recent: recentContacts },
      newsletter: { activeSubscribers: totalSubscribers },
      feedback: { total: totalFeedback, averageRating: avgRating },
      submissions: {
        total: totalSubmissions,
        resolved: resolvedSubmissions,
        categoryBreakdown,
      },
      knowledgeBase: { problems: totalProblems, routes: totalRoutes },
      tracker: { items: totalTrackerItems },
      generatedAt: new Date().toISOString(),
    },
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN AUTH VERIFY
// ─────────────────────────────────────────────────────────────────────────────

router.post("/admin/verify", (req, res) => {
  const { secret } = req.body || {};
  const adminSecret = process.env.ADMIN_SECRET || "";
  if (!secret || !adminSecret || secret !== adminSecret) {
    return res.status(401).json({ ok: false, error: "Invalid secret. Access denied." });
  }
  res.json({ ok: true, message: "Authenticated successfully." });
});

module.exports = router;
