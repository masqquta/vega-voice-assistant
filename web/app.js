// Главный экран: шар (orb.js), диалог, запись голоса, план на неделю.
// Голос: MediaRecorder → POST /assistant/voice (VR-2). Если серверный STT недоступен, а браузер умеет
// распознавать речь (Web Speech API) — отправляем браузерную расшифровку как текст. Если не вышло
// ни то ни другое — поле ввода подсвечивается (VR-6). Ответ озвучивается speechSynthesis (VR-5).
import { mountOrb } from "./orb.js";
import { identity, createApi } from "./api.js";

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const MOCK = params.has("mock");
const id = identity();
const api = createApi(id, { mock: MOCK });

const ui = {
  thread: $("thread"), chips: $("chips"), input: $("input"), composer: $("composer"), mic: $("mic"),
  send: $("send"), timer: $("timer"), status: $("status"), live: $("live"), agenda: $("agenda"),
  mute: $("mute"), muteLabel: $("muteLabel"),
};
$("mode").hidden = !MOCK;

const STATUS = {
  idle: "Готова", listening: "Слушаю…", thinking: "Думаю…", speaking: "Отвечаю",
};
// ---------- экран загрузки: логотип, пока грузится модель (не меньше 1,2 с, не дольше 10 с) ----------
const loader = $("loader");
const hideLoader = () => {
  if (!loader.isConnected || loader.classList.contains("done")) return;
  loader.classList.add("done");
  document.body.classList.add("ready");                          // шар проявляется из-под растворяющегося логотипа
  setTimeout(() => loader.remove(), 800);
};
const shownAt = performance.now();
setTimeout(hideLoader, 10_000);                                  // до mountOrb: даже если WebGL упадёт, заставка уйдёт

const phone = matchMedia("(max-width: 760px)").matches;
const orb = mountOrb($("orb"), {
  background: 0xffffff, touchAction: "pan-y", zoom: phone ? 1.12 : 1.4,
  onStateChange: (s) => { ui.status.textContent = STATUS[s]; ui.status.dataset.state = s; if (s === "idle") ui.live.textContent = ""; heroState(s); },
});

orb.ready
  .then(() => Promise.race([                                     // первый кадр нарисован; в фоновой вкладке rAF спит — не ждём его
    new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    new Promise((r) => setTimeout(r, 400)),
  ]))
  .then(() => setTimeout(hideLoader, Math.max(0, 1200 - (performance.now() - shownAt))))
  .catch(hideLoader);

// ---------- сцена: прокрутка уводит модель в сторону и выдвигает чат справа ----------
const scene = $("scene");
const chatEl = $("chat");
const root = document.documentElement.style;
const clamp01 = (x) => Math.min(1, Math.max(0, x));
const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
let chatOpen = false, heroActive = true, sceneRaf = 0;
const heroEl = $("hero");
function updateScene() {
  sceneRaf = 0;
  const vh = window.visualViewport?.height || innerHeight;
  const s = window.scrollY / vh;
  const raw = clamp01(s / 0.95);                                  // фаза 2: модель в сторону, чат справа
  const qRaw = clamp01((s - 1.45) / 1.5);                         // фаза 3 (растянута): чат уезжает, чаты прилетают на орбиту
  const q = ease(qRaw);
  root.setProperty("--p", (ease(raw) * (1 - q)).toFixed(4));
  root.setProperty("--c", (ease(clamp01((raw - 0.12) / 0.88)) * (1 - q)).toFixed(4));
  root.setProperty("--q", q.toFixed(4));
  orbitQ = q;
  orbitScroll = s;
  projectsEl.dataset.active = String(q > 0.6);
  if (q < 0.6 && struct) setStruct(false);
  if (q > 0.001) startOrbit();
  const heroOn = raw < 0.12 && qRaw === 0;
  if (heroOn !== heroActive) { heroActive = heroOn; heroEl.dataset.active = String(heroOn); heroEl.inert = !heroOn; }
  const open = raw > 0.72 && qRaw < 0.35;
  if (open !== chatOpen) {
    chatOpen = open;
    chatEl.inert = !open;                                         // за краем экрана чат не ловит фокус и клики
  }
}
const requestScene = () => { if (!sceneRaf) sceneRaf = requestAnimationFrame(updateScene); };

