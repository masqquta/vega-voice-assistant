// Схема NluResult (docs/05 раздел 2). Валидатор приводит ответ любой реализации к одному виду:
// неизвестные поля игнорируются, отсутствующие заполняются дефолтами, дата не из закрытого
// набора kind (в том числе дата строкой «2026-10-22») считается none.
import { z } from "zod";
import { DATE_KINDS } from "../dates/resolver.js";

export const INTENTS = ["create_task", "create_meeting", "list_events", "search", "update", "delete",
  "complete", "clarify_answer", "unknown"];
export const TYPES = ["task", "meeting", "reminder"];
export const CONFIDENCE_MIN = 0.5;

const nullable = (s) => s.nullable().optional().catch(null);
const int = (lo, hi) => z.coerce.number().int().min(lo).max(hi);

export const DateObj = z.object({
  kind: z.enum(DATE_KINDS),
  weekday: int(1, 7).optional(),
  offset: int(1, 3650).optional(),
  day: int(1, 31).optional(),
  month: int(1, 12).optional(),
  year: int(2000, 2100).optional(),
}).catch({ kind: "none" });

export const TimeObj = z.object({
  hour: nullable(int(0, 23)),
  minute: int(0, 59).optional().catch(0),
  part_of_day: nullable(z.enum(["morning", "day", "evening", "night"])),
  relative: nullable(z.object({ amount: int(1, 100000), unit: z.enum(["minute", "hour"]) })),
  ambiguous_hour: z.boolean().optional().catch(false),
}).nullable().catch(null);

export const Slots = z.object({
  title: nullable(z.string().trim().min(1).max(200)),
  type_hint: nullable(z.enum(TYPES)),
  date: DateObj.optional().default({ kind: "none" }),
  time: TimeObj.optional().default(null),
  duration_min: nullable(int(5, 1440)),
  participants: z.array(z.string().max(100)).max(20).optional().catch([]).default([]),
  query: nullable(z.string().trim().min(1).max(200)),
  type_filter: nullable(z.enum(TYPES)),
  target_ref: nullable(z.enum(["last", "index", "query"])),
  target_index: nullable(int(1, 20)),
  new_date: DateObj.optional().default({ kind: "none" }),
  new_time: TimeObj.optional().default(null),
  new_title: nullable(z.string().trim().min(1).max(200)),
  confirm: nullable(z.enum(["yes", "no"])),
}).passthrough();

export const NluResult = z.object({
  intent: z.enum(INTENTS),
  confidence: z.coerce.number().min(0).max(1).catch(0),
  slots: Slots.optional().default({}),
});

/** Разбор ответа LLM/правил. Бросает ошибку с понятным текстом — её отдаём LLM в ретрае. */
export function validateNlu(raw) {
  const parsed = NluResult.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`schema: ${issue.path.join(".") || "root"} ${issue.message}`);
  }
  // временной объект без обязательных параметров — тоже none
  const s = parsed.data.slots;
  for (const k of ["date", "new_date"]) {
    const d = s[k];
    if ((d.kind === "weekday" && !d.weekday) || (d.kind === "in_days" && !d.offset) ||
        (d.kind === "absolute" && !d.day)) s[k] = { kind: "none" };   // число без месяца допустимо: «на 30-е»
  }
  return parsed.data;
}

/** Достаёт JSON из ответа модели: снимает ```json, обрезает до внешних фигурных скобок. */
export function extractJson(text) {
  if (typeof text !== "string") throw new Error("empty response");
  let t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("no JSON object");
  t = t.slice(a, b + 1);
  return JSON.parse(t);
}
