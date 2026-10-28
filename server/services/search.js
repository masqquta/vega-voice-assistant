// Гибридный поиск (docs/04 раздел 4): FTS5 по стемам + косинус по эмбеддингам, слияние RRF.
//   score(d) = w_fts / (k + rank_fts(d)) + w_sem / (k + rank_sem(d)),  k = 60, w = 1.0
// Запись проходит порог, если её нашёл FTS или cos ≥ T_sem; только-семантическая с cos < T_sem + 0.05
// считается слабой и в выдачу не идёт. Бустер +10% если все слова запроса есть в title, −10% к done.
import { cosine, fromBlob } from "./embeddings.js";
import { queryStems, stems, SYNONYMS } from "./stem.js";

export const RRF_K = 60;
export const W_FTS = 1.0;
export const W_SEM = 1.0;
export const T_SEM = 0.5;          // стартовое значение, калибруется на размеченных запросах

const typesOf = (type) => (type === "task" ? ["task", "reminder"] : type ? [type] : null);

function ftsRank(db, userId, terms, types) {
  if (!terms.length) return [];
  const expanded = [...new Set(terms.flatMap((t) => [t, ...(SYNONYMS[t] || [])]))];
  const match = expanded.map((t) => `"${t.replace(/"/g, "")}"*`).join(" OR ");
  const rows = db.prepare(`
    SELECT i.*, bm25(items_fts) AS bm
    FROM items_fts JOIN items i ON i.id = items_fts.rowid
    WHERE items_fts MATCH ? AND i.user_id = ? AND i.deleted_at IS NULL
    ORDER BY bm LIMIT 50`).all(match, userId);
  return (types ? rows.filter((r) => types.includes(r.type)) : rows).slice(0, 20);
}

async function semanticRank(db, userId, q, types, embedder) {
  const qv = await embedder.embedQuery(q);
  const rows = db.prepare(`
    SELECT i.*, e.vector FROM embeddings e JOIN items i ON i.id = e.item_id
    WHERE i.user_id = ? AND i.deleted_at IS NULL AND e.model = ?`).all(userId, embedder.model);
  return rows
    .filter((r) => !types || types.includes(r.type))
    .map((r) => ({ ...r, cos: cosine(qv, fromBlob(r.vector)) }))
    .sort((a, b) => b.cos - a.cos)
    .slice(0, 20);
}

/** Доля слов запроса (с синонимами), найденных в записи: для бустера и разбора «близких» результатов. */
function coverage(terms, row) {
  if (!terms.length) return 0;
  const have = row.search_text.split(" ");
  const hit = (t) => [t, ...(SYNONYMS[t] || [])].some((x) => have.some((h) => h.startsWith(x)));
  return terms.filter(hit).length / terms.length;
}

/**
 * @param {{userId: string, q: string, type?: string|null, mode?: "hybrid"|"fts"|"semantic", limit?: number,
 *          embedder?: object|null, status?: "open"|"done"|null}} p
 * @returns {Promise<{results: {row: object, score: number, match: "fts"|"semantic"|"both", coverage: number}[],
 *                    degraded: boolean}>}
 */
export async function search(db, { userId, q, type = null, mode = "hybrid", limit = 5, embedder = null, status = null }) {
  const terms = queryStems(q);
  const types = typesOf(type);
  let degraded = false;
  const fts = mode === "semantic" ? [] : ftsRank(db, userId, terms, types);
  let sem = [];
  if (mode !== "fts") {
    if (embedder) {
      try { sem = await semanticRank(db, userId, q, types, embedder); }
      catch (e) { if (mode === "semantic") throw Object.assign(e, { code: "UPSTREAM" }); degraded = true; }
    } else if (mode === "semantic") {
      throw Object.assign(new Error("embeddings unavailable"), { code: "UPSTREAM" });
    } else degraded = true;                     // hybrid без эмбеддингов деградирует до FTS
  }

  const byId = new Map();
  fts.forEach((r, i) => byId.set(r.id, { row: r, fts: i + 1, sem: null, cos: null }));
  sem.forEach((r, i) => {
    const cur = byId.get(r.id) || { row: r, fts: null };
    byId.set(r.id, { ...cur, sem: i + 1, cos: r.cos });
  });

  const out = [];
  const tSem = embedder?.threshold ?? T_SEM;                            // порог у каждой модели свой
  for (const c of byId.values()) {
    const semOk = c.cos != null && c.cos >= tSem;
    if (!c.fts && !(semOk && c.cos >= tSem + (embedder?.margin ?? 0.05))) continue;   // слабый только-семантический — мимо
    if (status && c.row.status !== status) continue;
    let score = (c.fts ? W_FTS / (RRF_K + c.fts) : 0) + (semOk ? W_SEM / (RRF_K + c.sem) : 0);
    const ts = stems(c.row.title);
    if (terms.length && terms.every((t) => ts.some((s) => s.startsWith(t) || (SYNONYMS[t] || []).some((x) => s.startsWith(x))))) score *= 1.1;
    if (c.row.status === "done") score *= 0.9;
    const cov = coverage(terms, c.row);
    out.push({ row: c.row, score: score * (0.5 + 0.5 * cov), match: c.fts && semOk ? "both" : c.fts ? "fts" : "semantic", coverage: cov });
  }
  out.sort((a, b) => b.score - a.score || b.row.id - a.row.id);
  return { results: out.slice(0, limit), degraded };
}

/** Результаты «на равных»: несколько записей с одинаковым покрытием запроса — нужен выбор пользователя. */
export function ambiguous(results) {
  return results.length > 1 && results[1].coverage >= results[0].coverage && results[1].score >= results[0].score * 0.9;
}