// орбита чатов: наклонный эллипс вокруг шара, плашки сзади меньше и бледнее (глубина), выход из центра шара.
// Когда чаты сели на орбиту, шар «бьётся» и зовёт нажать; нажатие раскладывает чаты по колонкам-темам (--s)
let orbitQ = 0, orbitQs = 0, orbitScroll = 0, orbitRaf = 0, orbitT = 0, orbitLast = 0;
let struct = false, sClock = 0, inviting = false;
const STRUCT_DUR = 1.35;                                          // с: перелёт орбита ↔ колонки
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
const easeIO = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const easeOut = (x) => 1 - Math.pow(1 - x, 3);
function startOrbit() { if (!orbitRaf) { orbitLast = performance.now(); orbitRaf = requestAnimationFrame(orbitFrame); } }
function orbitFrame(now) {
  orbitRaf = 0;
  const dt = Math.min(0.05, Math.max(0, (now - orbitLast) / 1000));
  orbitLast = now;
  const reduced = reducedMotion.matches;
  if (!reduced) orbitT += dt * 0.12 * (1 - sClock);              // в колонках орбита замирает
  // инерция: даже при резкой прокрутке плашки догоняют позицию плавно (~1 с)
  orbitQs += (orbitQ - orbitQs) * (1 - Math.exp(-dt * (reduced ? 30 : 2.2)));
  sClock = clamp01(sClock + (struct ? 1 : -1) * (reduced ? 1 : dt / STRUCT_DUR));
  const sE = easeIO(sClock);
  root.setProperty("--s", sE.toFixed(4));
  // приглашение: все чаты сели на орбиту, шар в центре и ждёт
  const invite = !struct && sClock === 0 && orbitQ > 0.6 && orbitQs > 0.97;
  if (invite !== inviting) { inviting = invite; orb.invite(invite); projectsEl.dataset.invite = String(invite); }

  const nodes = projectNodes;
  const n = nodes.length;
  const W = innerWidth, H = window.visualViewport?.height || innerHeight;
  const narrow = W <= 760;
  const rx = narrow ? W * 0.36 : Math.min(W * 0.34, 560);
  const ry = narrow ? H * 0.3 : rx * 0.42;
  const tilt = (narrow ? -8 : -14) * Math.PI / 180;
  const cos = Math.cos(tilt), sin = Math.sin(tilt);
  nodes.forEach((node, i) => {
    // по очереди прилетают из-за краёв экрана по спирали и мягко садятся на орбиту
    const k = clamp01(orbitQs * (1 + n * 0.16) - i * 0.16);
    const kk = 1 - Math.pow(1 - k, 3);                              // ease-out: быстро издалека, медленно у цели
    const a = orbitT + orbitScroll * 0.35 + (i / n) * Math.PI * 2;
    const swirl = (1 - kk) * (1.6 + (i % 3) * 0.35) * (i % 2 ? -1 : 1);   // закрутка: одни по часовой, другие против
    const far = 1 + (1 - kk) * 2.4;                                 // старт — далеко за краем экрана
    const ex = Math.cos(a + swirl) * rx * far, ey = Math.sin(a + swirl) * ry * far;
    const depth = (Math.sin(a) + 1) / 2;                            // 1 — ближе к зрителю (нижняя дуга)
    let scale = (0.72 + 0.32 * depth) * (0.55 + 0.45 * kk);
    // плашка целиком в пределах экрана, с отступом 10px
    const maxX = Math.max(0, W / 2 - (node.offsetWidth * scale) / 2 - 10);
    const rawX = ex * cos - ey * sin;
    let y = ex * sin + ey * cos;
    const clampX = Math.max(-maxX, Math.min(maxX, rawX));
    let x = rawX + (clampX - rawX) * kk;                          // в полёте — свободно, на орбите — в пределах экрана
    let turn = (1 - kk) * 22 * (i % 2 ? 1 : -1);                   // в полёте плашка слегка повёрнута
    let opacity = Math.pow(k, 0.6) * (0.45 + 0.55 * depth);
    let blur = (1 - kk) * 7 + (depth < 0.35 ? (0.35 - depth) * 3 : 0);  // размытие движения, тает при посадке
    let z = 10 + Math.round(depth * 10);
    // перелёт в колонку: по одной, по дуге, с наклоном и размытием в середине пути
    const slot = node._slot;
    if (slot && sClock > 0) {
      const ks = clamp01(sClock * (1 + n * 0.07) - (struct ? i : n - 1 - i) * 0.07);
      const e = easeIO(ks), mid = Math.sin(Math.PI * e);
      const dx = slot.x - x, dy = slot.y - y, len = Math.hypot(dx, dy) || 1;
      const bow = Math.min(140, len * 0.3) * (i % 2 ? 1 : -1) * mid;
      x += dx * e + (-dy / len) * bow;
      y += dy * e + (dx / len) * bow;
      scale += (slot.scale - scale) * e;
      turn = turn * (1 - e) + mid * 9 * (i % 2 ? -1 : 1);
      opacity += (1 - opacity) * e;
      blur = blur * (1 - e) + mid * 3.5;
      z = e > 0.5 ? 30 : z;
    }
    node.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -50%) rotate(${turn.toFixed(2)}deg) scale(${scale.toFixed(3)})`;
    node.style.opacity = opacity.toFixed(3);
    node.style.zIndex = String(z);
    node.style.filter = blur > 0.05 ? `blur(${blur.toFixed(2)}px)` : "";
    node.tabIndex = (struct ? sClock > 0.6 : kk > 0.6) ? 0 : -1;
  });
  // заголовки колонок проявляются, когда карточки уже на подлёте
  groupHeads.forEach((h, j) => {
    const o = easeOut(clamp01(sClock * 1.8 - 0.55 - j * 0.08));
    h.style.opacity = o.toFixed(3);
    h.style.transform = `translate(${h._x.toFixed(1)}px, ${(h._y + (1 - o) * 16).toFixed(1)}px) translate(-50%, -50%)`;
  });
  if (orbitQ > 0.001 || orbitQs > 0.001 || sClock > 0) orbitRaf = requestAnimationFrame(orbitFrame);
}

// ---------- раскладка «по темам»: колонки под уменьшенным шаром ----------
const GROUPS = [
  { id: "meet", name: "Встречи" },
  { id: "task", name: "Задачи и напоминания" },
  { id: "plan", name: "Планы и поиск" },
  { id: "other", name: "Разное" },
];
function groupOf(c) {
  const sc = { meet: 0, task: 0, plan: 0, other: 0 };
  for (const m of c.messages) {
    if (m.role !== "bot" || !m.res) continue;
    const a = m.res.action, t = m.res.data?.item?.type;
    if (a === "create_meeting" || t === "meeting") sc.meet += 2;
    else if (a === "create_task" || a === "complete" || t === "task" || t === "reminder") sc.task += 2;
    else if (a === "list_events" || a === "search") sc.plan += 2;
    else sc.other += 1;
  }
  const best = Object.entries(sc).sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : "other";
}
let groupHeads = [];
function layoutBoard() {
  groupHeads.forEach((h) => h.remove());
  groupHeads = [];
  if (!struct && sClock === 0) return;
  const W = innerWidth, H = window.visualViewport?.height || innerHeight;
  const narrow = W <= 760;
  const cardH = narrow ? 76 : 78, gap = narrow ? 8 : 12, headH = narrow ? 28 : 36, colGap = narrow ? 10 : 18;
  const groups = GROUPS.map((g) => ({ ...g, nodes: projectNodes.filter((nd) => nd.dataset.group === g.id) })).filter((g) => g.nodes.length);
  const newNode = projectNodes.find((nd) => nd.dataset.group === "new");
  const cols = narrow ? Math.min(2, Math.max(1, groups.length)) : Math.max(1, groups.length);
  const colW = Math.min(narrow ? 220 : 280, (W - (narrow ? 20 : 64) - (cols - 1) * colGap) / cols);
  root.setProperty("--colw", `${Math.floor(colW)}px`);
  root.setProperty("--cardh", `${cardH}px`);
  // группы по колонкам: на телефоне — в самую короткую из двух
  const colsArr = Array.from({ length: cols }, () => ({ h: 0, items: [] }));
  groups.forEach((g, gi) => {
    const col = narrow ? colsArr.reduce((a, b) => (b.h < a.h ? b : a)) : colsArr[gi];
    col.items.push({ head: g });
    col.h += headH;
    g.nodes.forEach((nd) => { col.items.push({ node: nd }); col.h += cardH + gap; });
  });
  if (newNode) { const col = colsArr.reduce((a, b) => (b.h < a.h ? b : a)); col.items.push({ node: newNode }); col.h += cardH + gap; }
  const top = H * (narrow ? 0.4 : 0.41), bottom = H - (narrow ? 14 : 24);
  const need = Math.max(...colsArr.map((c) => c.h));
  const k = Math.min(1, (bottom - top) / Math.max(1, need));     // не влезает — сжимаем всю доску
  const total = cols * colW + (cols - 1) * colGap;
  colsArr.forEach((col, ci) => {
    const cx = -total / 2 + colW / 2 + ci * (colW + colGap);
    let yy = top + Math.max(0, bottom - top - need) * 0.3;        // короткая доска — чуть ниже, ближе к центру
    for (const it of col.items) {
      if (it.head) {
        const h = el("div", "group-h");
        h.append(el("span", "gn", it.head.name), el("span", "gc", String(it.head.nodes.length)));
        h.style.width = `${Math.floor(colW)}px`;
        h._x = cx; h._y = yy + (headH * k) / 2 - H / 2 - 2;
        h.style.opacity = "0";
        orbitEl.append(h);
        groupHeads.push(h);
        yy += headH * k;
      } else {
        it.node._slot = { x: cx, y: yy + (cardH * k) / 2 - H / 2, scale: k };
        yy += (cardH + gap) * k;
      }
    }
  });
}
function setStruct(on) {
  if (on === struct) return;
  struct = on;
  projectsEl.dataset.struct = String(on);
  orbHit.setAttribute("aria-pressed", String(on));
  orbHit.setAttribute("aria-label", on ? "Вернуть чаты на орбиту" : "Разложить чаты по темам");
  $("orbHintText").textContent = on ? "Нажмите на шар ещё раз — вернуть орбиту" : "Нажмите на шар — разложу чаты по темам";
  if (on) layoutBoard();
  startOrbit();
}
const orbHit = $("orbHit");
orbHit.addEventListener("click", () => { orb.poke(); setStruct(!struct); });
addEventListener("keydown", (e) => { if (e.key === "Escape" && struct) setStruct(false); });
addEventListener("resize", () => { if (struct) layoutBoard(); });
addEventListener("scroll", requestScene, { passive: true });
addEventListener("resize", requestScene);
// высота видимой области: на телефоне клавиатура уменьшает её, сцена подстраивается
function updateVh() { root.setProperty("--vh", `${Math.round(window.visualViewport?.height || innerHeight)}px`); requestScene(); }
window.visualViewport?.addEventListener("resize", updateVh);
updateVh();
chatEl.inert = true;
requestScene();                                                   // первый расчёт — после загрузки всего модуля
/** Довести прокрутку до открытого чата (например, когда пользователь начал печатать/говорить). */
function openChat() {
  if (chatOpen) return;
  const vh = window.visualViewport?.height || innerHeight;
  window.scrollTo({ top: scene.offsetTop + vh * 0.95, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
}

// ---------- дата в шапке и формат дат ----------
const fmtDay = new Intl.DateTimeFormat("ru-RU", { weekday: "long", day: "numeric", month: "long" });
const fmtShort = new Intl.DateTimeFormat("ru-RU", { weekday: "short", day: "numeric", month: "long" });
const isoLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const fromIso = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
$("today").textContent = fmtDay.format(new Date());
const TYPE_RU = { task: "Задача", reminder: "Напоминание", meeting: "Встреча" };

function when(item) {
  if (!item.due_date) return "без срока";
  const today = isoLocal(new Date());
  const tomorrow = isoLocal(new Date(Date.now() + 864e5));
  const day = item.due_date === today ? "сегодня" : item.due_date === tomorrow ? "завтра" : fmtShort.format(fromIso(item.due_date));
  const dur = item.type === "meeting" && item.duration_min ? ` · ${item.duration_min} мин` : "";
  return `${day}${item.due_time ? ` · ${item.due_time}` : ""}${dur}`;
}

// ---------- озвучка ----------
let muted = (() => { try { return localStorage.getItem("va.muted") === "1"; } catch { return false; } })();
let hasRuVoice = false;
function checkVoices() {
  try { hasRuVoice = speechSynthesis.getVoices().some((v) => v.lang?.toLowerCase().startsWith("ru")); } catch { hasRuVoice = false; }
}
if (typeof speechSynthesis !== "undefined") { checkVoices(); speechSynthesis.addEventListener?.("voiceschanged", checkVoices); }
function renderMute() {
  ui.mute.setAttribute("aria-pressed", String(muted));
  ui.mute.title = muted ? "Включить озвучку" : "Выключить озвучку";
  ui.muteLabel.textContent = muted ? "Звук выключен" : "Звук включён";
}
ui.mute.addEventListener("click", () => {
  muted = !muted;
  try { localStorage.setItem("va.muted", muted ? "1" : "0"); } catch { /* ignore */ }
  if (muted) try { speechSynthesis.cancel(); } catch { /* ignore */ }
  renderMute();
});
renderMute();

// ---------- лента диалога ----------
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const MIC_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.9V21h2v-3.1A7 7 0 0 0 19 11h-2z"/></svg>';

// прокручиваем только ленту чата, страницу не трогаем
function scrollDown() { requestAnimationFrame(() => { ui.thread.scrollTop = ui.thread.scrollHeight; }); }

function addUser(text, { voice = false, note = "" } = {}) {
  ui.thread.querySelector(".welcome")?.remove();
  const li = el("li", "msg user");
  li.append(el("div", "bubble", text));
  if (voice) {
    const via = el("div", "via");
    via.innerHTML = MIC_SVG;
    via.append(note || "голосом, расшифровка");
    li.append(via);
  }
  ui.thread.append(li);
  scrollDown();
  record({ role: "user", text, voice, note });
}

function card(item, extra = "") {
  const c = el("div", `card${item.status === "done" ? " done" : ""}`);
  c.dataset.type = item.type;
  c.append(el("span", "kind"), el("span", "title", item.title));
  const w = el("span", "when", `${TYPE_RU[item.type]} · ${when(item)}`);
  if (extra) w.append(" ", el("span", "score", extra));
  c.append(w);
  return c;
}

function addBot(res) {
  const kind = res.status === "error" ? " error" : res.status === "need_clarification" ? " clarify" : "";
  const li = el("li", `msg bot${kind}`);
  li.append(el("div", "bubble", res.reply_text));
  const d = res.data || {};
  const cards = el("div", "cards");
  if (d.item && res.action !== "delete") cards.append(card(d.item));
  if (Array.isArray(d.items)) d.items.forEach((it) => cards.append(card(it)));               // на экране — все записи (FR-3.6)
  if (Array.isArray(d.results)) d.results.forEach((r) => cards.append(card(r.item, `${r.match} · ${r.score}`)));
  if (Array.isArray(d.candidates)) d.candidates.forEach((it, i) => cards.append(card({ ...it, title: `${i + 1}. ${it.title}` })));
  if (cards.childElementCount) li.append(cards);
  if (d.conflicts?.length) li.append(el("div", "conflict", `Пересечение: ${d.conflicts.map((c) => `«${c.title}» в ${c.due_time}`).join(", ")}`));
  if (res.meta) li.append(explain(res));
  ui.thread.append(li);
  scrollDown();
  record({ role: "bot", res: { action: res.action, status: res.status, reply_text: res.reply_text, data: res.data, meta: res.meta, missing_slots: res.missing_slots, error: res.error } });
}

// «как я понял»: интент, уверенность, извлечённые слоты и то, что посчитал код (даты) — логика видна
const INTENT_RU = {
  create_task: "создать задачу", create_meeting: "создать встречу", list_events: "показать планы", search: "найти",
  update: "изменить", delete: "удалить", complete: "отметить выполненным", clarify_answer: "ответ на уточнение", unknown: "не понято",
};
const SLOT_SKIP = new Set(["title_raw"]);
function slotText(v) {
  if (v == null || v === "" || v === false || (Array.isArray(v) && !v.length)) return null;
  if (typeof v !== "object") return String(v);
  if (Array.isArray(v)) return v.map(slotText).filter(Boolean).join(", ");
  if (v.kind === "none") return null;
  return Object.entries(v).filter(([, x]) => x != null && x !== "" && x !== false).map(([k, x]) => `${k}=${typeof x === "object" ? JSON.stringify(x) : x}`).join(" ") || null;
}
function explain(res) {
  const m = res.meta, nlu = m.nlu;
  const d = el("details", "why");
  d.append(el("summary", null, `как я понял · ${m.nlu_provider || "—"} · ${m.latency_ms} мс`));
  if (!nlu) return d;
  const body = el("div", "why-body");
  const row = (label, ...content) => { const r = el("div", "why-row"); r.append(el("span", null, label), ...content); body.append(r); };
  row("намерение", el("span", null, `${INTENT_RU[nlu.intent] || nlu.intent} → ${res.action} · ${res.status}`));
  const bar = el("div", "why-bar"), fill = el("i");
  fill.style.width = `${Math.round((nlu.confidence || 0) * 100)}%`;
  bar.append(fill);
  const conf = el("div"); conf.style.cssText = "display:grid;grid-template-columns:1fr auto;gap:10px;align-items:center";
  conf.append(bar, el("span", null, `${Math.round((nlu.confidence || 0) * 100)}%`));
  row("уверенность", conf);
  const slots = el("div", "why-slots");
  for (const [k, v] of Object.entries(nlu.slots || {})) {
    if (SLOT_SKIP.has(k)) continue;
    const t = slotText(v);
    if (t) slots.append(el("code", null, `${k}: ${t}`));
  }
  if (slots.childElementCount) row("извлекла", slots);
  const it = res.data?.item;
  if (it?.due_at) row("посчитал код", el("span", null, `${it.due_at}${it.duration_min ? ` · ${it.duration_min} мин` : ""}`));
  if (res.missing_slots?.length) row("не хватает", el("span", null, res.missing_slots.join(", ")));
  body.append(el("p", "why-note", "LLM понимает смысл, даты и время считает код — без ошибок «завтра» в полночь."));
  body.querySelector(".why-note").style.margin = "0";
  d.append(body);
  return d;
}

function addNote(text, cls = "error") {
  const li = el("li", `msg bot ${cls}`);
  li.append(el("div", "bubble", text));
  ui.thread.append(li);
  scrollDown();
  record({ role: "note", text, cls });
}

// ---------- система чатов: у каждого чата свой session_id (контекст на сервере) и история в браузере ----------
const CHATS_KEY = "va.chats";
const loadChats = () => { try { return JSON.parse(localStorage.getItem(CHATS_KEY) || "[]"); } catch { return []; } };
let chats = loadChats();
let replaying = false;
function saveChats() {
  chats.sort((a, b) => b.updatedAt - a.updatedAt);
  chats = chats.slice(0, 50);
  try { localStorage.setItem(CHATS_KEY, JSON.stringify(chats)); } catch { /* переполнение — не критично */ }
  renderChatsMenu();
  renderProjects();
}
const currentChat = () => chats.find((c) => c.id === id.session);
function ensureChat() {
  let c = currentChat();
  if (!c) { c = { id: id.session, title: "Новый чат", createdAt: Date.now(), updatedAt: Date.now(), messages: [] }; chats.unshift(c); }
  return c;
}
function record(msg) {
  if (replaying) return;
  const c = ensureChat();
  c.messages.push(msg);
  if (c.messages.length > 200) c.messages.splice(0, c.messages.length - 200);
  if (msg.role === "user" && c.title === "Новый чат") c.title = msg.text.length > 42 ? `${msg.text.slice(0, 40)}…` : msg.text;
  c.updatedAt = Date.now();
  saveChats();
}
function renderThread() {
  ui.thread.replaceChildren();
  setChips([]);
  const c = currentChat();
  if (!c || !c.messages.length) { welcome(); return; }
  replaying = true;
  for (const m of c.messages) {
    if (m.role === "user") addUser(m.text, { voice: m.voice, note: m.note });
    else if (m.role === "bot") addBot(m.res);
    else addNote(m.text, m.cls);
  }
  replaying = false;
  const last = c.messages.at(-1);
  if (last?.role === "bot") setChips(chipsFor(last.res));
}
function switchChat(chatId) {
  if (busy || recording) return;
  try { speechSynthesis.cancel(); } catch { /* ignore */ }
  id.use(chatId);
  orb.setState("idle");
  renderThread();
  closeMenu();
  renderChatsMenu();
  renderProjects();
}
function newChat() {
  if (busy || recording) return;
  try { speechSynthesis.cancel(); } catch { /* ignore */ }
  id.newSession();
  orb.setState("idle");
  renderThread();
  closeMenu();
  renderChatsMenu();
  renderProjects();
}
function deleteChat(chatId) {
  chats = chats.filter((c) => c.id !== chatId);
  if (chatId === id.session) { id.newSession(); renderThread(); }
  saveChats();
}

const fmtWhen = (ts) => {
  const d = new Date(ts), today = isoLocal(new Date()), day = isoLocal(d);
  if (day === today) return `сегодня, ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return fmtShort.format(d);
};
const plural = (n, a, b, c) => (n % 10 === 1 && n % 100 !== 11 ? a : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? b : c);
const msgCount = (c) => { const n = c.messages.filter((m) => m.role === "user").length; return `${n} ${plural(n, "запрос", "запроса", "запросов")}`; };

// меню чатов
const menu = $("chatsMenu"), chatsBtn = $("chatsBtn");
function closeMenu() { menu.hidden = true; chatsBtn.setAttribute("aria-expanded", "false"); }
function renderChatsMenu() {
  const list = $("chatsList");
  const items = chats.filter((c) => c.messages.length || c.id === id.session);
  list.replaceChildren(...items.map((c) => {
    const li = el("li", "chat-item");
    if (c.id === id.session) li.setAttribute("aria-current", "true");
    const open = el("button", "open");
    open.type = "button";
    open.append(el("span", "t", c.title), el("span", "m", `${msgCount(c)} · ${fmtWhen(c.updatedAt)}`));
    open.addEventListener("click", () => switchChat(c.id));
    const del = el("button", "del", "×");
    del.type = "button";
    del.setAttribute("aria-label", `Удалить чат «${c.title}»`);
    del.addEventListener("click", (e) => { e.stopPropagation(); deleteChat(c.id); });
    li.append(open, del);
    return li;
  }));
}
chatsBtn.addEventListener("click", () => {
  menu.hidden = !menu.hidden;
  chatsBtn.setAttribute("aria-expanded", String(!menu.hidden));
  if (!menu.hidden) renderChatsMenu();
});
$("chatsNew").addEventListener("click", newChat);
addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenu(); });
document.addEventListener("pointerdown", (e) => { if (!menu.hidden && !menu.contains(e.target) && !chatsBtn.contains(e.target)) closeMenu(); });

