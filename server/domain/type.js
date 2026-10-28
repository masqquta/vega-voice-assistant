// Правило определения типа записи (docs/00 раздел 2, ЗАФИКСИРОВАНО). LLM может подсказать,
// но финальное слово за правилом:
//   1. «встреча / созвон / митинг / совещание / планёрка / ревью / собеседование» → meeting;
//   2. иначе «напомни / напомнить / не забудь» → reminder;
//   3. иначе → task.
// «Напомни про встречу с командой в 15:00» → meeting: первое правило сильнее.
import { word } from "../nlu/normalize.js";

const MEETING = word("встреч[а-я]*|созвон[а-я]*|митинг[а-я]*|совещани[а-я]*|планерк[а-я]*|ревью|собеседовани[а-я]*", "iu");
const REMINDER = word("напомни|напомнить|не забудь", "iu");

/** @param {string} text  нормализованный текст (lower, ё→е) */
export function typeFor(text) {
  if (MEETING.test(text)) return "meeting";
  if (REMINDER.test(text)) return "reminder";
  return "task";
}

export const TYPE_RU = { task: "задача", meeting: "встреча", reminder: "напоминание" };
