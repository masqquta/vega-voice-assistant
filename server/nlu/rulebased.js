// RuleBased-парсер — третий слой NLU (docs/05 раздел 6): работает без LLM и без ключей.
// Возвращает тот же NluResult, что и LLM: intent + слоты с временными объектами (не датами).
// Порядок проверки: complete/delete/update → search → list_events → meeting → task.
import { L, R, word, MONTHS_GEN, toMatch } from "./normalize.js";

// винительный («в пятницу») и дательный («к пятнице») падежи
const WEEKDAYS = [
  ["понедельник[уа]?", 1], ["вторник[уа]?", 2], ["сред[аеуы]", 3], ["четверг[уа]?", 4], ["пятниц[аеуы]", 5],
  ["суббот[аеуы]", 6], ["воскресень[еюя]", 7],
];
const MEETING_WORD = "встреч[а-я]*|созвон[а-я]*|совещани[а-я]*|митинг[а-я]*|планерк[а-я]*|планёрк[а-я]*|ревью|собеседовани[а-я]*|демо";
const MEETING_NOMINATIVE = [
  [/^встреч/i, "Встреча"], [/^созвон/i, "Созвон"], [/^совещани/i, "Совещание"], [/^митинг/i, "Митинг"],
  [/^план[её]рк/i, "Планёрка"], [/^ревью/i, "Ревью"], [/^собеседовани/i, "Собеседование"], [/^демо/i, "Демо"],
];

// встреча/созвон/митинг без описания — не название (U-3), а эти слова сами по себе называют событие
const SELF_TITLED = new Set(["Планёрка", "Совещание", "Ревью", "Собеседование", "Демо"]);

const T = {
  complete: word("отметь|отметить|отмечай|выполнил[аи]?|выполнено|закрой|закрыть|готово|сделал[аи]?|сделано", "iu"),
  delete: word("удали|удалить|отмени|отменить|убери|убрать", "iu"),
  update: word("перенеси|перенести|измени|изменить|поменяй|поменять|передвинь|сдвинь", "iu"),
  search: new RegExp(`${L}(?:найди|найти|поищи|поиск|вспомни|ставил[аи]?|собирал(?:ся|ась)|что там было|что-?то про|когда[^?]{0,30}${L}(?:был|была|было|были)${R})`, "iu"),
  list: new RegExp(`${L}(?:что у меня|что запланир|какие(?: у меня)? (?:задачи|планы|встречи|дела|напоминания|созвоны)|какой (?:у меня )?план|покажи|есть ли|мои (?:дела|встречи|задачи|планы)|что на (?:сегодня|завтра|послезавтра|неделе|этой неделе)|расписание|планы на)`, "iu"),
  meeting: word(MEETING_WORD, "iu"),
  reminder: word("напомни|напомнить|напоминани[а-я]*|не забудь|не забыть", "iu"),
  task: word("напомни|напомнить|не забудь|не забыть|добавь|добавить|поставь|поставить|нужно|надо|запиши|записать|создай|создать|задач[а-я]*", "iu"),
  question: new RegExp(`^(?:какая|какой|какое|сколько|кто|где|почему|зачем|как|что такое)${R}`, "iu"),
  yes: new RegExp(`^(?:да|ага|угу|конечно|давай|хорошо|ок|окей|ставь|поставь|верно|согласен|согласна)${R}`, "iu"),
  no: new RegExp(`^(?:нет|не надо|не нужно|не ставь|отмена|не)${R}`, "iu"),
};

const INDEX_WORDS = [["перв[а-я]*|1", 1], ["втор[а-я]*|2", 2], ["трет[а-я]*|3", 3], ["четв[её]рт[а-я]*|4", 4], ["пят[а-я]*|5", 5]];

/**
 * Достаёт из фразы временные объекты (дату, время, длительность) и возвращает остаток.
 * Это описание сказанного, не даты: даты считает DateResolver.
 */