// ---------- фаза 3: чаты на орбите вокруг шара ----------
const projectsEl = $("projects"), orbitEl = $("projectsOrbit");
let projectNodes = [];
function renderProjects() {
  const list = chats.filter((c) => c.messages.length).slice(0, 8);
  const nodes = [];
  const make = (c, isNew) => {
    const b = el("button", `project${isNew ? " new" : ""}`);
    b.type = "button";
    if (!isNew && c.id === id.session) b.dataset.current = "true";
    b.dataset.group = isNew ? "new" : groupOf(c);
    const lastBot = isNew ? null : [...c.messages].reverse().find((m) => m.role === "bot")?.res?.reply_text;
    b.append(el("span", "pt", isNew ? "+ Новый чат" : c.title), el("span", "pm", isNew ? "начать разговор" : `${msgCount(c)} · ${fmtWhen(c.updatedAt)}`),
      el("span", "px", isNew ? "Задача, встреча или вопрос о планах" : lastBot || ""));
    b.addEventListener("click", () => { isNew ? newChat() : switchChat(c.id); openChat(true); });
    return b;
  };
  for (const c of list) nodes.push(make(c, false));
  nodes.push(make(null, true));
  orbitEl.replaceChildren(...nodes);
  groupHeads = [];
  projectNodes = nodes;
  if (struct) layoutBoard();
}

