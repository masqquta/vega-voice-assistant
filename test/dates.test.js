// docs/06 раздел 3: D-1…D-25. NOW = среда 21.10.2026 14:30, Europe/Moscow.
import { test } from "node:test";
import assert from "node:assert/strict";
import { nowIn, resolve } from "../server/dates/resolver.js";

const TZ = "Europe/Moscow";
const NOW = nowIn(TZ, "2026-10-21T14:30:00+03:00");
const at = (iso) => nowIn(TZ, iso);
const r = (date, time, opts = {}, now = NOW) => resolve({ date, time }, now, { mode: "create", type: "task", ...opts });
const dt = (x) => `${x.due_date}${x.due_time ? " " + x.due_time : ""}`;

const cases = [
  ["D-1", () => r({ kind: "today" }), "2026-10-21"],
  ["D-2", () => r({ kind: "tomorrow" }), "2026-10-22"],
  ["D-3", () => r({ kind: "day_after_tomorrow" }), "2026-10-23"],
  ["D-4", () => r({ kind: "weekday", weekday: 5 }), "2026-10-23"],
  ["D-5", () => r({ kind: "weekday", weekday: 3 }), "2026-10-28"],
  ["D-6", () => r({ kind: "weekday", weekday: 1 }), "2026-10-26"],
  ["D-7", () => r({ kind: "weekday", weekday: 4 }, { hour: 11, ambiguous_hour: true }), "2026-10-22 11:00"],
  ["D-8", () => r({ kind: "none" }, { relative: { amount: 2, unit: "hour" } }), "2026-10-21 16:30"],
  ["D-9", () => r({ kind: "none" }, { relative: { amount: 30, unit: "minute" } }), "2026-10-21 15:00"],
  ["D-10", () => r({ kind: "in_days", offset: 3 }), "2026-10-24"],
  ["D-11", () => r({ kind: "in_days", offset: 7 }), "2026-10-28"],
  ["D-12", () => r({ kind: "end_of_week" }), "2026-10-25"],
  ["D-13", () => r({ kind: "end_of_week" }, null, {}, at("2026-10-25T14:30:00+03:00")), "2026-10-25"],
  ["D-14", () => r({ kind: "next_week" }), "2026-11-01"],
  ["D-17", () => r({ kind: "absolute", day: 25, month: 10 }), "2026-10-25"],
  ["D-18", () => r({ kind: "absolute", day: 5, month: 10 }), "2027-10-05"],
  ["D-26", () => r({ kind: "absolute", day: 30 }), "2026-10-30"],          // «на 30-е» — этот месяц
  ["D-27", () => r({ kind: "absolute", day: 5 }), "2026-11-05"],           // «5-е» уже прошло — следующий месяц
  ["D-19", () => r({ kind: "none" }, { hour: 15, ambiguous_hour: true }), "2026-10-21 15:00"],
  ["D-20", () => r({ kind: "none" }, { hour: 9, ambiguous_hour: true }), "2026-10-22 09:00"],
  ["D-21", () => r({ kind: "tomorrow" }, { part_of_day: "evening" }), "2026-10-22 19:00"],
  ["D-22", () => r({ kind: "tomorrow" }, null, {}, at("2026-10-31T14:30:00+03:00")), "2026-11-01"],
  ["D-23", () => r({ kind: "tomorrow" }, null, {}, at("2026-12-31T14:30:00+03:00")), "2027-01-01"],
  ["D-24", () => r({ kind: "none" }, { relative: { amount: 2, unit: "hour" } }, {}, at("2026-10-25T01:30:00+03:00")), "2026-10-25 03:30"],
  ["D-25", () => r({ kind: "weekday", weekday: 5 }, null, {}, at("2026-10-23T14:30:00+03:00")), "2026-10-30"],
];

for (const [id, fn, expected] of cases) {
  test(id, () => assert.equal(dt(fn()), expected));
}

test("D-15 this_week (период)", () => {
  assert.deepEqual(r({ kind: "this_week" }, null, { mode: "list" }).period, { from: "2026-10-19", to: "2026-10-25" });
});
test("D-16 next_week (период)", () => {
  assert.deepEqual(r({ kind: "next_week" }, null, { mode: "list" }).period, { from: "2026-10-26", to: "2026-11-01" });
});
test("next_week для встречи → уточнение «В какой день?»", () => {
  assert.equal(r({ kind: "next_week" }, null, { type: "meeting" }).need, "date");
});
test("час 7–8 без указания → уточнение утро/вечер", () => {
  assert.equal(r({ kind: "tomorrow" }, { hour: 7, ambiguous_hour: true }).need, "ampm");
});
test("«в 3» → 15:00, «в 12» → 12:00, «ночью» → уточнение", () => {
  assert.equal(r({ kind: "tomorrow" }, { hour: 3, ambiguous_hour: true }).due_time, "15:00");
  assert.equal(r({ kind: "tomorrow" }, { hour: 12, ambiguous_hour: true }).due_time, "12:00");
  assert.equal(r({ kind: "tomorrow" }, { part_of_day: "night" }).need, "night");
});
test("сегодня в 14:00 (уже прошло) → подтверждение с предложением на завтра", () => {
  const x = r({ kind: "today" }, { hour: 14, minute: 0 });
  assert.equal(x.need, "past");
  assert.deepEqual(x.suggestion, { due_date: "2026-10-22", due_time: "14:00" });
});
test("«в 10 утра», «в 3 часа дня», «вечером», «днём»", () => {
  assert.equal(r({ kind: "tomorrow" }, { hour: 10, part_of_day: "morning" }).due_time, "10:00");
  assert.equal(r({ kind: "tomorrow" }, { hour: 3, part_of_day: "day" }).due_time, "15:00");
  assert.equal(r({ kind: "tomorrow" }, { part_of_day: "day" }).due_time, "13:00");
  assert.equal(r({ kind: "tomorrow" }, { part_of_day: "morning" }).due_time, "09:00");
});