export function extractWhen(input) {
  let s = ` ${input} `;
  let date = { kind: "none" }, time = null, duration_min = null, weekend = false;
  const cut = (re, fn) => { s = s.replace(re, (...m) => (fn(...m) === false ? m[0] : " ")); };
  const setTime = (patch) => { time = { hour: null, minute: 0, part_of_day: null, relative: null, ambiguous_hour: false, ...(time || {}), ...patch }; };

  // длительность встречи: «на 2 часа», «на полчаса», «на 30 минут», «на полтора часа»
  cut(new RegExp(`${L}на\\s+(?:(\\d+)\\s*(час(?:а|ов)?|минут[уы]?|мин)|(полчаса|час|полтора часа))${R}`, "giu"), (_, n, unit, word_) => {
    if (word_) { duration_min = { "полчаса": 30, "час": 60, "полтора часа": 90 }[word_.toLowerCase()]; return; }
    duration_min = /^час/i.test(unit) ? Number(n) * 60 : Number(n);
  });
  // относительные: «через 2 часа», «через 30 минут», «через 3 дня», «через неделю», «через полчаса»
  cut(new RegExp(`${L}через\\s+(?:(\\d+|пару|несколько)\\s+)?(полчаса|час(?:а|ов)?|минут[уы]?|мин|дн(?:я|ей)|день|недел(?:ю|и|ь))${R}`, "giu"), (_, n, unit) => {
    const k = n == null ? 1 : n === "пару" ? 2 : n === "несколько" ? 3 : Number(n);
    const u = unit.toLowerCase();
    if (u === "полчаса") setTime({ relative: { amount: 30, unit: "minute" } });
    else if (u.startsWith("час")) setTime({ relative: { amount: k, unit: "hour" } });
    else if (u.startsWith("мин")) setTime({ relative: { amount: k, unit: "minute" } });
    else if (u.startsWith("недел")) date = { kind: "in_days", offset: 7 * k };
    else date = { kind: "in_days", offset: k };
  });
  // неделя
  cut(new RegExp(`${L}(?:до|к)\\s+конц[ауе]\\s+недели${R}`, "giu"), () => { date = { kind: "end_of_week" }; });
  cut(new RegExp(`${L}(?:на\\s+)?(?:следующ(?:ей|ую|ая)|будущ(?:ей|ую))\\s+недел[еюи]${R}`, "giu"), () => { date = { kind: "next_week" }; });
  cut(new RegExp(`${L}(?:на\\s+)?(?:эт(?:ой|у|а))\\s+недел[еюи]${R}|${L}на\\s+неделе${R}`, "giu"), () => { date = { kind: "this_week" }; });
  cut(new RegExp(`${L}(?:на|в)\\s+выходн(?:ых|ые)${R}`, "giu"), () => { weekend = true; });
  // сегодня / завтра / послезавтра
  cut(new RegExp(`${L}(?:на\\s+|к\\s+)?(сегодня|завтра|послезавтра)${R}`, "giu"), (_, w) => {
    date = { kind: { "сегодня": "today", "завтра": "tomorrow", "послезавтра": "day_after_tomorrow" }[w.toLowerCase()] };
  });
  // дни недели
  for (const [stem, n] of WEEKDAYS) {
    cut(new RegExp(`${L}(?:(?:в|во|на|к|до)\\s+)?(?:${stem})${R}`, "giu"), () => { date = { kind: "weekday", weekday: n }; });
  }
  // абсолютные даты: «25 октября», «5 ноября 2027», «25.10»
  cut(new RegExp(`${L}(?:(?:на|к|до)\\s+)?(\\d{1,2})(?:-?го)?\\s+(${MONTHS_GEN.join("|")})(?:\\s+(\\d{4})(?:\\s*(?:г\\.?|года))?)?${R}`, "giu"), (_, d, mon, y) => {
    date = { kind: "absolute", day: Number(d), month: MONTHS_GEN.indexOf(mon.toLowerCase()) + 1, ...(y ? { year: Number(y) } : {}) };
  });
  cut(new RegExp(`${L}(?:(?:на|к|до)\\s+)?(\\d{1,2})\\.(\\d{1,2})(?:\\.(\\d{2,4}))?${R}`, "gu"), (m, d, mo, y) => {
    if (Number(mo) > 12 || Number(d) > 31) return false;
    date = { kind: "absolute", day: Number(d), month: Number(mo), ...(y ? { year: y.length === 2 ? 2000 + Number(y) : Number(y) } : {}) };
  });
  // время суток словами
  cut(new RegExp(`${L}(?:в\\s+)?(полдень|полночь)${R}`, "giu"), (_, w) => {
    setTime({ hour: w.toLowerCase() === "полдень" ? 12 : 0, minute: 0, ambiguous_hour: false });
  });
  // «в 15:30», «к 9:00», «на 10:00», «15:00»
  cut(new RegExp(`${L}(?:(?:в|к|на|около|с)\\s+)?(\\d{1,2}):(\\d{2})(?:\\s+(утра|дня|вечера|ночи))?${R}`, "giu"), (_, h, m, part) => {
    if (Number(h) > 23 || Number(m) > 59) return false;
    setTime({ hour: Number(h), minute: Number(m), part_of_day: partOf(part), ambiguous_hour: !part && Number(h) >= 1 && Number(h) <= 12 });
  });
  // «в 10 утра», «в 3 часа дня», «в 11», «к 9»
  cut(new RegExp(`${L}(?:в|к|около|на)\\s+(\\d{1,2})(?:\\s*(?:час(?:а|ов)?|ч\\.?))?(?:\\s+(утра|дня|вечера|ночи))?${R}`, "giu"), (_, h, part) => {
    if (Number(h) > 23) return false;
    setTime({ hour: Number(h), minute: 0, part_of_day: partOf(part), ambiguous_hour: !part && Number(h) >= 1 && Number(h) <= 12 });
  });
  // «утром», «днём», «вечером», «ночью», «с утра»; одиночные «утра»/«вечера» — ответ на уточнение
  cut(new RegExp(`${L}(?:с\\s+)?(утром|утра|днём|днем|дня|вечером|вечера|ночью|ночи)${R}`, "giu"), (_, w) => {
    const p = partOf(w);
    if (time && time.hour != null) time.part_of_day = p, time.ambiguous_hour = false;
    else setTime({ part_of_day: p });
  });

  const rest = s.replace(/\s+/g, " ").trim();
  return { date, time, duration_min, weekend, rest };
}