const EXAMPLES = [
  "Напомни мне завтра в 10 утра позвонить Ивану",
  "Добавь встречу с командой завтра в 15:00",
  "Что у меня сегодня?",
  "Найди задачу про презентацию",
];
function welcome() {
  const li = el("li", "welcome");
  li.append(el("h1", null, "Скажите или напишите, что нужно сделать"), el("p", null, "Я поставлю задачу, напоминание или встречу, покажу план и найду старые записи."));
  ui.thread.append(li);
  setChips(EXAMPLES);
}

// ---------- быстрые ответы ----------
let busy = false;
function setChips(list) {
  ui.chips.replaceChildren(...list.map((t) => {
    const b = el("button", "chip", t);
    b.type = "button";
    b.disabled = busy;
    b.addEventListener("click", () => sendText(t));
    return b;
  }));
}
function chipsFor(res) {
  const m = res.missing_slots || [];
  if (res.status !== "need_clarification") return [];
  if (m.includes("confirm")) return ["Да", "Нет"];
  if (m.includes("ampm")) return ["утра", "вечера"];
  if (m.includes("target") && res.data?.candidates?.length) return res.data.candidates.map((_, i) => String(i + 1));
  if (/субботу или/.test(res.reply_text)) return ["в субботу", "в воскресенье"];
  if (m.includes("title")) return [];
  if (m.includes("date") && m.includes("time")) return ["завтра в 10 утра", "сегодня в 18:00", "в понедельник в 9:00"];
  if (m.includes("time")) return ["в 10 утра", "в 15:00", "в 19:00"];
  if (m.includes("date")) return ["завтра", "в понедельник", "в пятницу"];
  return [];
}

