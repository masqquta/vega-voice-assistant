// YandexGPT (Foundation Models, completion API). Основной провайдер NLU.
// Документация: https://yandex.cloud/ru/docs/foundation-models/text-generation/api-ref/TextGeneration/completion
import { config } from "../config.js";

export const name = "yandex";
export const available = () => Boolean(config.yandex.apiKey && config.yandex.folderId);

/** @param {{role: string, text: string}[]} messages  @returns {Promise<string>} текст ответа модели */
export async function complete(messages, { signal } = {}) {
  const res = await fetch("https://llm.api.cloud.yandex.net/foundationModels/v1/completion", {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Api-Key ${config.yandex.apiKey}`,
      "x-folder-id": config.yandex.folderId,
    },
    body: JSON.stringify({
      modelUri: `gpt://${config.yandex.folderId}/${config.yandex.llmModel}`,
      completionOptions: { stream: false, temperature: 0, maxTokens: "400" },
      messages,
    }),
  });
  if (!res.ok) throw Object.assign(new Error(`yandex HTTP ${res.status}`), { status: res.status });
  const body = await res.json();
  return body?.result?.alternatives?.[0]?.message?.text ?? "";
}
