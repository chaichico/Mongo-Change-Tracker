const { MongoClient } = require("mongodb");

let sourceClient, trackerClient;
let sourceDb, trackerDb;

async function connect() {
  sourceClient = new MongoClient(process.env.SOURCE_MONGO_URI);
  await sourceClient.connect();
  sourceDb = sourceClient.db(process.env.SOURCE_DB_NAME);

  // Tracker can point at the same URI, we just use a different db name,
  // so a single MongoClient is reused when the URIs match.
  if (process.env.TRACKER_MONGO_URI === process.env.SOURCE_MONGO_URI) {
    trackerClient = sourceClient;
  } else {
    trackerClient = new MongoClient(process.env.TRACKER_MONGO_URI);
    await trackerClient.connect();
  }
  trackerDb = trackerClient.db(process.env.TRACKER_DB_NAME);

  await trackerDb.collection("change_events").createIndex({ collection: 1, documentId: 1, timestamp: -1 });
  await trackerDb.collection("change_events").createIndex({ timestamp: -1 });
  await trackerDb.collection("templates").createIndex({ collection: 1, name: 1 }, { unique: true });
  await trackerDb.collection("templates").createIndex({ collection: 1, actionName: 1 });
  await trackerDb.collection("action_sessions").createIndex({ startedAt: -1 });
  await trackerDb.collection("action_sessions").createIndex({ status: 1, startedAt: -1 });

  console.log(`[db] connected to source db "${sourceDb.databaseName}" and tracker db "${trackerDb.databaseName}"`);
  return { sourceDb, trackerDb };
}

function getSourceDb() {
  if (!sourceDb) throw new Error("Source DB not connected yet");
  return sourceDb;
}

function getTrackerDb() {
  if (!trackerDb) throw new Error("Tracker DB not connected yet");
  return trackerDb;
}

module.exports = { connect, getSourceDb, getTrackerDb };
