// «Человеческий» ответ: шаблон (templates.js) гарантирует точность, LLM делает его живым.
// Шаблон → LLM переписывает тепло и разговорно → проверка фактов → если хоть одно число, время,
// дата или название в «…» потерялось, вопрос стал утверждением, ответ раздулся или LLM не успела —
// отдаём исходный шаблон. Так «человечность» никогда не портит факты (принцип «LLM не считает даты»).
const SYSTEM = `Ты — Вега, голосовой ассистент для задач и встреч. Говоришь о себе в женском роде.
Тебе дают исходный ответ ассистента. Перепиши его так, как сказал бы живой внимательный помощник:
тепло, просто, разговорно, без канцелярита («Готово.», «Записала задачу» — это слишком сухо). Можно лёгкую интонацию.
ЖЁСТКИЕ ПРАВИЛА:
1. Сохрани ВСЕ факты дословно: числа, время (10:00), даты (29 октября), дни недели, названия в кавычках «…».
2. Ничего не добавляй от себя: ни новых фактов, ни советов, ни вопросов. Если в исходном есть вопрос — оставь его вопросом.
3. Одно-два коротких предложения. Без эмодзи, markdown, списков и кавычек вокруг всего ответа — это зачитает синтез речи.
4. Обращайся на «вы», о себе — в женском роде действием («записала», «поставила», «напомню»), без страдательного залога («запланирована», «назначена»).
5. Верни только новый текст ответа.

ПРИМЕРЫ ТОНА
Исходный: Готово. Напомню завтра, 29 октября, в 10:00: позвонить Ивану.
Ответ: Хорошо, завтра, 29 октября, в 10:00 напомню вам позвонить Ивану.
Исходный: Поставила встречу с командой завтра, 29 октября, в 15:00.
Ответ: Записала встречу с командой на завтра, 29 октября, в 15:00.
Исходный: На какое время поставить встречу?
Ответ: Во сколько поставить встречу?
Исходный: Отметила выполненной: «Купить билеты».
Ответ: Отлично, отметила «Купить билеты» как сделанное.
Исходный: Ничего похожего не нашла. Попробуйте описать иначе.
Ответ: Хм, ничего похожего не нашла. Попробуйте сказать по-другому.`;

// что обязано пережить перефразирование
function facts(text) {
  const out = new Set();
  for (const m of text.matchAll(/«[^»]+»/g)) out.add(m[0].slice(1, -1).toLowerCase());
  for (const m of text.matchAll(/\d{1,2}:\d{2}|\d+/g)) out.add(m[0]);
  for (const m of text.matchAll(/(?:январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр)[а-я]*/giu)) out.add(m[0].toLowerCase().slice(0, 5));
  for (const m of text.matchAll(/(?:понедельник|вторник|сред|четверг|пятниц|суббот|воскресень|сегодня|завтра|послезавтра)/giu)) out.add(m[0].toLowerCase());
  return [...out];
}

/** Перефраз прошёл проверку? */
export function keepsFacts(template, text) {
  if (!text || /\n|[*#_`]|[\u{1F300}-\u{1FAFF}]/u.test(text)) return false;
  if (text.length > Math.max(220, template.length * 2)) return false;
  if (template.trim().endsWith("?") !== text.trim().endsWith("?")) return false;
  const low = text.toLowerCase().replace(/ё/g, "е");
  return facts(template).every((f) => low.includes(f.replace(/ё/g, "е")));
}

// списки и находки — это перечисление фактов: их не трогаем, чтобы ничего не выпало
const SKIP = new Set(["list_events", "search"]);

/**
 * @param {{complete: Function, available: () => boolean}} llm  OpenAI-совместимый провайдер (Groq)
 * @returns {(out: {action: string, status: string, reply: string}, userText: string) => Promise<string>}
 */
export function createHumanizer({ llm, timeoutMs = 2500, log = () => {} }) {
  return async function humanize(out, userText) {
    if (!llm?.available() || !out.reply || (SKIP.has(out.action) && out.status === "ok")) return out.reply;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const text = (await llm.complete([
        { role: "system", text: SYSTEM },
        { role: "user", text: `Пользователь сказал: «${userText}»\nИсходный ответ: ${out.reply}` },
      ], { signal: ctl.signal, json: false, maxTokens: 160 })).trim().replace(/^["«]|["»]$/g, "");
      if (keepsFacts(out.reply, text)) return text;
      log({ event: "humanize_rejected", template: out.reply, text });
    } catch (e) {
      log({ event: "humanize_error", error: e.name === "AbortError" ? "timeout" : e.message });
    } finally { clearTimeout(timer); }
    return out.reply;
  };
}
