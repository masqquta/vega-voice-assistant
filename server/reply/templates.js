// Шаблоны reply_text (docs/03 «Правила reply_text»): только простой текст (его читает TTS), ≤ 2 предложений,
// подтверждение = действие + название + дата с днём недели и числом + время «в 15:00», числа цифрами.
import { DateTime } from "luxon";

const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const WD_ACC = ["", "в понедельник", "во вторник", "в среду", "в четверг", "в пятницу", "в субботу", "в воскресенье"];
const WD_GEN = ["", "понедельника", "вторника", "среды", "четверга", "пятницы", "субботы", "воскресенья"];
const WD_NOM = ["", "понедельник", "вторник", "среду", "четверг", "пятницу", "субботу", "воскресенье"];

const lc = (s) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);
const dm = (d) => `${d.day} ${MONTHS[d.month - 1]}`;
const D = (iso) => DateTime.fromISO(iso);

function diffDays(iso, now) {
  const a = DateTime.fromISO(iso, { zone: now.zone }).startOf("day");
  return Math.round(a.diff(now.startOf("day"), "days").days);
}

/** «сегодня, 21 октября», «завтра, 22 октября», «в пятницу, 23 октября», «5 ноября». */
export function dayPhrase(iso, now) {
  const d = D(iso), n = diffDays(iso, now);
  if (n === 0) return `сегодня, ${dm(d)}`;
  if (n === 1) return `завтра, ${dm(d)}`;
  if (n === 2) return `послезавтра, ${dm(d)}`;
  if (n > 2 && n <= 13) return `${WD_ACC[d.weekday]}, ${dm(d)}`;
  return `${dm(d)}${d.year !== now.year ? ` ${d.year} года` : ""}`;
}
/** «завтра, 22 октября, в 10:00» */
export const when = (date, time, now) => `${dayPhrase(date, now)}${time ? `, в ${time}` : ""}`;

/** Встреча в винительном падеже для «Поставила …»: «Встреча с дизайнером» → «встречу с дизайнером». */
function accusative(title) {
  return lc(title).replace(/^встреча/, "встречу").replace(/^планёрка/, "планёрку").replace(/^планерка/, "планерку");
}

function plural(n, one, few, many) {
  const a = n % 10, b = n % 100;
  if (a === 1 && b !== 11) return one;
  if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return few;
  return many;
}
const COUNT_N = ["", "одно", "два", "три", "четыре"];
const COUNT_F = ["", "одна", "две", "три", "четыре"];

// ---------------------------------------------------------------- подтверждения действий

export function created(item, now, conflicts = []) {
  let text;
  if (item.type === "reminder") text = `Готово. Напомню ${when(item.due_date, item.due_time, now)}: ${lc(item.title)}.`;
  else if (item.type === "meeting") {
    const dur = item.duration_min && item.duration_min !== 60
      ? `, на ${item.duration_min % 60 === 0 ? `${item.duration_min / 60} ${plural(item.duration_min / 60, "час", "часа", "часов")}` : `${item.duration_min} минут`}` : "";
    text = `Поставила ${accusative(item.title)} ${when(item.due_date, item.due_time, now)}${dur}.`;
  } else if (item.due_date && item.due_time) text = `Записала задачу «${item.title}» на ${when(item.due_date, item.due_time, now)}.`;
  else if (item.due_date) {
    const n = diffDays(item.due_date, now), d = D(item.due_date);
    const by = n >= 2 && n <= 13 ? `до ${WD_GEN[d.weekday]}, ${dm(d)}` : `на ${dayPhrase(item.due_date, now)}`;
    text = `Записала задачу «${item.title}» ${by}.`;
  } else text = `Записала задачу «${item.title}».`;
  if (conflicts.length) {
    const c = conflicts[0];
    text += ` Внимание: пересекается с «${c.title}» в ${c.due_time}${conflicts.length > 1 ? ` и ещё ${conflicts.length - 1}` : ""}.`;
  }
  return text;
}

export const completed = (item) => `Отметила выполненной: «${item.title}».`;
export const reopened = (item) => `Вернула в работу: «${item.title}».`;
export const deleted = (item) => `Удалила: «${item.title}».`;
export function updated(item, now) {
  if (item.due_date) return `Перенесла «${item.title}» на ${when(item.due_date, item.due_time, now)}.`;
  return `Изменила: «${item.title}».`;
}

// ---------------------------------------------------------------- списки

/** Подпись периода: «Сегодня», «Завтра», «В понедельник, 26 октября», «На этой неделе», «5 ноября». */
function periodLabel(period, dateKind, now) {
  if (dateKind === "this_week") return { head: "На этой неделе", empty: "На эту неделю" };
  if (dateKind === "next_week") return { head: "На следующей неделе", empty: "На следующую неделю" };
  if (period.from !== period.to) return { head: `С ${dm(D(period.from))} по ${dm(D(period.to))}`, empty: `С ${dm(D(period.from))} по ${dm(D(period.to))}` };
  const n = diffDays(period.from, now), d = D(period.from);
  if (n === 0) return { head: "Сегодня", empty: "На сегодня" };
  if (n === 1) return { head: "Завтра", empty: "На завтра" };
  if (n === 2) return { head: "Послезавтра", empty: "На послезавтра" };
  if (n > 2 && n <= 13) return { head: `${WD_ACC[d.weekday].replace(/^в/, "В")}, ${dm(d)},`, empty: `На ${WD_NOM[d.weekday]}, ${dm(d)},` };
  return { head: dm(d), empty: `На ${dm(d)}` };
}

