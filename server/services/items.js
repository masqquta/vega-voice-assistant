// Записи (items): создание, выборка за период, изменение, отметка, мягкое удаление, конфликты встреч.
// due_date/due_time — источник истины, start_utc вычисляется кодом (docs/04 раздел 1).
import { DateTime } from "luxon";
import { startUtc, dueAt } from "../dates/resolver.js";
import { searchText } from "./stem.js";

export class ValidationError extends Error {
  constructor(message, details = []) { super(message); this.code = "VALIDATION"; this.details = details; }
}

export function ensureUser(db, userId, tz, nowSec) {
  db.prepare("INSERT INTO users (id, tz, created_at) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING").run(userId, tz, nowSec);
  return db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
}

function check(item) {
  const errs = [];
  if (!item.title || item.title.length > 200) errs.push({ field: "title", issue: "required" });
  if (!["task", "meeting", "reminder"].includes(item.type)) errs.push({ field: "type", issue: "invalid" });
  if (item.due_date && !/^\d{4}-\d{2}-\d{2}$/.test(item.due_date)) errs.push({ field: "due_date", issue: "format" });
  if (item.due_time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(item.due_time)) errs.push({ field: "due_time", issue: "format" });
  if (item.due_time && !item.due_date) errs.push({ field: "due_date", issue: "required" });
  if (item.type !== "task" && !(item.due_date && item.due_time)) {
    if (!item.due_date) errs.push({ field: "due_date", issue: "required" });
    if (!item.due_time) errs.push({ field: "due_time", issue: "required" });
  }
  if (item.duration_min != null && !(item.duration_min >= 5 && item.duration_min <= 1440)) errs.push({ field: "duration_min", issue: "range" });
  if (item.notes && item.notes.length > 1000) errs.push({ field: "notes", issue: "too_long" });
  if (errs.length) throw new ValidationError(`${errs[0].field}: ${errs[0].issue}`, errs);
}

export function insertItem(db, userId, fields, { tz, nowSec }) {
  const item = {
    type: fields.type || "task", title: String(fields.title || "").trim(), title_raw: fields.title_raw ?? null,
    notes: fields.notes ?? null, participants: fields.participants?.length ? JSON.stringify(fields.participants) : null,
    due_date: fields.due_date ?? null, due_time: fields.due_time ?? null,
    duration_min: fields.type === "meeting" ? (fields.duration_min ?? 60) : (fields.duration_min ?? null),
    status: fields.status === "done" ? "done" : "open", source: fields.source || "assistant",
    type_confidence: fields.type_confidence ?? null,
  };
  check(item);
  const info = db.prepare(`
    INSERT INTO items (user_id, type, title, title_raw, notes, participants, due_date, due_time, start_utc,
                       duration_min, status, source, type_confidence, search_text, created_at, updated_at, completed_at)
    VALUES (@user_id, @type, @title, @title_raw, @notes, @participants, @due_date, @due_time, @start_utc,
            @duration_min, @status, @source, @type_confidence, @search_text, @now, @now, @completed_at)`).run({
    ...item, user_id: userId, start_utc: startUtc(item.due_date, item.due_time, tz),
    search_text: searchText({ ...item, participants: fields.participants }), now: nowSec,
    completed_at: item.status === "done" ? nowSec : null,
  });
  return getItem(db, userId, Number(info.lastInsertRowid));
}

export function getItem(db, userId, id) {
  return db.prepare("SELECT * FROM items WHERE id = ? AND user_id = ? AND deleted_at IS NULL").get(id, userId) || null;
}

/** Выборка за период [from, to] по локальным датам. type="task" подтягивает и reminder (docs/04 раздел 7). */
export function listItems(db, userId, { from, to, type = null, status = "open" }) {
  const types = type === "task" ? ["task", "reminder"] : type ? [type] : null;
  const rows = db.prepare(`
    SELECT * FROM items
    WHERE user_id = ? AND deleted_at IS NULL
      AND (? = 'all' OR status = ?)
      AND due_date BETWEEN ? AND ?
    ORDER BY due_date, (due_time IS NULL), due_time, id`).all(userId, status, status, from, to);
  return types ? rows.filter((r) => types.includes(r.type)) : rows;
}

/** Встречи, пересекающиеся с [start, start + duration) — docs/04 раздел 7. */
export function findConflicts(db, userId, { start, durationMin, excludeId = null }) {
  if (start == null) return [];
  const end = start + (durationMin || 60) * 60;
  return db.prepare(`
    SELECT * FROM items
    WHERE user_id = ? AND type = 'meeting' AND deleted_at IS NULL AND status = 'open'
      AND start_utc < ? AND (start_utc + COALESCE(duration_min, 60) * 60) > ? AND id IS NOT ?
    ORDER BY start_utc`).all(userId, end, start, excludeId);
}

export function updateItem(db, userId, id, patch, { tz, nowSec }) {
  const cur = getItem(db, userId, id);
  if (!cur) return null;
  const next = { ...cur };
  for (const k of ["title", "due_date", "due_time", "notes", "duration_min"]) if (k in patch) next[k] = patch[k];
  if ("due_date" in patch && patch.due_date === null) next.due_time = null;
  if (next.title) next.title = String(next.title).trim();
  check({ ...next, participants: null });
  const participants = cur.participants ? JSON.parse(cur.participants) : [];
  db.prepare(`
    UPDATE items SET title = @title, due_date = @due_date, due_time = @due_time, notes = @notes,
      duration_min = @duration_min, start_utc = @start_utc, search_text = @search_text, updated_at = @now
    WHERE id = @id AND user_id = @user_id`).run({
    ...next, start_utc: startUtc(next.due_date, next.due_time, tz),
    search_text: searchText({ ...next, participants }), now: nowSec, id, user_id: userId,
  });
  return getItem(db, userId, id);
}

export function setDone(db, userId, id, done, nowSec) {
  const r = db.prepare(`
    UPDATE items SET status = ?, completed_at = ?, updated_at = ?
    WHERE id = ? AND user_id = ? AND deleted_at IS NULL`).run(done ? "done" : "open", done ? nowSec : null, nowSec, id, userId);
  return r.changes ? getItem(db, userId, id) : null;
}

export function softDelete(db, userId, id, nowSec) {
  const r = db.prepare("UPDATE items SET deleted_at = ?, updated_at = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL")
    .run(nowSec, nowSec, id, userId);
  return r.changes > 0;
}

const isoAt = (sec, tz) => (sec == null ? null : DateTime.fromSeconds(sec, { zone: tz }).toISO({ suppressMilliseconds: true }));

/** Объект Item контракта (docs/03). */
export function serialize(row, tz) {
  if (!row) return null;
  return {
    id: row.id, type: row.type, title: row.title, notes: row.notes ?? null,
    due_date: row.due_date ?? null, due_time: row.due_time ?? null, due_at: dueAt(row.due_date, row.due_time, tz),
    duration_min: row.duration_min ?? null, participants: row.participants ? JSON.parse(row.participants) : [],
    status: row.status, created_at: isoAt(row.created_at, tz),
    ...(row.completed_at ? { completed_at: isoAt(row.completed_at, tz) } : {}),
  };
}
