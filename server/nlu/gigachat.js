// GigaChat — запасной провайдер NLU. OAuth-токен живёт ~30 минут: кешируем и обновляем за минуту
// до истечения. Сертификат НУЦ Минцифры подключается через NODE_EXTRA_CA_CERTS (см. Dockerfile/README).
import crypto from "node:crypto";
import { config } from "../config.js";

export const name = "gigachat";
export const available = () => Boolean(config.gigachat.authKey);

let token = null;     // { value, expiresAt (ms) }

async function accessToken(signal) {
  if (token && token.expiresAt - 60_000 > Date.now()) return token.value;
  const res = await fetch("https://ngw.devices.sberbank.ru:9443/api/v2/oauth", {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      RqUID: crypto.randomUUID(),
      Authorization: `Basic ${config.gigachat.authKey}`,
    },
    body: new URLSearchParams({ scope: config.gigachat.scope }),
  });
  if (!res.ok) throw Object.assign(new Error(`gigachat oauth HTTP ${res.status}`), { status: res.status });
  const body = await res.json();
  token = { value: body.access_token, expiresAt: Number(body.expires_at) || Date.now() + 25 * 60_000 };
  return token.value;
}

/** @param {{role: string, text: string}[]} messages  @returns {Promise<string>} */
export async function complete(messages, { signal } = {}) {
  const bearer = await accessToken(signal);
  const res = await fetch("https://gigachat.devices.sberbank.ru/api/v1/chat/completions", {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${bearer}` },
    body: JSON.stringify({
      model: config.gigachat.model,
      temperature: 0.01,
      max_tokens: 400,
      messages: messages.map((m) => ({ role: m.role, content: m.text })),
    }),
  });
  if (res.status === 401) token = null;
  if (!res.ok) throw Object.assign(new Error(`gigachat HTTP ${res.status}`), { status: res.status });
  const body = await res.json();
  return body?.choices?.[0]?.message?.content ?? "";
}
