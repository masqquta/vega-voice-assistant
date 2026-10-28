// DateResolver: временной объект (что сказал пользователь) + NOW + таймзона → конкретные даты.
// Принцип «LLM понимает, код считает даты»: никакая другая часть системы даты не вычисляет.
// Таблица правил — docs/05 раздел 3, тест-кейсы — docs/06 D-1…D-25.
import { DateTime } from "luxon";

export const DATE_KINDS = ["today", "tomorrow", "day_after_tomorrow", "weekday", "in_days", "absolute",
  "this_week", "next_week", "end_of_week", "weekend", "none"];

const PART_HOUR = { morning: 9, day: 13, evening: 19 };   // «утром» без часа → 09:00 и т. д.

/** NOW как Luxon DateTime в таймзоне пользователя. */
export function nowIn(tz, iso) {
  return iso ? DateTime.fromISO(iso, { setZone: true }).setZone(tz) : DateTime.now().setZone(tz);
}

const day = (dt) => dt.startOf("day");

/**
 * Дата или период из временного объекта.
 * mode: "create" — нужна одна дата (для task «на следующей неделе» = воскресенье следующей недели);
 *       "list"   — период (неделя = пн–вс).
 * @returns {{ date: DateTime|null, period: {from: DateTime, to: DateTime}|null, need: null|"date" }}
 */
export function resolveDate(date, now, { type = "task", mode = "create" } = {}) {
  const kind = date?.kind || "none";
  const today = day(now);
  const one = (d) => ({ date: d, period: mode === "list" ? { from: d, to: d } : null, need: null });
  switch (kind) {
    case "today": return one(today);
    case "tomorrow": return one(today.plus({ days: 1 }));
    case "day_after_tomorrow": return one(today.plus({ days: 2 }));
    case "weekday": {
      const wd = Number(date.weekday);
      if (!(wd >= 1 && wd <= 7)) return { date: null, period: null, need: null };
      const add = (wd - today.weekday + 7) % 7 || 7;               // сегодняшний день не считается
      return one(today.plus({ days: add }));
    }
    case "in_days": {
      const n = Number(date.offset);
      return n >= 1 ? one(today.plus({ days: n })) : { date: null, period: null, need: null };
    }
    case "absolute": {
      const d = Number(date.day), m = Number(date.month) || today.month;   // «на 30-е» — месяц текущий
      let cand = DateTime.fromObject({ year: date.year || today.year, month: m, day: d }, { zone: now.zone });
      if (!cand.isValid) return { date: null, period: null, need: null };
      if (!date.month && cand < today) cand = cand.plus({ months: 1 });     // число прошло — значит в следующем месяце
      else if (!date.year && cand < today) cand = cand.plus({ years: 1 });  // прошла — значит в следующем году
      return one(cand);
    }
    case "this_week":
    case "next_week": {
      const from = today.startOf("week").plus({ weeks: kind === "next_week" ? 1 : 0 });
      const to = from.plus({ days: 6 });
      if (mode === "list") return { date: null, period: { from, to }, need: null };
      if (type === "meeting") return { date: null, period: null, need: "date" };   // «В какой день?»
      return { date: to, period: null, need: null };                               // дедлайн — воскресенье
    }
    case "end_of_week": return one(today.startOf("week").plus({ days: 6 }));
    case "weekend": {                                                // «на выходных»: сб–вс этой недели
      const from = today.startOf("week").plus({ days: 5 });
      if (mode === "list") return { date: null, period: { from, to: from.plus({ days: 1 }) }, need: null };
      return { date: null, period: null, need: "date" };            // создать «на выходных» — спросим день
    }
    default: return { date: null, period: null, need: null };
  }
}

/**
 * Время из объекта времени: {hour, minute, part_of_day, ambiguous_hour}.
 * @returns {{ hour: number, minute: number }|{ need: "ampm"|"night", hour?: number }|null}
 */
