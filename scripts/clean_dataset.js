// npm run clean [-- data/raw/voice_assistant_events_1000.csv]
// Очистка датасета из ТЗ (id,date,time,text) → data/dataset.clean.csv для npm run seed.
// 1. Падежи: «Позвонить Марией» → «Позвонить Марии», «вопросы для Еленой» → «для Елены»,
//    «про мобильному приложению» → «про мобильное приложение», «Обсудить сайту с …» → «Обсудить сайт с …».
//    После «с» творительный падеж верный и не трогается.
// 2. Тип — общим правилом domain/type.js; «Подготовиться к встрече» и «Отправить итоги встречи» — задачи.
// 3. Статус: записи раньше сегодняшнего дня — done (история), остальные — open.
// Отчёт о правках — data/clean_report.md.
import fs from "node:fs";
import { parseCsv, toCsv } from "./csv.js";
import { typeFor } from "../server/domain/type.js";
import { toMatch } from "../server/nlu/normalize.js";

const src = process.argv[2] || "data/raw/voice_assistant_events_1000.csv";
const OUT = "data/dataset.clean.csv", REPORT = "data/clean_report.md";

// творительный → дательный / родительный
const NAMES = {
  "Иваном": ["Ивану", "Ивана"], "Марией": ["Марии", "Марии"], "Анной": ["Анне", "Анны"],
  "Дмитрием": ["Дмитрию", "Дмитрия"], "Сергеем": ["Сергею", "Сергея"], "Максимом": ["Максиму", "Максима"],
  "Алексеем": ["Алексею", "Алексея"], "Ольгой": ["Ольге", "Ольги"], "Еленой": ["Елене", "Елены"],
  "Натальей": ["Наталье", "Натальи"],
};
// дательный → винительный (после «про» и после глагола «обсудить»)
const TOPICS = {
  "бюджету": "бюджет", "сайту": "сайт", "договору": "договор", "презентации": "презентацию",
  "аналитике": "аналитику", "интеграции": "интеграцию", "хакатону": "хакатон",
  "новому продукту": "новый продукт", "мобильному приложению": "мобильное приложение", "CRM": "CRM",
};
const alt = (o) => Object.keys(o).sort((a, b) => b.length - a.length).join("|");

export function fixCases(text) {
  let t = text;
  t = t.replace(new RegExp(`(для )(${alt(NAMES)})`, "gu"), (_, p, n) => p + NAMES[n][1]);
  t = t.replace(new RegExp(`(^|[^с] )(${alt(NAMES)})(?=$| )`, "gu"), (m, p, n) => (/(^|\s)с $/.test(p) ? m : p + NAMES[n][0]));
  t = t.replace(new RegExp(`(про )(${alt(TOPICS)})`, "gu"), (_, p, x) => p + TOPICS[x]);
  t = t.replace(new RegExp(`^(Обсудить )(${alt(TOPICS)})( с )`, "u"), (_, a, x, b) => a + TOPICS[x] + b);
  return t;
}

export function typeOf(title) {
  if (/^(Подготовиться к |Отправить итоги )/u.test(title)) return { type: "task", type_confidence: "high" };
  const type = typeFor(toMatch(title));
  return { type, type_confidence: type === "task" && /^Демо /u.test(title) ? "low" : "high" };
}

{
  const raw = parseCsv(fs.readFileSync(src, "utf8").replace(/^﻿/, ""));
  const today = new Date().toISOString().slice(0, 10);
  const fixes = new Map(), types = { task: 0, meeting: 0, reminder: 0 };
  const rows = raw.map((r) => {
    const title = fixCases(r.text);
    if (title !== r.text) fixes.set(r.text, title);
    const t = typeOf(title);
    types[t.type]++;
    return { title, title_raw: r.text, ...t, due_date: r.date, due_time: r.time, status: r.date < today ? "done" : "open" };
  });
  fs.writeFileSync(OUT, toCsv(["title", "title_raw", "type", "due_date", "due_time", "status", "type_confidence"], rows));
  const done = rows.filter((r) => r.status === "done").length;
  fs.writeFileSync(REPORT, [
    `# Очистка датасета — ${today}`, "",
    `Источник: \`${src}\`, записей: ${rows.length}. Результат: \`${OUT}\`.`, "",
    `| Тип | Записей |`, `|---|---|`, ...Object.entries(types).map(([k, v]) => `| ${k} | ${v} |`), "",
    `Статус: done (дата раньше ${today}) — ${done}, open — ${rows.length - done}.`, "",
    `## Исправленные формулировки (${fixes.size} уникальных)`, "",
    `| Было | Стало |`, `|---|---|`, ...[...fixes].sort().map(([a, b]) => `| ${a} | ${b} |`), "",
  ].join("\n"));
  console.log(`Очищено ${rows.length} записей → ${OUT}; правок падежей: ${fixes.size} уникальных; типы:`, types);
}
