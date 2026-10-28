// Повторяющиеся задачи и встречи (бонус ТЗ). Правило хранится строкой в items.repeat:
//   "daily" — каждый день, "weekdays" — по будням (пн–пт), "weekly:N" — раз в неделю (N: пн=1 … вс=7),
//   "monthly:D" — каждое D-е число (в коротком месяце — последний день).
// Запись одна: due_date — ближайший раз. В списках и календаре повторы разворачиваются на период,
// «выполнено» переносит запись на следующий раз, в .ics уходит RRULE.
import { DateTime } from "luxon";
import { L, R } from "../nlu/normalize.js";

const WD = [["понедельник", 1], ["вторник", 2], ["сред", 3], ["четверг", 4], ["пятниц", 5], ["суббот", 6], ["воскресень", 7]];
const WD_EACH = ["", "каждый понедельник", "каждый вторник", "каждую среду", "каждый четверг", "каждую пятницу", "каждую субботу", "каждое воскресенье"];
const ICS_DAY = ["", "MO", "TU", "WE", "TH", "FR", "SA", "SU"];

// «каждый понедельник», «по понедельникам», «каждую среду»
const WEEKLY_DAY = new RegExp(`${L}(?:кажд(?:ый|ую|ое|ой)\\s+|по\\s+)(понедельник|вторник|сред|четверг|пятниц|суббот|воскресень)[а-я]*${R}`, "iu");
const DAILY = new RegExp(`${L}(?:каждый\\s+день|ежедневно|каждое\\s+утро|каждый\\s+вечер|каждый\\s+вечером|по\\s+утрам|по\\s+вечерам)${R}`, "iu");
const WEEKDAYS = new RegExp(`${L}(?:по\\s+будням|каждый\\s+будний\\s+день|в\\s+будни|по\\s+рабочим\\s+дням|каждый\\s+рабочий\\s+день)${R}`, "iu");
const WEEKLY = new RegExp(`${L}(?:каждую\\s+неделю|еженедельно|раз\\s+в\\s+неделю)${R}`, "iu");
const MONTHLY_DAY = new RegExp(`${L}кажд(?:ое|ый)\\s+(\\d{1,2})(?:-?(?:е|го|ое))?(?:\\s+числ[оа])?${R}`, "iu");
const MONTHLY = new RegExp(`${L}(?:каждый\\s+месяц|ежемесячно|раз\\s+в\\s+месяц)${R}`, "iu");
// «каждое утро» / «по вечерам» задают и время суток — оставляем подсказку для extractWhen
const PART = { "каждое утро": "утром", "по утрам": "утром", "каждый вечер": "вечером", "каждый вечером": "вечером", "по вечерам": "вечером" };

/**
 * Повтор из текста: {repeat: {freq, weekday?, day?}, rest} — rest без слов о повторе (для названия и дат).
 * @returns {{repeat: object|null, rest: string}}
 */
export function parseRepeat(text) {
  let m;
  if ((m = text.match(WEEKLY_DAY))) {
    const wd = WD.find(([w]) => m[1].toLowerCase().startsWith(w))[1];
    return { repeat: { freq: "weekly", weekday: wd }, rest: text.replace(WEEKLY_DAY, " ") };
  }
  if ((m = text.match(WEEKDAYS))) return { repeat: { freq: "weekdays" }, rest: text.replace(WEEKDAYS, " ") };
  if ((m = text.match(DAILY))) {
    const part = PART[m[0].toLowerCase().replace(/\s+/g, " ").trim()];
    return { repeat: { freq: "daily" }, rest: text.replace(DAILY, part ? ` ${part} ` : " ") };
  }
  if ((m = text.match(MONTHLY_DAY))) return { repeat: { freq: "monthly", day: Number(m[1]) }, rest: text.replace(MONTHLY_DAY, " ") };
  if ((m = text.match(MONTHLY))) return { repeat: { freq: "monthly" }, rest: text.replace(MONTHLY, " ") };
  if ((m = text.match(WEEKLY))) return { repeat: { freq: "weekly" }, rest: text.replace(WEEKLY, " ") };
  return { repeat: null, rest: text };
}

const iso = (dt) => dt.toISODate();
const fromIso = (s) => DateTime.fromISO(s);

/** Попадает ли день в правило. */
function matches(rule, dt) {
  const [freq, arg] = rule.split(":");
  if (freq === "daily") return true;
  if (freq === "weekdays") return dt.weekday <= 5;
  if (freq === "weekly") return dt.weekday === Number(arg);
  if (freq === "monthly") return dt.day === Math.min(Number(arg), dt.daysInMonth);
  return false;
}

/** Правило-строка из слота NLU; недостающее (день недели / число) берём из первой даты. */
export function toRule(repeat, firstIso) {
  if (!repeat?.freq) return null;
  const first = firstIso ? fromIso(firstIso) : null;
  if (repeat.freq === "daily" || repeat.freq === "weekdays") return repeat.freq;
  if (repeat.freq === "weekly") { const wd = repeat.weekday || first?.weekday; return wd ? `weekly:${wd}` : null; }
  if (repeat.freq === "monthly") { const d = repeat.day || first?.day; return d ? `monthly:${d}` : null; }
  return null;
}

/** Первый день по правилу не раньше fromIso (включительно). */
export function firstOnOrAfter(rule, fromIso_) {
  let d = fromIso(fromIso_);
  for (let i = 0; i < 400 && !matches(rule, d); i++) d = d.plus({ days: 1 });
  return iso(d);
}

/** Следующий раз строго после afterIso. */
export const nextAfter = (rule, afterIso) => firstOnOrAfter(rule, iso(fromIso(afterIso).plus({ days: 1 })));

/** Все даты повторов в [from, to], начиная с startIso. */
export function occurrences(rule, startIso, from, to, limit = 400) {
  const out = [];
  let d = fromIso(startIso > from ? startIso : from);
  const end = fromIso(to);
  for (let i = 0; d <= end && out.length < limit && i < 4000; i++, d = d.plus({ days: 1 })) if (matches(rule, d)) out.push(iso(d));
  return out;
}

/** RRULE для .ics (RFC 5545). */
export function toIcs(rule) {
  const [freq, arg] = rule.split(":");
  if (freq === "daily") return "RRULE:FREQ=DAILY";
  if (freq === "weekdays") return "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR";
  if (freq === "weekly") return `RRULE:FREQ=WEEKLY;BYDAY=${ICS_DAY[Number(arg)]}`;
  if (freq === "monthly") return `RRULE:FREQ=MONTHLY;BYMONTHDAY=${Number(arg)}`;
  return null;
}

/** «каждый понедельник», «каждый день», «по будням», «каждое 15-е число». */
export function phrase(rule) {
  const [freq, arg] = rule.split(":");
  if (freq === "daily") return "каждый день";
  if (freq === "weekdays") return "по будням";
  if (freq === "weekly") return WD_EACH[Number(arg)];
  if (freq === "monthly") return `каждое ${Number(arg)}-е число`;
  return "";
}

