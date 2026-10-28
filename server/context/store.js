// Контекст диалога (docs/02 раздел 6): последние записи, последний список, pending. TTL 10 минут.
// Хранится в SQLite, поэтому переживает перезапуск сервера (E-15).

export const TTL_SEC = 600;
const EMPTY = () => ({ last_items: [], last_list: [], pending: null, last_intent: null });

export function loadContext(db, sessionId, userId, nowSec) {
  const row = db.prepare("SELECT state_json, expires_at FROM dialog_context WHERE session_id = ? AND user_id = ?").get(sessionId, userId);
  if (!row || row.expires_at <= nowSec) return EMPTY();
  try { return { ...EMPTY(), ...JSON.parse(row.state_json) }; } catch { return EMPTY(); }
}

export function saveContext(db, sessionId, userId, state, nowSec) {
  db.prepare(`
    INSERT INTO dialog_context (session_id, user_id, state_json, updated_at, expires_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET user_id = excluded.user_id, state_json = excluded.state_json,
      updated_at = excluded.updated_at, expires_at = excluded.expires_at`)
    .run(sessionId, userId, JSON.stringify(state), nowSec, nowSec + TTL_SEC);
  db.prepare("DELETE FROM dialog_context WHERE expires_at < ?").run(nowSec - 86400);
}