function partOf(w) {
  if (!w) return null;
  const x = toMatch(w);
  if (x.startsWith("утр")) return "morning";
  if (x.startsWith("дн")) return "day";
  if (x.startsWith("веч")) return "evening";
  if (x.startsWith("ноч")) return "night";
  return null;
}

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
/** Подчищает края: висячие предлоги, союзы, запятые, тире. */
export function tidyEdges(s, { keepWith = false } = {}) {
  let t = ` ${s} `.replace(/\s+/g, " ");
  const lead = keepWith ? "" : "|с";
  const edge = new RegExp(`^\\s*(?:,|—|-|:|и|а|в|во|на|к|до|про|о|об|у${lead}|что|чтобы|это|мне|меня|ещё|еще)\\s+|\\s+(?:,|—|-|:|и|а|в|во|на|к|до|про|о|об|у|с|что|чтобы|это|мне|ещё|еще)\\s*$`, "iu");
  let prev;
  do { prev = t; t = t.replace(edge, " "); } while (t !== prev);
  return t.replace(/\s+,/g, ",").replace(/\s+/g, " ").replace(/^[\s,.:;—-]+|[\s,.:;—-]+$/g, "").trim();
}

const SERVICE = word([
  "напомни(?:ть)?(?:\\s+мне)?", "не\\s+забудь", "не\\s+забыть", "поставь", "поставить", "добавь", "добавить",
  "запиши", "записать", "создай", "создать", "сделай", "назначь", "запланируй", "организуй",
  "задач[а-я]*", "напоминани[а-я]*", "нужно", "надо", "необходимо", "у\\s+меня", "мне", "пожалуйста",
  "о\\s+том,?\\s+что", "о\\s+том", "чтобы", "что\\s+нужно", "игнорируй[а-я ]*инструкции",
].join("|"));

