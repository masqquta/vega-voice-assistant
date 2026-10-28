// npm run eval:nlu [-- docs/eval/phrases.csv] — метрика «точность понимания» (docs/06 раздел 7).
// Формат набора: id,phrase,context,expected_intent,expected_slots,category,needs_clarification
//   context          — пусто или «after:<фраза>[ | <фраза>]» (реплики до проверяемой, в той же сессии);
//   expected_slots   — JSON с резолвнутыми значениями: type, title, due_date, due_time, duration_min,
//                      period_from, period_to, first_title, missing;
//   needs_clarification — true/false.
// Фраза пройдена, если совпал intent, все ожидаемые слоты и решение «нужно ли уточнение».
// Прогон на фиксированном NOW = 2026-10-21T14:30+03:00 (Europe/Moscow). Без ключей LLM — слой RuleBased.
import fs from "node:fs";
import { parseCsv } from "./csv.js";
import { openDb } from "../server/db/index.js";
import { seedMini } from "../server/db/seed.js";
import { createNlu } from "../server/nlu/adapter.js";
import { createAssistant } from "../server/services/assistant.js";
import { nowIn } from "../server/dates/resolver.js";

const FILE = process.argv.slice(2).find((a) => !a.startsWith("--")) || "docs/eval/phrases.csv";
const TZ = "Europe/Moscow";
const NOW = nowIn(TZ, "2026-10-21T14:30:00+03:00");

const nlu = createNlu();
const rows = parseCsv(fs.readFileSync(FILE, "utf8"));
const results = [];

for (const r of rows) {
  const db = openDb(":memory:");
  seedMini(db, "eval", { tz: TZ, nowSec: Math.floor(NOW.toSeconds()) });
  let intent = null;
  const spy = { status: nlu.status, parse: async (n, c) => { const x = await nlu.parse(n, c); intent = x.intent; return x; } };
  const a = createAssistant({ db, nlu: spy });
  const say = (text) => a.handle({ requestId: "eval", userId: "eval", sessionId: "s", text, tz: TZ, now: NOW });
  for (const pre of (r.context.match(/^after:(.*)$/)?.[1] || "").split("|").map((s) => s.trim()).filter(Boolean)) await say(pre);
  const t0 = Date.now();
  const out = await say(r.phrase);
  const latency = Date.now() - t0;
  const exp = r.expected_slots ? JSON.parse(r.expected_slots) : {};
  const it = out.data?.item || {};
  const got = {
    type: it.type, title: it.title, due_date: it.due_date, due_time: it.due_time, duration_min: it.duration_min,
    period_from: out.data?.period?.from, period_to: out.data?.period?.to,
    first_title: out.data?.results?.[0]?.item?.title ?? out.data?.items?.[0]?.title,
    missing: out.missing_slots,
  };
  const slotErrors = Object.entries(exp).filter(([k, v]) => JSON.stringify(got[k] ?? null) !== JSON.stringify(v)).map(([k, v]) => `${k}: ждали ${JSON.stringify(v)}, получили ${JSON.stringify(got[k] ?? null)}`);
  const needs = out.status === "need_clarification";
  const expNeeds = r.needs_clarification === "true";
  // clarify_answer — это ответ на уточнение; итоговое действие сверяем по action
  const intentOk = intent === r.expected_intent || (intent === "clarify_answer" && out.action === r.expected_intent);
  results.push({ ...r, intent, intentOk, slotErrors, needs, expNeeds, pass: intentOk && !slotErrors.length && needs === expNeeds, latency, provider: out.meta.nlu_provider });
}

const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : "—");
const n = results.length;
const intentAcc = results.filter((x) => x.intentOk).length;
const strict = results.filter((x) => x.pass).length;
const tp = results.filter((x) => x.needs && x.expNeeds).length;
const fp = results.filter((x) => x.needs && !x.expNeeds).length;
const fn = results.filter((x) => !x.needs && x.expNeeds).length;
const lat = results.map((x) => x.latency).sort((a, b) => a - b);
const p95 = lat[Math.min(lat.length - 1, Math.floor(0.95 * lat.length))];
const providers = [...new Set(results.map((x) => x.provider))].join(", ");

const byCat = {};
for (const x of results) (byCat[x.category] ||= []).push(x);

const lines = [
  `# NLU eval — ${new Date().toISOString().slice(0, 10)}`,
  "",
  `Набор: \`${FILE}\` (${n} фраз). NOW = 2026-10-21 14:30, Europe/Moscow. Провайдер: ${providers}.`,
  "",
  "| Метрика | Значение | Цель MVP |",
  "|---|---|---|",
  `| Intent accuracy | ${pct(intentAcc, n)} (${intentAcc}/${n}) | ≥ 92% |`,
  `| Strict accuracy | ${pct(strict, n)} (${strict}/${n}) | ≥ 85% (RuleBased ≥ 65%) |`,
  `| Clarification precision | ${pct(tp, tp + fp)} | ≥ 90% |`,
  `| Clarification recall | ${pct(tp, tp + fn)} | — |`,
  `| Latency p95 (весь пайплайн) | ${p95} мс | ≤ 2 с |`,
  "",
  "| Категория | Фраз | Intent | Strict |",
  "|---|---|---|---|",
  ...Object.entries(byCat).map(([c, xs]) => `| ${c} | ${xs.length} | ${pct(xs.filter((x) => x.intentOk).length, xs.length)} | ${pct(xs.filter((x) => x.pass).length, xs.length)} |`),
  "",
  "## Ошибки",
  "",
  ...(results.filter((x) => !x.pass).map((x) => `- **${x.id}** «${x.phrase}»: intent ${x.intent}${x.intentOk ? "" : ` (ждали ${x.expected_intent})`}` +
    `${x.needs !== x.expNeeds ? `; уточнение ${x.needs ? "задано лишнее" : "не задано"}` : ""}${x.slotErrors.length ? `; ${x.slotErrors.join("; ")}` : ""}`)),
];
if (!results.some((x) => !x.pass)) lines.push("Нет.");
const report = lines.join("\n") + "\n";
fs.mkdirSync("docs/eval", { recursive: true });
const outFile = `docs/eval/${new Date().toISOString().slice(0, 10)}-${providers.replace(/[^a-z]+/g, "-")}.md`;
fs.writeFileSync(outFile, report);
console.log(report);
console.log(`Отчёт: ${outFile}`);
