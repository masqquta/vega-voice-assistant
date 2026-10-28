// Пайплайн ассистента (docs/02 раздел 4): нормализация → контекст → NLU → слияние с pending →
// валидация слотов → DateResolver → тип по правилу → бизнес-действие → шаблон ответа → контекст и лог.
// Голос и текст идут через один и тот же handle() (FR-5.2).
import { normalize } from "../nlu/normalize.js";
import { CONFIDENCE_MIN } from "../nlu/schema.js";
import { resolve, resolveDate, resolveTime } from "../dates/resolver.js";
import { typeFor } from "../domain/type.js";
import * as items from "./items.js";
import { search, ambiguous } from "./search.js";
import { queryStems } from "./stem.js";
import { embedItem } from "./embeddings.js";
import { loadContext, saveContext } from "../context/store.js";
import * as R from "../reply/templates.js";

const MASS = /(?<![а-яё])(?:все|всё|всех)(?![а-яё])/iu;
const hhmm = (t) => `${String(t.hour).padStart(2, "0")}:${String(t.minute).padStart(2, "0")}`;

/**
 * @param {{db: import("better-sqlite3").Database, nlu: {parse: Function}, embedder?: object|null,
 *          log?: (event: object) => void}} deps
 */
export function createAssistant({ db, nlu, embedder = null, log = () => {} }) {
  const clarify = (action, missing, reply, data = {}) => ({ action, status: "need_clarification", data, reply, missing });

  function embedLater(row) {
    if (!embedder || !row) return;
    setImmediate(() => embedItem(db, embedder, row).catch((e) => log({ event: "embedding_error", item_id: row.id, error: e.message })));
  }

  // ---------------------------------------------------------------- создание

  async function createFlow(f, env, attempts = 0) {
    const { ctx, now } = env;
    const type = f.type;
    const action = type === "meeting" ? "create_meeting" : "create_task";
    const setPending = (missing, question, extra = {}) => {
      ctx.pending = { kind: "slot_filling", intent: action, filled: f, missing, attempts, question, ...extra };
      return clarify(action, missing, question);
    };

    const r = resolve({ date: f.date, time: f.time }, now, { type, mode: "create" });
    const missing = [];
    if (!f.title) missing.push("title");
    if (f.weekend && (f.date?.kind || "none") === "none" && !f.time?.relative) {
      return setPending([...missing, "date"], missing.length ? R.ask(["title"], { type }) : R.ASK_WEEKEND);
    }
    if (r.need === "night") return setPending([...missing, "time"], missing.length ? R.ask(["title"], { type }) : R.ASK_NIGHT, { night: true });
    if (r.need === "ampm") {
      if (missing.length) return setPending([...missing, "time"], R.ask(["title"], { type }));
      return setPending(["ampm"], R.ask(["ampm"], { hour: r.ampm_hour }));
    }
    if (r.need === "date") missing.push("date");
    if (type !== "task" && !r.need) {
      if (!r.due_date && !r.due_time) missing.push("date", "time");
      else if (!r.due_time) missing.push("time");
    }
    if (missing.length) {
      let q;
      if (missing.includes("title") && missing.length > 1) {
        q = type === "meeting" ? "С кем и когда встреча?" : type === "reminder" ? "О чём напомнить?" : "Что именно записать?";
      } else q = R.ask(missing, { type });
      return setPending(missing, q);
    }
    if (r.need === "past") {
      ctx.pending = { kind: "confirm", intent: action, filled: f, suggestion: r.suggestion, missing: ["confirm"], attempts, question: R.askPast(r.suggestion.due_time) };
      return clarify(action, ["confirm"], ctx.pending.question);
    }
    return createItem(f, { due_date: r.due_date, due_time: r.due_time }, env);
  }

  function createItem(f, due, env) {
    const { ctx, now, tz, userId, nowSec } = env;
    const type = f.type;
    const row = items.insertItem(db, userId, {
      type, title: f.title, title_raw: f.title_raw, due_date: due.due_date, due_time: due.due_time,
      duration_min: type === "meeting" ? f.duration_min || 60 : null, participants: type === "meeting" ? f.participants : null,
      source: "assistant",
    }, { tz, nowSec });
    const conflicts = type === "meeting"
      ? items.findConflicts(db, userId, { start: row.start_utc, durationMin: row.duration_min, excludeId: row.id }).map((c) => items.serialize(c, tz))
      : [];
    embedLater(row);
    ctx.pending = null;
    ctx.last_items = [row.id];
    const item = items.serialize(row, tz);
    return {
      action: type === "meeting" ? "create_meeting" : "create_task", status: "ok",
      data: type === "meeting" ? { item, conflicts } : { item },
      reply: R.created(item, now, conflicts),
    };
  }

  // ---------------------------------------------------------------- список, поиск

  function listFlow(slots, env) {
    const { ctx, now, tz, userId } = env;
    const r = resolve({ date: slots.date, time: null }, now, { mode: "list" });
    const today = now.toISODate();
    const period = r.period || { from: today, to: today };
    const status = slots.status === "done" ? "done" : "open";
    let rows = items.listItems(db, userId, { ...period, type: slots.type_filter, status });
    if (slots.query) {
      const qs = queryStems(slots.query);
      rows = rows.filter((row) => qs.every((q) => row.search_text.split(" ").some((s) => s.startsWith(q))));
    }
    ctx.last_list = rows.map((row) => row.id);
    const list = rows.map((row) => items.serialize(row, tz));
    return {
      action: "list_events", status: "ok",
      data: { period, items: list, total: list.length },
      reply: R.list(list, { period, dateKind: slots.date?.kind, typeFilter: slots.type_filter, now }),
    };
  }

  async function searchFlow(slots, env) {
    const { ctx, now, tz, userId } = env;
    if (!slots.query) return clarify("search", ["target"], R.ASK_QUERY);
    const { results } = await search(db, { userId, q: slots.query, type: slots.type_filter, embedder });
    const data = {
      query: slots.query,
      results: results.map((r) => ({ item: items.serialize(r.row, tz), score: Number(r.score.toFixed(4)), match: r.match })),
    };
    if (!results.length) return { action: "search", status: "not_found", data, reply: R.NOT_FOUND };
    ctx.last_items = [results[0].row.id];
    ctx.last_list = results.map((r) => r.row.id);
    return { action: "search", status: "ok", data, reply: R.found(ambiguous(results) ? results.slice(0, 3) : results.slice(0, 1), now) };
  }

  // ---------------------------------------------------------------- изменение, отметка, удаление

  async function targetFlow(action, slots, env) {
    const { ctx, userId } = env;
    const patch = action === "update" ? { new_date: slots.new_date, new_time: slots.new_time, new_title: slots.new_title } : null;
    const askTarget = (reply) => {
      ctx.pending = { kind: "target", intent: action, patch, type_filter: slots.type_filter, missing: ["target"], attempts: 0, question: reply };
      return clarify(action, ["target"], reply);
    };
    if (slots.target_ref === "last" || slots.target_ref === "index") {
      const id = slots.target_ref === "last" ? ctx.last_items[0] : ctx.last_list[(slots.target_index || 0) - 1];
      if (!id || !items.getItem(db, userId, id)) return askTarget(R.NO_CONTEXT);
      return applyTarget(action, id, patch, env);
    }
    if (!slots.query) return askTarget(MASS.test(env.norm.match) ? R.ASK_MASS : R.ASK_TARGET[action]);
    const status = action === "delete" ? null : "open";
    const { results } = await search(db, { userId, q: slots.query, type: slots.type_filter, embedder, status });
    if (!results.length) return { action, status: "not_found", data: {}, reply: R.NO_TARGET };
    if (ambiguous(results) && action !== "delete") {
      // переносят и закрывают обычно предстоящее: если среди равных ровно одна запись не в прошлом — берём её
      const today = env.now.toISODate();
      const top = results.filter((r) => r.coverage >= results[0].coverage);
      const upcoming = top.filter((r) => !r.row.due_date || r.row.due_date >= today);
      if (upcoming.length === 1) return applyTarget(action, upcoming[0].row.id, patch, env);
    }
    if (ambiguous(results)) {
      const cands = results.slice(0, 3).map((r) => r.row);
      const reply = R.candidates(cands, slots.type_filter || cands[0].type);
      ctx.pending = { kind: "choose", intent: action, candidates: cands.map((c) => c.id), patch, missing: ["target"], attempts: 0, question: reply };
      ctx.last_list = cands.map((c) => c.id);
      return clarify(action, ["target"], reply, { candidates: cands.map((c) => items.serialize(c, env.tz)) });
    }
    return applyTarget(action, results[0].row.id, patch, env);
  }

  function applyTarget(action, id, patch, env) {
    const { ctx, now, tz, userId, nowSec } = env;
    const row = items.getItem(db, userId, id);
    if (!row) return { action, status: "not_found", data: {}, reply: R.NO_TARGET };
    ctx.pending = null;
    ctx.last_items = [id];
    if (action === "complete") {
      const done = items.setDone(db, userId, id, true, nowSec);
      return { action, status: "ok", data: { item: items.serialize(done, tz) }, reply: R.completed(done) };
    }
    if (action === "delete") {
      items.softDelete(db, userId, id, nowSec);
      return { action, status: "ok", data: { item_id: id }, reply: R.deleted(row) };
    }
    // update
    const changes = {};
    if (patch?.new_date && patch.new_date.kind !== "none") {
      const d = resolveDate(patch.new_date, now, { type: row.type, mode: "create" });
      if (d.need || !d.date) return askUpdateWhen(id, env);
      changes.due_date = d.date.toISODate();
    }
    if (patch?.new_time) {
      if (patch.new_time.relative) {
        const r = resolve({ date: null, time: patch.new_time }, now);
        changes.due_date = r.due_date; changes.due_time = r.due_time;
      } else {
        const t = resolveTime(patch.new_time);
        if (!t || t.need) return askUpdateWhen(id, env);
        changes.due_time = hhmm(t);
        if (!changes.due_date && !row.due_date) changes.due_date = resolve({ date: null, time: patch.new_time }, now).due_date;
      }
    }
    if (patch?.new_title) changes.title = patch.new_title;
    if (!Object.keys(changes).length) return askUpdateWhen(id, env);
    const upd = items.updateItem(db, userId, id, changes, { tz, nowSec });
    embedLater(upd);
    const item = items.serialize(upd, tz);
    const conflicts = upd.type === "meeting"
      ? items.findConflicts(db, userId, { start: upd.start_utc, durationMin: upd.duration_min, excludeId: id }).map((c) => items.serialize(c, tz))
      : [];
    let reply = R.updated(item, now);
    if (conflicts.length) reply += ` Внимание: пересекается с «${conflicts[0].title}» в ${conflicts[0].due_time}.`;
    return { action, status: "ok", data: { item, ...(upd.type === "meeting" ? { conflicts } : {}) }, reply };
  }

  function askUpdateWhen(id, env) {
    env.ctx.pending = { kind: "update_when", intent: "update", target: id, missing: ["date"], attempts: 0, question: R.ASK_NEW_WHEN };
    return clarify("update", ["date"], R.ASK_NEW_WHEN);
  }

  // ---------------------------------------------------------------- уточнения

  function failedAttempt(p, env) {
    p.attempts = (p.attempts || 0) + 1;
    if (p.attempts >= 2) {                                    // после 2 неудачных попыток — сброс (U-12)
      env.ctx.pending = null;
      return { action: p.intent, status: "error", reply: R.RESET, error: { code: "UNKNOWN_INTENT", message: "clarification failed" } };
    }
    env.ctx.pending = p;
    return clarify(p.intent, p.missing, p.question);
  }

  async function continuePending(p, slots, env) {
    const { ctx } = env;
    if (p.kind === "confirm") {
      if (slots.confirm === "yes") return createItem(p.filled, p.suggestion, env);
      if (slots.confirm === "no") {
        ctx.pending = { kind: "slot_filling", intent: p.intent, filled: { ...p.filled, date: { kind: "none" }, time: null }, missing: ["time"], attempts: 0, question: R.DECLINED };
        return clarify(p.intent, ["time"], R.DECLINED);
      }
      if (slots.time || slots.date?.kind !== "none") {
        ctx.pending = null;
        return createFlow({ ...p.filled, ...(slots.time ? { time: slots.time } : {}), ...(slots.date?.kind !== "none" ? { date: slots.date } : {}) }, env);
      }
      return failedAttempt(p, env);
    }
    if (p.kind === "choose") {
      const id = p.candidates[(slots.target_index || 0) - 1];
      if (!id) return failedAttempt(p, env);
      return applyTarget(p.intent, id, p.patch, env);
    }
    if (p.kind === "target") {
      if (!slots.query) return failedAttempt(p, env);
      ctx.pending = null;
      return targetFlow(p.intent, { ...(p.patch || {}), target_ref: "query", query: slots.query, type_filter: p.type_filter }, env);
    }
    if (p.kind === "update_when") {
      if ((!slots.date || slots.date.kind === "none") && !slots.time) return failedAttempt(p, env);
      return applyTarget("update", p.target, { new_date: slots.date, new_time: slots.time }, env);
    }
    // slot_filling
    const f = { ...p.filled };
    let changed = false;
    if (slots.title && p.missing.includes("title")) { f.title = slots.title; changed = true; }
    if (slots.date && slots.date.kind !== "none") { f.date = slots.date; f.weekend = false; changed = true; }
    if (slots.time) {
      if (p.missing.includes("ampm") && slots.time.hour == null && slots.time.part_of_day) {
        f.time = { ...f.time, part_of_day: slots.time.part_of_day, ambiguous_hour: false };
      } else if (p.night && slots.time.hour != null && !slots.time.part_of_day) {
        f.time = { ...slots.time, part_of_day: "night", ambiguous_hour: false };
      } else f.time = slots.time;
      changed = true;
    }
    if (slots.duration_min) f.duration_min = slots.duration_min;
    if (!changed) return failedAttempt(p, env);
    ctx.pending = null;
    return createFlow(f, env, p.attempts);
  }

  // ---------------------------------------------------------------- маршрутизация

  async function route(nluRes, env) {
    const { ctx } = env;
    let { intent, confidence, slots } = nluRes;
    const p = ctx.pending;
    if (p) {
      if (intent === "clarify_answer") return continuePending(p, slots, env);
      if (intent !== "unknown" && confidence >= 0.7) ctx.pending = null;   // пользователь сменил тему (U-13)
      else return failedAttempt(p, env);
    }
    if (intent === "clarify_answer") intent = "unknown";
    if (intent !== "unknown" && confidence < CONFIDENCE_MIN) return clarify("unknown", [], R.ASK_LOW_CONFIDENCE);
    switch (intent) {
      case "create_task":
      case "create_meeting":
        return createFlow({
          type: typeFor(env.norm.match), title: slots.title, title_raw: env.norm.original,
          date: slots.date, time: slots.time, duration_min: slots.duration_min,
          participants: slots.participants || [], weekend: Boolean(slots.weekend),
        }, env);
      case "list_events": return listFlow(slots, env);
      case "search": return searchFlow(slots, env);
      case "complete":
      case "delete":
      case "update": return targetFlow(intent, slots, env);
      default:
        return { action: "unknown", status: "error", reply: R.UNKNOWN, error: { code: "UNKNOWN_INTENT", message: "intent not recognized" } };
    }
  }

  /**
   * @param {{requestId: string, userId: string, sessionId: string, text: string, channel?: "text"|"voice",
   *          tz: string, now: import("luxon").DateTime, transcript?: string|null}} req
   */
  async function handle({ requestId, userId, sessionId, text, channel = "text", tz, now, transcript = null }) {
    const started = Date.now();
    const nowSec = Math.floor(now.toSeconds());
    items.ensureUser(db, userId, tz, nowSec);
    const norm = normalize(text);
    const ctx = loadContext(db, sessionId, userId, nowSec);
    const brief = ctx.last_items.slice(0, 3).map((id) => items.getItem(db, userId, id)).filter(Boolean)
      .map((r) => ({ id: r.id, title: r.title, type: r.type }));
    const nluRes = await nlu.parse(norm, { pending: ctx.pending, last_items: brief });
    const env = { db, userId, tz, now, nowSec, norm, ctx };
    const out = await route(nluRes, env);
    ctx.last_intent = out.action;
    saveContext(db, sessionId, userId, ctx, nowSec);
    const latency = Date.now() - started;
    db.prepare(`
      INSERT INTO message_log (request_id, session_id, user_id, input_text, channel, nlu_json, provider, status, latency_ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(requestId, sessionId, userId, norm.original, channel,
      JSON.stringify({ intent: nluRes.intent, confidence: nluRes.confidence, slots: nluRes.slots }), nluRes.provider, out.status, latency, nowSec);
    return {
      request_id: requestId, action: out.action, status: out.status, data: out.data || {}, reply_text: out.reply,
      missing_slots: out.missing || [],
      context: { session_id: sessionId, last_items: ctx.last_items, pending: ctx.pending },
      meta: { transcript, nlu_provider: nluRes.provider, latency_ms: latency,
        // «как я понял»: что извлекла NLU (до расчёта дат кодом) — для прозрачности в интерфейсе
        nlu: { intent: nluRes.intent, confidence: nluRes.confidence, slots: nluRes.slots } },
      ...(out.error ? { error: out.error } : {}),
    };
  }

  return { handle };
}