// ---------- запрос → ответ ----------
let recording = null;
function setBusy(v) {
  busy = v;                                   // POST не идемпотентны: блокируем кнопки на время запроса
  ui.send.disabled = v;
  ui.mic.disabled = v && !recording;
  ui.chips.querySelectorAll("button").forEach((b) => { b.disabled = v; });
}
function attention(on = true) {
  ui.composer.classList.toggle("attention", on);
  if (on) ui.input.focus({ preventScroll: true });
}

async function handle(res) {
  addBot(res);
  heroAnswer(res);
  setChips(chipsFor(res));
  const code = res.error?.code || "";
  if (code.startsWith("STT") || code === "UNKNOWN_INTENT") attention(true);
  if (res.status === "ok" && ["create_task", "create_meeting", "update", "complete", "delete"].includes(res.action)) loadAgenda();
  ui.live.textContent = "";
  setBusy(false);
  await orb.speak(res.reply_text, { tts: !muted && hasRuVoice });   // без голоса ru-RU — только текст (VR-8)
}

async function sendText(text, { voice = false, note = "" } = {}) {
  text = String(text || "").trim().slice(0, 500);
  if (!text || busy) return;
  heroLive(text);
  attention(false);
  addUser(text, { voice, note });
  ui.input.value = "";
  setChips([]);
  setBusy(true);
  orb.setState("thinking");
  try {
    await handle(await api.message(text));
  } catch (e) {
    setBusy(false);
    orb.setState("idle");
    addNote(e.http === 429 ? "Слишком много запросов. Подождите минуту." : e.http ? `Не получилось: ${e.message}` : "Нет связи с сервером. Проверьте интернет и попробуйте ещё раз.");
    heroText(e.http ? "Не получилось. Попробуйте ещё раз." : "Нет связи с сервером.");
    attention(true);
  }
}

