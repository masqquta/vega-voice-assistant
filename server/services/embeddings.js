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

export function createEmbedder() {
  return yandexEmbedder();   // GigaChat Embeddings — следующий кандидат; без ключей семантика выключена
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
  const v = await embedder.embedDoc(text);
  db.prepare(`
    INSERT INTO embeddings (item_id, model, dim, vector, text_hash, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(item_id) DO UPDATE SET model = excluded.model, dim = excluded.dim, vector = excluded.vector,
      text_hash = excluded.text_hash, updated_at = excluded.updated_at`)
    .run(row.id, embedder.model, v.length, toBlob(v), hash, nowSec);
  return true;
}
