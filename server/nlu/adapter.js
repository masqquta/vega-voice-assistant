// Адаптер NLU: parse(text, context) → NluResult. Цепочка Yandex → GigaChat → RuleBased (docs/05 раздел 6):
// невалидный JSON или схема → 1 ретрай с подсказкой об ошибке → следующий провайдер; таймаут/5xx →
// сразу следующий. Пользователь стектрейса не видит, сбои уходят в лог с request_id.
import { config } from "../config.js";
import { buildMessages } from "./prompt.js";
import { extractJson, validateNlu } from "./schema.js";
import { parseRuleBased } from "./rulebased.js";
import { word } from "./normalize.js";
import * as groq from "./groq.js";
import * as openrouter from "./openrouter.js";
import * as yandex from "./yandex.js";
import * as gigachat from "./gigachat.js";

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

// Каскад «сначала правила»: бесплатный слой отвечает сам, только если фраза «чистая» — на ней правила
// не ошибаются (docs/eval: 100% на базовом наборе). Признаки «грязной» фразы подобраны по ошибкам
// правил на docs/eval/phrases_hard.csv: разговорные вставки, «полтора», «30-е», опечатка в дне
// недели (похоже на дату, а даты нет), вопрос, понятый как создание задачи, длинная фраза.
const COLLOQUIAL = word("слушай|короче|че|чо|типа|вроде|ну|бы|чтоб|ближе|полтора|полчаса|связан[а-я]*|что-нибудь|когда-то|ой|эээ|э+|блин", "iu");
const DATEISH = /(?<![а-я])(понед|вторн|сред[аеуы]|четве|пятн|субб|воскр|январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентяб|октяб|ноябр|декаб|завтр|послезав)/iu;
const ORDINAL_DAY = /\d+-?(е|го|ое)(?![а-я])/iu;

/** Можно ли отдать ответ правил без LLM. */
export function rulesConfident(norm, rb) {
  const m = norm.match;
  if (rb.intent === "unknown" || rb.confidence < 0.9) return false;
  if (COLLOQUIAL.test(m) || ORDINAL_DAY.test(m) || m.split(/\s+/).length > 10) return false;
  if (m.includes("?") && rb.intent.startsWith("create_")) return false;
  const kind = rb.slots?.date?.kind || "none";
  if (rb.intent !== "clarify_answer" && kind === "none" && DATEISH.test(m)) return false;   // «в четверк» — дата не распознана
  return true;
}

function withTimeout(fn, ms) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  return fn(ctl.signal).finally(() => clearTimeout(timer));
}

/**
 * @param {{providers?: {name: string, available: () => boolean, complete: Function}[], timeoutMs?: number,
 *          log?: (event: object) => void}} opts
 */
export function createNlu({ providers = [groq, openrouter, yandex, gigachat], timeoutMs = config.llmTimeoutMs, log = () => {}, cascade = false } = {}) {
  const status = Object.fromEntries(providers.map((p) => [p.name, p.available() ? "configured" : "unknown"]));
  const pausedUntil = {};                                 // 429 «лимит исчерпан» — не дёргаем провайдера 10 минут
  const QUOTA_PAUSE_MS = 10 * 60_000;

  async function viaLlm(p, norm, ctx) {
    let hint = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      let text;
      try {
        text = await withTimeout((signal) => p.complete(buildMessages(norm.clean, ctx, hint), { signal }), timeoutMs);
        status[p.name] = "up";
      } catch (e) {
        status[p.name] = e.status === 429 ? "quota" : "down";
        if (e.status === 429) pausedUntil[p.name] = Date.now() + (p.retryAfterMs?.() ?? QUOTA_PAUSE_MS);
        log({ event: "nlu_provider_error", provider: p.name, error: e.name === "AbortError" ? "timeout" : e.message });
        return null;                                      // таймаут / 5xx — без ретрая, к следующему провайдеру
      }
      try {
        const res = validateNlu(extractJson(text));
        if (res.slots.title) res.slots.title = cap(res.slots.title.replace(/\s+/g, " ").trim());
        return res;
      } catch (e) {
        hint = e.message;
        log({ event: "nlu_invalid", provider: p.name, attempt, error: e.message });
      }
    }
    return null;
  }

  return {
    status,
    /** @returns {Promise<object>} NluResult + provider */
    async parse(norm, ctx = {}) {
      if (cascade) {
        const rb = validateNlu(parseRuleBased(norm, ctx));
        if (rulesConfident(norm, rb)) return { ...rb, provider: "rulebased" };
      }
      for (const p of providers) {
        if (!p.available() || pausedUntil[p.name] > Date.now()) continue;
        const res = await viaLlm(p, norm, ctx);
        if (!res) continue;
        // LLM не поняла, а правила уверенно понимают — берём правила (страховка базовых фраз)
        if (res.intent === "unknown") {
          const rb = validateNlu(parseRuleBased(norm, ctx));
          if (rb.intent !== "unknown" && rb.confidence >= 0.7) return { ...rb, provider: "rulebased" };
        }
        return { ...res, provider: p.name };
      }
      return { ...validateNlu(parseRuleBased(norm, ctx)), provider: "rulebased" };
    },
  };
}
