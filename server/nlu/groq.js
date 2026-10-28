// Groq — OpenAI-совместимый API, бесплатный тариф, ответ за доли секунды. Ключ без карты: https://console.groq.com/keys.
// Лимиты бесплатного тарифа — у каждой модели свои: 1000 запросов в сутки и 8000 токенов в минуту, а наш
// промпт ~2500 токенов. Поэтому моделей несколько (GROQ_MODELS): упёрлись в лимит одной — сразу берём
// следующую, а исчерпанную пропускаем ровно на время из ответа Groq (retry-after). Итого ~3000 запросов/сутки.
import { config } from "../config.js";

export const name = "groq";
export const available = () => Boolean(config.groq.apiKey);

// «Размышления» для извлечения слотов не нужны и добавляют задержку: у gpt-oss — минимум, у qwen — выкл.
const reasoning = (model) => (/gpt-oss/.test(model) ? { reasoning_effort: "low" } : /qwen3/.test(model) ? { reasoning_effort: "none" } : {});

const pausedUntil = new Map();                       // модель → когда снова можно

/** «41.34s», «2m52.8s», «577ms» → миллисекунды. */
export function parseReset(s) {
  if (!s) return null;
  let ms = 0;
  for (const [, n, u] of String(s).matchAll(/([\d.]+)(ms|h|m|s)/g)) ms += Number(n) * { ms: 1, s: 1e3, m: 6e4, h: 36e5 }[u];
  return ms || null;
}

/** @param {{role: string, text: string}[]} messages  @returns {Promise<string>} */
export async function complete(messages, { signal } = {}) {
  let lastErr = null;
  for (const model of config.groq.models) {
    if (pausedUntil.get(model) > Date.now()) continue;
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.groq.apiKey}` },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 400,
        response_format: { type: "json_object" },     // модель обязана вернуть JSON
        ...reasoning(model),
        messages: messages.map((m) => ({ role: m.role, content: m.text })),
      }),
    });
    if (res.status === 429) {                        // лимит этой модели — пауза по подсказке Groq, пробуем следующую
      const wait = Number(res.headers.get("retry-after")) * 1000 || parseReset(res.headers.get("x-ratelimit-reset-tokens")) || 60_000;
      pausedUntil.set(model, Date.now() + wait);
      lastErr = Object.assign(new Error(`groq ${model} HTTP 429`), { status: 429 });
      continue;
    }
    if (!res.ok) throw Object.assign(new Error(`groq ${model} HTTP ${res.status}`), { status: res.status });
    const body = await res.json();
    return body?.choices?.[0]?.message?.content ?? "";
  }
  // все модели на паузе — адаптер пропустит Groq до ближайшего освобождения
  const soonest = Math.min(...config.groq.models.map((m) => pausedUntil.get(m) || 0));
  throw lastErr || Object.assign(new Error("groq: all models rate-limited"), { status: 429, retryAfterMs: Math.max(1000, soonest - Date.now()) });
}

/** Через сколько освободится хотя бы одна модель (для паузы в адаптере). */
export const retryAfterMs = () => Math.max(1000, Math.min(...config.groq.models.map((m) => (pausedUntil.get(m) || 0))) - Date.now());
