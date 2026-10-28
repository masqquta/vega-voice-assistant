// Точка входа: миграции → автосид при пустой БД → NLU/STT/эмбеддинги → HTTP.
import { config } from "./config.js";
import { openDb } from "./db/index.js";
import { seedIfEmpty } from "./db/seed.js";
import { createNlu } from "./nlu/adapter.js";
import { createStt } from "./stt/index.js";
import { createEmbedder } from "./services/embeddings.js";
import { createAssistant } from "./services/assistant.js";
import { createApp } from "./app.js";

// логи — JSON-строки в stdout (их собирает хостинг); стектрейс пользователю не уходит никогда
const log = (event) => console.log(JSON.stringify({ ts: new Date().toISOString(), level: "info", ...event }));

const db = openDb(config.dbPath);
if (config.seedDemo) {
  const seeded = seedIfEmpty(db, "demo", { tz: config.tzDefault });
  if (seeded) log({ event: "seeded", items: seeded.size, user: "demo" });
}
const nlu = createNlu({ log });
const stt = createStt();
const embedder = createEmbedder();
const assistant = createAssistant({ db, nlu, embedder, log });
const app = createApp({ db, assistant, nlu, stt, embedder, config, log });

app.listen(config.port, () => {
  log({
    event: "listening", port: config.port, db: config.dbPath, production: config.production,
    nlu: Object.keys(nlu.status).filter((k) => nlu.status[k] === "configured").concat("rulebased"),
    stt: stt.available() ? stt.name : "browser-fallback", embeddings: embedder ? embedder.model : "off (FTS only)",
  });
});