ui.composer.addEventListener("submit", (e) => { e.preventDefault(); sendText(ui.input.value); });

// ---------- запись голоса ----------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

function browserRecognition() {
  if (!SR) return null;
  const r = new SR();
  r.lang = "ru-RU"; r.interimResults = true; r.continuous = true;
  let finalText = "", interim = "", lastAt = 0;
  r.onresult = (e) => {
    interim = ""; lastAt = Date.now();
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) finalText += e.results[i][0].transcript + " ";
      else interim += e.results[i][0].transcript;
    }
    ui.live.textContent = (finalText + interim).trim();
    heroLive(ui.live.textContent);
  };
  r.onerror = () => {};
  try { r.start(); } catch { return null; }
  return { stop() { try { r.stop(); } catch { /* ignore */ } }, text: () => (finalText + interim).replace(/\s+/g, " ").trim(), get lastAt() { return lastAt; } };
}

function micUnavailable(text) {
  addNote(text);
  heroText(text);
  attention(true);
  orb.setState("idle");
}

async function startRecording({ auto = false } = {}) {
  if (busy || recording) return;
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    return micUnavailable(location.protocol === "https:" || location.hostname === "localhost"
      ? "Микрофон в этом браузере недоступен. Напишите запрос текстом."
      : "Микрофон работает только по HTTPS. Напишите запрос текстом.");
  }
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch { return micUnavailable("Нет доступа к микрофону. Разрешите его в настройках браузера или напишите текстом."); }
  const mime = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus", "audio/webm"].find((m) => MediaRecorder.isTypeSupported?.(m)) || "";
  const mr = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : undefined);
  const chunks = [];
  mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const started = Date.now();
  recording = {
    mr, stream, chunks, started, recog: browserRecognition(),
    tick: setInterval(() => {
      ui.timer.textContent = `${Math.floor((Date.now() - started) / 1000)} / 30 с`;
      // с первого экрана — «свободные руки»: замолчали на 1,4 с после фразы (или молчим 8 с) — отправляем сами
      const rg = recording?.recog;
      if (auto && rg && ((rg.lastAt && Date.now() - rg.lastAt > 1400) || (!rg.lastAt && Date.now() - started > 8000))) stopRecording();
    }, 200),
    limit: setTimeout(stopRecording, 30_000),                     // VR-7: не дольше 30 секунд
  };
  mr.start(250);
  ui.mic.setAttribute("aria-pressed", "true");
  ui.mic.setAttribute("aria-label", "Остановить запись");
  setChips([]);
  orb.setState("listening");
}

