// Адаптер NLU: parse(text, context) → NluResult. Цепочка Yandex → GigaChat → RuleBased (docs/05 раздел 6):
// невалидный JSON или схема → 1 ретрай с подсказкой об ошибке → следующий провайдер; таймаут/5xx →
// сразу следующий. Пользователь стектрейса не видит, сбои уходят в лог с request_id.
import { config } from "../config.js";
import { buildMessages } from "./prompt.js";
import { extractJson, validateNlu } from "./schema.js";
import { parseRuleBased } from "./rulebased.js";
import * as openrouter from "./openrouter.js";
import * as yandex from "./yandex.js";
import * as gigachat from "./gigachat.js";

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

function withTimeout(fn, ms) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  return fn(ctl.signal).finally(() => clearTimeout(timer));
}

/**
 * @param {{providers?: {name: string, available: () => boolean, complete: Function}[], timeoutMs?: number,
 *          log?: (event: object) => void}} opts
 */
export function createNlu({ providers = [openrouter, yandex, gigachat], timeoutMs = config.llmTimeoutMs, log = () => {} } = {}) {
  const status = Object.fromEntries(providers.map((p) => [p.name, p.available() ? "configured" : "unknown"]));

  async function viaLlm(p, norm, ctx) {
    let hint = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      let text;
      try {
        text = await withTimeout((signal) => p.complete(buildMessages(norm.clean, ctx, hint), { signal }), timeoutMs);
        status[p.name] = "up";
      } catch (e) {
        status[p.name] = "down";
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
      for (const p of providers) {
        if (!p.available()) continue;
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
