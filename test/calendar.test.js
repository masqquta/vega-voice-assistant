// Экспорт .ics (RFC 5545): время в UTC, задачи без времени — на весь день, экранирование, перенос длинных строк.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildIcs } from "../server/api/calendar.js";

const base = { created_at: 1792900000, updated_at: 1792900000, notes: null, duration_min: null };
const ics = buildIcs([
  { ...base, id: 1, type: "meeting", title: "Встреча с Иваном, по бюджету; срочно", due_date: "2026-10-22", due_time: "15:00", duration_min: 90 },
  { ...base, id: 2, type: "task", title: "Купить билеты", due_date: "2026-10-25", due_time: null },
  { ...base, id: 3, type: "reminder", title: "Позвонить маме ".repeat(8).trim(), due_date: "2026-10-21", due_time: "19:00" },
], { tz: "Europe/Moscow", host: "vega.test" });
const lines = ics.split("\r\n");

test("ICS: календарь и три события", () => {
  assert.equal(lines[0], "BEGIN:VCALENDAR");
  assert.equal(ics.match(/BEGIN:VEVENT/g).length, 3);
  assert.ok(ics.endsWith("END:VCALENDAR\r\n"));
});

test("ICS: встреча — UTC и длительность, экранирование запятой и точки с запятой", () => {
  assert.ok(lines.includes("DTSTART:20261022T120000Z"));          // 15:00 МСК = 12:00 UTC
  assert.ok(lines.includes("DTEND:20261022T133000Z"));            // + 90 минут
  assert.ok(ics.includes("SUMMARY:Встреча с Иваном\\, по бюджету\\; срочно"));
});

test("ICS: задача без времени — событие на весь день", () => {
  assert.ok(lines.includes("DTSTART;VALUE=DATE:20261025"));
  assert.ok(lines.includes("DTEND;VALUE=DATE:20261026"));
});

test("ICS: напоминание с сигналом, длинные строки перенесены (≤ 75 байт)", () => {
  assert.ok(lines.includes("TRIGGER:PT0M"));
  for (const l of lines) assert.ok(Buffer.byteLength(l) <= 75, `длина ${Buffer.byteLength(l)}: ${l}`);
  assert.ok(lines.some((l) => l.startsWith(" ")));
});
