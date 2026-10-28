// Нормализация до NLU (docs/05 раздел 4): пробелы, числительные → цифры, форматы времени,
// слова-паразиты, артефакты STT. Падежи не трогаем: title сохраняется как сказал пользователь.

export const MAX_TEXT = 500;

/** Границы слова для кириллицы (\b в JS работает только с латиницей). */
export const L = "(?<![а-яёa-z0-9])";
export const R = "(?![а-яёa-z0-9])";
export const word = (body, flags = "giu") => new RegExp(`${L}(?:${body})${R}`, flags);

const UNITS = {
  "ноль": 0, "один": 1, "одна": 1, "одну": 1, "два": 2, "две": 2, "три": 3, "четыре": 4, "пять": 5,
  "шесть": 6, "семь": 7, "восемь": 8, "девять": 9, "десять": 10, "одиннадцать": 11, "двенадцать": 12,
  "тринадцать": 13, "четырнадцать": 14, "пятнадцать": 15, "шестнадцать": 16, "семнадцать": 17,
  "восемнадцать": 18, "девятнадцать": 19,
};
const TENS = { "двадцать": 20, "тридцать": 30, "сорок": 40, "пятьдесят": 50 };
const ORDINALS = {
  "перв": 1, "втор": 2, "трет": 3, "четверт": 4, "пят": 5, "шест": 6, "седьм": 7, "восьм": 8,
  "девят": 9, "десят": 10, "одиннадцат": 11, "двенадцат": 12, "тринадцат": 13, "четырнадцат": 14,
  "пятнадцат": 15, "шестнадцат": 16, "семнадцат": 17, "восемнадцат": 18, "девятнадцат": 19,
  "двадцат": 20, "тридцат": 30,
};
export const MONTHS_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа",
  "сентября", "октября", "ноября", "декабря"];

const FILLERS = word("ну|слушай(?:те)?|пожалуйста|короче|типа|блин|э+-?э*|эм+|ммм+|значит|кстати");

function numbersToDigits(s) {
  // порядковые для дат: «двадцать пятое октября» → «25 октября»
  const ordStem = Object.keys(ORDINALS).join("|");
  s = s.replace(new RegExp(`${L}(?:(двадцать|тридцать)\\s+)?(${ordStem})(?:ое|ого|ье|ьего|ий)${R}(?=\\s+(?:${MONTHS_GEN.join("|")}))`, "giu"),
    (_, tens, stem) => String((tens ? TENS[tens.toLowerCase()] : 0) + ORDINALS[stem.toLowerCase()]));
  // количественные: «двадцать пять» → 25, «десять» → 10
  const unitRe = Object.keys(UNITS).join("|");
  s = s.replace(new RegExp(`${L}(${Object.keys(TENS).join("|")})(?:\\s+(${unitRe}))?${R}`, "giu"),
    (_, t, u) => String(TENS[t.toLowerCase()] + (u ? UNITS[u.toLowerCase()] : 0)));
  s = s.replace(new RegExp(`${L}(${unitRe})${R}`, "giu"), (_, u) => String(UNITS[u.toLowerCase()]));
  return s;
}

function timeFormats(s) {
  // «11 0-0», «15 0 0» (после замены «ноль-ноль») → «11:00»
  s = s.replace(/(\d{1,2})\s+0\s*-?\s*0(?!\d)/g, "$1:00");
  // «в 15.30», «в 15 30» → «в 15:30»
  s = s.replace(new RegExp(`${L}(в|к|на)\\s+(\\d{1,2})[.\\s](\\d{2})${R}`, "giu"), (m, p, h, mm) =>
    Number(h) <= 23 && Number(mm) <= 59 ? `${p} ${h}:${mm}` : m);
  return s;
}

/**
 * @returns {{ original: string, clean: string, match: string }}
 *   original — как пришло (trim, ≤500); clean — для разбора и title (регистр сохранён);
 *   match — lower + ё→е, только для сопоставления правил и поиска.
 */
export function normalize(input) {
  const original = String(input ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
  let s = original;
  s = s.replace(FILLERS, " ");
  s = numbersToDigits(s);
  s = timeFormats(s);
  s = s.replace(/\s*,(\s*,)+/g, ",").replace(/^[\s,]+|[\s,]+$/g, "").replace(/\s+,/g, ",");
  s = s.replace(/[.!]+$/, "").replace(/\s+/g, " ").trim();
  return { original, clean: s, match: toMatch(s) };
}

export const toMatch = (s) => s.toLowerCase().replace(/ё/g, "е");
