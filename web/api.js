// Клиент API /api/v1. X-User-Id — анонимный id из localStorage (по умолчанию «demo», чтобы демо-данные
// были видны; ?user=new создаёт свой), session_id — uuid сессии диалога. ?mock=1 — ответы из /mocks.

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* приватный режим */ } },
};
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);

export function identity() {
  const params = new URLSearchParams(location.search);
  if (params.get("user") === "new") store.set("va.user", uuid());
  else if (params.get("user")) store.set("va.user", params.get("user"));
  let user = store.get("va.user");
  if (!user) { user = "demo"; store.set("va.user", user); }
  let session = store.get("va.session");
  if (!session) { session = uuid(); store.set("va.session", session); }
  return {
    user,
    get session() { return session; },
    newSession() { session = uuid(); store.set("va.session", session); return session; },
    /** Переключиться на сессию существующего чата (у каждого чата свой контекст диалога на сервере). */
    use(id) { session = id; store.set("va.session", session); return session; },
  };
}

export const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Moscow";

export function createApi(id, { mock = false } = {}) {
  async function request(method, path, body, isForm = false) {
    const res = await fetch(`/api/v1${path}`, {
      method,
      headers: { "X-User-Id": id.user, ...(body && !isForm ? { "Content-Type": "application/json" } : {}) },
      body: isForm ? body : body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { /* не JSON */ }
    if (!res.ok) throw Object.assign(new Error(data?.error?.message || `HTTP ${res.status}`), { http: res.status, code: data?.error?.code, data });
    return data;
  }

  if (mock) return mockApi();
  return {
    message: (text) => request("POST", "/assistant/message", { text, session_id: id.session, tz }),
    voice(blob) {
      const f = new FormData();
      f.append("audio", blob, `voice.${blob.type.includes("mp4") ? "mp4" : blob.type.includes("ogg") ? "ogg" : "webm"}`);
      f.append("session_id", id.session);
      f.append("tz", tz);
      return request("POST", "/assistant/voice", f, true);
    },
    events: (from, to) => request("GET", `/events?from=${from}&to=${to}&tz=${encodeURIComponent(tz)}`),
    complete: (itemId, done = true) => request("PATCH", `/tasks/${itemId}/complete`, { done }),
  };
}

// ---------- mock-режим: фронт стартует без бэка (docs/03 «Готово, если») ----------
function mockApi() {
  const load = (name) => fetch(`/mocks/${name}.json`).then((r) => r.json());
  const pick = (t) => {
    const s = t.toLowerCase();
    if (/что у меня|планы|покажи|какие/.test(s)) return "list_today";
    if (/найди|когда/.test(s)) return /космос/.test(s) ? "search_not_found" : "search";
    if (/поставь встречу с иваном завтра$/.test(s)) return "clarify_time";
    if (/встреч|созвон/.test(s)) return "create_meeting";
    if (/напомни|нужно|надо|задач/.test(s)) return "create_reminder";
    return "unknown";
  };
  return {
    message: async (text) => { await new Promise((r) => setTimeout(r, 600)); return load(pick(text)); },
    voice: async () => load("stt_unavailable"),
    events: async () => load("events"),
    complete: async () => ({}),
  };
}