async function stopRecording() {
  const r = recording;
  if (!r) return;
  recording = null;
  clearInterval(r.tick); clearTimeout(r.limit);
  ui.timer.textContent = "";
  ui.mic.setAttribute("aria-pressed", "false");
  ui.mic.setAttribute("aria-label", "Записать голос (или удерживайте пробел)");
  await new Promise((res) => { r.mr.onstop = res; try { r.mr.stop(); } catch { res(); } });
  r.stream.getTracks().forEach((t) => t.stop());
  r.recog?.stop();
  await new Promise((res) => setTimeout(res, 300));               // даём браузеру дослать финальный текст
  const blob = new Blob(r.chunks, { type: r.mr.mimeType || "audio/webm" });
  const browserText = r.recog?.text() || "";
  if (Date.now() - r.started < 500 || blob.size < 600) { orb.setState("idle"); ui.live.textContent = ""; heroIdle(); return; }  // случайное касание

  setBusy(true);
  orb.setState("thinking");
  let res = null;
  try { if (blob.size <= 1024 * 1024) res = await api.voice(blob); }
  catch (e) { res = null; if (e.http && e.http !== 413 && e.http !== 415) { setBusy(false); orb.setState("idle"); addNote(`Не получилось: ${e.message}`); return; } }
  const sttFailed = !res || ["STT_UNAVAILABLE", "STT_EMPTY"].includes(res.error?.code);
  if (sttFailed && browserText) {
    setBusy(false);
    return sendText(browserText, { voice: true, note: "голосом, расшифровка браузера" });
  }
  if (!res) { setBusy(false); orb.setState("idle"); addNote("Не удалось распознать запись. Напишите запрос текстом."); heroText("Не расслышала. Попробуйте ещё раз — нажмите на шар."); attention(true); return; }
  if (res.meta?.transcript) addUser(res.meta.transcript, { voice: true });
  await handle(res);
}

ui.mic.addEventListener("click", () => (recording ? stopRecording() : startRecording()));
// push-to-talk: удерживайте пробел вне поля ввода (только когда чат открыт — иначе пробел листает страницу)
const typing = () => ["INPUT", "TEXTAREA", "BUTTON"].includes(document.activeElement?.tagName);
addEventListener("keydown", (e) => { if (e.code === "Space" && !e.repeat && (chatOpen || heroActive) && !typing() && !recording) { e.preventDefault(); startRecording(); } });

// ---------- первый экран: шар слушает и отвечает субтитрами ----------
const hero = { orb: $("heroOrb"), line: $("heroLine"), card: $("heroCard"), bubble: $("heroBubble") };
// В покое под шаром пусто — субтитр появляется, только пока идёт разговор, и сам гаснет
let heroTimer = 0;
function heroSet(text, kind = "") {
  clearTimeout(heroTimer);
  heroEl.dataset.cap = "on";
  hero.line.textContent = text;
  hero.bubble.dataset.kind = kind;
  hero.bubble.classList.remove("swap"); void hero.bubble.offsetWidth; hero.bubble.classList.add("swap");   // перезапуск анимации смены текста
}
function heroIdle() {
  clearTimeout(heroTimer);
  heroEl.dataset.cap = "off";
}
function heroState(s) {
  hero.orb.setAttribute("aria-pressed", String(s === "listening"));
  heroEl.dataset.state = s;
  if (s === "listening") { heroSet("Слушаю…", "live"); hero.card.hidden = true; }
}
function heroLive(text) { if (text) { clearTimeout(heroTimer); hero.line.textContent = `«${text}»`; hero.bubble.dataset.kind = "live"; } }
function heroText(text) {
  heroSet(text, "error"); hero.card.hidden = true;
  heroTimer = setTimeout(heroIdle, 6000);
}
function heroAnswer(res) {
  heroSet(res.reply_text, res.status === "error" ? "error" : "answer");
  const it = res.data?.item || res.data?.items?.[0] || res.data?.results?.[0]?.item;
  hero.card.hidden = !it;
  if (it) hero.card.replaceChildren(card(it));
  heroTimer = setTimeout(heroIdle, it ? 12000 : 9000);
}
hero.orb.addEventListener("click", () => (recording ? stopRecording() : startRecording({ auto: true })));
heroIdle();
addEventListener("keyup", (e) => { if (e.code === "Space" && !typing() && recording) { e.preventDefault(); stopRecording(); } });