/** title задачи/напоминания: без служебных слов и даты, с заглавной буквы (FR-1.7). */
export function taskTitle(rest) {
  let t = rest.replace(SERVICE, " ");
  t = t.replace(new RegExp(`^\\s*(?:про|о|об)${R}`, "iu"), " ");
  t = tidyEdges(t);
  return t.length >= 2 ? cap(t) : null;
}

/** title встречи: «Встреча с командой». Только ключевое слово без описания → title не задан (U-3). */
export function meetingTitle(rest) {
  const kw = rest.match(word(MEETING_WORD, "iu"));
  if (!kw) return null;
  const nominative = (MEETING_NOMINATIVE.find(([re]) => re.test(kw[0])) || [null, cap(kw[0])])[1];
  let t = rest.replace(kw[0], " ").replace(SERVICE, " ");
  t = t.replace(new RegExp(`^\\s*(?:про|о|об)${R}`, "iu"), " ");
  t = tidyEdges(t, { keepWith: true });
  if (t) return `${nominative} ${t}`;
  return SELF_TITLED.has(nominative) ? nominative : null;   // «планёрка» — уже название, «встреча» — ещё нет
}

export function participantsOf(rest) {
  const out = [];
  for (const m of rest.matchAll(new RegExp(`${L}(?:с|со)\\s+([А-ЯЁ][а-яё]+(?:\\s+[А-ЯЁ][а-яё]+)?)`, "gu"))) out.push(m[1]);
  return out;
}

function typeFilterOf(m) {
  if (/встреч|созвон|совещан|планерк|митинг/.test(m)) return "meeting";
  if (/напоминан/.test(m)) return "reminder";
  if (/задач|дела|дело/.test(m)) return "task";
  return null;
}

const SEARCH_NOISE = word([
  "найди|найти|поищи|поиск|вспомни|покажи", "задач[а-я]*", "встреч[а-я]*", "напоминани[а-я]*", "запис[а-я]*",
  "когда-?то|когда", "у\\s+меня", "был|была|было|были", "я", "ставил[аи]?|собирал(?:ся|ась)", "её|ее|его|их",
  "что\\s+там\\s+было|что-?то|что", "про|по|о|об|для|с|со|в|на|тот|та|то|ту|мой|мою|мои|какой|какую|какая",
  "отметь|отметить|выполнил[аи]?|выполненн[а-я]*|сделанн[а-я]*|как|закрой|готово|сделал[аи]?",
  "удали|удалить|отмени|отменить|убери|убрать", "перенеси|перенести|измени|изменить|поменяй|передвинь|сдвинь",
  "игнорируй[а-я]*|инструкци[а-я]*", "пожалуйста|мне|надо|нужно",
].join("|"));

/** Поисковый запрос: суть без служебных слов («Найди задачу про презентацию» → «презентацию»). */
export function queryOf(rest) {
  const q = tidyEdges(rest.replace(SEARCH_NOISE, " ").replace(/[?,.!]/g, " "));
  return q.length >= 2 ? q : null;
}

function indexOf(m) {
  for (const [re, n] of INDEX_WORDS) if (new RegExp(`^(?:${re})${R}`, "iu").test(m.trim())) return n;
  return null;
}

const EMPTY_SLOTS = () => ({
  title: null, type_hint: null, date: { kind: "none" }, time: null, duration_min: null, participants: [],
  query: null, type_filter: null, target_ref: null, target_index: null,
  new_date: { kind: "none" }, new_time: null, new_title: null, confirm: null,
});

/**
 * @param {{clean: string, match: string}} norm  результат normalize()
 * @param {{pending?: object}} ctx
 * @returns {{intent: string, confidence: number, slots: object}}
 */
