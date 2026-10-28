// npm run eval:search — качество поиска старых записей: слова (FTS) vs смысл (эмбеддинги) vs гибрид.
// База: мини-сид + очищенный датасет ТЗ (1000 записей). Запросы — перефразировки без общих слов
// с записью («встреча по деньгам» → «…по бюджету») и запросы «мимо базы» (ждём пустой ответ).
// Метрики: Hit@1 / Hit@3 — релевантная запись первая / в тройке; «мимо» — доля правильных «ничего нет».
// Также подбирает порог T_sem для модели: перебирает значения и берёт лучший гибрид.
import fs from "node:fs";
import { parseCsv } from "./csv.js";
import { openDb } from "../server/db/index.js";
import { seedMini } from "../server/db/seed.js";
import { insertItem } from "../server/services/items.js";
import { createEmbedder, backfill } from "../server/services/embeddings.js";
import { search } from "../server/services/search.js";

// запрос → регулярка релевантных заголовков (null — в базе такого нет)
const QUERIES = [
  ["встреча по деньгам", /бюджет/i], ["финансы", /бюджет|смет|сч[её]т|бухгалтер/i],
  ["расходы", /бюджет|смет|сч[её]т/i], ["приложение для телефона", /мобильн/i],
  ["слайды для показа", /презентац/i], ["отчётность", /отч[её]т/i], ["веб-сайт", /сайт/i],
  ["соревнование программистов", /хакатон/i], ["собрание команды", /планёрк|планерк/i],
  ["техзадание", /техническое задание/i], ["фидбек", /обратную связь/i], ["отпуск", /отпуск/i],
  ["документы на подпись", /договор|акт|согласован/i], ["договорённости после встречи", /итоги встречи|протокол/i],
  ["дизайн интерфейса", /дизайнер|макет/i], ["CRM система", /CRM/i], ["анализ данных", /аналитик/i],
  ["коммерческое предложение клиенту", /коммерческое предложение/i], ["созвон с партнёрами", /Партн[её]р/i],
  ["инвестиции", /инвестор/i],
  ["полёт в космос", null], ["рецепт борща", null], ["покупка автомобиля", null], ["футбольный матч", null],
];

const TZ = "Europe/Moscow", nowSec = Math.floor(Date.parse("2026-10-21T11:30:00Z") / 1000);
const db = openDb(":memory:");
seedMini(db, "demo", { tz: TZ, nowSec });
db.transaction(() => {
  for (const r of parseCsv(fs.readFileSync("data/dataset.clean.csv", "utf8"))) {
    insertItem(db, "demo", { type: r.type, title: r.title, title_raw: r.title_raw, due_date: r.due_date || null,
      due_time: r.due_time || null, status: r.status, type_confidence: r.type_confidence, source: "dataset" }, { tz: TZ, nowSec });
  }
})();
const embedder = createEmbedder();
if (!embedder) { console.log("Эмбеддинги выключены (EMBEDDINGS=off)"); process.exit(0); }
const t0 = Date.now();
await embedder.warmup?.();
await backfill(db, embedder);
const n = db.prepare("SELECT COUNT(*) n FROM embeddings").get().n;
console.log(`Векторы: ${n} записей за ${Date.now() - t0} мс (${embedder.model})`);

async function run(mode, threshold) {
  const emb = { ...embedder, threshold };
  let h1 = 0, h3 = 0, pos = 0, neg = 0, negOk = 0;
  const misses = [];
  for (const [q, re] of QUERIES) {
    const { results } = await search(db, { userId: "demo", q, mode, embedder: emb, limit: 3 });
    const titles = results.map((r) => r.row.title);
    if (!re) { neg++; if (!titles.length) negOk++; else misses.push(`«${q}» → лишнее: ${titles[0]}`); continue; }
    pos++;
    if (titles[0] && re.test(titles[0])) h1++;
    if (titles.some((t) => re.test(t))) h3++; else misses.push(`«${q}» → ${titles[0] || "ничего"}`);
  }
  return { mode, threshold, hit1: h1 / pos, hit3: h3 / pos, neg: negOk / neg, misses, pos, negN: neg };
}

const pct = (x) => `${(100 * x).toFixed(0)}%`;
const sweep = [];
for (let t = 0.80; t <= 0.90001; t += 0.01) sweep.push(await run("hybrid", +t.toFixed(2)));
const f = (r) => r.hit3 + r.neg;                                   // качество + честное «ничего нет»
const best = sweep.reduce((a, b) => (f(b) > f(a) || (f(b) === f(a) && b.hit1 > a.hit1) ? b : a));
const rows = [await run("fts", best.threshold), await run("semantic", best.threshold), best];

const report = [
  `# Search eval — ${new Date().toISOString().slice(0, 10)}`, "",
  `База: мини-сид + датасет ТЗ (${n} записей). Запросов: ${best.pos} по смыслу + ${best.negN} «мимо базы». Модель: ${embedder.model}, порог T_sem = ${best.threshold}.`, "",
  "| Режим | Hit@1 | Hit@3 | «Ничего нет», когда нет |", "|---|---|---|---|",
  ...rows.map((r) => `| ${r.mode} | ${pct(r.hit1)} | ${pct(r.hit3)} | ${pct(r.neg)} |`), "",
  "Подбор порога (гибрид):", "", "| T_sem | Hit@1 | Hit@3 | «Ничего нет» |", "|---|---|---|---|",
  ...sweep.map((r) => `| ${r.threshold} | ${pct(r.hit1)} | ${pct(r.hit3)} | ${pct(r.neg)} |`), "",
  "## Промахи гибрида", "", ...(best.misses.length ? best.misses.map((m) => `- ${m}`) : ["Нет."]), "",
].join("\n");
const out = `docs/eval/${new Date().toISOString().slice(0, 10)}-search.md`;
fs.writeFileSync(out, report);
console.log(report);
console.log(`Отчёт: ${out}`);