export function list(items, { period, dateKind, typeFilter, now }) {
  const lab = periodLabel(period, dateKind, now);
  const noun = typeFilter === "meeting" ? ["встреча", "встречи", "встреч", COUNT_F]
    : typeFilter === "task" ? ["задача", "задачи", "задач", COUNT_F]
    : typeFilter === "reminder" ? ["напоминание", "напоминания", "напоминаний", COUNT_N]
    : ["дело", "дела", "дел", COUNT_N];
  if (!items.length) {
    if (typeFilter) return `${lab.empty} ${noun[2]} нет.`;
    return `${lab.empty} ничего не запланировано.`;
  }
  const multiDay = period.from !== period.to;
  const phrase = (it) => {
    const day = multiDay ? `${dm(D(it.due_date))} ` : "";
    return it.due_time ? `${day}в ${it.due_time} — ${lc(it.title)}` : `${multiDay ? day.trim() : "без времени"} — ${lc(it.title)}`;
  };
  const shown = items.slice(0, 5).map(phrase);
  const more = items.length - shown.length;
  let body = shown.length > 1 ? `${shown.slice(0, -1).join(", ")}, и ${shown.at(-1)}` : shown[0];
  if (more > 0) body = `${shown.join(", ")}, и ещё ${more}`;
  const n = items.length;
  const count = n <= 4 ? noun[3][n] : String(n);
  return `${lab.head} ${count} ${plural(n, noun[0], noun[1], noun[2])}: ${body}.`;
}

// ---------------------------------------------------------------- поиск

export function found(results, now) {
  const one = (row) => {
    if (!row.due_date) return `«${row.title}»`;
    const past = DateTime.fromISO(`${row.due_date}T${row.due_time || "23:59"}`, { zone: now.zone }) < now;
    const date = `${dm(D(row.due_date))}${row.due_time ? ` в ${row.due_time}` : ""}`;
    if (row.type === "meeting") return `«${row.title}» — ${past ? "была" : "будет"} ${date}`;
    return `«${row.title}», срок ${past ? "был " : ""}${date}`;
  };
  if (results.length === 1) return `Нашла: ${one(results[0].row)}.`;
  const top = results.slice(0, 3);
  return `Нашла ${top.length === 2 ? "две" : top.length} ${plural(top.length, "запись", "записи", "записей")}: ${top.map((r, i) => `${i + 1}) ${one(r.row)}`).join(", ")}.`;
}
export const NOT_FOUND = "Ничего похожего не нашла. Попробуйте описать иначе.";

// ---------------------------------------------------------------- уточнения (docs/01 раздел 5)

export function ask(missing, { intent, type, hour } = {}) {
  const meeting = type === "meeting" || intent === "create_meeting";
  const m = new Set(missing);
  if (m.has("title")) return meeting ? "С кем встреча?" : "Что именно записать?";
  if (m.has("ampm")) return `${hour}:00 утра или вечера?`;
  if (m.has("date") && m.has("time")) return type === "reminder" ? "Когда напомнить?" : `Когда поставить ${meeting ? "встречу" : "задачу"}?`;
  if (m.has("time")) return type === "reminder" ? "Во сколько напомнить?" : `На какое время поставить ${meeting ? "встречу" : "задачу"}?`;
  if (m.has("date")) return "На какой день?";
  return "Уточните, пожалуйста.";
}
export const ASK_WEEKEND = "В субботу или в воскресенье?";
export const ASK_NIGHT = "Во сколько именно?";
export const askPast = (time) => `Это время уже прошло. Поставить на завтра в ${time}?`;
export const ASK_TARGET = { update: "Какую запись изменить?", delete: "Какую запись удалить?", complete: "Какую запись отметить?" };
export const ASK_MASS = "Удалить или изменить можно одну запись за раз. Какую именно?";
export const ASK_NEW_WHEN = "На когда перенести?";
export const ASK_QUERY = "Что найти?";
export const ASK_LOW_CONFIDENCE = "Вы хотите создать запись или найти?";
export function candidates(rows, kind) {
  const word = kind === "meeting" ? ["встречи", "встреч"] : ["задачи", "записей"];
  const n = rows.length;
  return `Нашла ${n === 2 ? "две" : n === 3 ? "три" : n} ${n <= 4 ? word[0] : word[1]}: ${rows.map((r, i) => `${i + 1}) ${r.title}`).join(", ")}. Какую?`;
}
export const DECLINED = "Хорошо, не ставлю. Назовите другое время.";
export const RESET = "Не поняла. Сформулируйте запрос целиком, например: поставь встречу с Иваном завтра в 15:00.";
export const UNKNOWN = "Не поняла запрос. Например: напомни завтра в 10 позвонить Ивану, или: что у меня сегодня?";
export const STT_EMPTY = "Не расслышала. Повторите или напишите текстом.";
export const STT_UNAVAILABLE = "Голосовой ввод сейчас недоступен. Напишите запрос текстом.";
export const NO_TARGET = "Не нашла такую запись. Уточните название.";
export const NO_CONTEXT = "Какую запись?";
export const INTERNAL = "Что-то пошло не так. Попробуйте ещё раз.";
