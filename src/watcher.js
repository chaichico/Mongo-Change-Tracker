const { EventEmitter } = require("events");
const { getSourceDb, getTrackerDb } = require("./db");

// Emits "event" whenever a new change_event document is stored, so the
// HTTP layer can push it to the dashboard over SSE without polling.
const bus = new EventEmitter();

// In-memory snapshot cache: collection:id -> last known document
const snapshotCache = new Map();
const cacheKey = (collection, id) => `${collection}:${id}`;
const collectionCachePrefix = (collection) => `${collection}:`;

// Per-collection watermarks for insert (last seen _id) and update (last seen updatedAt)
const lastSeenId = new Map();       // collection -> ObjectId (highest _id seen)
const lastSeenUpdated = new Map();  // collection -> Date (highest updatedAt seen)
const initializedCollections = new Set();

function getByPath(document, path) {
  if (!document || !path) return undefined;
  return path.split(".").reduce((value, segment) => {
    if (value === null || value === undefined) return undefined;
    return value[segment];
  }, document);
}

function normalizeValue(value) {
  if (value === undefined) return null;
  return value;
}

function stableStringify(value) {
  if (value === undefined) return "__undefined__";
  return JSON.stringify(value);
}

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date) && !value._bsontype;
}

function deepDiff(before, after, prefix = "") {
  if (stableStringify(before) === stableStringify(after)) return [];

  if (Array.isArray(before) && Array.isArray(after)) {
    const changed = [];
    const length = Math.max(before.length, after.length);
    for (let index = 0; index < length; index += 1) {
      const path = prefix ? `${prefix}.${index}` : String(index);
      changed.push(...deepDiff(before[index], after[index], path));
    }
    return changed;
  }

  if (Array.isArray(before) || Array.isArray(after)) {
    return prefix ? [{ field: prefix, before: normalizeValue(before), after: normalizeValue(after) }] : [];
  }

  const beforeIsObject = isPlainObject(before);
  const afterIsObject = isPlainObject(after);

  if (beforeIsObject || afterIsObject) {
    const beforeObject = beforeIsObject ? before : {};
    const afterObject = afterIsObject ? after : {};
    const fields = new Set([...Object.keys(beforeObject), ...Object.keys(afterObject)]);
    const changed = [];
    for (const field of fields) {
      if (field === "_id") continue;
      const path = prefix ? `${prefix}.${field}` : field;
      changed.push(...deepDiff(beforeObject[field], afterObject[field], path));
    }
    return changed;
  }

  if (!beforeIsObject || !afterIsObject) {
    return prefix ? [{ field: prefix, before: normalizeValue(before), after: normalizeValue(after) }] : [];
  }
}

function toDate(value) {
  if (value instanceof Date) return value;
  if (value && typeof value === "object" && typeof value.toJSDate === "function") return value.toJSDate();
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return null;
}

