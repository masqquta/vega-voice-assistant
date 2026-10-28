// Контракт API (docs/03) и ошибки/fallback (docs/06 раздел 6, E-1…E-15) на живом HTTP-сервере.
// Внешние сервисы (LLM, STT) замоканы; NOW фиксирован заголовком X-Debug-Now.
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../server/db/index.js";
import { seedMini } from "../server/db/seed.js";
import { createNlu } from "../server/nlu/adapter.js";
import { createAssistant } from "../server/services/assistant.js";
import { createApp } from "../server/app.js";
import { nowIn } from "../server/dates/resolver.js";

const NOW = "2026-10-21T14:30:00+03:00";
const CONFIG = { production: false, tzDefault: "Europe/Moscow", rateLimitPerMin: 1000 };
const servers = [];
after(() => servers.forEach((s) => s.close()));

const noStt = { name: "none", available: () => false, async transcribe(_b, mime) {
  if (!/^audio\/(webm|ogg|mp4)/.test(mime)) throw Object.assign(new Error("fmt"), { code: "AUDIO_FORMAT" });
  throw Object.assign(new Error("off"), { code: "STT_UNAVAILABLE" });
} };

async function start({ db = openDb(":memory:"), providers = [], stt = noStt, seed = false, config = CONFIG, logs = [] } = {}) {
  if (seed) seedMini(db, "u_test", { nowSec: Math.floor(nowIn("Europe/Moscow", NOW).toSeconds()) });
  const log = (e) => logs.push(e);
  const nlu = createNlu({ providers, timeoutMs: 200, log });
  const assistant = createAssistant({ db, nlu, log });
  const app = createApp({ db, assistant, nlu, stt, config, log });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const headers = { "X-User-Id": "u_test", "X-Debug-Now": NOW };
  const call = async (method, p, body, extra = {}) => {
    const res = await fetch(base + p, {
      method, headers: { ...headers, ...(body && !(body instanceof FormData) ? { "Content-Type": "application/json" } : {}), ...extra },
      body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  const say = (text, session = "s1") => call("POST", "/assistant/message", { text, session_id: session });
  return { db, call, say, server, logs };
}

// мок-провайдер LLM: отдаёт заданные строки по очереди
const mockLlm = (name, replies, { delayMs = 0 } = {}) => {
  let i = 0;
  return { name, available: () => true, calls: () => i, async complete(_m, { signal }) {
    const reply = replies[Math.min(i++, replies.length - 1)];
    if (delayMs) await new Promise((r, j) => { const t = setTimeout(r, delayMs); signal?.addEventListener("abort", () => { clearTimeout(t); j(Object.assign(new Error("aborted"), { name: "AbortError" })); }); });
    if (reply instanceof Error) throw reply;
    return reply;
  } };
};

describe("Контракт ассистента", () => {
  test("пример 1: создание напоминания — единый ответ и объект Item", async () => {
    const { say } = await start();
    const { status, body } = await say("Напомни мне завтра в 10 утра позвонить Ивану");
    assert.equal(status, 200);
    assert.match(body.request_id, /^r_/);
    assert.deepEqual([body.action, body.status, body.missing_slots], ["create_task", "ok", []]);
    assert.equal(body.reply_text, "Готово. Напомню завтра, 22 октября, в 10:00: позвонить Ивану.");
    const it = body.data.item;
    for (const k of ["id", "type", "title", "notes", "due_date", "due_time", "due_at", "duration_min", "participants", "status", "created_at"]) assert.ok(k in it, k);
    assert.deepEqual([it.type, it.due_at, it.status, it.created_at], ["reminder", "2026-10-22T10:00:00+03:00", "open", "2026-10-21T14:30:00+03:00"]);
    assert.deepEqual(body.context, { session_id: "s1", last_items: [it.id], pending: null });
    assert.equal(body.meta.nlu_provider, "rulebased");
    assert.equal(body.meta.transcript, null);
  });
  test("пример 4: уточнение — context.pending по контракту", async () => {
    const { say } = await start();
    const { body } = await say("Поставь встречу с Иваном завтра");
    assert.deepEqual([body.status, body.missing_slots, body.reply_text], ["need_clarification", ["time"], "На какое время поставить встречу?"]);
    assert.equal(body.context.pending.intent, "create_meeting");
    assert.deepEqual(body.context.pending.missing, ["time"]);
    assert.equal(body.context.pending.filled.title, "Встреча с Иваном");
  });
});

describe("Ошибки и fallback NLU (E-1…E-5)", () => {
  test("E-1 таймаут LLM → ответ от RuleBased, nlu_provider=rulebased", async () => {
    const slow = mockLlm("yandex", ['{"intent":"unknown","confidence":1,"slots":{}}'], { delayMs: 1000 });
    const { say, logs } = await start({ providers: [slow] });
    const { body } = await say("Добавь встречу с командой завтра в 15:00");
    assert.deepEqual([body.status, body.meta.nlu_provider], ["ok", "rulebased"]);
    assert.ok(logs.some((l) => l.error === "timeout"));
  });
  test("E-2 LLM вернула текст вместо JSON → ретрай с подсказкой → GigaChat", async () => {
    const y = mockLlm("yandex", ["Конечно! Вот ваш JSON:", "не знаю"]);
    const g = mockLlm("gigachat", ['```json\n{"intent":"create_task","confidence":0.9,"slots":{"title":"Позвонить Ивану","date":{"kind":"tomorrow"},"time":{"hour":10,"part_of_day":"morning"}}}\n```']);
    const { say } = await start({ providers: [y, g] });
    const { body } = await say("Напомни мне завтра в 10 утра позвонить Ивану");
    assert.equal(y.calls(), 2);                       // 1 ретрай
    assert.deepEqual([body.status, body.meta.nlu_provider, body.data.item.due_time], ["ok", "gigachat", "10:00"]);
  });
  test("E-3 JSON с неизвестным intent book_flight → RuleBased / UNKNOWN_INTENT", async () => {
    const y = mockLlm("yandex", ['{"intent":"book_flight","confidence":0.9,"slots":{}}']);
    const { say } = await start({ providers: [y] });
    const { body } = await say("Забронируй мне рейс в Сочи");
    assert.deepEqual([body.status, body.error?.code], ["error", "UNKNOWN_INTENT"]);
  });
  test("E-4 обе LLM недоступны → RuleBased отвечает на T-2.1", async () => {
    const down = (n) => mockLlm(n, [Object.assign(new Error("HTTP 503"), { status: 503 })]);
    const { say } = await start({ providers: [down("yandex"), down("gigachat")] });
    const { body } = await say("Добавь встречу с командой завтра в 15:00");
    assert.deepEqual([body.status, body.meta.nlu_provider, body.data.item.due_date], ["ok", "rulebased", "2026-10-22"]);
  });
  test("E-5 LLM вернула дату строкой «2026-10-22» → слот пуст, уточнение, а не выдуманная дата", async () => {
    const y = mockLlm("yandex", ['{"intent":"create_meeting","confidence":0.9,"slots":{"title":"Встреча с Иваном","date":"2026-10-22","time":{"hour":15}}}']);
    const { say } = await start({ providers: [y] });
    const { body } = await say("Встреча с Иваном 2026-10-22 в 15");
    assert.equal(body.meta.nlu_provider, "yandex");
    assert.equal(body.status, "ok");                  // только время → сегодня 15:00 (код считает, дату строкой игнорируем)
    assert.equal(body.data.item.due_date, "2026-10-21");
  });
  test("LLM-ответ с low confidence < 0.5 → уточнение «создать или найти?» (FR-5.5)", async () => {
    const y = mockLlm("yandex", ['{"intent":"create_task","confidence":0.3,"slots":{"title":"Иван"}}']);
    const { say, db } = await start({ providers: [y] });
    const { body } = await say("Иван");
    assert.deepEqual([body.status, body.reply_text], ["need_clarification", "Вы хотите создать запись или найти?"]);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM items").get().n, 0);
  });
});

describe("Ошибки голоса и запроса (E-6…E-11, E-14, E-15)", () => {
  const audio = (bytes, type) => {
    const f = new FormData();
    f.append("audio", new Blob([new Uint8Array(bytes)], { type }), "a");
    f.append("session_id", "s1");
    return f;
  };
  test("E-6 тишина → status=error STT_EMPTY и подсказка ввести текстом", async () => {
    const stt = { ...noStt, available: () => true, transcribe: async () => ({ text: "" }) };
    const { call } = await start({ stt });
    const { status, body } = await call("POST", "/assistant/voice", audio(100, "audio/webm"));
    assert.deepEqual([status, body.status, body.error.code], [200, "error", "STT_EMPTY"]);
    assert.equal(body.reply_text, "Не расслышала. Повторите или напишите текстом.");
  });
  test("голос с расшифровкой → тот же пайплайн, meta.transcript заполнен (FR-5.2, VR-4)", async () => {
    const stt = { ...noStt, available: () => true, transcribe: async () => ({ text: "Что у меня сегодня?" }) };
    const { call } = await start({ stt });
    const { body } = await call("POST", "/assistant/voice", audio(100, "audio/webm;codecs=opus"));
    assert.deepEqual([body.action, body.meta.transcript], ["list_events", "Что у меня сегодня?"]);
  });
  test("E-7 аудио > 1 МБ → 413 PAYLOAD_TOO_LARGE", async () => {
    const { call } = await start();
    const { status, body } = await call("POST", "/assistant/voice", audio(1024 * 1024 + 10, "audio/webm"));
    assert.deepEqual([status, body.error.code], [413, "PAYLOAD_TOO_LARGE"]);
  });
  test("E-8 audio/mp3 → 415 AUDIO_FORMAT", async () => {
    const { call } = await start();
    const { status, body } = await call("POST", "/assistant/voice", audio(100, "audio/mpeg"));
    assert.deepEqual([status, body.error.code], [415, "AUDIO_FORMAT"]);
  });
  test("E-9 STT недоступен → status=error STT_UNAVAILABLE", async () => {
    const { call } = await start();
    const { status, body } = await call("POST", "/assistant/voice", audio(100, "audio/webm"));
    assert.deepEqual([status, body.error.code], [200, "STT_UNAVAILABLE"]);
  });
  test("E-10 пустой текст → 400, 600 символов → 413", async () => {
    const { call } = await start();
    assert.equal((await call("POST", "/assistant/message", { text: "", session_id: "s" })).status, 400);
    const big = await call("POST", "/assistant/message", { text: "а".repeat(600), session_id: "s" });
    assert.deepEqual([big.status, big.body.error.code], [413, "PAYLOAD_TOO_LARGE"]);
  });
  test("E-11 нет X-User-Id → 400 USER_REQUIRED", async () => {
    const { server } = await start();
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/events?from=2026-10-21&to=2026-10-21`);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "USER_REQUIRED");
  });
  test("E-14 ошибка БД → 500 INTERNAL без стектрейса", async () => {
    const db = openDb(":memory:");
    const { call } = await start({ db });
    db.exec("DROP TABLE message_log");
    const { status, body } = await call("POST", "/assistant/message", { text: "Что у меня сегодня?", session_id: "s" });
    assert.deepEqual([status, body.error.code], [500, "INTERNAL"]);
    assert.doesNotMatch(JSON.stringify(body), /at |\.js|stack/);
  });
  test("E-15 перезапуск сервера между запросами: запись и dialog_context сохраняются", async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "va-")), "app.db");
    const a = await start({ db: openDb(file) });
    await a.say("Поставь встречу с Иваном завтра");                 // pending в БД
    await a.say("Надо оплатить интернет", "s2");
    a.server.close(); a.db.close();
    const b = await start({ db: openDb(file) });
    const r = await b.say("в три");                                 // продолжаем диалог после рестарта
    assert.deepEqual([r.body.status, r.body.data.item.due_time], ["ok", "15:00"]);
    const ev = await b.call("GET", "/events?from=2026-10-21&to=2026-10-22");
    assert.equal(ev.body.total, 1);
  });
  test("X-Debug-Now игнорируется в production", async () => {
    const { say } = await start({ config: { ...CONFIG, production: true } });
    const { body } = await say("Надо купить билеты завтра");
    assert.notEqual(body.data.item.due_date, "2026-10-22");
  });
});

describe("REST без LLM", () => {
  test("POST /tasks → 201; reminder без даты → 400", async () => {
    const { call } = await start();
    const ok = await call("POST", "/tasks", { title: "Купить билеты" });
    assert.deepEqual([ok.status, ok.body.item.type, ok.body.item.due_date], [201, "task", null]);
    const bad = await call("POST", "/tasks", { title: "Позвонить", type: "reminder" });
    assert.deepEqual([bad.status, bad.body.error.code], [400, "VALIDATION"]);
  });
  test("POST /meetings → 201 + conflicts; GET /events сортировка дата, время, NULL в конце", async () => {
    const { call } = await start();
    await call("POST", "/meetings", { title: "Встреча с командой", due_date: "2026-10-22", due_time: "15:00" });
    const m = await call("POST", "/meetings", { title: "Встреча с партнёрами", due_date: "2026-10-22", due_time: "15:30", participants: ["Пётр"] });
    assert.deepEqual([m.status, m.body.conflicts.length, m.body.item.duration_min], [201, 1, 60]);
    await call("POST", "/tasks", { title: "Отчёт", due_date: "2026-10-22" });
    await call("POST", "/tasks", { title: "Позвонить", type: "reminder", due_date: "2026-10-22", due_time: "09:00" });
    const ev = await call("GET", "/events?from=2026-10-22&to=2026-10-22");
    assert.deepEqual(ev.body.items.map((i) => i.due_time), ["09:00", "15:00", "15:30", null]);
    assert.equal((await call("GET", "/events?from=2026-10-23&to=2026-10-22")).status, 400);
    assert.equal((await call("GET", "/events?from=21.10.2026&to=2026-10-22")).status, 400);
    const tasks = await call("GET", "/events?from=2026-10-22&to=2026-10-22&type=task");
    assert.deepEqual(tasks.body.items.map((i) => i.type).sort(), ["reminder", "task"]);
  });
  test("GET /search: hybrid деградирует до FTS, semantic без эмбеддингов → 502, пусто → 200 []", async () => {
    const { call } = await start({ seed: true });
    const r = await call("GET", `/search?q=${encodeURIComponent("презентацию")}`);
    assert.deepEqual([r.status, r.body.results[0].item.title, r.body.results[0].match], [200, "Подготовить презентацию для инвесторов", "fts"]);
    assert.equal((await call("GET", "/search?q=x&mode=semantic")).status, 502);
    const none = await call("GET", `/search?q=${encodeURIComponent("космос")}`);
    assert.deepEqual([none.status, none.body.results], [200, []]);
  });
  test("PATCH /tasks/:id, /complete, DELETE — бонусы S", async () => {
    const { call } = await start();
    const id = (await call("POST", "/tasks", { title: "Отчёт", due_date: "2026-10-23" })).body.item.id;
    const p = await call("PATCH", `/tasks/${id}`, { due_date: "2026-10-24", due_time: "10:00" });
    assert.deepEqual([p.body.item.due_date, p.body.item.due_at], ["2026-10-24", "2026-10-24T10:00:00+03:00"]);
    const c = await call("PATCH", `/tasks/${id}/complete`, {});
    assert.equal(c.body.item.status, "done");
    const back = await call("PATCH", `/tasks/${id}/complete`, { done: false });
    assert.equal(back.body.item.status, "open");
    assert.deepEqual((await call("DELETE", `/tasks/${id}`)).body, { deleted: true, item_id: id });
    assert.equal((await call("DELETE", `/tasks/${id}`)).status, 404);
    assert.equal((await call("PATCH", "/tasks/999", { title: "x" })).status, 404);
  });
  test("GET /health без X-User-Id", async () => {
    const { server } = await start();
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/health`);
    const body = await res.json();
    assert.deepEqual([res.status, body.ok, body.db], [200, true, "up"]);
  });
});
