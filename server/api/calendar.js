// Экспорт в календарь (бонус ТЗ «интеграция с календарём»): GET /api/v1/calendar/<user>.ics — подписка
// iCalendar (RFC 5545). Google / Яндекс / Apple / Outlook сами раз в несколько часов перечитывают ссылку,
// поэтому новые задачи из Веги появляются в календаре без повторного экспорта.
// Календарь не умеет слать X-User-Id, поэтому id в пути: он анонимный uuid, ссылка работает как «секретная».
// В выгрузке — открытые записи с датой: от 30 дней назад и вперёд. Встречи — со временем и длительностью,
// задачи без времени — событием на весь день, напоминания — с сигналом в момент срока.
import { DateTime } from "luxon";

const PAST_DAYS = 30;

/** Экранирование текста по RFC 5545 (3.3.11). */
const esc = (s) => String(s).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

/** Строки длиннее 75 байт переносятся пробелом в начале следующей (3.1); режем по байтам UTF-8, не по символам. */
function fold(line) {
  const out = [];
  let cur = "", bytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch);
    if (bytes + b > (out.length ? 74 : 75)) { out.push(cur); cur = ""; bytes = 0; }
    cur += ch; bytes += b;
  }
  out.push(cur);
  return out.join("\r\n ");
}

const utc = (dt) => dt.toUTC().toFormat("yyyyMMdd'T'HHmmss'Z'");
const day = (iso) => iso.replace(/-/g, "");

export function buildIcs(rows, { tz, host }) {
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Vega voice assistant//RU", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    "X-WR-CALNAME:Вега", `X-WR-TIMEZONE:${tz}`, "REFRESH-INTERVAL;VALUE=DURATION:PT1H", "X-PUBLISHED-TTL:PT1H",
  ];
  for (const r of rows) {
    const kind = r.type === "meeting" ? "Встреча" : r.type === "reminder" ? "Напоминание" : "Задача";
    lines.push("BEGIN:VEVENT", `UID:vega-${r.id}@${host}`, `DTSTAMP:${utc(DateTime.fromSeconds(r.updated_at || r.created_at))}`,
      `SUMMARY:${esc(r.title)}`, `CATEGORIES:${kind}`);
    if (r.due_time) {
      const start = DateTime.fromISO(`${r.due_date}T${r.due_time}`, { zone: tz });
      const min = r.duration_min || (r.type === "meeting" ? 60 : 30);
      lines.push(`DTSTART:${utc(start)}`, `DTEND:${utc(start.plus({ minutes: min }))}`);
    } else {
      lines.push(`DTSTART;VALUE=DATE:${day(r.due_date)}`, `DTEND;VALUE=DATE:${day(DateTime.fromISO(r.due_date).plus({ days: 1 }).toISODate())}`,
        "TRANSP:TRANSPARENT");                                     // задача на день не занимает время в расписании
    }
    if (r.notes) lines.push(`DESCRIPTION:${esc(r.notes)}`);
    if (r.type === "reminder" && r.due_time) lines.push("BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${esc(r.title)}`, "TRIGGER:PT0M", "END:VALARM");
    if (r.type === "meeting") lines.push("BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${esc(r.title)}`, "TRIGGER:-PT10M", "END:VALARM");
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

export function calendarHandler({ db, tzDefault }) {
  return (req, res) => {
    const userId = req.params.user;
    if (!/^[\w-]{1,64}$/.test(userId)) return res.status(400).json({ status: "error", error: { code: "USER_REQUIRED", message: "bad user id" } });
    const user = db.prepare("SELECT tz FROM users WHERE id = ?").get(userId);
    if (!user) return res.status(404).json({ status: "error", error: { code: "NOT_FOUND", message: "unknown user" } });
    const tz = user.tz || tzDefault;
    const from = DateTime.now().setZone(tz).minus({ days: PAST_DAYS }).toISODate();
    const rows = db.prepare(`SELECT * FROM items WHERE user_id = ? AND deleted_at IS NULL AND status = 'open'
      AND due_date IS NOT NULL AND due_date >= ? ORDER BY due_date, due_time`).all(userId, from);
    res.set("Content-Type", "text/calendar; charset=utf-8");
    res.set("Content-Disposition", `inline; filename="vega-${userId}.ics"`);
    res.set("Cache-Control", "no-cache");
    res.send(buildIcs(rows, { tz, host: req.hostname || "vega" }));
  };
}