// ---------- план на 7 дней ----------
async function loadAgenda() {
  const from = new Date();
  const to = new Date(Date.now() + 6 * 864e5);
  let data;
  try { data = await api.events(isoLocal(from), isoLocal(to)); }
  catch { ui.agenda.replaceChildren(el("p", "empty", "План не загрузился.")); return; }
  reminders.items = data.items;
  if (!data.items.length) { ui.agenda.replaceChildren(el("p", "empty", "На неделю ничего не запланировано.")); return; }
  const byDay = new Map();
  for (const it of data.items) {
    if (!byDay.has(it.due_date)) byDay.set(it.due_date, []);
    byDay.get(it.due_date).push(it);
  }
  const today = isoLocal(new Date()), tomorrow = isoLocal(new Date(Date.now() + 864e5));
  const blocks = [];
  for (const [day, list] of byDay) {
    const sec = el("section", "day");
    sec.append(el("h3", null, day === today ? "Сегодня" : day === tomorrow ? "Завтра" : fmtDay.format(fromIso(day))));
    for (const it of list) {
      const row = el("label", `row${it.status === "done" ? " done" : ""}`);
      row.dataset.type = it.type;
      const box = el("input");
      box.type = "checkbox"; box.checked = it.status === "done";
      box.setAttribute("aria-label", `Выполнено: ${it.title}`);
      box.addEventListener("change", async () => {
        try { await api.complete(it.id, box.checked); row.classList.toggle("done", box.checked); }
        catch { box.checked = !box.checked; }
      });
      row.append(box, el("span", "t", it.due_time || "—"), el("span", "k"), el("span", "title", it.title));
      sec.append(row);
    }
    blocks.push(sec);
  }
  ui.agenda.replaceChildren(...blocks);
}
$("refresh").addEventListener("click", loadAgenda);

// ---------- живые напоминания: в срок — стеклянный тост сверху и голос шара ----------
const reminders = {
  items: [],
  fired: new Set((() => { try { return JSON.parse(localStorage.getItem("va.fired") || "[]"); } catch { return []; } })()),
  snoozed: new Map(),
};
function markFired(key) {
  reminders.fired.add(key);
  try { localStorage.setItem("va.fired", JSON.stringify([...reminders.fired].slice(-200))); } catch { /* ignore */ }
}
function toast(it, { title = it.title, sub } = {}) {
  const t = el("div", "toast");
  t.setAttribute("role", "alert");
  const tt = el("div", "tt");
  tt.append(el("b", null, title), el("span", null, sub || `${TYPE_RU[it.type] || "Напоминание"} · ${it.due_time || "сейчас"}`));
  const tb = el("div", "tb");
  const done = el("button", "primary", "Готово"), later = el("button", null, "+10 мин");
  done.type = later.type = "button";
  tb.append(later, done);
  t.append(el("span", "ti"), tt, tb);
  const close = () => { if (t.classList.contains("out")) return; t.classList.add("out"); setTimeout(() => t.remove(), 450); };
  done.addEventListener("click", async () => { close(); if (it.id) try { await api.complete(it.id, true); loadAgenda(); } catch { /* ignore */ } });
  later.addEventListener("click", () => { close(); reminders.snoozed.set(`${it.id}@${it.due_at}`, Date.now() + 10 * 60e3); });
  $("toasts").append(t);
  setTimeout(close, 25_000);
}
function fireReminder(it) {
  toast(it);
  if (!busy && !recording) orb.speak(`Напоминаю: ${it.title}`, { tts: !muted && hasRuVoice });
}
function checkReminders() {
  const now = Date.now();
  for (const it of reminders.items) {
    if (it.status === "done" || !it.due_at || !it.due_time) continue;
    const key = `${it.id}@${it.due_at}`, at = reminders.snoozed.get(key) ?? Date.parse(it.due_at);
    if (now >= at && now - at < 5 * 60e3 && !reminders.fired.has(key + (reminders.snoozed.has(key) ? "+s" : ""))) {
      markFired(key + (reminders.snoozed.has(key) ? "+s" : ""));
      fireReminder(it);
    }
  }
}
setInterval(checkReminders, 10_000);
setInterval(loadAgenda, 5 * 60e3);

$("newSession").addEventListener("click", newChat);

renderThread();
renderChatsMenu();
renderProjects();
loadAgenda();
// ?debug — ручной шаг анимации орбиты (для проверки кадров в фоновой вкладке, где rAF замедлен)
if (params.has("debug")) window.__orbit = { frame: (dtMs = 16.7) => { cancelAnimationFrame(orbitRaf); orbitFrame(orbitLast + dtMs); }, get state() { return { orbitQ, orbitQs, sClock, struct, inviting }; } };
window.assistant = {
  orb, api, sendText, openChat, newChat, switchChat, chats: () => chats, setStruct,
  /** для демо: показать напоминание прямо сейчас */
  demoReminder: (title = "Позвонить Ивану") => fireReminder({ id: null, type: "reminder", title, due_time: new Date().toTimeString().slice(0, 5) }),
};
