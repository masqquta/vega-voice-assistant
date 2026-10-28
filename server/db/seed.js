// Сид демо-данных: мини-набор из docs/06 раздел 5 (записи 201–210). Боевой датасет на 1000 записей
// импортируется скриптом scripts/import_dataset.js. Автосид при старте — только если items пуста.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureUser, insertItem } from "../services/items.js";

const SEED = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../data/seed_mini.json");

/** @returns {Map<number, number>} ref из сида → id в БД */
export function seedMini(db, userId, { tz = "Europe/Moscow", nowSec = Math.floor(Date.now() / 1000) } = {}) {
  ensureUser(db, userId, tz, nowSec);
  const refs = new Map();
  db.transaction(() => {
    for (const s of JSON.parse(fs.readFileSync(SEED, "utf8"))) {
      const row = insertItem(db, userId, { ...s, source: "dataset", type_confidence: "high", title_raw: s.title }, { tz, nowSec });
      refs.set(s.ref, row.id);
    }
  })();
  return refs;
}

export function seedIfEmpty(db, userId = "demo", opts) {
  const n = db.prepare("SELECT COUNT(*) AS n FROM items").get().n;
  return n === 0 ? seedMini(db, userId, opts) : null;
}