export function resolveTime(time) {
  if (!time) return null;
  const minute = Number.isInteger(time.minute) ? time.minute : 0;
  const part = time.part_of_day || null;
  let h = time.hour;
  if (h == null) {
    if (!part) return null;
    if (part === "night") return { need: "night" };
    return { hour: PART_HOUR[part], minute: 0 };
  }
  h = Number(h);
  if (!(h >= 0 && h <= 23) || !(minute >= 0 && minute <= 59)) return null;
  if (part === "morning") return { hour: h === 12 ? 0 : h, minute };
  if (part === "day") return { hour: h >= 1 && h <= 6 ? h + 12 : h, minute };
  if (part === "evening") return { hour: h < 12 ? h + 12 : h, minute };
  if (part === "night") return { hour: h === 12 ? 0 : h >= 10 && h < 12 ? h + 12 : h, minute };
  if (time.ambiguous_hour && h >= 1 && h <= 12) {
    if (h <= 6) return { hour: h + 12, minute };                  // «в 3» → 15:00
    if (h <= 8) return { need: "ampm", hour: h };                 // 7–8 — уточняем утро/вечер
    return { hour: h, minute };                                   // 9–11 — утро, 12 — полдень
  }
  return { hour: h, minute };
}

const hhmm = (t) => `${String(t.hour).padStart(2, "0")}:${String(t.minute).padStart(2, "0")}`;

/**
 * Полный резолв для создания/изменения записи или для выборки.
 * @returns {{
 *   due_date: string|null, due_time: string|null, period: {from: string, to: string}|null,
 *   need: null|"past"|"ampm"|"night"|"date", suggestion?: {due_date: string, due_time: string},
 *   inferred_date: boolean
 * }}
 */
export function resolve({ date, time }, now, { type = "task", mode = "create" } = {}) {
  const out = { due_date: null, due_time: null, period: null, need: null, inferred_date: false };
  if (time?.relative && time.relative.amount > 0) {
    const unit = time.relative.unit === "hour" ? "hours" : "minutes";
    const dt = now.plus({ [unit]: Number(time.relative.amount) }).set({ second: 0, millisecond: 0 });
    return { ...out, due_date: dt.toISODate(), due_time: dt.toFormat("HH:mm") };
  }
  const d = resolveDate(date, now, { type, mode });
  if (d.need) return { ...out, need: d.need };
  if (d.period) out.period = { from: d.period.from.toISODate(), to: d.period.to.toISODate() };
  const t = resolveTime(time);
  if (t?.need) return { ...out, need: t.need, ampm_hour: t.hour };
  let dateDt = d.date;
  if (!dateDt && t) {
    // только время: сегодня, если ещё впереди, иначе завтра (день называем в ответе)
    const todayAt = day(now).set({ hour: t.hour, minute: t.minute });
    dateDt = todayAt > now ? day(now) : day(now).plus({ days: 1 });
    out.inferred_date = true;
  }
  if (dateDt) out.due_date = dateDt.toISODate();
  if (t) out.due_time = hhmm(t);
  if (mode === "create" && dateDt && t && !out.inferred_date) {
    const at = dateDt.set({ hour: t.hour, minute: t.minute });
    if (at < now) {
      const tomorrow = day(now).plus({ days: 1 });
      return { ...out, need: "past", suggestion: { due_date: tomorrow.toISODate(), due_time: out.due_time } };
    }
  }
  return out;
}

/** Момент начала в UTC (epoch seconds) по локальным полям — производное поле start_utc. */
export function startUtc(due_date, due_time, tz) {
  if (!due_date || !due_time) return null;
  return Math.floor(DateTime.fromISO(`${due_date}T${due_time}`, { zone: tz }).toSeconds());
}

/** ISO 8601 с оффсетом для поля due_at. */
export function dueAt(due_date, due_time, tz) {
  if (!due_date || !due_time) return null;
  return DateTime.fromISO(`${due_date}T${due_time}`, { zone: tz }).toISO({ suppressMilliseconds: true });
}
