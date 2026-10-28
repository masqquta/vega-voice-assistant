// SQLite (better-sqlite3): WAL, foreign_keys, миграции по возрастанию номера файла.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

export function openDb(file = ":memory:") {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

export function migrate(db) {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
  const done = new Set(db.prepare("SELECT version FROM schema_migrations").all().map((r) => r.version));
  const files = fs.readdirSync(MIGRATIONS).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
  const applied = [];
  for (const f of files) {
    const version = Number(f.split("_")[0]);
    if (done.has(version)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS, f), "utf8");
    db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(version, Math.floor(Date.now() / 1000));
    })();
    applied.push(f);
  }
  return applied;
}
