const express = require("express");
const fs = require("fs");
const path = require("path");

const router = express.Router();

const DATA_DIR = path.join(__dirname, "..", "..", "data");

function readJson(fileName) {
  const fullPath = path.join(DATA_DIR, fileName);
  if (!fs.existsSync(fullPath)) return [];
  return JSON.parse(fs.readFileSync(fullPath, "utf8"));
}

let db = {
  problems: readJson("problems.json"),
  routes: readJson("routes.json"),
  questions: readJson("questions.json"),
  tracker_items: [],
  submissions: []
};

let trackerIdCounter = 1;
let submissionsIdCounter = 1;

function interpolate(template, values) {
  return String(template || "").replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key) => {
    const value = values[key];
    if (value === undefined || value === null || String(value).trim() === "") {
      return "[to be filled]";
    }
    return String(value).trim();
  });
}

router.get("/problems", (req, res) => {
  const query = String(req.query.q || req.query.query || "").trim().toLowerCase();
  let rows = db.problems;
  if (query) {
    rows = rows.filter(p => 
      p.title.toLowerCase().includes(query) ||
      p.category.toLowerCase().includes(query) ||
      p.summary.toLowerCase().includes(query) ||
      p.keywords.toLowerCase().includes(query) ||
      p.id.toLowerCase().includes(query)
    );
  }
  rows = [...rows].sort((a, b) => a.title.localeCompare(b.title));
  res.json({ ok: true, count: rows.length, data: rows.map(r => ({...r, routeId: r.route_id})) });
});

router.get("/routes/:id", (req, res) => {
  const route = db.routes.find(r => String(r.id) === String(req.params.id));
  if (!route) {
    return res.status(404).json({ ok: false, error: "Route not found" });
  }

  const questions = db.questions
    .filter(q => String(q.route_id) === String(req.params.id))
    .sort((a, b) => a.sort_order - b.sort_order)
    .map(q => ({
      id: q.id,
      routeId: q.route_id,
      sortOrder: q.sort_order,
      prompt: q.prompt,
      questionKey: q.question_key,
      options: q.options || []
    }));

  const problems = db.problems
    .filter(p => String(p.route_id) === String(req.params.id))
    .map(p => ({...p, routeId: p.route_id}));

  res.json({
    ok: true,
    data: {
      id: route.id,
      authorityName: route.authority_name,
      portalName: route.portal_name,
      portalUrl: route.portal_url,
      helpline: route.helpline,
      department: route.department,
      checklist: route.checklist || [],
      steps: route.steps || [],
      draftTemplate: route.draft_template,
      questions,
      problems
    }
  });
});

const generateDraft = (req, res) => {
  const body = req.body || {};
  const answers = body.answers && typeof body.answers === "object" ? body.answers : body;
  const routeId = body.routeId || answers.routeId;

  let template = "Subject: Citizen grievance — {{issueType}}\n\nTo,\nThe Concerned Authority\n\nRespected Sir/Madam,\n\nI am {{complainantName}} of {{location}}.\n\nIssue: {{issueType}}\nDetails: {{description}}\n\nRelief sought: {{reliefSought}}\n\nI will file this myself on the official government portal. NyayaSetu does not submit complaints on my behalf.\n\nThank you.\n{{complainantName}}";

  if (routeId) {
    const route = db.routes.find(r => String(r.id) === String(routeId));
    if (route && route.draft_template) {
      template = route.draft_template;
    }
  }

  const draft = interpolate(template, answers);
  res.json({ ok: true, data: { draft, disclaimer: "NyayaSetu is an independent guidance layer. It does not file this text on any government portal." } });
};

router.post("/drafts/generate", generateDraft);
router.post("/drafts", generateDraft);

router.get("/tracker", (_req, res) => {
  const sorted = [...db.tracker_items].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ ok: true, count: sorted.length, data: sorted });
});

router.post("/tracker", (req, res) => {
  const body = req.body || {};
  const title = String(body.title || "").trim();
  if (!title) return res.status(400).json({ ok: false, error: "title is required" });

  const item = {
    id: trackerIdCounter++,
    title,
    category: String(body.category || "").trim(),
    referenceId: String(body.referenceId || body.reference_id || "").trim(),
    filingDate: String(body.filingDate || body.filing_date || "").trim(),
    status: String(body.status || "drafted").trim(),
    notes: String(body.notes || "").trim(),
    portalUrl: String(body.portalUrl || body.portal_url || "").trim(),
    createdAt: new Date().toISOString()
  };
  db.tracker_items.push(item);
  res.status(201).json({ ok: true, data: item });
});

