// npm run embeddings — считает эмбеддинги для записей без вектора или с изменившимся текстом.
// Пакетами с паузами (лимиты API). Нужен YANDEX_API_KEY + YANDEX_FOLDER_ID.
import { config } from "../server/config.js";
import { openDb } from "../server/db/index.js";
import { createEmbedder, embedItem } from "../server/services/embeddings.js";

const BATCH = 20, PAUSE_MS = 1000;
const embedder = createEmbedder();
if (!embedder) {
  console.log("Ключ эмбеддингов не задан (YANDEX_API_KEY, YANDEX_FOLDER_ID): поиск работает в режиме FTS.");
  process.exit(0);
}
const db = openDb(config.dbPath);
const rows = db.prepare("SELECT * FROM items WHERE deleted_at IS NULL ORDER BY id").all();
let done = 0, skipped = 0, failed = 0;
for (let i = 0; i < rows.length; i += BATCH) {
  for (const row of rows.slice(i, i + BATCH)) {
    try { (await embedItem(db, embedder, row)) ? done++ : skipped++; }
    catch (e) { failed++; console.log(`item ${row.id}: ${e.message}`); }
  }
  process.stdout.write(`\r${Math.min(i + BATCH, rows.length)}/${rows.length}`);
  if (i + BATCH < rows.length) await new Promise((r) => setTimeout(r, PAUSE_MS));
}
console.log(`\nГотово: посчитано ${done}, без изменений ${skipped}, ошибок ${failed} (модель ${embedder.model})`);
db.close();
