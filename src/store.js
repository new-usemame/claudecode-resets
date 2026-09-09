import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, "..");
const SEED_PATH = join(REPO_ROOT, "data", "resets.json");

/**
 * Everything durable lives in one SQLite file. On Railway that file sits on the
 * attached volume (DATA_DIR); locally it lands in ./data. The committed
 * data/resets.json is the curated backfill and is re-applied on every boot, so a
 * corrected announcement in git wins over whatever the fetcher guessed earlier.
 */
export function openDb(dataDir = process.env.DATA_DIR || join(REPO_ROOT, "data")) {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, "resets.db"));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS events (
      id            TEXT PRIMARY KEY,
      kind          TEXT NOT NULL,               -- reset | policy
      reset_type    TEXT,                        -- full | partial | NULL for policy
      scope         TEXT,
      announced_at  TEXT NOT NULL,               -- ISO-8601 UTC
      text          TEXT NOT NULL,
      author        TEXT NOT NULL,
      url           TEXT NOT NULL,
      verification  TEXT NOT NULL DEFAULT 'provisional',
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS events_announced ON events(announced_at DESC);

    CREATE TABLE IF NOT EXISTS push_subs (
      endpoint   TEXT PRIMARY KEY,
      p256dh     TEXT NOT NULL,
      auth       TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS email_subs (
      email        TEXT PRIMARY KEY,
      token        TEXT NOT NULL,
      confirmed_at TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS notified (
      event_id TEXT NOT NULL,
      channel  TEXT NOT NULL,
      sent_at  TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (event_id, channel)
    );

    CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
  `);
  seed(db);
  return db;
}

function seed(db) {
  let doc;
  try {
    doc = JSON.parse(readFileSync(SEED_PATH, "utf8"));
  } catch {
    return; // no seed file is not fatal
  }
  const up = db.prepare(`
    INSERT INTO events (id, kind, reset_type, scope, announced_at, text, author, url, verification)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'curated')
    ON CONFLICT(id) DO UPDATE SET
      kind = excluded.kind, reset_type = excluded.reset_type, scope = excluded.scope,
      announced_at = excluded.announced_at, text = excluded.text, author = excluded.author,
      url = excluded.url, verification = 'curated'
  `);
  for (const e of doc.events ?? []) {
    up.run(e.id, e.kind, e.reset_type ?? null, e.scope ?? null,
           e.announced_at, e.text, e.source?.author ?? "ClaudeDevs", e.source?.url ?? "");
  }
}

export const allEvents = (db) =>
  db.prepare(`SELECT * FROM events ORDER BY announced_at DESC`).all();

export const resets = (db) =>
  db.prepare(`SELECT * FROM events WHERE kind = 'reset' ORDER BY announced_at DESC`).all();

export function insertEvent(db, e) {
  const r = db.prepare(`
    INSERT INTO events (id, kind, reset_type, scope, announced_at, text, author, url, verification)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `).run(e.id, e.kind, e.reset_type ?? null, e.scope ?? null, e.announced_at,
         e.text, e.author, e.url, e.verification ?? "provisional");
  return r.changes > 0;
}

export const getKv = (db, k) =>
  db.prepare(`SELECT v FROM kv WHERE k = ?`).get(k)?.v ?? null;

export const setKv = (db, k, v) =>
  db.prepare(`INSERT INTO kv (k, v) VALUES (?, ?)
              ON CONFLICT(k) DO UPDATE SET v = excluded.v`).run(k, String(v));

export const markNotified = (db, eventId, channel) =>
  db.prepare(`INSERT INTO notified (event_id, channel) VALUES (?, ?)
              ON CONFLICT DO NOTHING`).run(eventId, channel).changes > 0;

export const wasNotified = (db, eventId, channel) =>
  !!db.prepare(`SELECT 1 FROM notified WHERE event_id = ? AND channel = ?`).get(eventId, channel);
