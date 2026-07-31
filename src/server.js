require("dotenv").config();
const path = require("path");
const express = require("express");
const cors = require("cors");
const { ObjectId } = require("mongodb");
const { connect, getTrackerDb } = require("./db");
const watcher = require("./watcher");
const { validate } = require("./schemaValidator");

function getByPath(document, path) {
  if (!document || !path || path.includes("*")) return undefined;
  return path.split(".").reduce((value, segment) => {
    if (value === null || value === undefined) return undefined;
    return value[segment];
  }, document);
}

function pathMatches(pattern, field) {
  if (pattern === field) return true;
  const escaped = pattern
    .split(".")
    .map((part) => (part === "*" ? "[^.]+" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("\\.");
  return new RegExp(`^${escaped}$`).test(field);
}

function valuesEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function getChangedField(event, path) {
  return (event.changedFields || []).find((field) => pathMatches(path, field.field));
}

function validateExpectedChange(event, expectation) {
  const changedField = getChangedField(event, expectation.path);
  const actualAfter = changedField ? changedField.after : getByPath(event.after, expectation.path);
  const actualBefore = changedField ? changedField.before : getByPath(event.before, expectation.path);
  const operator = expectation.operator || "equals";

  if (!changedField && operator !== "exists") {
    return { ok: false, type: "missing-change", path: expectation.path, message: "field did not change" };
  }

  if (Object.prototype.hasOwnProperty.call(expectation, "before") && !valuesEqual(actualBefore, expectation.before)) {
    return { ok: false, type: "wrong-before", path: expectation.path, expected: expectation.before, actual: actualBefore };
  }

  if (operator === "changed") return { ok: true, path: expectation.path };
  if (operator === "exists") {
    const exists = actualAfter !== undefined && actualAfter !== null;
    return exists ? { ok: true, path: expectation.path } : { ok: false, type: "missing-value", path: expectation.path };
  }
  if (operator === "notEquals") {
    return !valuesEqual(actualAfter, expectation.after)
      ? { ok: true, path: expectation.path }
      : { ok: false, type: "wrong-value", path: expectation.path, expected: `not ${JSON.stringify(expectation.after)}`, actual: actualAfter };
  }

  return valuesEqual(actualAfter, expectation.after)
    ? { ok: true, path: expectation.path }
    : { ok: false, type: "wrong-value", path: expectation.path, expected: expectation.after, actual: actualAfter };
}

function validateAgainstTemplate(event, template) {
  const errors = [];

  if (template.schema) {
    if (!event.after) {
      errors.push({ path: "(root)", message: "This event has no resulting document (e.g. a delete)", type: "schema" });
    } else {
      const schemaResult = validate(event.after, template.schema);
      errors.push(...schemaResult.errors.map((error) => ({ ...error, type: "schema" })));
    }
  }

  for (const path of template.requiredChangedPaths || []) {
    if (!getChangedField(event, path)) {
      errors.push({ path, message: "required field did not change", type: "missing-change" });
    }
  }

  for (const path of template.forbiddenChangedPaths || []) {
    const field = getChangedField(event, path);
    if (field) {
      errors.push({ path: field.field, message: "forbidden field changed", type: "unexpected-change" });
    }
  }

  for (const expectation of template.expectedChanges || []) {
    const result = validateExpectedChange(event, expectation);
    if (!result.ok) errors.push({ ...result, message: result.message || result.type });
  }

  return { valid: errors.length === 0, errors };
}

function buildSessionEventFilter(session) {
  const filters = session.filters || {};
  const captureGraceMs = parseInt(process.env.CAPTURE_GRACE_MS || "5000", 10);
  const endedAt = session.endedAt || new Date();
  const upperBound = new Date(new Date(endedAt).getTime() + captureGraceMs);
  const query = { timestamp: { $gte: session.startedAt, $lte: upperBound } };
  if (filters.collection) query.collection = filters.collection;
  if (filters.documentId) query.documentId = filters.documentId;
  if (filters.methodName) query.methodName = filters.methodName;
  return query;
}

async function main() {
  const { trackerDb } = await connect();
  await watcher.start();

  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use(express.static(path.join(__dirname, "..", "public")));

  // --- Live stream (SSE): dashboard subscribes to get new events without polling ---
  app.get("/api/stream", (req, res) => {
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.flushHeaders();

    const onEvent = (event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    watcher.bus.on("event", onEvent);

    req.on("close", () => watcher.bus.off("event", onEvent));
  });

  // --- Documents: grouped by collection + documentId, most recently changed first ---
  app.get("/api/documents", async (req, res) => {
    const events = trackerDb.collection("change_events");
    const pipeline = [
      { $sort: { timestamp: -1 } },
      {
        $group: {
          _id: { collection: "$collection", documentId: "$documentId" },
          lastMethodName: { $first: "$methodName" },
          lastOperationType: { $first: "$operationType" },
          lastChangedAt: { $first: "$timestamp" },
          lastSubject: { $first: "$after.Content.Subject" },
          eventCount: { $sum: 1 },
        },
      },
      { $sort: { lastChangedAt: -1 } },
      {
        $project: {
          _id: 0,
          collection: "$_id.collection",
          documentId: "$_id.documentId",
          lastMethodName: 1,
          lastOperationType: 1,
          lastChangedAt: 1,
          subject: "$lastSubject",
          eventCount: 1,
        },
      },
    ];
    const documents = await events.aggregate(pipeline).toArray();
    res.json(documents);
  });

  // --- Event timeline for one document ---
  app.get("/api/documents/:collection/:documentId/events", async (req, res) => {
    const { collection, documentId } = req.params;
    const list = await trackerDb
      .collection("change_events")
      .find({ collection, documentId })
      .sort({ timestamp: -1 })
      .toArray();
    res.json(list);
  });

  // --- Single event detail ---
  app.get("/api/events/:eventId", async (req, res) => {
    const event = await trackerDb.collection("change_events").findOne({ _id: new ObjectId(req.params.eventId) });
    if (!event) return res.status(404).json({ error: "Event not found" });
    res.json(event);
  });

  // --- Templates: JSON Schemas used to validate a document's shape ---
  app.get("/api/templates", async (req, res) => {
    const { collection } = req.query;
    const filter = collection ? { collection } : {};
    const templates = await trackerDb.collection("templates").find(filter).toArray();
    res.json(templates);
  });

  app.post("/api/templates", async (req, res) => {
    const { name, collection, actionName, description, schema, expectedChanges, requiredChangedPaths, forbiddenChangedPaths } = req.body;
    if (!name || !collection) {
      return res.status(400).json({ error: "name and collection are required" });
    }
    await trackerDb
      .collection("templates")
      .updateOne(
        { name, collection },
        { $set: { name, collection, actionName, description, schema, expectedChanges, requiredChangedPaths, forbiddenChangedPaths } },
        { upsert: true }
      );
    res.json({ ok: true });
  });

  app.delete("/api/templates/:id", async (req, res) => {
    await trackerDb.collection("templates").deleteOne({ _id: new ObjectId(req.params.id) });
    res.json({ ok: true });
  });

  // --- Capture windows: group events produced while testing one frontend action ---
  app.get("/api/action-sessions", async (req, res) => {
    const sessions = await trackerDb.collection("action_sessions").find({}).sort({ startedAt: -1 }).limit(50).toArray();
    res.json(sessions);
  });

  app.post("/api/action-sessions/start", async (req, res) => {
    const { name, filters } = req.body;
    const session = {
      name: name || `manual-action-${new Date().toISOString()}`,
      filters: filters || {},
      status: "active",
      startedAt: new Date(),
      endedAt: null,
    };
    const { insertedId } = await trackerDb.collection("action_sessions").insertOne(session);
    res.json({ ...session, _id: insertedId });
  });

  app.post("/api/action-sessions/:id/end", async (req, res) => {
    const endedAt = new Date();
    await trackerDb
      .collection("action_sessions")
      .updateOne({ _id: new ObjectId(req.params.id) }, { $set: { status: "ended", endedAt } });
    const session = await trackerDb.collection("action_sessions").findOne({ _id: new ObjectId(req.params.id) });
    res.json(session);
  });

  app.get("/api/action-sessions/:id/events", async (req, res) => {
    const session = await trackerDb.collection("action_sessions").findOne({ _id: new ObjectId(req.params.id) });
    if (!session) return res.status(404).json({ error: "Action session not found" });
    const events = await trackerDb
      .collection("change_events")
      .find(buildSessionEventFilter(session))
      .sort({ timestamp: 1 })
      .toArray();
    res.json({ session, events });
  });

  app.post("/api/action-sessions/:id/validate", async (req, res) => {
    const { templateId } = req.body;
    const session = await trackerDb.collection("action_sessions").findOne({ _id: new ObjectId(req.params.id) });
    if (!session) return res.status(404).json({ error: "Action session not found" });
    const template = await trackerDb.collection("templates").findOne({ _id: new ObjectId(templateId) });
    if (!template) return res.status(404).json({ error: "Template not found" });
    const events = await trackerDb.collection("change_events").find(buildSessionEventFilter(session)).sort({ timestamp: 1 }).toArray();
    const results = events.map((event) => ({ eventId: event._id, ...validateAgainstTemplate(event, template) }));
    res.json({ valid: results.length > 0 && results.every((result) => result.valid), results });
  });

  // --- Validate an event's resulting document and field diff against a chosen template ---
  app.post("/api/events/:eventId/validate", async (req, res) => {
    const { templateId } = req.body;
    const event = await trackerDb.collection("change_events").findOne({ _id: new ObjectId(req.params.eventId) });
    if (!event) return res.status(404).json({ error: "Event not found" });
    const template = await trackerDb.collection("templates").findOne({ _id: new ObjectId(templateId) });
    if (!template) return res.status(404).json({ error: "Template not found" });

    res.json(validateAgainstTemplate(event, template));
  });

  const port = process.env.PORT || 4400;
  app.listen(port, () => console.log(`[server] mongo-change-tracker listening on http://localhost:${port}`));
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