function pickFirst(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function getCachedKeys(collection) {
  const prefix = collectionCachePrefix(collection);
  return [...snapshotCache.keys()].filter((key) => key.startsWith(prefix));
}

async function findRelatedAction(collection, documentId, changedAt) {
  if (collection !== "Documents") return null;

  const sourceDb = getSourceDb();
  const windowMs = parseInt(process.env.ACTION_LOG_WINDOW_MS || "10000", 10);
  const changedDate = toDate(changedAt) || new Date();
  const from = new Date(changedDate.getTime() - windowMs);
  const to = new Date(changedDate.getTime() + windowMs);

  try {
    let log = await sourceDb.collection("DocumentChangeLogs").findOne(
      {
        DocumentId: documentId,
        "Audit.ChangedDate": { $gte: from, $lte: to },
      },
      { sort: { "Audit.ChangedDate": -1 } }
    );

    if (!log) {
      log = await sourceDb.collection("DocumentChangeLogs").findOne(
        { DocumentId: documentId },
        { sort: { _id: -1 } }
      );
    }

    if (!log) return null;
    return {
      methodName: pickFirst(log.Action, log.action, "unknown"),
      source: "DocumentChangeLogs",
      logId: log._id?.toString?.() || log.Id || null,
      changedDate: getByPath(log, "Audit.ChangedDate") || null,
    };
  } catch (err) {
    console.warn(`[watcher] action lookup failed for document "${documentId}":`, err.message);
    return null;
  }
}

async function saveEvent(collection, documentId, operationType, changedFields, before, after, changedAt) {
  const trackerDb = getTrackerDb();
  const action = await findRelatedAction(collection, documentId, changedAt);
  const event = {
    collection,
    documentId,
    operationType,
    methodName: action?.methodName || "unknown",
    action,
    changedFields,
    before,
    after,
    timestamp: new Date(),
  };
  const { insertedId } = await trackerDb.collection("change_events").insertOne(event);
  bus.emit("event", { ...event, _id: insertedId });
}

async function pollCollection(sourceDb, collection) {
  const updatedAtField = process.env.UPDATED_AT_FIELD || "updatedAt";
  const col = sourceDb.collection(collection);

  if (!initializedCollections.has(collection) && process.env.EMIT_INITIAL_INSERTS !== "true") {
    const newestById = await col.find({}).sort({ _id: -1 }).limit(1).toArray();
    if (newestById.length) {
      lastSeenId.set(collection, newestById[0]._id);
    }

    const newestByUpdatedAt = await col
      .find({ [updatedAtField]: { $exists: true } })
      .sort({ [updatedAtField]: -1 })
      .limit(1)
      .toArray();
    if (newestByUpdatedAt.length) {
      lastSeenUpdated.set(collection, toDate(getByPath(newestByUpdatedAt[0], updatedAtField)) || new Date());
    }

    const existing = await col.find({}).limit(parseInt(process.env.SNAPSHOT_SEED_LIMIT || "1000", 10)).toArray();
    for (const doc of existing) {
      snapshotCache.set(cacheKey(collection, doc._id.toString()), doc);
    }

    initializedCollections.add(collection);
    console.log(`[watcher] seeded ${existing.length} existing document(s) from "${collection}"`);
    return;
  }

  initializedCollections.add(collection);

  if ((process.env.POLL_SCAN_MODE || "watermark") === "full") {
    const limit = parseInt(process.env.POLL_SCAN_LIMIT || "5000", 10);
    const docs = await col.find({}).limit(limit).toArray();
    const seenKeys = new Set();

    for (const doc of docs) {
      const documentId = doc._id.toString();
      const key = cacheKey(collection, documentId);
      seenKeys.add(key);
      const previousSnapshot = snapshotCache.get(key) || null;

      if (!previousSnapshot) {
        const changedFields = deepDiff(null, doc);
        await saveEvent(collection, documentId, "insert", changedFields, null, doc, new Date());
        snapshotCache.set(key, doc);
        continue;
      }

      const changedFields = deepDiff(previousSnapshot, doc);
      if (changedFields.length > 0) {
        await saveEvent(collection, documentId, "update", changedFields, previousSnapshot, doc, new Date());
      }
      snapshotCache.set(key, doc);
    }

    for (const key of getCachedKeys(collection)) {
      if (seenKeys.has(key)) continue;
      const previousSnapshot = snapshotCache.get(key);
      const documentId = key.slice(collectionCachePrefix(collection).length);
      const changedFields = deepDiff(previousSnapshot, null);
      await saveEvent(collection, documentId, "delete", changedFields, previousSnapshot, null, new Date());
      snapshotCache.delete(key);
    }

    if (docs.length >= limit) {
      console.warn(`[watcher] full scan for "${collection}" hit POLL_SCAN_LIMIT=${limit}; some documents may not be checked.`);
    }
    return;
  }

  // --- Detect inserts: find documents with _id greater than last seen ---
  const lastId = lastSeenId.get(collection);
  const insertQuery = lastId ? { _id: { $gt: lastId } } : {};
  const newDocs = await col.find(insertQuery).sort({ _id: 1 }).toArray();

  for (const doc of newDocs) {
    const documentId = doc._id.toString();
    const key = cacheKey(collection, documentId);
    const changedFields = deepDiff(null, doc);
    const docUpdated = getByPath(doc, updatedAtField);
    await saveEvent(collection, documentId, "insert", changedFields, null, doc, docUpdated);
    snapshotCache.set(key, doc);
    lastSeenId.set(collection, doc._id);

    // seed updatedAt watermark from the inserted doc so we don't re-fire it as an update
    const docUpdatedDate = toDate(docUpdated);
    if (docUpdatedDate) {
      const cur = lastSeenUpdated.get(collection);
      if (!cur || docUpdatedDate > cur) {
        lastSeenUpdated.set(collection, docUpdatedDate);
      }
    }
  }

  // --- Detect updates: find documents whose updatedAt is newer than last seen ---
  const lastUpdated = lastSeenUpdated.get(collection);
  if (!lastUpdated) {
    // first run: seed the watermark from the current max updatedAt, don't fire events
    const newest = await col.find({ [updatedAtField]: { $exists: true } })
      .sort({ [updatedAtField]: -1 })
      .limit(1)
      .toArray();
    if (newest.length) {
      lastSeenUpdated.set(collection, toDate(getByPath(newest[0], updatedAtField)) || new Date());
      // seed snapshot cache for all existing docs (up to 500) for future diff
      const existing = await col.find({}).limit(500).toArray();
      for (const d of existing) {
        snapshotCache.set(cacheKey(collection, d._id.toString()), d);
      }
    }
    return;
  }

  const updatedDocs = await col
    .find({ [updatedAtField]: { $gt: lastUpdated } })
    .sort({ [updatedAtField]: 1 })
    .toArray();

  for (const doc of updatedDocs) {
    const documentId = doc._id.toString();
    const key = cacheKey(collection, documentId);
    const previousSnapshot = snapshotCache.get(key) || null;

    // skip if this was already handled as an insert above
    if (!previousSnapshot) {
      snapshotCache.set(key, doc);
      lastSeenUpdated.set(collection, toDate(getByPath(doc, updatedAtField)) || new Date());
      continue;
    }

    const docUpdated = getByPath(doc, updatedAtField);
    const docUpdatedDate = toDate(docUpdated) || new Date();
    const changedFields = deepDiff(previousSnapshot, doc);
    if (changedFields.length > 0) {
      await saveEvent(collection, documentId, "update", changedFields, previousSnapshot, doc, docUpdatedDate);
    }
    snapshotCache.set(key, doc);
    lastSeenUpdated.set(collection, docUpdatedDate);
  }
}

async function start() {
  const sourceDb = getSourceDb();
  const watchList = (process.env.WATCH_COLLECTIONS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (!watchList.length) {
    console.warn("[watcher] WATCH_COLLECTIONS is empty — polling mode requires explicit collection names.");
    return;
  }

  const intervalMs = parseInt(process.env.POLL_INTERVAL_MS || "3000", 10);

  console.log(
    `[watcher] polling db "${sourceDb.databaseName}" every ${intervalMs}ms` +
    ` (collections: ${watchList.join(", ")})`
  );

  // run once immediately, then on interval
  const poll = () => {
    for (const collection of watchList) {
      pollCollection(sourceDb, collection).catch((err) =>
        console.error(`[watcher] poll error on "${collection}":`, err)
      );
    }
  };

  poll();
  setInterval(poll, intervalMs);
}

module.exports = { start, bus, deepDiff };
