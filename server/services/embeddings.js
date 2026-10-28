// Эмбеддинги для семантического поиска (docs/04 раздел 4). Основной — Yandex text-search-doc/query,
// запасной — GigaChat Embeddings. Векторы разных моделей не смешиваем: поле model в таблице.
import crypto from "node:crypto";
import { config } from "../config.js";
import { TYPE_RU } from "../domain/type.js";

const sha1 = (s) => crypto.createHash("sha1").update(s).digest("hex");

/** Текст документа: «{тип по-русски}: {title}. {notes}» — без дат, они не несут смысла запроса. */
export const docText = (row) => `${TYPE_RU[row.type] || "запись"}: ${row.title}.${row.notes ? " " + row.notes : ""}`;

function yandexEmbedder() {
  const { apiKey, folderId } = config.yandex;
  if (!apiKey || !folderId) return null;
  const call = async (model, text) => {
    const res = await fetch("https://llm.api.cloud.yandex.net/foundationModels/v1/textEmbedding", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Api-Key ${apiKey}`, "x-folder-id": folderId },
      body: JSON.stringify({ modelUri: `emb://${folderId}/${model}/latest`, text }),
      signal: AbortSignal.timeout(config.llmTimeoutMs),
    });
    if (!res.ok) throw Object.assign(new Error(`yandex embedding HTTP ${res.status}`), { status: res.status });
    return Float32Array.from((await res.json()).embedding);
  };
  return {
    model: "yandex/text-search-doc",
    embedDoc: (t) => call("text-search-doc", t),
    embedQuery: (t) => call("text-search-query", t),
  };
}

// Локальная модель (Transformers.js + ONNX): работает на самом сервере, без ключей и лимитов.
// multilingual-e5-small, q8 (~130 МБ): на русском правильно ранжирует «встреча по деньгам» → «…по бюджету».
// У e5 сходства сжаты в узкий диапазон (≈0.8–0.9), поэтому порог свой — калибровка: npm run eval:search.
const LOCAL_MODEL = "Xenova/multilingual-e5-small";
let localPipe = null;
async function localPipeline() {
  localPipe ||= import("@huggingface/transformers").then(({ pipeline, env }) => {
    env.cacheDir = config.modelCacheDir;
    return pipeline("feature-extraction", LOCAL_MODEL, { dtype: "q8" });
  });
  return localPipe;
}
function localEmbedder() {
  const embed = async (text) => Float32Array.from((await (await localPipeline())(text, { pooling: "mean", normalize: true })).data);
  const self = {
    model: "local/multilingual-e5-small",
    ready: false,                                  // пока модель грузится (на слабом CPU — минуты), поиск идёт по словам
    threshold: config.semThreshold ?? 0.82,          // подобран npm run eval:search (docs/eval/*-search.md)
    margin: 0.01,                                  // запас для «только-семантических» результатов
    embedDoc: (t) => embed(`passage: ${t}`),       // префиксы обязательны для e5
    embedQuery: (t) => embed(`query: ${t}`),
    warmup: () => localPipeline().then((p) => { self.ready = true; return p; }),
  };
  return self;
}

export function createEmbedder(kind = config.embeddings) {
  if (kind === "off") return null;
  if (kind === "yandex") return yandexEmbedder();
  return yandexEmbedder() || localEmbedder();      // есть ключ Yandex — он, иначе локальная модель
}

/** Векторы для всех записей без вектора (фоном после старта: на free-хостинге база собирается заново). */
export async function backfill(db, embedder, log = () => {}) {
  if (!embedder) return;
  const t0 = Date.now();
  const rows = db.prepare(`SELECT i.* FROM items i LEFT JOIN embeddings e ON e.item_id = i.id AND e.model = ?
    WHERE i.deleted_at IS NULL AND e.item_id IS NULL ORDER BY i.id`).all(embedder.model);
  let n = 0;
  for (const row of rows) {
    try { if (await embedItem(db, embedder, row)) n++; }
    catch (e) { log({ event: "embedding_error", item_id: row.id, error: e.message }); return; }
  }
  log({ event: "embeddings_ready", model: embedder.model, items: rows.length, computed: n, ms: Date.now() - t0 });
}

export function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

const toBlob = (v) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);
export const fromBlob = (b) => new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));

/** Считает вектор записи, если его нет или текст изменился (text_hash). */
export async function embedItem(db, embedder, row, nowSec = Math.floor(Date.now() / 1000)) {
  if (!embedder || !row) return false;
  const text = docText(row);
  const hash = sha1(text);
  const cur = db.prepare("SELECT text_hash, model FROM embeddings WHERE item_id = ?").get(row.id);
  if (cur && cur.text_hash === hash && cur.model === embedder.model) return false;
  // одинаковый текст уже посчитан (в датасете много повторов) — берём готовый вектор
  const same = db.prepare("SELECT vector FROM embeddings WHERE text_hash = ? AND model = ? LIMIT 1").get(hash, embedder.model);
  const v = same ? fromBlob(same.vector) : await embedder.embedDoc(text);
  db.prepare(`
    INSERT INTO embeddings (item_id, model, dim, vector, text_hash, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(item_id) DO UPDATE SET model = excluded.model, dim = excluded.dim, vector = excluded.vector,
      text_hash = excluded.text_hash, updated_at = excluded.updated_at`)
    .run(row.id, embedder.model, v.length, toBlob(v), hash, nowSec);
  return true;
}