// Admin Routes CRUD
router.get("/routes", (req, res) => res.json({ ok: true, count: db.routes.length, data: db.routes }));
router.post("/routes", (req, res) => { db.routes.push({...req.body, id: req.body.id || Date.now()}); res.json({ ok: true }); });
router.put("/routes/:id", (req, res) => {
  const idx = db.routes.findIndex(r => String(r.id) === String(req.params.id));
  if (idx !== -1) db.routes[idx] = { ...db.routes[idx], ...req.body };
  res.json({ ok: true });
});
router.delete("/routes/:id", (req, res) => { db.routes = db.routes.filter(r => String(r.id) !== String(req.params.id)); res.json({ ok: true }); });

// Admin Tracker CRUD
router.put("/tracker/:id", (req, res) => {
  const idx = db.tracker_items.findIndex(t => String(t.id) === String(req.params.id));
  if (idx !== -1) db.tracker_items[idx] = { ...db.tracker_items[idx], status: req.body.status || "drafted", notes: req.body.notes || "" };
  res.json({ ok: true });
});
router.delete("/tracker/:id", (req, res) => { db.tracker_items = db.tracker_items.filter(t => String(t.id) !== String(req.params.id)); res.json({ ok: true }); });

// Admin Analytics
router.get("/analytics", (req, res) => {
  const trackerByStatus = Object.entries(
    db.tracker_items.reduce((acc, curr) => { acc[curr.status] = (acc[curr.status] || 0) + 1; return acc; }, {})
  ).map(([status, count]) => ({ status, count }));

  const routesByDept = Object.entries(
    db.routes.reduce((acc, curr) => { acc[curr.department || 'Unknown'] = (acc[curr.department || 'Unknown'] || 0) + 1; return acc; }, {})
  ).map(([department, count]) => ({ department, count }));

  const problemsByCategory = Object.entries(
    db.problems.reduce((acc, curr) => { acc[curr.category || 'Unknown'] = (acc[curr.category || 'Unknown'] || 0) + 1; return acc; }, {})
  ).map(([category, count]) => ({ category, count }));

  res.json({
    ok: true,
    data: {
      totals: {
        trackerItems: db.tracker_items.length,
        routes: db.routes.length,
        problems: db.problems.length,
        questions: db.questions.length
      },
      trackerByStatus,
      routesByDept,
      problemsByCategory
    }
  });
});

// Admin Problems CRUD
router.post("/problems", (req, res) => { db.problems.push({...req.body, id: req.body.id || Date.now()}); res.json({ ok: true }); });
router.put("/problems/:id", (req, res) => {
  const idx = db.problems.findIndex(r => String(r.id) === String(req.params.id));
  if (idx !== -1) db.problems[idx] = { ...db.problems[idx], ...req.body };
  res.json({ ok: true });
});
router.delete("/problems/:id", (req, res) => { db.problems = db.problems.filter(r => String(r.id) !== String(req.params.id)); res.json({ ok: true }); });

// Admin Questions CRUD
router.get("/questions", (req, res) => res.json({ ok: true, count: db.questions.length, data: db.questions }));
router.post("/questions", (req, res) => { db.questions.push({...req.body, id: req.body.id || Date.now()}); res.json({ ok: true }); });
router.put("/questions/:id", (req, res) => {
  const idx = db.questions.findIndex(r => String(r.id) === String(req.params.id));
  if (idx !== -1) db.questions[idx] = { ...db.questions[idx], ...req.body };
  res.json({ ok: true });
});
router.delete("/questions/:id", (req, res) => { db.questions = db.questions.filter(r => String(r.id) !== String(req.params.id)); res.json({ ok: true }); });

// Submissions
router.get("/submissions", (req, res) => res.json({ ok: true, data: db.submissions.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)) }));
router.post("/submissions", (req, res) => {
  const { name, email, message, form_type } = req.body;
  if (!email || !form_type) return res.status(400).json({ ok: false, error: "email and form_type are required" });
  db.submissions.push({
    id: submissionsIdCounter++,
    name: name || null,
    email,
    message: message || null,
    form_type,
    created_at: new Date().toISOString()
  });
  res.json({ ok: true, id: submissionsIdCounter - 1 });
});

module.exports = router;
