// Эндпоинты /api/v1 (docs/03 раздел 3). /assistant/* всегда отвечают 200, если запрос синтаксически
// корректен — результат в status (ok | need_clarification | not_found | error). 4xx/5xx — только нарушения
// контракта и аварии. REST-эндпоинты /tasks, /meetings, /events, /search работают без LLM.
import express from "express";
import multer from "multer";
import { z } from "zod";
import { DateTime } from "luxon";
import * as items from "../services/items.js";
import { search } from "../services/search.js";
import { embedItem } from "../services/embeddings.js";
import { MAX_TEXT } from "../nlu/normalize.js";
import * as R from "../reply/templates.js";
import { ApiError } from "./middleware.js";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const TYPES = ["task", "meeting", "reminder"];

function parse(schema, data) {
  const r = schema.safeParse(data);
  if (r.success) return r.data;
  const details = r.error.issues.map((i) => ({ field: i.path.join(".") || "body", issue: i.message }));
  throw new ApiError(400, "VALIDATION", `${details[0].field}: ${details[0].issue}`, details);
}
const validDate = (s) => DATE.test(s) && DateTime.fromISO(s).isValid;

/**
 * @param {{db, assistant, stt, embedder, nlu, log}} deps
 */
export function apiRouter({ db, assistant, stt, embedder, nlu, log }) {
  const r = express.Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024, files: 1 } });
  const embedLater = (row) => embedder && setImmediate(() => embedItem(db, embedder, row).catch((e) => log({ event: "embedding_error", error: e.message })));

  // ---------- ассистент ----------
  const MessageBody = z.object({
    text: z.string({ required_error: "required" }).trim().min(1, "required"),
    session_id: z.string({ required_error: "required" }).min(1).max(100),
    tz: z.string().optional(),
  });
  r.post("/assistant/message", async (req, res, next) => {
    try {
      if (typeof req.body?.text === "string" && req.body.text.length > MAX_TEXT) throw new ApiError(413, "PAYLOAD_TOO_LARGE", `text is longer than ${MAX_TEXT} characters`);
      const body = parse(MessageBody, req.body);
      const out = await assistant.handle({ requestId: req.requestId, userId: req.userId, sessionId: body.session_id, text: body.text, channel: "text", tz: req.tz, now: req.now });
      res.json(out);
    } catch (e) { next(e); }
  });

  r.post("/assistant/voice", upload.single("audio"), async (req, res, next) => {
    try {
      const sessionId = req.body?.session_id;
      if (!sessionId) throw new ApiError(400, "VALIDATION", "session_id: required", [{ field: "session_id", issue: "required" }]);
      if (!req.file) throw new ApiError(400, "VALIDATION", "audio: required", [{ field: "audio", issue: "required" }]);
      let text;
      try {
        ({ text } = await stt.transcribe(req.file.buffer, req.file.mimetype));
      } catch (e) {
        if (e.code === "AUDIO_FORMAT") throw new ApiError(415, "AUDIO_FORMAT", "unsupported audio format, send webm/ogg/mp4 or use text");
        log({ event: "stt_error", request_id: req.requestId, error: e.message });
        return res.json({ request_id: req.requestId, action: "unknown", status: "error", data: {}, reply_text: R.STT_UNAVAILABLE,
          missing_slots: [], context: { session_id: sessionId, last_items: [], pending: null },
          meta: { transcript: null, nlu_provider: null, latency_ms: 0 }, error: { code: "STT_UNAVAILABLE", message: "speech recognition unavailable" } });
      }
      if (!text) {
        return res.json({ request_id: req.requestId, action: "unknown", status: "error", data: {}, reply_text: R.STT_EMPTY,
          missing_slots: [], context: { session_id: sessionId, last_items: [], pending: null },
          meta: { transcript: "", nlu_provider: null, latency_ms: 0 }, error: { code: "STT_EMPTY", message: "empty transcript" } });
      }
      const out = await assistant.handle({ requestId: req.requestId, userId: req.userId, sessionId, text: text.slice(0, MAX_TEXT), channel: "voice", tz: req.tz, now: req.now, transcript: text });
      res.json(out);
    } catch (e) { next(e); }
  });

  // ---------- выборка и поиск ----------
  r.get("/events", (req, res, next) => {
    try {
      const q = parse(z.object({
        from: z.string().refine(validDate, "format YYYY-MM-DD"),
        to: z.string().refine(validDate, "format YYYY-MM-DD"),
        type: z.enum(TYPES).optional(),
        status: z.enum(["open", "done", "all"]).optional(),
      }), req.query);
      if (q.from > q.to) throw new ApiError(400, "VALIDATION", "from must be <= to");
      if (DateTime.fromISO(q.to).diff(DateTime.fromISO(q.from), "days").days > 366) throw new ApiError(400, "VALIDATION", "range is longer than 366 days");
      const rows = items.listItems(db, req.userId, { from: q.from, to: q.to, type: q.type || null, status: q.status || "open" });
      res.json({ items: rows.map((row) => items.serialize(row, req.tz)), total: rows.length });
    } catch (e) { next(e); }
  });

  r.get("/search", async (req, res, next) => {
    try {
      const q = parse(z.object({
        q: z.string().trim().min(1).max(200),
        type: z.enum(TYPES).optional(),
        mode: z.enum(["hybrid", "fts", "semantic"]).optional(),
        limit: z.coerce.number().int().min(1).max(20).optional(),
      }), req.query);
      let out;
      try {
        out = await search(db, { userId: req.userId, q: q.q, type: q.type, mode: q.mode || "hybrid", limit: q.limit || 5, embedder });
      } catch (e) {
        if (e.code === "UPSTREAM") throw new ApiError(502, "UPSTREAM", "embedding service unavailable");
        throw e;
      }
      res.json({ results: out.results.map((x) => ({ item: items.serialize(x.row, req.tz), score: Number(x.score.toFixed(4)), match: x.match })) });
    } catch (e) { next(e); }
  });

  // ---------- прямое создание и изменение (без LLM) ----------
  const Base = {
    title: z.string().trim().min(1).max(200),
    due_date: z.string().refine(validDate, "format YYYY-MM-DD"),
    due_time: z.string().regex(TIME, "format HH:MM"),
    notes: z.string().max(1000).optional(),
  };
  r.post("/tasks", (req, res, next) => {
    try {
      const b = parse(z.object({
        title: Base.title, type: z.enum(["task", "reminder"]).optional(),
        due_date: Base.due_date.nullable().optional(), due_time: Base.due_time.nullable().optional(), notes: Base.notes,
      }), req.body);
      const row = items.insertItem(db, req.userId, { ...b, type: b.type || "task", source: "api" }, { tz: req.tz, nowSec: Math.floor(req.now.toSeconds()) });
      embedLater(row);
      res.status(201).json({ item: items.serialize(row, req.tz) });
    } catch (e) { next(e); }
  });

  r.post("/meetings", (req, res, next) => {
    try {
      const b = parse(z.object({
        title: Base.title, due_date: Base.due_date, due_time: Base.due_time,
        duration_min: z.number().int().min(5).max(1440).optional(), participants: z.array(z.string().max(100)).max(20).optional(),
        notes: Base.notes,
      }), req.body);
      const row = items.insertItem(db, req.userId, { ...b, type: "meeting", source: "api" }, { tz: req.tz, nowSec: Math.floor(req.now.toSeconds()) });
      const conflicts = items.findConflicts(db, req.userId, { start: row.start_utc, durationMin: row.duration_min, excludeId: row.id });
      embedLater(row);
      res.status(201).json({ item: items.serialize(row, req.tz), conflicts: conflicts.map((c) => items.serialize(c, req.tz)) });
    } catch (e) { next(e); }
  });

  const idParam = (req) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) throw new ApiError(400, "VALIDATION", "id must be a positive integer");
    return id;
  };

  r.patch("/tasks/:id", (req, res, next) => {
    try {
      const id = idParam(req);
      const b = parse(z.object({
        title: Base.title.optional(), due_date: Base.due_date.nullable().optional(), due_time: Base.due_time.nullable().optional(),
        notes: z.string().max(1000).nullable().optional(), duration_min: z.number().int().min(5).max(1440).nullable().optional(),
      }).refine((x) => Object.keys(x).length > 0, "at least one field"), req.body);
      if (!items.getItem(db, req.userId, id)) throw new ApiError(404, "NOT_FOUND", "item not found");
      const row = items.updateItem(db, req.userId, id, b, { tz: req.tz, nowSec: Math.floor(req.now.toSeconds()) });
      embedLater(row);
      res.json({ item: items.serialize(row, req.tz) });
    } catch (e) { next(e); }
  });

  r.delete("/tasks/:id", (req, res, next) => {
    try {
      const id = idParam(req);
      if (!items.softDelete(db, req.userId, id, Math.floor(req.now.toSeconds()))) throw new ApiError(404, "NOT_FOUND", "item not found");
      res.json({ deleted: true, item_id: id });
    } catch (e) { next(e); }
  });

  r.patch("/tasks/:id/complete", (req, res, next) => {
    try {
      const id = idParam(req);
      const done = req.body?.done === undefined ? true : Boolean(req.body.done);
      const row = items.setDone(db, req.userId, id, done, Math.floor(req.now.toSeconds()), { tz: req.tz });
      if (!row) throw new ApiError(404, "NOT_FOUND", "item not found");
      res.json({ item: items.serialize(row, req.tz) });
    } catch (e) { next(e); }
  });

  return r;
}

/** GET /health — для хостинга и прогрева. Без X-User-Id. */
export function healthHandler({ db, nlu }) {
  return (req, res) => {
    let dbOk = "up";
    try { db.prepare("SELECT 1").get(); } catch { dbOk = "down"; }
    res.json({ ok: dbOk === "up", db: dbOk, llm: { ...nlu.status } });
  };
}
