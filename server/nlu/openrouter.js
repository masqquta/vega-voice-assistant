// OpenRouter — OpenAI-совместимый шлюз к десяткам моделей, есть бесплатные (суффикс :free).
// Ключ без карты: https://openrouter.ai/keys. Второй моделью в списке OpenRouter сам подстрахуется,
// если первая перегружена. Документация: https://openrouter.ai/docs/api-reference/chat-completion
import { config } from "../config.js";

export const name = "openrouter";
export const available = () => Boolean(config.openrouter.apiKey);

/** @param {{role: string, text: string}[]} messages  @returns {Promise<string>} */
export async function complete(messages, { signal } = {}) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.openrouter.apiKey}`,
      "X-Title": "Vega voice assistant",
    },
    body: JSON.stringify({
      models: config.openrouter.models,
      temperature: 0,
      max_tokens: 400,
      messages: messages.map((m) => ({ role: m.role, content: m.text })),
    }),
  });
  if (!res.ok) throw Object.assign(new Error(`openrouter HTTP ${res.status}`), { status: res.status });
  const body = await res.json();
  return body?.choices?.[0]?.message?.content ?? "";
}
