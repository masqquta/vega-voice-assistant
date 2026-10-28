// Повторяющиеся записи: разбор фразы, правило, развёртка по дням, «выполнено» → следующий раз, .ics.
// NOW = ср 21.10.2026 14:30, Europe/Moscow; без LLM (RuleBased).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../server/db/index.js";
import { createNlu } from "../server/nlu/adapter.js";
import { createAssistant } from "../server/services/assistant.js";
import { nowIn } from "../server/dates/resolver.js";
import { listItems } from "../server/services/items.js";
import { buildIcs } from "../server/api/calendar.js";
import { parseRepeat, toRule, occurrences, nextAfter, toIcs } from "../server/domain/repeat.js";

const TZ = "Europe/Moscow";
const NOW = nowIn(TZ, "2026-10-21T14:30:00+03:00");

function setup() {
  const db = openDb(":memory:");
  const assistant = createAssistant({ db, nlu: createNlu({ providers: [] }) });
  let n = 0;
  const say = (text) => assistant.handle({ requestId: `r_${++n}`, userId: "u", sessionId: "s", text, tz: TZ, now: NOW });
  return { db, say };
}

describe("Повтор: правило", () => {
  test("фразы → повтор и остаток без слов о повторе", () => {
    assert.deepEqual(parseRepeat("напоминай каждый понедельник в 9 сдавать отчёт").repeat, { freq: "weekly", weekday: 1 });
    assert.deepEqual(parseRepeat("по средам в 10 планёрка").repeat, { freq: "weekly", weekday: 3 });
    assert.deepEqual(parseRepeat("каждый день в 8 пить таблетки").repeat, { freq: "daily" });
    assert.deepEqual(parseRepeat("по будням в 9 зарядка").repeat, { freq: "weekdays" });
    assert.deepEqual(parseRepeat("каждое 15 число платить за квартиру").repeat, { freq: "monthly", day: 15 });
    assert.equal(parseRepeat("завтра в 10 позвонить Ивану").repeat, null);
    assert.doesNotMatch(parseRepeat("напоминай каждый понедельник сдавать отчёт").rest, /кажд|понедельник/);
  });
  test("развёртка и следующий раз", () => {
    assert.deepEqual(occurrences("weekly:1", "2026-10-26", "2026-10-19", "2026-11-08"), ["2026-10-26", "2026-11-02"]);
    assert.deepEqual(occurrences("weekdays", "2026-10-23", "2026-10-23", "2026-10-27"), ["2026-10-23", "2026-10-26", "2026-10-27"]);
    assert.equal(nextAfter("monthly:31", "2026-10-31"), "2026-11-30");          // в коротком месяце — последний день
    assert.equal(toRule({ freq: "weekly" }, "2026-10-23"), "weekly:5");          // «каждую неделю» — день первой даты
    assert.equal(toIcs("weekdays"), "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR");
  });
});

describe("Повтор: сценарии", () => {
  test("«Напоминай каждый понедельник в 9 сдавать отчёт» → reminder weekly:1, первый раз 26.10 09:00", async () => {
    const { say } = setup();
    const r = await say("Напоминай каждый понедельник в 9 сдавать отчёт");
    assert.equal(r.status, "ok");
    const it = r.data.item;
    assert.deepEqual([it.type, it.title, it.due_date, it.due_time, it.repeat], ["reminder", "Сдавать отчёт", "2026-10-26", "09:00", "weekly:1"]);
    assert.equal(r.reply_text, "Готово. Буду напоминать каждый понедельник в 09:00: сдавать отчёт. Первый раз — в понедельник, 26 октября.");
  });
  test("«каждый день в 8 вечера пить таблетки» — сегодня 20:00 ещё впереди → первый раз сегодня", async () => {
    const { say } = setup();
    const it = (await say("Напоминай каждый день в 8 вечера пить таблетки")).data.item;
    assert.deepEqual([it.due_date, it.due_time, it.repeat], ["2026-10-21", "20:00", "daily"]);
  });
  test("«каждый день в 9 утра» — сегодня 09:00 уже прошло → первый раз завтра, без вопроса «время прошло»", async () => {
    const { say } = setup();
    const r = await say("Напоминай каждый день в 9 утра делать зарядку");
    assert.deepEqual([r.status, r.data.item.due_date, r.data.item.repeat], ["ok", "2026-10-22", "daily"]);
  });
  test("список за неделю показывает каждый раз; «выполнено» переносит на следующий", async () => {
    const { db, say } = setup();
    await say("Напоминай каждый понедельник в 9 сдавать отчёт");
    const rows = listItems(db, "u", { from: "2026-10-19", to: "2026-11-08" });
    assert.deepEqual(rows.map((r) => r.due_date), ["2026-10-26", "2026-11-02"]);
    const done = await say("Отметь, что отчёт сдал");
    assert.equal(done.status, "ok");
    assert.equal(done.data.item.due_date, "2026-11-02");
    assert.match(done.reply_text, /Следующий раз — в понедельник, 2 ноября/);
  });
  test(".ics: повтор уходит как RRULE", async () => {
    const { say } = setup();
    const it = (await say("Напоминай каждый понедельник в 9 сдавать отчёт")).data.item;
    const ics = buildIcs([{ ...it, created_at: 1792900000, updated_at: 1792900000 }], { tz: TZ, host: "t" });
    assert.ok(ics.includes("RRULE:FREQ=WEEKLY;BYDAY=MO"));
  });
});