export function parseRuleBased(norm, ctx = {}) {
  const { clean } = norm;
  const m = norm.match;
  const slots = EMPTY_SLOTS();
  const when = extractWhen(clean);
  const pending = ctx.pending;

  // ответ на уточнение: да/нет, «первую», время/дата/название без нового намерения
  if (pending) {
    const short = m.split(/\s+/).length <= 6;
    if (pending.kind === "confirm" && (T.yes.test(m) || T.no.test(m))) {
      return { intent: "clarify_answer", confidence: 0.9, slots: { ...slots, confirm: T.no.test(m) && !T.yes.test(m) ? "no" : "yes" } };
    }
    if (pending.kind === "choose") {
      const idx = indexOf(m.replace(/^(?:давай|ну|номер)\s+/, ""));
      if (idx) return { intent: "clarify_answer", confidence: 0.9, slots: { ...slots, target_index: idx } };
    }
    // новое полноценное намерение (свой триггер) — это смена темы, а не ответ на вопрос
    const strong = T.complete.test(m) || T.delete.test(m) || T.update.test(m) || T.search.test(m) || T.list.test(m)
      || (pending.kind !== "confirm" && (T.task.test(m) || (T.meeting.test(m) && !pending.missing?.includes("title"))));
    if (!strong && short) {
      const s = { ...slots, date: when.date, time: when.time, duration_min: when.duration_min };
      if (pending.kind === "confirm" && T.yes.test(m)) s.confirm = "yes";
      const leftover = tidyEdges(when.rest.replace(T.yes, " "));
      if (pending.missing?.includes("title") && leftover) {
        s.title = pending.intent === "create_meeting" ? (meetingTitle(leftover) || cap(leftover)) : taskTitle(leftover);
      }
      if (pending.missing?.includes("target") && leftover) { s.target_ref = "query"; s.query = queryOf(leftover) || leftover; }
      return { intent: "clarify_answer", confidence: 0.85, slots: s };
    }
  }

  // 1. complete / delete / update
  for (const intent of ["complete", "delete", "update"]) {
    if (!T[intent].test(m)) continue;
    const s = { ...slots };
    if (word("её|ее|его|эту|это|последн[а-я]*", "iu").test(m)) s.target_ref = "last";
    const idxMatch = m.match(new RegExp(`${L}(перв[а-я]*|втор[а-я]*|трет[а-я]*)${R}`, "iu"));
    if (!s.target_ref && idxMatch && !/задач|встреч/.test(m.replace(idxMatch[0], ""))) { s.target_ref = "index"; s.target_index = indexOf(idxMatch[1]); }
    if (intent === "update") { s.new_date = when.date; s.new_time = when.time; }
    const q = queryOf(when.rest);
    if (!s.target_ref && q) { s.target_ref = "query"; s.query = q; }
    s.type_filter = typeFilterOf(m);
    if (word("все|всё|всех", "iu").test(m)) s.query = null, s.target_ref = null;  // массовые действия не поддерживаем
    return { intent, confidence: 0.9, slots: s };
  }
  // 2. search
  if (T.search.test(m)) {
    return { intent: "search", confidence: 0.9, slots: { ...slots, query: queryOf(when.rest), type_filter: typeFilterOf(m) } };
  }
  // 3. list_events
  if (T.list.test(m)) {
    const s = { ...slots, date: when.date, type_filter: typeFilterOf(m) };
    const who = participantsOf(when.rest);
    if (who.length) s.query = who.join(" ");
    if (/выполненн|сделанн|закрыт/.test(m)) s.status = "done";
    return { intent: "list_events", confidence: 0.9, slots: s };
  }
  if (T.question.test(m)) return { intent: "unknown", confidence: 0, slots };
  // 4. meeting
  if (T.meeting.test(m)) {
    return { intent: "create_meeting", confidence: 0.9, slots: {
      ...slots, title: meetingTitle(when.rest), type_hint: "meeting", date: when.date, time: when.time,
      duration_min: when.duration_min, participants: participantsOf(when.rest), weekend: when.weekend,
    } };
  }
  // 5. task / reminder
  const hasWhen = when.date.kind !== "none" || when.time;
  if (T.task.test(m) || hasWhen) {
    const title = taskTitle(when.rest);
    if (!T.task.test(m) && !title) return { intent: "unknown", confidence: 0, slots };
    return { intent: "create_task", confidence: T.task.test(m) ? 0.9 : 0.6, slots: {
      ...slots, title, type_hint: T.reminder.test(m) ? "reminder" : null, date: when.date, time: when.time, weekend: when.weekend,
    } };
  }
  return { intent: "unknown", confidence: 0, slots };
}
