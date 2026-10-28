// Стемминг для FTS (docs/04 раздел 3). SQLite unicode61 кириллицу не стеммит, поэтому индексируем
// готовые стемы, а запрос стеммим тем же стеммером (Snowball russian) — так «презентацию» находит
// «презентация», а «Марии» — «Марией».
import snowball from "snowball-stemmers";

const ru = snowball.newStemmer("russian");

/** Служебные слова запроса: не несут смысла для поиска. */
export const STOP = new Set([
  "найди", "найти", "поищи", "задача", "задачу", "задачи", "запись", "записи", "про", "когда", "когдато", "у", "меня",
  "был", "была", "было", "были", "я", "мне", "мой", "мою", "мои", "что", "там", "то", "тот", "та", "ту", "это",
  "и", "в", "во", "на", "с", "со", "по", "о", "об", "для", "к", "до", "за", "из", "её", "ее", "его", "их",
  "ставил", "ставила", "собирался", "собиралась", "какой", "какая", "какую", "вспомни", "покажи", "ли",
]);

// Небольшой словарь синонимов — страховка, пока не посчитаны эмбеддинги (без ключа Yandex/GigaChat
// семантического поиска нет). Ключ — стем запроса, значение — стемы, которыми расширяем запрос.
export const SYNONYMS = {
  "слайд": ["презентац"], "презентац": ["слайд"],
  "документ": ["договор"], "контракт": ["договор"],
  "созвон": ["встреч", "звонк"], "встреч": ["созвон"], "митинг": ["встреч"],
  "звонк": ["позвон"], "звонок": ["позвон"], "позвон": ["звонк"],
  "счет": ["оплат"], "оплат": ["счет"],
};

export const toMatch = (s) => String(s ?? "").toLowerCase().replace(/ё/g, "е");

/** Слова (lower, ё→е) без пунктуации. */
export function words(text) {
  return toMatch(text).replace(/[-‐]/g, "").split(/[^а-яa-z0-9]+/u).filter((w) => w.length >= 2);
}

export const stem = (w) => ru.stem(w);
export const stems = (text) => words(text).map(stem);

/** Колонка search_text: стемы title + notes + participants. */
export function searchText({ title, notes, participants }) {
  const p = Array.isArray(participants) ? participants.join(" ") : participants || "";
  return [...new Set(stems(`${title || ""} ${notes || ""} ${p}`))].join(" ");
}

/** Стемы запроса без стоп-слов. */
export function queryStems(q) {
  return [...new Set(words(q).filter((w) => !STOP.has(w)).map(stem).filter((s) => s.length >= 2))];
}
