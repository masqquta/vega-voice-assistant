// npm run seed [-- path/to/dataset.clean.csv] [--user demo]
// Импорт очищенного датасета (docs/04 раздел 5): колонки title,title_raw,type,due_date,due_time,notes,status,
// type_confidence. Считает search_text и start_utc, пишет транзакцией с source='dataset'.
// Идемпотентен: повторный запуск не дублирует (ключ — user_id + title_raw + due_date).
// Без файла датасета загружает мини-сид из docs/06 (data/seed_mini.json).
import fs from "node:fs";
import { parseCsv } from "./csv.js";
import { config } from "../server/config.js";
import { openDb } from "../server/db/index.js";
import { seedMini } from "../server/db/seed.js";
import { ensureUser, insertItem } from "../server/services/items.js";

const args = process.argv.slice(2);
const userIdx = args.indexOf("--user");
const userId = userIdx >= 0 ? args[userIdx + 1] : "demo";
const file = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--user") || "data/dataset.clean.csv";

const db = openDb(config.dbPath);
const nowSec = Math.floor(Date.now() / 1000);

if (!fs.existsSync(file)) {
  const exists = db.prepare("SELECT COUNT(*) n FROM items WHERE user_id = ? AND source = 'dataset'").get(userId).n;
  if (exists) console.log(`Датасета ${file} нет; у пользователя ${userId} уже ${exists} записей датасета — пропускаю.`);
  else console.log(`Датасета ${file} нет — загружен мини-сид: ${seedMini(db, userId, { tz: config.tzDefault, nowSec }).size} записей.`);
  process.exit(0);
}

ensureUser(db, userId, config.tzDefault, nowSec);
const rows = parseCsv(fs.readFileSync(file, "utf8"));
const exists = db.prepare("SELECT 1 FROM items WHERE user_id = ? AND title_raw IS ? AND due_date IS ? AND deleted_at IS NULL");
const stats = { inserted: 0, skipped: 0, invalid: 0 };
const errors = [];
db.transaction(() => {
  for (const [i, r] of rows.entries()) {
    const fields = {
      type: r.type || "task", title: r.title, title_raw: r.title_raw || r.title, notes: r.notes || null,
      due_date: r.due_date || null, due_time: r.due_time || null, status: r.status === "done" ? "done" : "open",
      type_confidence: r.type_confidence === "low" ? "low" : "high", source: "dataset",
    };
    if (exists.get(userId, fields.title_raw, fields.due_date)) { stats.skipped++; continue; }
    try { insertItem(db, userId, fields, { tz: config.tzDefault, nowSec }); stats.inserted++; }
    catch (e) { stats.invalid++; if (errors.length < 10) errors.push(`строка ${i + 2}: ${e.message}`); }
  }
})();
console.log(`Импорт ${file} → ${userId}: добавлено ${stats.inserted}, уже было ${stats.skipped}, отклонено ${stats.invalid}`);
for (const e of errors) console.log("  " + e);
db.close();
