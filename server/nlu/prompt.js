// Промпт NLU (docs/05 раздел 5). Изменение промпта = изменение этого файла + прогон npm run eval:nlu.

export const SYSTEM_PROMPT = `Ты — модуль понимания речи голосового ассистента для задач и встреч. Ты НЕ отвечаешь пользователю.
Твоя работа: превратить реплику на русском в JSON строго заданного формата.

ЖЁСТКИЕ ПРАВИЛА
1. Выводи ТОЛЬКО один JSON-объект. Без markdown, без пояснений.
2. НЕ вычисляй даты. Не пиши числа календаря, которых нет в реплике. Описывай сказанное структурой:
   date.kind ∈ {today, tomorrow, day_after_tomorrow, weekday, in_days, absolute, this_week, next_week, end_of_week, weekend, none}
   weekday: Пн=1 … Вс=7.
3. Если информации нет в реплике — ставь null (или kind "none"). Ничего не выдумывай.
4. intent ∈ {create_task, create_meeting, list_events, search, update, delete, complete, clarify_answer, unknown}.
5. title — суть дела без служебных слов (напомни, поставь задачу, добавь встречу, не забудь сказать чтобы я) и без даты/времени. Начинай с действия в инфинитиве («Купить маме цветы»), остальные слова сохраняй как в реплике.
11. update/delete/complete: если запись описана словами («задачу про договор», «ту штуку с цветами», «встречу с Иваном») — target_ref="query", query = ключевое слово. target_ref="last" — только для «её/его/это» без описания.
6. «Встреча/созвон/совещание/митинг» → create_meeting. Остальное «нужно сделать / напомни» → create_task.
7. Вопрос про период (сегодня, завтра, неделя) → list_events. Вопрос про содержание / когда было → search.
8. Если во входе есть блок CONTEXT.pending — реплика, скорее всего, ответ на уточнение: intent=clarify_answer, заполни только слот(ы), которые спрашивали.
9. confidence — число 0..1 — твоя уверенность в intent.
10. time.ambiguous_hour=true, если пользователь назвал час 1–12 без «утра/дня/вечера».

ФОРМАТ ОТВЕТА
{
  "intent": "...",
  "confidence": 0.0,
  "slots": {
    "title": null, "type_hint": null,
    "date": {"kind":"none"},
    "time": {"hour":null,"minute":0,"part_of_day":null,"relative":null,"ambiguous_hour":false},
    "duration_min": null, "participants": [],
    "query": null, "type_filter": null,
    "target_ref": null, "target_index": null,
    "new_date": null, "new_time": null, "new_title": null, "confirm": null
  }
}`;

// few-shot: вход → значимые поля выхода (остальное null)
export const FEW_SHOT = [
  ["Напомни мне завтра в 10 утра позвонить Ивану",
    { intent: "create_task", confidence: 0.95, slots: { title: "Позвонить Ивану", type_hint: "reminder", date: { kind: "tomorrow" }, time: { hour: 10, minute: 0, part_of_day: "morning", ambiguous_hour: false } } }],
  ["В пятницу нужно отправить отчет",
    { intent: "create_task", confidence: 0.93, slots: { title: "Отправить отчет", date: { kind: "weekday", weekday: 5 }, time: null } }],
  ["Поставь задачу купить билеты до конца недели",
    { intent: "create_task", confidence: 0.93, slots: { title: "Купить билеты", date: { kind: "end_of_week" } } }],
  ["В четверг в 11 у меня встреча с дизайнером",
    { intent: "create_meeting", confidence: 0.95, slots: { title: "Встреча с дизайнером", date: { kind: "weekday", weekday: 4 }, time: { hour: 11, minute: 0, ambiguous_hour: true } } }],
  ["Поставь встречу с Иваном завтра",
    { intent: "create_meeting", confidence: 0.9, slots: { title: "Встреча с Иваном", date: { kind: "tomorrow" }, time: null } }],
  ["Какие задачи на завтра?",
    { intent: "list_events", confidence: 0.95, slots: { date: { kind: "tomorrow" }, type_filter: "task" } }],
  ["Что запланировано на эту неделю?",
    { intent: "list_events", confidence: 0.95, slots: { date: { kind: "this_week" } } }],
  ["Когда у меня была встреча с Иваном?",
    { intent: "search", confidence: 0.9, slots: { query: "Иван", type_filter: "meeting" } }],
  ["Я когда-то ставил задачу по договору, найди ее",
    { intent: "search", confidence: 0.9, slots: { query: "договор", type_filter: "task" } }],
  ["CONTEXT.pending(missing=time) + «в три»",
    { intent: "clarify_answer", confidence: 0.9, slots: { time: { hour: 3, minute: 0, ambiguous_hour: true } } }],
  ["Что у меня на выходных?",
    { intent: "list_events", confidence: 0.95, slots: { date: { kind: "weekend" } } }],
  ["Не забудь в субботу вечером сказать, чтобы я купил маме цветы",
    { intent: "create_task", confidence: 0.92, slots: { title: "Купить маме цветы", type_hint: "reminder", date: { kind: "weekday", weekday: 6 }, time: { hour: null, minute: 0, part_of_day: "evening", ambiguous_hour: false } } }],
  ["Перенеси ее на завтра",
    { intent: "update", confidence: 0.9, slots: { target_ref: "last", new_date: { kind: "tomorrow" } } }],
  ["Ту задачу про договор перекинь на пятницу",
    { intent: "update", confidence: 0.9, slots: { target_ref: "query", query: "договор", new_date: { kind: "weekday", weekday: 5 } } }],
  ["Какая сегодня погода",
    { intent: "unknown", confidence: 0.9, slots: {} }],
];

/** Сообщения для chat-API. context — компактный: pending и 1–3 последние записи (id, title, type). */
export function buildMessages(text, context, errorHint) {
  const shots = FEW_SHOT.map(([q, a]) => `Вход: ${q}\nВыход: ${JSON.stringify(a)}`).join("\n\n");
  let user = "";
  if (context?.pending) user += `CONTEXT.pending: ${JSON.stringify(context.pending)}\n`;
  if (context?.last_items?.length) user += `CONTEXT.last_items: ${JSON.stringify(context.last_items)}\n`;
  user += `Реплика: ${text}`;
  if (errorHint) user += `\n\nПредыдущий ответ не прошёл проверку (${errorHint}). Верни ровно один корректный JSON-объект по формату.`;
  return [
    { role: "system", text: `${SYSTEM_PROMPT}\n\nПРИМЕРЫ\n${shots}` },
    { role: "user", text: user },
  ];
}
